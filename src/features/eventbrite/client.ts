/**
 * Eventbrite API v3 client with rate-limit awareness.
 *
 * Reads the token from process.env.EVENTBRITE_PRIVATE_TOKEN at construction.
 * The token NEVER leaves this module — sandboxed analytics processes are
 * given JSON files on disk, not the token.
 *
 * Behavior:
 *   - Parses X-Rate-Limit on every response (format:
 *     `token:ID N/2000 reset=Ns, key:ID N/2000 reset=Ns`)
 *   - Proactively slows down when remaining < RATE_LIMIT_FLOOR
 *   - On 429: sleeps reset window + jitter, retries once
 *   - On 5xx / network: exponential backoff up to MAX_RETRIES
 *   - getPaginated() parallelizes pages via ?page=N with MAX_CONCURRENT cap
 */

import { createLogger } from '../../logger.js';

const log = createLogger('Eventbrite');

const API_BASE = 'https://www.eventbriteapi.com/v3';
const RATE_LIMIT_FLOOR = 100;   // start trickling below this
const MAX_CONCURRENT = 16;      // parallel page fetches
const MAX_RETRIES = 4;          // for 5xx / network errors

export class EventbriteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'EventbriteError';
  }
}

interface Pagination {
  page_number: number;
  page_size: number;
  page_count: number;
  object_count: number;
  has_more_items: boolean;
  continuation?: string;
}

interface Paginated<T = unknown> {
  pagination: Pagination;
  [key: string]: T[] | Pagination;
}

interface RateState {
  remaining: number;
  resetAt: number; // epoch ms
}

class EventbriteClient {
  private token: string;
  private rate: RateState = { remaining: 2000, resetAt: 0 };

  constructor(token: string) {
    if (!token) throw new Error('EVENTBRITE_PRIVATE_TOKEN is not set');
    this.token = token;
  }

  get rateState(): Readonly<RateState> {
    return this.rate;
  }

  /** GET a single endpoint. Path may be a full path (`/events/123/`) or include query. */
  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  /** POST JSON to a single endpoint. Path may be a full path or include query. */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, 0, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * GET a paginated endpoint and return the merged array under `itemsKey`.
   * Parallelizes pages 2..N via `?page=N`.
   */
  async getPaginated<T = unknown>(path: string, itemsKey: string): Promise<{
    items: T[];
    pagination: Pagination;
  }> {
    const first = await this.get<Paginated<T>>(addQuery(path, { page: 1 }));
    const pagination = first.pagination;
    const firstItems = (first[itemsKey] ?? []) as T[];

    if (!pagination.has_more_items || pagination.page_count <= 1) {
      return { items: firstItems, pagination };
    }

    const pages = pagination.page_count;
    const pageNumbers = Array.from({ length: pages - 1 }, (_, i) => i + 2);
    const rest = await runWithConcurrency(pageNumbers, MAX_CONCURRENT, (p) =>
      this.get<Paginated<T>>(addQuery(path, { page: p })),
    );

    const items = [firstItems, ...rest.map((r) => (r[itemsKey] ?? []) as T[])].flat();
    return { items, pagination: { ...pagination, page_number: pages } };
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private async request<T>(path: string, attempt = 0, init: RequestInit = {}): Promise<T> {
    await this.maybeTrickle();

    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
      });
    } catch (err) {
      // Network error — exp backoff
      if (attempt < MAX_RETRIES) {
        const wait = backoffMs(attempt);
        log.warn(`Network error on ${path}, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        return this.request<T>(path, attempt + 1, init);
      }
      throw err;
    }

    this.parseRateLimit(res.headers.get('x-rate-limit'));

    if (res.status === 429) {
      const wait = Math.max(1000, this.rate.resetAt - Date.now()) + Math.floor(Math.random() * 500);
      log.warn(`Rate-limited on ${path}, sleeping ${Math.round(wait / 1000)}s before retry`);
      await sleep(wait);
      if (attempt < MAX_RETRIES) return this.request<T>(path, attempt + 1, init);
      throw new EventbriteError(`Rate-limited (429) after ${MAX_RETRIES} retries: ${path}`, 429);
    }

    if (res.status >= 500 && res.status < 600) {
      if (attempt < MAX_RETRIES) {
        const wait = backoffMs(attempt);
        log.warn(`HTTP ${res.status} on ${path}, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        return this.request<T>(path, attempt + 1, init);
      }
    }

    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { /* not JSON */ }
      throw new EventbriteError(`HTTP ${res.status} on ${path}`, res.status, body);
    }

    return res.json() as Promise<T>;
  }

  private parseRateLimit(header: string | null): void {
    if (!header) return;
    // Format: `token:ID 21/2000 reset=1651s, key:ID 21/2000 reset=1651s`
    // Take the minimum remaining across both bucket types.
    const parts = header.split(',').map((s) => s.trim());
    let minRemaining = Infinity;
    let maxResetSecs = 0;
    for (const part of parts) {
      const m = /\s(\d+)\/(\d+)\s+reset=(\d+)s/.exec(part);
      if (!m) continue;
      const used = parseInt(m[1]!, 10);
      const limit = parseInt(m[2]!, 10);
      const resetSecs = parseInt(m[3]!, 10);
      const remaining = limit - used;
      if (remaining < minRemaining) minRemaining = remaining;
      if (resetSecs > maxResetSecs) maxResetSecs = resetSecs;
    }
    if (Number.isFinite(minRemaining)) {
      this.rate.remaining = minRemaining;
      this.rate.resetAt = Date.now() + maxResetSecs * 1000;
    }
  }

  /** Proactively trickle when approaching the rate ceiling. */
  private async maybeTrickle(): Promise<void> {
    if (this.rate.remaining >= RATE_LIMIT_FLOOR) return;
    const msUntilReset = Math.max(0, this.rate.resetAt - Date.now());
    if (msUntilReset === 0 || this.rate.remaining <= 0) {
      // Reset window has passed or we're out — wait the rest of the window
      const wait = Math.max(1000, msUntilReset);
      log.warn(`Rate floor hit (${this.rate.remaining} left), waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      return;
    }
    const perCallMs = msUntilReset / this.rate.remaining;
    await sleep(perCallMs);
  }
}

// ─── module singleton ────────────────────────────────────────────────────────

let _client: EventbriteClient | null = null;

export function getClient(): EventbriteClient {
  if (!_client) {
    _client = new EventbriteClient(process.env.EVENTBRITE_PRIVATE_TOKEN || '');
  }
  return _client;
}

/** Test-only: reset the singleton so a different token can be used. */
export function resetClient(): void {
  _client = null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function addQuery(path: string, params: Record<string, string | number>): string {
  const [base, existing = ''] = path.split('?');
  const usp = new URLSearchParams(existing);
  for (const [k, v] of Object.entries(params)) {
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  // 500ms, 1s, 2s, 4s with full jitter
  const base = 500 * Math.pow(2, attempt);
  return Math.floor(Math.random() * base) + base / 2;
}

async function runWithConcurrency<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I) => Promise<O>,
): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

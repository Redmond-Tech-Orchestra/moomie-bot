/**
 * Snapshot a single Eventbrite event to disk.
 *
 * Layout:
 *   data/eventbrite/events/{event_id}/
 *     _meta.json           — { event_id, event_name, event_end, synced_at, frozen, sync_count }
 *     event.json           — /events/{id}/?expand=...
 *     attendees.json       — paginated, merged
 *     orders.json          — paginated, merged
 *     ticket_classes.json
 *     description.json
 *     structured_content.json   (may be absent if endpoint returns 404)
 *     questions.json
 *     canned_questions.json
 *     display_settings.json
 *     reports/sales.json        — /organizations/{org}/reports/sales/?event_ids={id}
 *     reports/attendees.json    — /organizations/{org}/reports/attendees/?event_ids={id}&group_by=ticket
 *     reports/traffic_conversion.json — /organizations/{org}/reports/datasets/traffic_conversion/ filtered by event_id
 *
 * `frozen=true` means the event has been over for longer than LATE_CHECKIN_MARGIN_MS
 * and no further snapshots are needed. Frozen events are skipped by syncArchive unless
 * `force: true` is passed.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVENTBRITE_DATA_DIR, EVENTBRITE_ORG_ID } from '../../config.js';
import { createLogger } from '../../logger.js';
import { getClient, EventbriteError } from './client.js';

const log = createLogger('Eventbrite.snapshot');

/** How long after an event ends we keep re-snapshotting to catch late check-ins. */
export const LATE_CHECKIN_MARGIN_MS = 24 * 60 * 60 * 1000;

export interface SnapshotMeta {
  event_id: string;
  event_name: string;
  event_end: string;
  synced_at: string;
  frozen: boolean;
  sync_count: number;
  attendee_count?: number;
  order_count?: number;
}

export interface SnapshotResult {
  event_id: string;
  event_name: string;
  frozen: boolean;
  duration_ms: number;
  attendee_count: number;
  order_count: number;
  files_written: string[];
  warnings: string[];
}

interface EventbriteEvent {
  id: string;
  name?: { text?: string };
  end?: { utc?: string };
  status?: string;
  series_id?: string;
}

interface TrafficConversionRow {
  traffic_date_daily?: string;
  affiliate_category?: string;
  traffic_pageviews__sum?: number;
  attendee_quantity__sum?: number;
  orders_sold__sum?: number;
}

interface TrafficConversionResponse {
  pagination?: { continuation?: string; has_more_items?: boolean };
  last_updated?: string;
  launch_tc_conversion_rate?: boolean;
  has_add_on?: boolean;
  show_no_backfill_banner?: boolean;
  data?: TrafficConversionRow[];
}

export function eventDir(eventId: string): string {
  return join(EVENTBRITE_DATA_DIR, 'events', eventId);
}

export async function readMeta(eventId: string): Promise<SnapshotMeta | null> {
  const path = join(eventDir(eventId), '_meta.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SnapshotMeta;
  } catch (err) {
    log.warn(`Failed to read _meta.json for ${eventId}:`, err);
    return null;
  }
}

/**
 * Pull all data for a single event and write it to disk.
 * Idempotent — overwrites existing files. Sets frozen=true if event ended
 * more than LATE_CHECKIN_MARGIN_MS ago.
 */
export async function snapshotEvent(eventId: string): Promise<SnapshotResult> {
  const t0 = Date.now();
  const client = getClient();
  const dir = eventDir(eventId);
  const reportsDir = join(dir, 'reports');
  await mkdir(reportsDir, { recursive: true });

  const warnings: string[] = [];
  const filesWritten: string[] = [];

  // Helper: pull JSON and write to disk. Optional flag to swallow 404s.
  const grab = async (path: string, file: string, opts: { optional?: boolean } = {}) => {
    try {
      const data = await client.get(path);
      const fullPath = join(dir, file);
      await writeFile(fullPath, JSON.stringify(data, null, 2), 'utf8');
      filesWritten.push(file);
      return data;
    } catch (err) {
      if (opts.optional && err instanceof EventbriteError && err.status === 404) {
        warnings.push(`${file}: 404 (optional, skipped)`);
        return null;
      }
      throw err;
    }
  };

  // Paginated grab — merge pages, wrap in envelope.
  const grabPaginated = async (path: string, itemsKey: string, file: string) => {
    const { items, pagination } = await client.getPaginated(path, itemsKey);
    const envelope = {
      source: path,
      retrieved_at: new Date().toISOString(),
      object_count: pagination.object_count,
      items,
    };
    const fullPath = join(dir, file);
    await writeFile(fullPath, JSON.stringify(envelope, null, 2), 'utf8');
    filesWritten.push(file);
    return envelope;
  };

  // 1. Core event blob — needed first to get name + end_date for meta.
  // Expansions are free (no extra HTTP call), so we pull everything that's
  // useful for the archive: visual assets (logo), taxonomy (subcategory),
  // refund context (refund_policy), and aggregate availability snapshot
  // (ticket_availability) on top of the basics.
  const eventBlob = (await grab(
    `/events/${eventId}/?expand=ticket_classes,venue,organizer,format,category,music_properties,logo,subcategory,refund_policy,ticket_availability`,
    'event.json',
  )) as EventbriteEvent;

  // 2. Everything else in parallel — independent endpoints.
  const [, , attendees, orders] = await Promise.all([
    grab(`/events/${eventId}/ticket_classes/`, 'ticket_classes.json'),
    grab(`/events/${eventId}/description/`, 'description.json'),
    // Omit ?status= so we capture every attendee record (Attending,
    // Checked In, Not Attending, Deleted). With the default "attending"
    // filter, refunded/cancelled rows are silently dropped, which makes
    // it impossible to reconcile registration vs check-in vs refund
    // numbers from the frozen snapshot alone.
    grabPaginated(`/events/${eventId}/attendees/`, 'attendees', 'attendees.json'),
    grabPaginated(`/events/${eventId}/orders/`, 'orders', 'orders.json'),
    grab(`/events/${eventId}/structured_content/`, 'structured_content.json', { optional: true }),
    grab(`/events/${eventId}/questions/`, 'questions.json', { optional: true }),
    grab(`/events/${eventId}/canned_questions/`, 'canned_questions.json', { optional: true }),
    grab(`/events/${eventId}/display_settings/`, 'display_settings.json', { optional: true }),
    grab(
      `/organizations/${EVENTBRITE_ORG_ID}/reports/sales/?event_ids=${eventId}`,
      'reports/sales.json',
      { optional: true },
    ),
    grab(
      `/organizations/${EVENTBRITE_ORG_ID}/reports/attendees/?event_ids=${eventId}&group_by=ticket`,
      'reports/attendees.json',
      { optional: true },
    ),
    grabTrafficConversion(eventId, eventBlob.series_id, dir, filesWritten, warnings),
  ]);

  // 3. Write meta.
  const prev = await readMeta(eventId);
  const eventEnd = eventBlob?.end?.utc ?? '';
  const frozen = !!eventEnd && isFrozen(eventEnd);

  const meta: SnapshotMeta = {
    event_id: eventId,
    event_name: eventBlob?.name?.text ?? '(unknown)',
    event_end: eventEnd,
    synced_at: new Date().toISOString(),
    frozen,
    sync_count: (prev?.sync_count ?? 0) + 1,
    attendee_count: attendees.object_count,
    order_count: orders.object_count,
  };
  await writeFile(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  filesWritten.push('_meta.json');

  const duration_ms = Date.now() - t0;
  log.info(
    `Snapshotted ${eventId} (${meta.event_name}) — ${attendees.object_count} attendees, ${orders.object_count} orders, ${duration_ms}ms, frozen=${frozen}`,
  );

  return {
    event_id: eventId,
    event_name: meta.event_name,
    frozen,
    duration_ms,
    attendee_count: attendees.object_count,
    order_count: orders.object_count,
    files_written: filesWritten,
    warnings,
  };
}

/** Returns true if the event ended more than LATE_CHECKIN_MARGIN_MS ago. */
export function isFrozen(eventEndIso: string): boolean {
  const end = Date.parse(eventEndIso);
  if (Number.isNaN(end)) return false;
  return Date.now() - end > LATE_CHECKIN_MARGIN_MS;
}

async function grabTrafficConversion(
  eventId: string,
  seriesId: string | undefined,
  dir: string,
  filesWritten: string[],
  warnings: string[],
): Promise<void> {
  const client = getClient();
  const source = `/organizations/${EVENTBRITE_ORG_ID}/reports/datasets/traffic_conversion/`;

  try {
    const eventReport = await fetchTrafficConversionReport(client, source, eventId);
    const seriesReport = seriesId && seriesId !== eventId
      ? await fetchTrafficConversionReport(client, source, seriesId)
      : null;

    const envelope = {
      source,
      retrieved_at: new Date().toISOString(),
      event_id: eventId,
      series_id: seriesId ?? null,
      event_report: eventReport,
      series_report: seriesReport,
    };
    await writeFile(join(dir, 'reports', 'traffic_conversion.json'), JSON.stringify(envelope, null, 2), 'utf8');
    filesWritten.push('reports/traffic_conversion.json');
  } catch (err) {
    if (err instanceof EventbriteError && (err.status === 400 || err.status === 404 || err.status === 500)) {
      warnings.push(`reports/traffic_conversion.json: ${err.status} (optional, skipped)`);
      return;
    }
    throw err;
  }
}

async function fetchTrafficConversionReport(
  client: ReturnType<typeof getClient>,
  source: string,
  reportEventId: string,
): Promise<{
  report_event_id: string;
  request: Record<string, unknown>;
  last_updated?: string;
  page_count: number;
  object_count: number;
  totals: ReturnType<typeof summarizeTrafficConversion>;
  items: TrafficConversionRow[];
}> {
  const request = {
    aggregations: [
      { field: 'traffic_pageviews', method: 'sum', alias: 'traffic_pageviews__sum' },
      { field: 'attendee_quantity', method: 'sum', alias: 'attendee_quantity__sum' },
      { field: 'orders_sold', method: 'sum', alias: 'orders_sold__sum' },
    ],
    sort_by: [{ field: 'traffic_date_daily', method: 'asc' }],
    group_by: [{ field: 'traffic_date_daily' }, { field: 'affiliate_category' }],
    filters: [{ field: 'event_id', operator: 'in', value: [reportEventId] }],
    having: [],
    select: [],
    page_size: 310,
    report: 'traffic_conversion',
    timezone: 'America/Los_Angeles',
  };

  const rows: TrafficConversionRow[] = [];
  let continuation: string | undefined;
  let lastUpdated: string | undefined;
  let pages = 0;

  do {
    const body = continuation ? { ...request, continuation } : request;
    const response = await client.post<TrafficConversionResponse>(source, body);
    rows.push(...(response.data ?? []));
    lastUpdated = response.last_updated ?? lastUpdated;
    continuation = response.pagination?.has_more_items ? response.pagination.continuation : undefined;
    pages += 1;
  } while (continuation && pages < 50);

  return {
    report_event_id: reportEventId,
    request,
    last_updated: lastUpdated,
    page_count: pages,
    object_count: rows.length,
    totals: summarizeTrafficConversion(rows),
    items: rows,
  };
}

function summarizeTrafficConversion(rows: TrafficConversionRow[]): {
  traffic_pageviews: number;
  attendee_quantity: number;
  orders_sold: number;
  by_affiliate_category: Array<{ affiliate_category: string; traffic_pageviews: number; attendee_quantity: number; orders_sold: number }>;
} {
  const totals = { traffic_pageviews: 0, attendee_quantity: 0, orders_sold: 0 };
  const byAffiliate = new Map<string, { traffic_pageviews: number; attendee_quantity: number; orders_sold: number }>();
  for (const row of rows) {
    const pageviews = Number(row.traffic_pageviews__sum ?? 0);
    const attendees = Number(row.attendee_quantity__sum ?? 0);
    const orders = Number(row.orders_sold__sum ?? 0);
    totals.traffic_pageviews += pageviews;
    totals.attendee_quantity += attendees;
    totals.orders_sold += orders;
    const affiliate = row.affiliate_category || '(none)';
    const current = byAffiliate.get(affiliate) ?? { traffic_pageviews: 0, attendee_quantity: 0, orders_sold: 0 };
    current.traffic_pageviews += pageviews;
    current.attendee_quantity += attendees;
    current.orders_sold += orders;
    byAffiliate.set(affiliate, current);
  }
  return {
    ...totals,
    by_affiliate_category: [...byAffiliate.entries()]
      .map(([affiliate_category, values]) => ({ affiliate_category, ...values }))
      .sort((a, b) => b.traffic_pageviews - a.traffic_pageviews),
  };
}

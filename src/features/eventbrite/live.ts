/**
 * Live ticket-sales tool for current (non-ended) Eventbrite events.
 *
 * Uses the cheap /reports/* endpoints for aggregate numbers + /ticket_classes/
 * for per-tier capacity remaining. Results are cached in-process for LIVE_TTL_MS
 * to keep latency low when the LLM hits this tool multiple times per conversation.
 *
 * This module deliberately stays shallow — no per-attendee data is fetched here.
 * If the LLM needs that (analytics over past events), it goes through the archive.
 */

import { EVENTBRITE_ORG_ID } from '../../config.js';
import { createLogger } from '../../logger.js';
import { getClient } from './client.js';

const log = createLogger('Eventbrite.live');

const LIVE_TTL_MS = 60 * 1000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.data as T;
  }
  const data = await fn();
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

interface TicketClass {
  id: string;
  name: string;
  cost?: { display: string; major_value: string };
  quantity_total?: number;
  quantity_sold?: number;
  on_sale_status?: string;
  hidden?: boolean;
}

interface ActiveEvent {
  id: string;
  name: string;
  start_utc: string;
  end_utc: string;
  status: string;
  url: string;
}

interface LiveEventSales {
  event: ActiveEvent;
  sales: {
    gross: string | null;
    net: string | null;
    total_attendees: number | null;
    by_ticket: Array<{
      ticket_class_id: string;
      name: string;
      sold: number;
      capacity: number | null;
      remaining: number | null;
      price: string | null;
    }>;
  };
  retrieved_at: string;
  cache_ttl_seconds: number;
}

interface OrgEventRaw {
  id: string;
  name: { text: string };
  start: { utc: string };
  end: { utc: string };
  status: string;
  url: string;
}

interface ReportsAttendeesResponse {
  attendees?: { num_attendees?: number };
  data?: Array<Record<string, unknown>>;
  // Other fields exist but we don't use them.
}

interface ReportsSalesResponse {
  // Eventbrite's sales report is a multi-section blob. We pluck the
  // top-level summary fields if present and otherwise fall back to null.
  gross?: { display?: string };
  net?: { display?: string };
  costs?: Record<string, { display?: string }>;
}

/** List all active (non-ended, non-canceled, non-draft) events in the org. */
export async function listActiveEvents(): Promise<ActiveEvent[]> {
  return cached('active-events', LIVE_TTL_MS, async () => {
    const client = getClient();
    const { items } = await client.getPaginated<OrgEventRaw>(
      `/organizations/${EVENTBRITE_ORG_ID}/events/?status=live&order_by=start_asc`,
      'events',
    );
    return items.map((e) => ({
      id: e.id,
      name: e.name.text,
      start_utc: e.start.utc,
      end_utc: e.end.utc,
      status: e.status,
      url: e.url,
    }));
  });
}

/** Live sales for a single event. */
export async function getLiveSalesForEvent(eventId: string): Promise<LiveEventSales> {
  return cached(`live-sales:${eventId}`, LIVE_TTL_MS, async () => {
    const client = getClient();
    const [eventBlob, ticketClassesBlob, salesReport, attendeesReport] = await Promise.all([
      client.get<OrgEventRaw>(`/events/${eventId}/`),
      client.get<{ ticket_classes: TicketClass[] }>(`/events/${eventId}/ticket_classes/`),
      client.get<ReportsSalesResponse>(
        `/organizations/${EVENTBRITE_ORG_ID}/reports/sales/?event_ids=${eventId}`,
      ).catch((err) => {
        log.warn(`reports/sales failed for ${eventId}:`, err);
        return {} as ReportsSalesResponse;
      }),
      client.get<ReportsAttendeesResponse>(
        `/organizations/${EVENTBRITE_ORG_ID}/reports/attendees/?event_ids=${eventId}`,
      ).catch((err) => {
        log.warn(`reports/attendees failed for ${eventId}:`, err);
        return {} as ReportsAttendeesResponse;
      }),
    ]);

    return {
      event: {
        id: eventBlob.id,
        name: eventBlob.name.text,
        start_utc: eventBlob.start.utc,
        end_utc: eventBlob.end.utc,
        status: eventBlob.status,
        url: eventBlob.url,
      },
      sales: {
        gross: salesReport.gross?.display ?? null,
        net: salesReport.net?.display ?? null,
        total_attendees: attendeesReport.attendees?.num_attendees ?? null,
        by_ticket: (ticketClassesBlob.ticket_classes ?? []).map((tc) => ({
          ticket_class_id: tc.id,
          name: tc.name,
          sold: tc.quantity_sold ?? 0,
          capacity: tc.quantity_total ?? null,
          remaining:
            tc.quantity_total != null ? Math.max(0, tc.quantity_total - (tc.quantity_sold ?? 0)) : null,
          price: tc.cost?.display ?? null,
        })),
      },
      retrieved_at: new Date().toISOString(),
      cache_ttl_seconds: LIVE_TTL_MS / 1000,
    };
  });
}

/** If no eventId is given, returns live sales for all active events. */
export async function getLiveSales(eventId?: string): Promise<LiveEventSales[]> {
  if (eventId) {
    return [await getLiveSalesForEvent(eventId)];
  }
  const events = await listActiveEvents();
  return Promise.all(events.map((e) => getLiveSalesForEvent(e.id)));
}

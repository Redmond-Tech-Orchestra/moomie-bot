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
  const eventBlob = (await grab(
    `/events/${eventId}/?expand=ticket_classes,venue,organizer,format,category,music_properties`,
    'event.json',
  )) as EventbriteEvent;

  // 2. Everything else in parallel — independent endpoints.
  const [, , attendees, orders] = await Promise.all([
    grab(`/events/${eventId}/ticket_classes/`, 'ticket_classes.json'),
    grab(`/events/${eventId}/description/`, 'description.json'),
    grabPaginated(`/events/${eventId}/attendees/?status=attending`, 'attendees', 'attendees.json'),
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

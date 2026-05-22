/**
 * Sync the cold storage archive against the live Eventbrite org.
 *
 * State machine per event (see snapshotEvent docs):
 *   - Active            (now < event_end)                        → skip (live tools handle)
 *   - Just ended        (event_end ≤ now < event_end + 24h)      → snapshot, keep frozen=false
 *   - Settled, unsaved  (now ≥ event_end + 24h, no _meta.json)   → snapshot, set frozen=true
 *   - Settled, unfrozen (now ≥ event_end + 24h, frozen=false)    → snapshot, set frozen=true
 *   - Settled, frozen   (frozen=true in _meta.json)              → skip
 *   - force=true                                                 → snapshot all past events
 */

import { EVENTBRITE_ORG_ID } from '../../config.js';
import { createLogger } from '../../logger.js';
import { getClient } from './client.js';
import { snapshotEvent, readMeta, LATE_CHECKIN_MARGIN_MS } from './snapshot.js';

const log = createLogger('Eventbrite.sync');

interface OrgEvent {
  id: string;
  name: { text: string };
  start: { utc: string };
  end: { utc: string };
  status: string; // 'live', 'ended', 'completed', 'started', 'draft', 'canceled'
}

export interface SyncReport {
  added: Array<{ id: string; name: string; duration_ms: number; attendee_count: number }>;
  refreshed: Array<{ id: string; name: string; duration_ms: number; reason: string }>;
  already_archived: Array<{ id: string; name: string; frozen: boolean }>;
  skipped_active: Array<{ id: string; name: string; status: string; start: string }>;
  failed: Array<{ id: string; name: string; error: string }>;
  total_duration_ms: number;
  rate_limit_remaining: number;
}

export interface SyncOptions {
  /** Re-snapshot every past event regardless of frozen state. */
  force?: boolean;
}

/** Returns true if the event is in the past (event_end ≤ now). */
function isPast(event: OrgEvent): boolean {
  const end = Date.parse(event.end?.utc ?? '');
  return Number.isFinite(end) && end <= Date.now();
}

/** Returns true if event ended more than the late-checkin margin ago. */
function isSettled(event: OrgEvent): boolean {
  const end = Date.parse(event.end?.utc ?? '');
  return Number.isFinite(end) && Date.now() - end > LATE_CHECKIN_MARGIN_MS;
}

export async function syncArchive(opts: SyncOptions = {}): Promise<SyncReport> {
  const t0 = Date.now();
  const client = getClient();
  log.info(`Sync starting (force=${!!opts.force})`);

  // Pull every event the org has access to. The org events endpoint paginates.
  const { items } = await client.getPaginated<OrgEvent>(
    `/organizations/${EVENTBRITE_ORG_ID}/events/?order_by=start_desc`,
    'events',
  );

  const report: SyncReport = {
    added: [],
    refreshed: [],
    already_archived: [],
    skipped_active: [],
    failed: [],
    total_duration_ms: 0,
    rate_limit_remaining: 0,
  };

  for (const event of items) {
    // Skip canceled/draft events entirely.
    if (event.status === 'canceled' || event.status === 'draft') {
      continue;
    }

    // Active events: not our concern here.
    if (!isPast(event)) {
      report.skipped_active.push({
        id: event.id,
        name: event.name.text,
        status: event.status,
        start: event.start.utc,
      });
      continue;
    }

    const meta = await readMeta(event.id);

    // Already frozen and not forcing → skip.
    if (meta?.frozen && !opts.force) {
      report.already_archived.push({ id: event.id, name: event.name.text, frozen: true });
      continue;
    }

    // Decide action.
    let reason: string;
    if (!meta) {
      reason = isSettled(event) ? 'first snapshot (settled)' : 'first snapshot (just ended, not yet frozen)';
    } else if (opts.force) {
      reason = 'force=true';
    } else {
      reason = 'within late-checkin window';
    }

    try {
      const result = await snapshotEvent(event.id);
      if (meta) {
        report.refreshed.push({
          id: event.id,
          name: event.name.text,
          duration_ms: result.duration_ms,
          reason,
        });
      } else {
        report.added.push({
          id: event.id,
          name: event.name.text,
          duration_ms: result.duration_ms,
          attendee_count: result.attendee_count,
        });
      }
    } catch (err) {
      log.error(`Snapshot failed for ${event.id} (${event.name.text}):`, err);
      report.failed.push({
        id: event.id,
        name: event.name.text,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  report.total_duration_ms = Date.now() - t0;
  report.rate_limit_remaining = client.rateState.remaining;

  log.info(
    `Sync done in ${report.total_duration_ms}ms — added=${report.added.length}, refreshed=${report.refreshed.length}, skipped_active=${report.skipped_active.length}, already_archived=${report.already_archived.length}, failed=${report.failed.length}, rate_remaining=${report.rate_limit_remaining}`,
  );

  return report;
}

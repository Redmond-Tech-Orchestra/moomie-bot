import { getDb, registerMigration } from '../../db.js';
import { createLogger } from '../../logger.js';

const log = createLogger('JobStore');

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// Write-ahead record of the in-memory coding queue. Every job is persisted here
// the moment it's enqueued so a process restart (deploy, crash, OOM) can recover
// jobs that were queued or running. The in-memory queue in job-runner.ts remains
// the live driver; this table is purely for durability + restart recovery.

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coding_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,                 -- 'new' | 'revision'
      status TEXT NOT NULL,               -- 'queued' | 'running' | 'done' | 'failed'
      payload TEXT NOT NULL,              -- JSON of the task options
      attempts INTEGER NOT NULL DEFAULT 0,
      enqueued_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      finished_at INTEGER,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_coding_jobs_status ON coding_jobs(status);
  `);
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type JobKind = 'new' | 'revision';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface PersistedJob {
  id: number;
  kind: JobKind;
  status: JobStatus;
  payload: string;
  attempts: number;
  enqueued_at: number;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Persist a freshly enqueued job. Returns the row id used to track it. */
export function insertJob(kind: JobKind, payload: unknown): number {
  const info = getDb()
    .prepare(`INSERT INTO coding_jobs (kind, status, payload) VALUES (?, 'queued', ?)`)
    .run(kind, JSON.stringify(payload));
  return Number(info.lastInsertRowid);
}

export function markRunning(id: number): void {
  getDb()
    .prepare(`UPDATE coding_jobs SET status = 'running', started_at = unixepoch() WHERE id = ?`)
    .run(id);
}

export function markDone(id: number, result?: unknown): void {
  getDb()
    .prepare(`UPDATE coding_jobs SET status = 'done', finished_at = unixepoch(), result = ? WHERE id = ?`)
    .run(result === undefined ? null : JSON.stringify(result), id);
}

export function markFailed(id: number, result?: unknown): void {
  getDb()
    .prepare(`UPDATE coding_jobs SET status = 'failed', finished_at = unixepoch(), result = ? WHERE id = ?`)
    .run(result === undefined ? null : JSON.stringify(result), id);
}

/** Reset an interrupted (was-running) job back to queued so it can be retried. */
export function requeueInterrupted(id: number): void {
  getDb()
    .prepare(`UPDATE coding_jobs SET status = 'queued', started_at = NULL, attempts = attempts + 1 WHERE id = ?`)
    .run(id);
}

// ─── Recovery ────────────────────────────────────────────────────────────────

/**
 * Jobs that were queued or running when the process last stopped, oldest first
 * (preserves original FIFO order on resume).
 */
export function getResumableJobs(): PersistedJob[] {
  return getDb()
    .prepare(
      `SELECT id, kind, status, payload, attempts, enqueued_at
         FROM coding_jobs
        WHERE status IN ('queued', 'running')
        ORDER BY enqueued_at ASC, id ASC`,
    )
    .all() as PersistedJob[];
}

/** Drop completed/failed rows older than the retention window. */
export function pruneFinishedJobs(days = 30): number {
  const res = getDb()
    .prepare(
      `DELETE FROM coding_jobs
        WHERE status IN ('done', 'failed')
          AND finished_at IS NOT NULL
          AND finished_at < unixepoch('now', ?)`,
    )
    .run(`-${days} days`);
  if (res.changes > 0) log.info(`Pruned ${res.changes} finished coding-job row(s).`);
  return res.changes;
}

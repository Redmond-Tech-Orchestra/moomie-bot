import { getDb, registerMigration } from './db.js';
import { logAudit } from './features/admin/audit-store.js';

// ─── Schema ──────────────────────────────────────────────────────────────────

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      timestamp TEXT DEFAULT (datetime('now')),
      level TEXT NOT NULL,
      tag TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_tag ON logs(tag);
  `);
});

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuditEntry {
  type: string;
  channel_id?: string;
  channel_name?: string;
  model?: string;
  input_summary?: string;
  output_json?: string;
  result?: string;
  tokens_in?: number;
  tokens_out?: number;
}

export interface LogEntry {
  id: number;
  timestamp: string;
  level: string;
  tag: string;
  message: string;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** Write a structured entry to the SQLite audit log. */
  audit(entry: AuditEntry): void;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getRecentLogs(opts: {
  hours?: number;
  tag?: string;
  level?: string;
  search?: string;
  limit?: number;
} = {}): LogEntry[] {
  const hours = opts.hours ?? 24;
  const limit = Math.min(opts.limit ?? 200, 500);
  const cutoff = `-${hours} hours`;

  let sql = `SELECT * FROM logs WHERE timestamp > datetime('now', ?)`;
  const params: unknown[] = [cutoff];

  if (opts.tag) {
    sql += ` AND tag = ?`;
    params.push(opts.tag);
  }
  if (opts.level) {
    sql += ` AND level = ?`;
    params.push(opts.level);
  }
  if (opts.search) {
    sql += ` AND message LIKE ?`;
    params.push(`%${opts.search}%`);
  }

  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  return getDb().prepare(sql).all(...params) as LogEntry[];
}

// ─── Persistence ─────────────────────────────────────────────────────────────

import type Database from 'better-sqlite3';

let insertStmt: Database.Statement | null = null;

function persistLog(level: string, tag: string, message: string): void {
  try {
    if (!insertStmt) {
      insertStmt = getDb().prepare(
        `INSERT INTO logs (level, tag, message) VALUES (?, ?, ?)`
      );
    }
    insertStmt.run(level, tag, message);
  } catch {
    // If DB isn't ready yet (early startup), just skip — console still has it
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a tagged logger. Every log line is prefixed with `[tag]`, persisted
 * to the `logs` SQLite table, and the `audit()` method writes to the
 * structured `audit_log` table.
 *
 * Usage:
 * ```ts
 * const log = createLogger('MyFeature');
 * log.info('starting up');            // → console + logs table
 * log.error('boom', err);             // → console + logs table
 * log.audit({ type: 'my-op', ... }); // → audit_log table
 * ```
 */
export function createLogger(tag: string): Logger {
  const prefix = `[${tag}]`;

  const write = (level: string, method: (...args: unknown[]) => void, message: string, args: unknown[]) => {
    method(`${prefix} ${message}`, ...args);
    // Flatten extra args into the persisted message so errors/objects are captured
    const full = args.length > 0
      ? `${message} ${args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ')}`
      : message;
    persistLog(level, tag, full);
  };

  return {
    info: (message, ...args) => write('info', console.log, message, args),
    warn: (message, ...args) => write('warn', console.warn, message, args),
    error: (message, ...args) => write('error', console.error, message, args),
    audit: (entry) => logAudit(entry),
  };
}

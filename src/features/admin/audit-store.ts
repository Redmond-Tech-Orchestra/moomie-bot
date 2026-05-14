import { getDb, registerMigration } from '../../db.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Audit');

// ─── Schema ──────────────────────────────────────────────────────────────────

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      timestamp TEXT DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      channel_id TEXT,
      channel_name TEXT,
      model TEXT,
      input_summary TEXT,
      output_json TEXT,
      result TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
  `);
});

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  timestamp: string;
  type: string;
  channel_id: string | null;
  channel_name: string | null;
  model: string | null;
  input_summary: string | null;
  output_json: string | null;
  result: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function logAudit(entry: {
  type: string;
  channel_id?: string;
  channel_name?: string;
  model?: string;
  input_summary?: string;
  output_json?: string;
  result?: string;
  tokens_in?: number;
  tokens_out?: number;
}): void {
  try {
    getDb()
      .prepare(`
        INSERT INTO audit_log (type, channel_id, channel_name, model, input_summary, output_json, result, tokens_in, tokens_out)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.type,
        entry.channel_id ?? null,
        entry.channel_name ?? null,
        entry.model ?? null,
        entry.input_summary ?? null,
        entry.output_json ?? null,
        entry.result ?? null,
        entry.tokens_in ?? null,
        entry.tokens_out ?? null,
      );
  } catch (err) {
    log.error('Failed to write audit log:', err);
  }
}

export function getRecentAudit(hours: number = 24, type?: string): AuditEntry[] {
  const cutoff = `-${hours} hours`;
  if (type) {
    return getDb()
      .prepare(`SELECT * FROM audit_log WHERE timestamp > datetime('now', ?) AND type = ? ORDER BY timestamp DESC`)
      .all(cutoff, type) as AuditEntry[];
  }
  return getDb()
    .prepare(`SELECT * FROM audit_log WHERE timestamp > datetime('now', ?) ORDER BY timestamp DESC`)
    .all(cutoff) as AuditEntry[];
}

export function getAuditStats(days: number = 7): {
  total: number;
  by_type: Record<string, number>;
  by_model: Record<string, number>;
  total_tokens_in: number;
  total_tokens_out: number;
} {
  const cutoff = `-${days} days`;
  const rows = getDb()
    .prepare(`SELECT type, model, tokens_in, tokens_out FROM audit_log WHERE timestamp > datetime('now', ?)`)
    .all(cutoff) as { type: string; model: string | null; tokens_in: number | null; tokens_out: number | null }[];

  const by_type: Record<string, number> = {};
  const by_model: Record<string, number> = {};
  let total_tokens_in = 0;
  let total_tokens_out = 0;

  for (const row of rows) {
    by_type[row.type] = (by_type[row.type] ?? 0) + 1;
    if (row.model) by_model[row.model] = (by_model[row.model] ?? 0) + 1;
    total_tokens_in += row.tokens_in ?? 0;
    total_tokens_out += row.tokens_out ?? 0;
  }

  return { total: rows.length, by_type, by_model, total_tokens_in, total_tokens_out };
}

import { getDb, registerMigration } from '../../db.js';

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_issues (
      issue_number INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'discord',
      conversation_ref TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
});

interface TrackedIssue {
  channelId: string;
  userId: string;
  platform: 'discord' | 'teams';
  conversationRef?: string;
  createdAt: number;
}

export function trackIssue(issueNumber: number, { channelId, userId, platform, conversationRef }: Omit<TrackedIssue, 'createdAt'>): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO tracked_issues (issue_number, channel_id, user_id, platform, conversation_ref) VALUES (?, ?, ?, ?, ?)`
  ).run(issueNumber, channelId, userId, platform, conversationRef ?? null);
}

export function getTrackedIssue(issueNumber: number): TrackedIssue | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT channel_id, user_id, platform, conversation_ref, created_at FROM tracked_issues WHERE issue_number = ?`
  ).get(issueNumber) as { channel_id: string; user_id: string; platform: string; conversation_ref: string | null; created_at: number } | undefined;

  if (!row) return undefined;
  return {
    channelId: row.channel_id,
    userId: row.user_id,
    platform: row.platform as 'discord' | 'teams',
    conversationRef: row.conversation_ref ?? undefined,
    createdAt: row.created_at,
  };
}

export function untrackIssue(issueNumber: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM tracked_issues WHERE issue_number = ?`).run(issueNumber);
}

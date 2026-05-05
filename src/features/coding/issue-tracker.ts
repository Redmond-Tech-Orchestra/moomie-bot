import { getDb, registerMigration } from '../../db.js';
import { GITHUB_REPO } from '../../config.js';

registerMigration((db) => {
  // Migrate from single-key to compound-key schema if needed.
  // tracked_issues is transient (entries deleted after PR notification), so
  // dropping and recreating is safe.
  const cols = db.pragma('table_info(tracked_issues)') as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === 'repo')) {
    db.exec(`DROP TABLE tracked_issues`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_issues (
      issue_number INTEGER NOT NULL,
      repo TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'discord',
      conversation_ref TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (issue_number, repo)
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

export function trackIssue(issueNumber: number, repo: string, { channelId, userId, platform, conversationRef }: Omit<TrackedIssue, 'createdAt'>): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO tracked_issues (issue_number, repo, channel_id, user_id, platform, conversation_ref) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(issueNumber, repo, channelId, userId, platform, conversationRef ?? null);
}

export function getTrackedIssue(issueNumber: number, repo: string): TrackedIssue | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT channel_id, user_id, platform, conversation_ref, created_at FROM tracked_issues WHERE issue_number = ? AND repo = ?`
  ).get(issueNumber, repo) as { channel_id: string; user_id: string; platform: string; conversation_ref: string | null; created_at: number } | undefined;

  if (!row) return undefined;
  return {
    channelId: row.channel_id,
    userId: row.user_id,
    platform: row.platform as 'discord' | 'teams',
    conversationRef: row.conversation_ref ?? undefined,
    createdAt: row.created_at,
  };
}

export function untrackIssue(issueNumber: number, repo: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM tracked_issues WHERE issue_number = ? AND repo = ?`).run(issueNumber, repo);
}

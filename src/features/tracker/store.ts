import { getDb, registerMigration } from '../../db.js';

// ─── Schema ──────────────────────────────────────────────────────────────────

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      end_date TEXT,
      channel_id TEXT,
      channel_name TEXT,
      confirmed INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      event_id INTEGER REFERENCES events(id),
      description TEXT NOT NULL,
      owner_id TEXT,
      owner_name TEXT,
      status TEXT DEFAULT 'open',
      target_date TEXT,
      source TEXT,
      source_channel TEXT,
      source_date TEXT,
      last_mentioned TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY,
      item_id INTEGER REFERENCES items(id),
      user_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS milestone_templates (
      id INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      offset_days INTEGER NOT NULL,
      default_role TEXT
    );

    -- Seed milestone templates if empty
    INSERT OR IGNORE INTO milestone_templates (id, description, offset_days, default_role) VALUES
      (1, 'Venue confirmed', 112, 'logistics'),
      (2, 'Music selected / scores distributed', 84, 'librarian'),
      (3, 'Rehearsal schedule published', 70, 'logistics'),
      (4, 'Tickets available', 56, 'marketing'),
      (5, 'Marketing in full swing', 42, 'marketing'),
      (6, 'Concert program draft', 28, 'librarian'),
      (7, 'Day-of logistics finalized', 14, 'logistics'),
      (8, 'Final rehearsal', 7, NULL),
      (9, 'Event day', 0, NULL);
  `);
});

// ─── Event Queries ───────────────────────────────────────────────────────────

export interface TrackerEvent {
  id: number;
  name: string;
  date: string;
  end_date: string | null;
  channel_id: string | null;
  channel_name: string | null;
  confirmed: number;
  archived: number;
  created_at: string;
}

export function getActiveEvents(): TrackerEvent[] {
  return getDb()
    .prepare(`SELECT * FROM events WHERE archived = 0 AND date >= date('now') ORDER BY date`)
    .all() as TrackerEvent[];
}

export function getAllEvents(): TrackerEvent[] {
  return getDb()
    .prepare(`SELECT * FROM events WHERE archived = 0 ORDER BY date`)
    .all() as TrackerEvent[];
}

export function getEventById(id: number): TrackerEvent | undefined {
  return getDb()
    .prepare(`SELECT * FROM events WHERE id = ?`)
    .get(id) as TrackerEvent | undefined;
}

export function getEventByChannelId(channelId: string): TrackerEvent | undefined {
  return getDb()
    .prepare(`SELECT * FROM events WHERE channel_id = ?`)
    .get(channelId) as TrackerEvent | undefined;
}

export function createEvent(event: { name: string; date: string; end_date?: string; channel_id?: string; channel_name?: string; confirmed?: boolean }): number {
  const result = getDb()
    .prepare(`INSERT INTO events (name, date, end_date, channel_id, channel_name, confirmed) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(event.name, event.date, event.end_date ?? null, event.channel_id ?? null, event.channel_name ?? null, event.confirmed ? 1 : 0);
  return result.lastInsertRowid as number;
}

export function confirmEvent(id: number): void {
  getDb().prepare(`UPDATE events SET confirmed = 1 WHERE id = ?`).run(id);
}

export function archiveEvent(id: number): void {
  getDb().prepare(`UPDATE events SET archived = 1 WHERE id = ?`).run(id);
}

// ─── Item Queries ────────────────────────────────────────────────────────────

export interface TrackerItem {
  id: number;
  event_id: number | null;
  description: string;
  owner_id: string | null;
  owner_name: string | null;
  status: string;
  target_date: string | null;
  source: string | null;
  source_channel: string | null;
  source_date: string | null;
  last_mentioned: string | null;
  created_at: string;
}

export function getItemsForEvent(eventId: number): TrackerItem[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE event_id = ? ORDER BY target_date, created_at`)
    .all(eventId) as TrackerItem[];
}

export function getOpenItemsForEvent(eventId: number): TrackerItem[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE event_id = ? AND status = 'open' ORDER BY target_date, created_at`)
    .all(eventId) as TrackerItem[];
}

export function getStaleItems(staleDays: number = 14): TrackerItem[] {
  return getDb()
    .prepare(`
      SELECT i.* FROM items i
      JOIN events e ON i.event_id = e.id
      WHERE i.status = 'open'
        AND e.archived = 0
        AND (i.last_mentioned IS NULL OR i.last_mentioned < datetime('now', ?))
      ORDER BY i.target_date
    `)
    .all(`-${staleDays} days`) as TrackerItem[];
}

export function createItem(item: { event_id: number; description: string; owner_id?: string; owner_name?: string; target_date?: string; source: string; source_channel?: string; source_date?: string }): number {
  const result = getDb()
    .prepare(`INSERT INTO items (event_id, description, owner_id, owner_name, target_date, source, source_channel, source_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(item.event_id, item.description, item.owner_id ?? null, item.owner_name ?? null, item.target_date ?? null, item.source, item.source_channel ?? null, item.source_date ?? null);
  return result.lastInsertRowid as number;
}

export function markItemDone(id: number): void {
  getDb().prepare(`UPDATE items SET status = 'done' WHERE id = ?`).run(id);
}

export function markItemStale(id: number): void {
  getDb().prepare(`UPDATE items SET status = 'stale' WHERE id = ?`).run(id);
}

export function updateItemLastMentioned(id: number): void {
  getDb().prepare(`UPDATE items SET last_mentioned = datetime('now') WHERE id = ?`).run(id);
}

// ─── Milestone Templates ─────────────────────────────────────────────────────

export interface MilestoneTemplate {
  id: number;
  description: string;
  offset_days: number;
  default_role: string | null;
}

export function getMilestoneTemplates(): MilestoneTemplate[] {
  return getDb()
    .prepare(`SELECT * FROM milestone_templates ORDER BY offset_days DESC`)
    .all() as MilestoneTemplate[];
}

export function generateMilestonesForEvent(eventId: number, eventDate: string): void {
  const templates = getMilestoneTemplates();
  const baseDate = new Date(eventDate + 'T00:00:00');
  const insert = getDb().prepare(
    `INSERT INTO items (event_id, description, target_date, source) VALUES (?, ?, ?, 'template')`
  );

  const insertMany = getDb().transaction(() => {
    for (const tmpl of templates) {
      const target = new Date(baseDate);
      target.setDate(target.getDate() - tmpl.offset_days);
      const targetStr = target.toISOString().slice(0, 10);
      insert.run(eventId, tmpl.description, targetStr);
    }
  });

  insertMany();
}

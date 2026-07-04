import { getDb, registerMigration } from '../../db.js';

// ─── Schema ──────────────────────────────────────────────────────────────────

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT,
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

    CREATE TABLE IF NOT EXISTS item_owners (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      owner_id TEXT,
      owner_name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, owner_name)
    );
  `);
});

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_owners (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      owner_id TEXT,
      owner_name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, owner_name)
    );

    INSERT OR IGNORE INTO item_owners (item_id, owner_id, owner_name, position)
    SELECT id, owner_id, owner_name, 0
    FROM items
    WHERE owner_name IS NOT NULL AND trim(owner_name) != '';
  `);
});

// Make events.date nullable (existing DBs have NOT NULL from the original schema)
registerMigration((db) => {
  const col = db.prepare(`SELECT * FROM pragma_table_info('events') WHERE name = 'date'`).get() as { notnull: number } | undefined;
  if (!col || !col.notnull) return; // already nullable or table doesn't exist yet

  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      DROP TABLE IF EXISTS events_new;
      CREATE TABLE events_new (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        date TEXT,
        end_date TEXT,
        channel_id TEXT,
        channel_name TEXT,
        confirmed INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO events_new SELECT * FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
    `);
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
});

// Same migration, with an explicit alias for live DBs that missed the earlier
// quoted-column detection and still have events.date as NOT NULL.
registerMigration((db) => {
  const col = db.prepare(`SELECT * FROM pragma_table_info('events') WHERE name = 'date'`).get() as { notnull: number } | undefined;
  if (!col || !col.notnull) return;

  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      DROP TABLE IF EXISTS events_nullable_date;
      CREATE TABLE events_nullable_date (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        date TEXT,
        end_date TEXT,
        channel_id TEXT,
        channel_name TEXT,
        confirmed INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO events_nullable_date (id, name, date, end_date, channel_id, channel_name, confirmed, archived, created_at)
      SELECT id, name, date, end_date, channel_id, channel_name, confirmed, archived, created_at
      FROM events;
      DROP TABLE events;
      ALTER TABLE events_nullable_date RENAME TO events;
    `);
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
});

// ─── Event Queries ───────────────────────────────────────────────────────────

export interface TrackerEvent {
  id: number;
  name: string;
  date: string | null;
  end_date: string | null;
  channel_id: string | null;
  channel_name: string | null;
  confirmed: number;
  archived: number;
  created_at: string;
}

export function getActiveEvents(): TrackerEvent[] {
  return getDb()
    .prepare(`SELECT * FROM events WHERE archived = 0 AND (date IS NULL OR date >= date('now')) ORDER BY date`)
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

export function createEvent(event: { name: string; date?: string; end_date?: string; channel_id?: string; channel_name?: string; confirmed?: boolean }): number {
  const result = getDb()
    .prepare(`INSERT INTO events (name, date, end_date, channel_id, channel_name, confirmed) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(event.name, event.date ?? null, event.end_date ?? null, event.channel_id ?? null, event.channel_name ?? null, event.confirmed ? 1 : 0);
  return result.lastInsertRowid as number;
}

export function confirmEvent(id: number): void {
  getDb().prepare(`UPDATE events SET confirmed = 1 WHERE id = ?`).run(id);
}

export function archiveEvent(id: number): void {
  getDb().prepare(`UPDATE events SET archived = 1 WHERE id = ?`).run(id);
}

export function updateEvent(id: number, fields: { name?: string; date?: string | null; end_date?: string | null; channel_name?: string }): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.date !== undefined) { sets.push('date = ?'); values.push(fields.date); }
  if (fields.end_date !== undefined) { sets.push('end_date = ?'); values.push(fields.end_date); }
  if (fields.channel_name !== undefined) { sets.push('channel_name = ?'); values.push(fields.channel_name); }
  if (sets.length === 0) return;
  values.push(id);
  getDb().prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...values);
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

export interface TrackerItemOwner {
  item_id: number;
  owner_id: string | null;
  owner_name: string;
  position: number;
}

export function getOwnersForItemIds(itemIds: number[]): Map<number, TrackerItemOwner[]> {
  const owners = new Map<number, TrackerItemOwner[]>();
  if (itemIds.length === 0) return owners;

  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM item_owners WHERE item_id IN (${placeholders}) ORDER BY item_id, position, owner_name`)
    .all(...itemIds) as TrackerItemOwner[];

  for (const row of rows) {
    const list = owners.get(row.item_id) ?? [];
    list.push(row);
    owners.set(row.item_id, list);
  }

  return owners;
}

export function setItemOwners(itemId: number, owners: { owner_id?: string | null; owner_name: string }[]): void {
  const db = getDb();
  const normalized = owners
    .map((owner) => ({
      owner_id: owner.owner_id ?? null,
      owner_name: owner.owner_name.trim(),
    }))
    .filter((owner) => owner.owner_name.length > 0);

  db.prepare(`DELETE FROM item_owners WHERE item_id = ?`).run(itemId);

  const first = normalized[0];
  db.prepare(`UPDATE items SET owner_id = ?, owner_name = ? WHERE id = ?`)
    .run(first?.owner_id ?? null, normalized.map((owner) => owner.owner_name).join(', ') || null, itemId);

  const stmt = db.prepare(`INSERT OR REPLACE INTO item_owners (item_id, owner_id, owner_name, position) VALUES (?, ?, ?, ?)`);
  normalized.forEach((owner, position) => {
    stmt.run(itemId, owner.owner_id, owner.owner_name, position);
  });
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

export function createItem(item: { event_id: number | null; description: string; owner_id?: string; owner_name?: string; target_date?: string; source: string; source_channel?: string; source_date?: string }): number {
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

export function getOrphanItems(): TrackerItem[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE event_id IS NULL AND status != 'done' ORDER BY created_at`)
    .all() as TrackerItem[];
}

export function reassignItems(itemIds: number[], eventId: number | null): void {
  const db = getDb();
  const stmt = db.prepare(`UPDATE items SET event_id = ? WHERE id = ?`);
  for (const id of itemIds) stmt.run(eventId, id);
}

export function getAllOpenItems(): TrackerItem[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE status = 'open' ORDER BY event_id, created_at`)
    .all() as TrackerItem[];
}

export function updateItemDescription(id: number, description: string): void {
  getDb().prepare(`UPDATE items SET description = ? WHERE id = ?`).run(description, id);
}

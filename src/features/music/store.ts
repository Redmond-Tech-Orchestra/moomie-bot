import { getDb, registerMigration } from '../../db.js';

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
});

const MUSIC_LINK_KEY = 'music_folder_link';

export function getMusicLink(): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(MUSIC_LINK_KEY) as { value: string } | undefined;
  return row?.value;
}

export function setMusicLink(url: string): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(MUSIC_LINK_KEY, url);
}

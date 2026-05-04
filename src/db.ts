import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'moomie.db');

let db: Database.Database | null = null;

type Migration = (db: Database.Database) => void;
const migrations: Migration[] = [];

export function registerMigration(fn: Migration): void {
  migrations.push(fn);
}

export function getDb(): Database.Database {
  if (!db) {
    // Ensure the data directory exists
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    for (const migrate of migrations) {
      migrate(db);
    }
  }
  return db;
}

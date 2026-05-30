import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'moomie.db');

let db: Database.Database | null = null;

type Migration = (db: Database.Database) => void;
const migrations: Migration[] = [];
// How many migrations have already been applied to the open connection. Modules
// register their migrations at import time, but the FIRST getDb() call can fire
// during module evaluation (e.g. the logger persisting to the `logs` table)
// before every feature module has been evaluated. Tracking the applied count
// lets a later getDb() pick up migrations registered after the connection was
// opened, instead of silently skipping them. Migrations are idempotent
// (CREATE ... IF NOT EXISTS), so re-checking on each call is safe and cheap.
let appliedMigrations = 0;

export function registerMigration(fn: Migration): void {
  migrations.push(fn);
}

export function getDb(): Database.Database {
  if (!db) {
    // Ensure the data directory exists
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  // Apply any migrations registered since the last call (handles modules whose
  // migration registered after the connection was first opened).
  while (appliedMigrations < migrations.length) {
    migrations[appliedMigrations++](db);
  }
  return db;
}

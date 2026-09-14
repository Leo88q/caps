import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const db = new Database(path.join(__dirname, '..', 'events.sqlite'));

db.pragma('journal_mode = WAL');

// One row per decoded on-chain event. `signature` + `event_index` gives a
// stable dedup key: backfill and the live listener both insert with
// INSERT OR IGNORE against this, so running backfill after the listener
// has already caught something is safe and just no-ops on overlap.
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    signature TEXT NOT NULL,
    event_index INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    block_time INTEGER,
    event_name TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (signature, event_index)
  );

  CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
  CREATE INDEX IF NOT EXISTS idx_events_block_time ON events(block_time);

  -- Tracks the last signature we've backfilled up to, so re-running
  -- backfill doesn't rescan the whole transaction history every time.
  CREATE TABLE IF NOT EXISTS backfill_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_signature TEXT
  );
`);

export interface StoredEvent {
  signature: string;
  event_index: number;
  slot: number;
  block_time: number | null;
  event_name: string;
  data: string; // JSON
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO events (signature, event_index, slot, block_time, event_name, data)
  VALUES (@signature, @event_index, @slot, @block_time, @event_name, @data)
`);

export function insertEvent(e: StoredEvent) {
  insertStmt.run(e);
}

export function getBackfillCursor(): string | null {
  const row = db.prepare('SELECT last_signature FROM backfill_cursor WHERE id = 1').get() as
    | { last_signature: string | null }
    | undefined;
  return row?.last_signature ?? null;
}

export function setBackfillCursor(signature: string) {
  db.prepare(
    'INSERT INTO backfill_cursor (id, last_signature) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_signature = excluded.last_signature',
  ).run(signature);
}

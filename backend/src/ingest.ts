// Shared ingestion path: transaction logs → events_raw → projections.
// backfill.ts, listen.ts and rebuild.ts all funnel through `ingestTx`, so
// there is exactly one place that decides what "indexed" means.
import { Connection, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import { COMMITMENT, PROGRAMS, RPC_URL, RPC_WS_URL, type ProgramName } from './config.ts';
import { db as sharedDb, type Db, now } from './db.ts';
import { decodeLogs, type RawEvent } from './events.ts';
import { applyEvent } from './projections.ts';

export interface TxLike {
  signature: string;
  slot: number;
  blockTime: number | null;
  logs: readonly string[];
  /** failed transactions emit nothing we trust */
  err: unknown;
}

export interface IngestResult { events: number; inserted: number; }

let connection: Connection | undefined;
export function getConnection(): Connection {
  if (!connection) connection = new Connection(RPC_URL, { commitment: COMMITMENT, wsEndpoint: RPC_WS_URL });
  return connection;
}

export function txFromResponse(signature: string, tx: VersionedTransactionResponse | null): TxLike | undefined {
  if (!tx?.meta?.logMessages) return undefined;
  return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, logs: tx.meta.logMessages, err: tx.meta.err };
}

/**
 * Decode + persist one transaction. Returns how many of its events were new.
 * Runs in a single SQLite transaction so events_raw and projections can never
 * disagree about whether an event was applied.
 */
export function ingestTx(t: TxLike, db: Db = sharedDb()): IngestResult {
  if (t.err) return { events: 0, inserted: 0 };
  const events = decodeLogs(t.logs);
  if (events.length === 0) return { events: 0, inserted: 0 };
  return db.tx(() => {
    let inserted = 0;
    for (const e of events) {
      const res = db.run(
        `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, block_time, processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(signature, ix_index, event_index) DO NOTHING`,
        t.signature, e.ixIndex, e.eventIndex, e.program, e.name, JSON.stringify(e.data), t.slot, t.blockTime,
      );
      if (res.changes === 0) {
        // Seen before (e.g. via websocket without blockTime) — backfill may now know the block time.
        if (t.blockTime !== null) db.run(`UPDATE events_raw SET block_time = ? WHERE signature = ? AND ix_index = ? AND event_index = ? AND block_time IS NULL`, t.blockTime, t.signature, e.ixIndex, e.eventIndex);
        continue;
      }
      inserted++;
      applyEvent(db, e, { signature: t.signature, slot: t.slot, blockTime: t.blockTime });
    }
    return { events: events.length, inserted };
  });
}

/** Replay already-stored raw events into the projection tables (used by rebuild). */
export function replayStored(db: Db = sharedDb(), onProgress?: (n: number) => void): number {
  const rows = db.all<{ signature: string; ix_index: number; event_index: number; program: ProgramName; name: string; data: string; slot: number; block_time: number | null }>(
    `SELECT signature, ix_index, event_index, program, name, data, slot, block_time FROM events_raw ORDER BY slot ASC, id ASC`,
  );
  let n = 0;
  db.tx(() => {
    for (const r of rows) {
      const e: RawEvent = { program: r.program, programId: PROGRAMS[r.program].toBase58(), name: r.name, data: JSON.parse(r.data), ixIndex: r.ix_index, eventIndex: r.event_index };
      applyEvent(db, e, { signature: r.signature, slot: r.slot, blockTime: r.block_time });
      if (++n % 1000 === 0) onProgress?.(n);
    }
    db.run(`UPDATE events_raw SET processed = 1`);
  });
  return n;
}

// ---------------------------------------------------------------- cursors
export interface Cursor { newest_signature: string | null; newest_slot: number | null; history_complete: number }
export function getCursor(program: ProgramName, db: Db = sharedDb()): Cursor | undefined {
  return db.get<Cursor>(`SELECT newest_signature, newest_slot, history_complete FROM indexer_cursor WHERE program = ?`, program);
}
export function setCursor(program: ProgramName, c: Partial<Cursor>, db: Db = sharedDb()) {
  const cur = getCursor(program, db);
  db.run(
    `INSERT INTO indexer_cursor (program, newest_signature, newest_slot, history_complete, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(program) DO UPDATE SET newest_signature = excluded.newest_signature, newest_slot = excluded.newest_slot, history_complete = excluded.history_complete, updated_at = excluded.updated_at`,
    program, c.newest_signature ?? cur?.newest_signature ?? null, c.newest_slot ?? cur?.newest_slot ?? null, c.history_complete ?? cur?.history_complete ?? 0, now(),
  );
}

// ---------------------------------------------------------------- fetching with bounded concurrency
export async function fetchTx(connection: Connection, signature: string, retries = 5): Promise<TxLike | undefined> {
  let delay = 400;
  for (let i = 0; ; i++) {
    try {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: COMMITMENT });
      return txFromResponse(signature, tx);
    } catch (e) {
      if (i >= retries) throw e;
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 8_000);
    }
  }
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch + ingest a page of signatures (oldest first so projections see events in order). */
export async function ingestSignatures(connection: Connection, sigs: readonly ConfirmedSignatureInfo[], concurrency: number, db: Db = sharedDb()): Promise<IngestResult> {
  const ok = sigs.filter((s) => !s.err);
  const txs = await mapLimit(ok, concurrency, (s) => fetchTx(connection, s.signature));
  let events = 0, inserted = 0;
  for (let i = txs.length - 1; i >= 0; i--) {
    const t = txs[i];
    if (!t) continue;
    const r = ingestTx(t, db);
    events += r.events; inserted += r.inserted;
  }
  return { events, inserted };
}

export const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

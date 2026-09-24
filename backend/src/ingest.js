"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = void 0;
exports.getConnection = getConnection;
exports.txFromResponse = txFromResponse;
exports.ingestTx = ingestTx;
exports.replayStored = replayStored;
exports.getCursor = getCursor;
exports.setCursor = setCursor;
exports.fetchTx = fetchTx;
exports.mapLimit = mapLimit;
exports.ingestSignatures = ingestSignatures;
// Shared ingestion path: transaction logs → events_raw → projections.
// backfill.ts, listen.ts and rebuild.ts all funnel through `ingestTx`, so
// there is exactly one place that decides what "indexed" means.
const web3_js_1 = require("@solana/web3.js");
const config_ts_1 = require("./config.ts");
const db_ts_1 = require("./db.ts");
const events_ts_1 = require("./events.ts");
const wire_ts_1 = require("./wire.ts");
const bus_ts_1 = require("./bus.ts");
const log_ts_1 = require("./log.ts");
const sql_ts_1 = require("./sql.ts");
const projections_ts_1 = require("./projections.ts");
const t2ctx = (t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime });
let connection;
function getConnection() {
    if (!connection)
        connection = new web3_js_1.Connection(config_ts_1.RPC_URL, { commitment: config_ts_1.COMMITMENT, wsEndpoint: config_ts_1.RPC_WS_URL });
    return connection;
}
function txFromResponse(signature, tx) {
    if (!tx?.meta?.logMessages)
        return undefined;
    return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, logs: tx.meta.logMessages, err: tx.meta.err };
}
/**
 * Decode + persist one transaction. Returns how many of its events were new.
 * Runs in a single SQLite transaction so events_raw and projections can never
 * disagree about whether an event was applied.
 */
function ingestTx(t, db = (0, db_ts_1.db)()) {
    if (t.err)
        return { events: 0, inserted: 0 };
    const events = (0, events_ts_1.decodeLogs)(t.logs);
    if (events.length === 0)
        return { events: 0, inserted: 0 };
    const out = [];
    const result = db.tx(() => {
        let inserted = 0;
        for (const e of events) {
            // The dedup key is the whole point of this insert: an event is identified by (signature, ix_index,
            // event_index), so a live frame and a backfill page can race without either double-applying.
            const res = db.run((0, sql_ts_1.insertIfAbsent)('events_raw', ['signature', 'ix_index', 'event_index', 'program', 'name', 'data', 'slot', 'block_time', 'processed'], ['signature', 'ix_index', 'event_index']), t.signature, e.ixIndex, e.eventIndex, e.program, e.name, JSON.stringify(e.data), t.slot, t.blockTime, 1);
            if (res.changes === 0) {
                // Seen before (e.g. via websocket without blockTime) — backfill may now know the block time.
                if (t.blockTime !== null) {
                    const healed = db.run(`UPDATE events_raw SET block_time = ? WHERE signature = ? AND ix_index = ? AND event_index = ? AND block_time IS NULL`, t.blockTime, t.signature, e.ixIndex, e.eventIndex);
                    // The projection rows written from that earlier, untimed application are still NULL (or 0 for
                    // `chips.burned_at`, which must stay "dead but undated"). Without this they would be permanently
                    // missing from every day-bucketed read while a rebuild would show them — two answers, one chain.
                    if (healed.changes > 0)
                        (0, projections_ts_1.patchLateTimes)(db, e, t2ctx(t));
                }
                continue;
            }
            inserted++;
            (0, projections_ts_1.applyEvent)(db, e, { signature: t.signature, slot: t.slot, blockTime: t.blockTime });
            // Only *newly inserted* events are queued for fan-out: a replayed or healed transaction must not
            // re-notify anyone, and a rebuild (which replays everything) must stay silent.
            try {
                const m = (0, wire_ts_1.wireEvent)(db, e, { slot: t.slot });
                if (m)
                    out.push(m);
            }
            catch (wireErr) {
                log_ts_1.log.warn('event fan-out encoding failed', { event: e.name, err: wireErr?.message });
            }
        }
        return { events: events.length, inserted };
    });
    // Published after the transaction commits. A frame sent before commit would tell the client to
    // refetch a projection it cannot read yet — the socket is an invalidation hint, so the hint has to
    // arrive when the hint is true (docs/09 §4.1).
    for (const m of out)
        (0, bus_ts_1.publish)(m);
    return result;
}
/** Replay already-stored raw events into the projection tables (used by rebuild). */
function replayStored(db = (0, db_ts_1.db)(), onProgress) {
    const rows = db.all(`SELECT signature, ix_index, event_index, program, name, data, slot, block_time FROM events_raw ORDER BY slot ASC, id ASC`);
    let n = 0;
    db.tx(() => {
        for (const r of rows) {
            const e = { program: r.program, programId: config_ts_1.PROGRAMS[r.program].toBase58(), name: r.name, data: JSON.parse(r.data), ixIndex: r.ix_index, eventIndex: r.event_index };
            (0, projections_ts_1.applyEvent)(db, e, { signature: r.signature, slot: r.slot, blockTime: r.block_time });
            if (++n % 1000 === 0)
                onProgress?.(n);
        }
        db.run(`UPDATE events_raw SET processed = 1`);
    });
    return n;
}
function getCursor(program, db = (0, db_ts_1.db)()) {
    return db.get(`SELECT newest_signature, newest_slot, history_complete FROM indexer_cursor WHERE program = ?`, program);
}
function setCursor(program, c, db = (0, db_ts_1.db)()) {
    const cur = getCursor(program, db);
    db.run(`INSERT INTO indexer_cursor (program, newest_signature, newest_slot, history_complete, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(program) DO UPDATE SET newest_signature = excluded.newest_signature, newest_slot = excluded.newest_slot, history_complete = excluded.history_complete, updated_at = excluded.updated_at`, program, c.newest_signature ?? cur?.newest_signature ?? null, c.newest_slot ?? cur?.newest_slot ?? null, c.history_complete ?? cur?.history_complete ?? 0, (0, db_ts_1.now)());
}
// ---------------------------------------------------------------- fetching with bounded concurrency
async function fetchTx(connection, signature, retries = 5) {
    let delay = 400;
    for (let i = 0;; i++) {
        try {
            const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: config_ts_1.COMMITMENT });
            return txFromResponse(signature, tx);
        }
        catch (e) {
            if (i >= retries)
                throw e;
            await (0, exports.sleep)(delay + Math.random() * delay);
            delay = Math.min(delay * 2, 8_000);
        }
    }
}
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length)
                return;
            out[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return out;
}
/** Fetch + ingest a page of signatures (oldest first so projections see events in order). */
async function ingestSignatures(connection, sigs, concurrency, db = (0, db_ts_1.db)()) {
    const ok = sigs.filter((s) => !s.err);
    const txs = await mapLimit(ok, concurrency, (s) => fetchTx(connection, s.signature));
    let events = 0, inserted = 0;
    for (let i = txs.length - 1; i >= 0; i--) {
        const t = txs[i];
        if (!t)
            continue;
        const r = ingestTx(t, db);
        events += r.events;
        inserted += r.inserted;
    }
    return { events, inserted };
}
const sleep = (ms) => new Promise((f) => setTimeout(f, ms));
exports.sleep = sleep;

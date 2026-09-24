"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FinalityError = exports.FINALITY_ASSUME = exports.FINALITY_DROP_AFTER_SLOTS = exports.FINALITY_BATCH = exports.FINALITY_MIN_SLOTS = exports.FINALITY_EVERY_MS = void 0;
exports.ensureFinalityColumn = ensureFinalityColumn;
exports.isFinalized = isFinalized;
exports.requireFinalized = requireFinalized;
exports.finalizedHorizon = finalizedHorizon;
exports.markFinalized = markFinalized;
exports.dropSignatures = dropSignatures;
exports.reconcileOnce = reconcileOnce;
exports.finalityStatus = finalityStatus;
exports.finality = finality;
const db_ts_1 = require("./db.ts");
const ingest_ts_1 = require("./ingest.ts");
const env = process.env;
exports.FINALITY_EVERY_MS = Number(env.FINALITY_EVERY_MS ?? 20_000);
/** Only ask about events at least this many slots behind the tip (finalization takes ≈ 32 slots; 150 leaves margin for RPC lag). */
exports.FINALITY_MIN_SLOTS = Number(env.FINALITY_MIN_SLOTS ?? 150);
/** getSignatureStatuses accepts ≤ 256 signatures per call. */
exports.FINALITY_BATCH = 256;
/** Give up waiting: an unfinalized signature older than this many slots that the cluster no longer knows is treated as dropped. */
exports.FINALITY_DROP_AFTER_SLOTS = Number(env.FINALITY_DROP_AFTER_SLOTS ?? 1_000);
exports.FINALITY_ASSUME = env.FINALITY_ASSUME === '1';
class FinalityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
exports.FinalityError = FinalityError;
/** Idempotent schema add-on (dev SQLite files created by older builds). */
function ensureFinalityColumn(db) {
    const cols = new Set(db.raw.prepare(`PRAGMA table_info(events_raw)`).all().map((c) => c.name));
    if (!cols.has('finalized_at'))
        db.raw.exec(`ALTER TABLE events_raw ADD COLUMN finalized_at INTEGER`);
    db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_events_unfinalized ON events_raw(finalized_at, slot)`);
}
function isFinalized(db, signature) {
    if (exports.FINALITY_ASSUME)
        return true;
    const r = db.get(`SELECT COUNT(*) AS n FROM events_raw WHERE signature = ? AND finalized_at IS NOT NULL`, signature);
    return (r?.n ?? 0) > 0;
}
/** Throws 409 `payment_pending` while a signature is only confirmed. Unknown signatures are not this function's business (callers 402 first). */
function requireFinalized(db, signature) {
    if (isFinalized(db, signature))
        return;
    throw new FinalityError('payment_pending', 'Transaction is confirmed but not yet finalized — retry in ~30 s');
}
/**
 * Finalized horizon (backlog #9): the highest slot at or below which EVERY indexed event is finalized —
 * the slot just before the oldest unfinalized event, or the newest finalized slot when nothing is
 * pending. Settlement code that turns projections into value (quest completions, season payouts —
 * backend/src/quests.ts, arena.ts, reward-oracle.ts) only counts rows with `slot <= horizon`; anything
 * newer simply waits for the next reconciler pass. A stuck RPC freezes the horizon, which is the
 * fail-safe direction (nothing is paid for events we cannot prove final; /health.finality turns
 * unhealthy). FINALITY_ASSUME=1 (dev) → MAX_SAFE_INTEGER; an empty log → 0 (nothing counts).
 */
function finalizedHorizon(db) {
    if (exports.FINALITY_ASSUME)
        return Number.MAX_SAFE_INTEGER;
    const pending = db.get(`SELECT MIN(slot) s FROM events_raw WHERE finalized_at IS NULL`)?.s;
    if (pending !== null && pending !== undefined)
        return pending - 1;
    return db.get(`SELECT MAX(slot) s FROM events_raw WHERE finalized_at IS NOT NULL`)?.s ?? 0;
}
/** Stamp signatures as finalized (used by the reconciler and by tests / localnet where everything is final at once). */
function markFinalized(db, signatures, at = (0, db_ts_1.now)()) {
    let n = 0;
    db.tx(() => { for (const s of signatures)
        n += Number(db.run(`UPDATE events_raw SET finalized_at = ? WHERE signature = ? AND finalized_at IS NULL`, at, s).changes); });
    return n;
}
/** Remove a dropped transaction's raw events and rebuild every projection from the remaining log. */
function dropSignatures(db, signatures) {
    if (signatures.length === 0)
        return [];
    const reports = [];
    db.tx(() => {
        for (const s of signatures) {
            const consumed = db.all(`SELECT consumed_by FROM service_payments WHERE signature = ? AND consumed_by IS NOT NULL`, s).map((r) => r.consumed_by);
            const events = Number(db.run(`DELETE FROM events_raw WHERE signature = ?`, s).changes);
            reports.push({ signature: s, events, consumedPayments: consumed });
        }
        for (const t of db_ts_1.PROJECTION_TABLES)
            db.run(`DELETE FROM ${t}`);
    });
    (0, ingest_ts_1.replayStored)(db);
    return reports;
}
/** One reconciliation pass. Pure w.r.t. the connection: tests pass a fake status source. */
async function reconcileOnce(connection, db = (0, db_ts_1.db)(), log = () => { }, opts = {}) {
    ensureFinalityColumn(db);
    const minSlots = opts.minSlots ?? exports.FINALITY_MIN_SLOTS;
    const dropAfter = opts.dropAfterSlots ?? exports.FINALITY_DROP_AFTER_SLOTS;
    const tip = await connection.getSlot('confirmed');
    const rows = db.all(`SELECT signature, MIN(slot) AS slot FROM events_raw WHERE finalized_at IS NULL AND slot <= ? GROUP BY signature ORDER BY slot ASC LIMIT ?`, tip - minSlots, exports.FINALITY_BATCH);
    const out = { checked: rows.length, finalized: 0, pending: 0, dropped: [] };
    if (rows.length === 0)
        return out;
    const { value } = await connection.getSignatureStatuses(rows.map((r) => r.signature), { searchTransactionHistory: true });
    const done = [], gone = [];
    rows.forEach((r, i) => {
        const st = value[i];
        if (st && !st.err && st.confirmationStatus === 'finalized')
            done.push(r.signature);
        else if ((st === null || st === undefined || st.err) && tip - r.slot >= dropAfter)
            gone.push(r.signature);
        else if (st && st.err)
            gone.push(r.signature); // a failed tx can never have emitted events we trust
        else
            out.pending++;
    });
    out.finalized = markFinalized(db, done);
    if (gone.length) {
        out.dropped = dropSignatures(db, gone);
        for (const d of out.dropped) {
            log(`[finality] ${d.consumedPayments.length ? 'ALERT ' : ''}dropped tx ${d.signature} (${d.events} events removed, projections rebuilt)${d.consumedPayments.length ? ` — payments already consumed: ${d.consumedPayments.join(', ')} — manual review` : ''}`);
        }
    }
    return out;
}
/** /health.finality — how far behind finalization the log is. */
function finalityStatus(db, nowS = (0, db_ts_1.now)()) {
    ensureFinalityColumn(db);
    const pending = db.get(`SELECT COUNT(DISTINCT signature) AS n, MIN(block_time) AS oldest FROM events_raw WHERE finalized_at IS NULL`);
    const last = db.get(`SELECT MAX(finalized_at) AS t FROM events_raw`)?.t ?? null;
    const oldestAgeS = pending.oldest === null ? null : nowS - pending.oldest;
    return {
        assume: exports.FINALITY_ASSUME,
        pendingSignatures: pending.n,
        oldestPendingAgeS: oldestAgeS,
        lastFinalizedAt: last === null ? null : new Date(last * 1000).toISOString(),
        // healthy: nothing has been waiting longer than ~10 minutes (finalization itself takes ~1 min)
        healthy: exports.FINALITY_ASSUME || oldestAgeS === null || oldestAgeS < 600,
    };
}
async function finality(log = console.log) {
    const connection = (0, ingest_ts_1.getConnection)();
    const db = (0, db_ts_1.db)();
    log(`[finality] every ${exports.FINALITY_EVERY_MS / 1000} s · min age ${exports.FINALITY_MIN_SLOTS} slots · drop after ${exports.FINALITY_DROP_AFTER_SLOTS} slots${exports.FINALITY_ASSUME ? ' · FINALITY_ASSUME=1 (dev only)' : ''}`);
    while (true) {
        try {
            const r = await reconcileOnce(connection, db, log);
            if (r.checked)
                log(`[finality] checked ${r.checked}: finalized ${r.finalized}, pending ${r.pending}, dropped ${r.dropped.length}`);
        }
        catch (e) {
            log(`[finality] pass failed: ${e.message}`);
        }
        await (0, ingest_ts_1.sleep)(exports.FINALITY_EVERY_MS);
    }
}
if (import.meta.url === `file://${process.argv[1]}`) {
    finality().catch((err) => {
        console.error('finality crashed:', err);
        process.exit(1);
    });
}

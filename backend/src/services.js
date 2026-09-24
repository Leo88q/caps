"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceError = exports.handleRefHash = exports.toHex = exports.enc = void 0;
exports.canonicalJson = canonicalJson;
exports.serviceRefHash = serviceRefHash;
exports.quoteUsdCents = quoteUsdCents;
exports.prices = prices;
exports.catalogue = catalogue;
exports.findPayment = findPayment;
exports.checkHandle = checkHandle;
exports.claimHandle = claimHandle;
exports.rowToEntitlement = rowToEntitlement;
exports.expiryFor = expiryFor;
exports.districtCompleted = districtCompleted;
exports.claimService = claimService;
exports.myServices = myServices;
// Paid services: bind an on-chain `ServicePaid` event to an off-chain
// entitlement (handle, skin, theme, season pass, …). The chain proves the
// payment; we prove the payload by recomputing ref_hash. Every payment can be
// consumed exactly once.
//
//   ref_hash = keccak256(0x00 ‖ kind:u8 ‖ wallet:32 ‖ payloadBytes)
//   handle payload  = lowercase(handle) utf-8
//   other payloads  = canonical JSON (sorted keys, no whitespace)
const sha3_1 = require("@noble/hashes/sha3");
const web3_js_1 = require("@solana/web3.js");
const economy_1 = require("@guttercaps/economy");
const config_ts_1 = require("./config.ts");
const db_ts_1 = require("./db.ts");
const finality_ts_1 = require("./finality.ts");
const sql_ts_1 = require("./sql.ts");
exports.enc = new TextEncoder();
function canonicalJson(v) {
    if (v === null || typeof v !== 'object')
        return JSON.stringify(v);
    if (Array.isArray(v))
        return `[${v.map(canonicalJson).join(',')}]`;
    const o = v;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
function serviceRefHash(kind, wallet, payload) {
    const body = typeof payload === 'string' ? payload : canonicalJson(payload);
    const bytes = exports.enc.encode(body);
    const w = typeof wallet === 'string' ? new web3_js_1.PublicKey(wallet) : wallet;
    const buf = new Uint8Array(34 + bytes.length);
    buf[0] = 0x00;
    buf[1] = kind;
    buf.set(w.toBytes(), 2);
    buf.set(bytes, 34);
    return (0, sha3_1.keccak_256)(buf);
}
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
exports.toHex = toHex;
const handleRefHash = (kind, wallet, handle) => serviceRefHash(kind, wallet, handle.trim().toLowerCase());
exports.handleRefHash = handleRefHash;
class ServiceError extends Error {
    status;
    code;
    details;
    /** `details` (optional) is serialised next to code/message — e.g. admin guard-rail violations. */
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
exports.ServiceError = ServiceError;
function quoteUsdCents(cents, solUsd, skrUsd) {
    const usd = cents / 100;
    return {
        SOL: String(Math.ceil((usd / solUsd) * 1e9 * 1.01)), // +1 % slippage guard, like the client
        USDC: String(cents * 10_000),
        CG: String(cents * 1_000_000), // 1 ¢ ≙ 1 $CG (burned)
        SKR: String(Math.ceil((usd / skrUsd) * 1e6 * 1.01)),
    };
}
/**
 * USD display prices: the pyth-cache worker writes `oracle_prices` from OUR Pyth accounts every
 * 10 s (owner decision Q7); the env fallbacks only cover a fresh dev database. Never use these
 * for on-chain amounts — /packs/quote and the client re-price from the PriceUpdateV2 account.
 */
function prices(db) {
    const sol = db.get(`SELECT usd FROM oracle_prices WHERE symbol = 'SOL'`)?.usd;
    const skr = db.get(`SELECT usd FROM oracle_prices WHERE symbol = 'SKR'`)?.usd;
    return { solUsd: sol ?? config_ts_1.SOL_USD_FALLBACK, skrUsd: skr ?? config_ts_1.SKR_USD_FALLBACK, source: sol !== undefined && skr !== undefined ? 'pyth' : 'fallback' };
}
function catalogue(db) {
    const { solUsd, skrUsd, source } = prices(db);
    return {
        services: economy_1.SERVICES.map((s) => ({ id: s.id, kind: s.kind, name: s.name, priceUsdCents: s.priceUsdCents, dailyCap: s.dailyCap, recurring: s.recurring, quotes: quoteUsdCents(s.priceUsdCents, solUsd, skrUsd) })),
        solUsd, skrUsd, priceSource: source,
    };
}
/** Find an unconsumed ServicePaid for (signature, buyer, kind). */
function findPayment(db, signature, buyer, kinds) {
    const rows = db.all(`SELECT * FROM service_payments WHERE signature = ? AND buyer = ?`, signature, buyer);
    if (rows.length === 0)
        throw new ServiceError(402, 'payment_not_found', 'No ServicePaid event from this wallet in that transaction (indexer may still be catching up — retry in a few seconds)');
    const match = rows.find((r) => kinds.includes(r.kind) && !r.consumed_by) ?? rows.find((r) => kinds.includes(r.kind));
    if (!match)
        throw new ServiceError(402, 'payment_kind_mismatch', `Transaction paid for kind ${rows[0].kind}, expected ${kinds.join('/')}`);
    if (match.consumed_by)
        throw new ServiceError(402, 'payment_consumed', 'This payment was already used');
    // SEC-M5: an entitlement is value leaving the treasury — only a finalized payment can buy it
    try {
        (0, finality_ts_1.requireFinalized)(db, signature);
    }
    catch (e) {
        if (e instanceof finality_ts_1.FinalityError)
            throw new ServiceError(409, e.code, e.message);
        throw e;
    }
    return match;
}
function consume(db, p, by) {
    db.run(`UPDATE service_payments SET consumed_by = ?, consumed_at = ? WHERE signature = ? AND event_index = ?`, by, (0, db_ts_1.now)(), p.signature, p.event_index);
}
function checkHandle(db, wallet, raw) {
    const handle = raw.trim();
    const me = db.get(`SELECT handle, handle_set_at FROM wallets WHERE address = ?`, wallet);
    const kind = me?.handle ? 1 : 0;
    const price = economy_1.SERVICE_BY_KIND[kind].priceUsdCents;
    const refHash = (0, exports.toHex)((0, exports.handleRefHash)(kind, wallet, handle));
    const base = { kind, refHash, priceUsdCents: price };
    if (!config_ts_1.HANDLE_RE.test(handle))
        return { available: false, reason: 'invalid', ...base };
    const lower = handle.toLowerCase();
    if (config_ts_1.HANDLE_BLOCKLIST.has(lower))
        return { available: false, reason: 'blocked', ...base };
    if (kind === 1 && me?.handle_set_at && (0, db_ts_1.now)() - me.handle_set_at < config_ts_1.HANDLE_CHANGE_COOLDOWN_S)
        return { available: false, reason: 'cooldown', ...base };
    const owner = db.get(`SELECT address FROM wallets WHERE ${(0, sql_ts_1.foldEq)('handle', '?')}`, lower);
    if (owner && owner.address !== wallet)
        return { available: false, reason: 'taken', ...base };
    const quarantined = db.get(`SELECT 1 FROM handle_history WHERE ${(0, sql_ts_1.foldEq)('handle', '?')} AND wallet != ? AND released_at > ?`, lower, wallet, (0, db_ts_1.now)() - config_ts_1.HANDLE_QUARANTINE_S);
    if (quarantined)
        return { available: false, reason: 'taken', ...base };
    const t = (0, db_ts_1.now)();
    db.run(`DELETE FROM handle_reservations WHERE expires_at < ?`, t);
    const res = db.get(`SELECT wallet, expires_at FROM handle_reservations WHERE ${(0, sql_ts_1.foldEq)('handle', '?')}`, lower);
    if (res && res.wallet !== wallet)
        return { available: false, reason: 'reserved', ...base };
    const reservedUntil = t + Math.floor(config_ts_1.HANDLE_RESERVE_MS / 1000);
    db.run(`INSERT INTO handle_reservations (handle, wallet, expires_at) VALUES (?, ?, ?) ON CONFLICT(handle) DO UPDATE SET wallet = excluded.wallet, expires_at = excluded.expires_at`, lower, wallet, reservedUntil);
    return { available: true, ...base, reservedUntil: new Date(reservedUntil * 1000).toISOString() };
}
/** PUT /me/handle — validates the on-chain payment and assigns the handle atomically. */
function claimHandle(db, wallet, raw, signature) {
    const handle = raw.trim();
    if (!config_ts_1.HANDLE_RE.test(handle))
        throw new ServiceError(400, 'invalid_handle', 'Handle must be 3–16 chars [a-zA-Z0-9_]');
    const lower = handle.toLowerCase();
    return db.tx(() => {
        const me = db.get(`SELECT handle, handle_set_at FROM wallets WHERE address = ?`, wallet);
        const kind = me?.handle ? 1 : 0;
        if (me?.handle && me.handle.toLowerCase() === lower)
            throw new ServiceError(409, 'same_handle', 'That is already your handle');
        const check = checkHandle(db, wallet, handle);
        if (!check.available)
            throw new ServiceError(409, `handle_${check.reason}`, `Handle unavailable (${check.reason})`);
        // strict: first handle must be paid as kind 0 ($1.99), a change as kind 1 ($0.99)
        const p = findPayment(db, signature, wallet, [kind]);
        const expected = (0, exports.toHex)((0, exports.handleRefHash)(kind, wallet, handle));
        if (p.ref_hash !== expected)
            throw new ServiceError(402, 'ref_hash_mismatch', 'Payment was committed for a different handle');
        if (kind === 1 && me?.handle_set_at && (0, db_ts_1.now)() - me.handle_set_at < config_ts_1.HANDLE_CHANGE_COOLDOWN_S)
            throw new ServiceError(409, 'handle_cooldown', 'Handle can change once per 30 days');
        if (me?.handle)
            db.run(`INSERT INTO handle_history (handle, wallet, released_at) VALUES (?, ?, ?)`, me.handle, wallet, (0, db_ts_1.now)());
        db.run(`INSERT INTO wallets (address, handle, handle_set_at, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET handle = excluded.handle, handle_set_at = excluded.handle_set_at`, wallet, handle, (0, db_ts_1.now)(), (0, db_ts_1.now)());
        db.run(`DELETE FROM handle_reservations WHERE ${(0, sql_ts_1.foldEq)('handle', '?')}`, lower);
        consume(db, p, `handle:${lower}`);
        db.run(`INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, wallet, p.kind, canonicalJson({ handle }), signature, p.currency, p.amount, (0, db_ts_1.now)());
        return { address: wallet, handle };
    });
}
const CUR = ['SOL', 'USDC', 'CG', 'SKR'];
const iso = (s) => (s === null ? null : new Date(s * 1000).toISOString());
function rowToEntitlement(r) {
    return { id: String(r.id), kind: r.kind, payload: JSON.parse(r.payload), signature: r.signature, currency: CUR[r.currency] ?? String(r.currency), amount: r.amount, grantedAt: iso(r.granted_at), expiresAt: iso(r.expires_at) };
}
/** Season pass = 6 weeks from grant; everything else is permanent. */
function expiryFor(s, grantedAt) {
    return s.id === 'seasonPass' ? grantedAt + 42 * 86_400 : null;
}
/** True when the wallet holds all 9 rarities of the district (unburned) — the banner requirement. */
function districtCompleted(db, wallet, collection) {
    return db.scalar(`SELECT COUNT(DISTINCT rarity) FROM chips WHERE owner = ? AND collection_idx = ? AND burned_at IS NULL`, wallet, collection) >= 9;
}
const PAYLOAD_RULES = {
    capSkin: (p) => (typeof p.asset === 'string' && typeof p.skin === 'string' && economy_1.SKIN_BY_ID[p.skin] ? undefined : 'payload needs {asset, skin} with a known skin id'),
    profileTheme: (p) => (typeof p.theme === 'string' && economy_1.PROFILE_THEME_BY_ID[p.theme] ? undefined : 'payload needs {theme} with a known theme id'),
    arenaEmotePack: (p) => (typeof p.pack === 'string' && economy_1.EMOTE_PACK_BY_ID[p.pack] ? undefined : 'payload needs {pack} with a known pack id'),
    districtBanner: (p) => (typeof p.collection === 'number' && Number.isInteger(p.collection) && p.collection >= 0 && p.collection < economy_1.COLLECTIONS.length ? undefined : 'payload needs {collection} with a live district index'),
};
/** POST /services/claim */
function claimService(db, wallet, signature, kind, payload) {
    const s = economy_1.SERVICE_BY_KIND[kind];
    if (!s)
        throw new ServiceError(400, 'unknown_kind', `Unknown service kind ${kind}`);
    if (kind === 0 || kind === 1)
        throw new ServiceError(400, 'use_handle_endpoint', 'Handles are claimed via PUT /me/handle');
    if (s.fulfilment === 'chain')
        throw new ServiceError(400, 'chain_fulfilled', `${s.name} is fulfilled on-chain; nothing to claim`);
    const problem = PAYLOAD_RULES[s.id]?.(payload);
    if (problem)
        throw new ServiceError(400, 'bad_payload', problem);
    return db.tx(() => {
        const p = findPayment(db, signature, wallet, [kind]);
        const expected = (0, exports.toHex)(serviceRefHash(kind, wallet, payload));
        if (p.ref_hash !== expected)
            throw new ServiceError(402, 'ref_hash_mismatch', 'Payment was committed for a different payload');
        if (s.id === 'capSkin') {
            const chip = db.get(`SELECT owner FROM chips WHERE asset = ? AND burned_at IS NULL`, String(payload.asset));
            if (!chip || chip.owner !== wallet)
                throw new ServiceError(409, 'not_owner', 'You do not own that cap');
        }
        if (s.id === 'districtBanner' && !districtCompleted(db, wallet, Number(payload.collection))) {
            throw new ServiceError(409, 'set_not_completed', 'Finish the district set first');
        }
        const granted = (0, db_ts_1.now)();
        const res = db.run(`INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, wallet, kind, canonicalJson(payload), signature, p.currency, p.amount, granted, expiryFor(s, granted));
        const id = Number(res.lastInsertRowid);
        if (s.id === 'capSkin')
            db.run(`UPDATE chips SET skin = ? WHERE asset = ?`, String(payload.skin), String(payload.asset));
        consume(db, p, `entitlement:${id}`);
        return rowToEntitlement({ id, kind, payload: canonicalJson(payload), signature, currency: p.currency, amount: p.amount, granted_at: granted, expires_at: expiryFor(s, granted) });
    });
}
function myServices(db, wallet) {
    const rows = db.all(`SELECT id, kind, payload, signature, currency, amount, granted_at, expires_at FROM entitlements WHERE wallet = ? ORDER BY id DESC`, wallet);
    const since = (0, db_ts_1.now)() - 86_400;
    const dailyLeft = {};
    for (const s of economy_1.SERVICES) {
        const used = db.scalar(`SELECT COUNT(*) FROM service_payments WHERE buyer = ? AND kind = ? AND COALESCE(block_time, ?) >= ?`, wallet, s.kind, (0, db_ts_1.now)(), since);
        dailyLeft[String(s.kind)] = Math.max(0, s.dailyCap - used);
    }
    return { entitlements: rows.map(rowToEntitlement), dailyLeft };
}

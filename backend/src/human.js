"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HUMAN = void 0;
exports.createTurnstileVerifier = createTurnstileVerifier;
exports.configureHuman = configureHuman;
exports.deviceHash = deviceHash;
exports.recordDevice = recordDevice;
exports.deviceStatus = deviceStatus;
exports.humanStatus = humanStatus;
exports.verifyHuman = verifyHuman;
exports.rewardGate = rewardGate;
exports.deviceLimited = deviceLimited;
exports.humanSummary = humanSummary;
// Proof of human + device dedupe (docs/02 "Жёсткие ограничители", docs/03 §3.4, docs/06 T-B-49).
//
// Two cheap Sybil brakes in front of the reward faucets, both *settlement-time* gates (nothing is
// blocked on chain, nothing is banned automatically — the flags below are ops decisions):
//
//   * Turnstile — `POST /me/human { token, fingerprint? }` verifies a Cloudflare Turnstile token with
//     siteverify and records a pass for `HUMAN_CHECK_TTL_S` (7 d). While a wallet has no fresh pass,
//     `quests.eligibility` answers `human_check_required` and `settleWallet` POSTPONES the wallet
//     (its finished quests are settled after the pass, inside the normal current-or-previous-period
//     window — so "verify within the day and you are paid", nothing is silently zeroed). SKR roots
//     use the same pass (`skrEligibility`). PvP match rewards are not gated by it — they are
//     credited at match time and the arena has its own brakes (≤ 8/day, ≤ 3/opponent, win-trading).
//   * Device dedupe — the client sends a salted, canvas-free fingerprint at sign-in; we store only
//     `sha256(DEVICE_SALT || fingerprint)` in `wallet_devices`. The first `DEVICE_MAX_WALLETS` (3)
//     wallets ever seen on a device may earn rewards; later ones get `device_limit` (quests, SKR,
//     PvP rewards and season payouts). A shared phone still serves a family; a farm of 50 wallets
//     on one Seeker earns 3×, not 50×. A device with more wallets than the limit is also raised as
//     a `device_ring` fraud signal so ops can look at the earlier wallets too.
//
// `flags.trusted` (admin resolution `trust`) bypasses both gates for support cases (lost phone,
// shared household device, false positive). The gate is OFF when `TURNSTILE_SECRET` is unset
// (dev / tests / explicit `HUMAN_CHECK=0`); production refuses to start without one of the two
// (config.ts). Tests configure the module through `configureHuman` (injected verifier + clock).
const node_crypto_1 = require("node:crypto");
const config_ts_1 = require("./config.ts");
const db_ts_1 = require("./db.ts");
const services_ts_1 = require("./services.ts");
function createTurnstileVerifier(secret = config_ts_1.TURNSTILE_SECRET, url = config_ts_1.TURNSTILE_SITEVERIFY_URL, fetchImpl = fetch) {
    return async (token, remoteIp) => {
        const body = new URLSearchParams({ secret, response: token });
        if (remoteIp)
            body.set('remoteip', remoteIp);
        const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8_000) });
        if (!res.ok)
            throw new services_ts_1.ServiceError(503, 'human_check_unavailable', `Turnstile siteverify answered HTTP ${res.status}`);
        const j = (await res.json());
        return { success: j.success === true, hostname: j.hostname, action: j.action, challengeTs: j.challenge_ts, errorCodes: j['error-codes'] ?? [] };
    };
}
/** Runtime knobs (module state so `quests.eligibility` and friends see the same view as the API). */
exports.HUMAN = {
    enabled: config_ts_1.HUMAN_CHECK_ENABLED,
    siteKey: config_ts_1.TURNSTILE_SITE_KEY,
    ttlS: config_ts_1.HUMAN_CHECK_TTL_S,
    maxWalletsPerDevice: config_ts_1.DEVICE_MAX_WALLETS,
    salt: config_ts_1.DEVICE_SALT,
    verifier: undefined,
};
function configureHuman(o) { Object.assign(exports.HUMAN, o); }
// ---------------------------------------------------------------- devices
/** Salted hash of the client fingerprint; `undefined` for missing / absurd input (never fail sign-in over it). */
function deviceHash(fingerprint) {
    if (typeof fingerprint !== 'string')
        return undefined;
    const fp = fingerprint.trim();
    if (fp.length < 8 || fp.length > 256)
        return undefined;
    return (0, node_crypto_1.createHash)('sha256').update(exports.HUMAN.salt).update('\u0000').update(fp).digest('hex');
}
function recordDevice(db, wallet, fingerprint, t = (0, db_ts_1.now)()) {
    const h = deviceHash(fingerprint);
    if (!h)
        return undefined;
    db.run(`INSERT INTO wallet_devices (device_hash, wallet, first_seen, last_seen, seen) VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(device_hash, wallet) DO UPDATE SET last_seen = excluded.last_seen, seen = seen + 1`, h, wallet, t, t);
    return h;
}
/**
 * A wallet is device-limited when, on any device it used, more than `maxWalletsPerDevice` wallets
 * were seen BEFORE it (rank by first_seen, ties by address) — the earliest wallets keep earning, the
 * late arrivals do not. Deterministic, so a user cannot rotate the limit onto someone else.
 */
function deviceStatus(db, wallet, max = exports.HUMAN.maxWalletsPerDevice) {
    const rows = db.all(`SELECT device_hash, first_seen FROM wallet_devices WHERE wallet = ?`, wallet);
    let limited = false, maxOn = 0;
    for (const r of rows) {
        const earlier = db.scalar(`SELECT COUNT(*) FROM wallet_devices WHERE device_hash = ? AND (first_seen < ? OR (first_seen = ? AND wallet < ?))`, r.device_hash, r.first_seen, r.first_seen, wallet);
        const total = db.scalar(`SELECT COUNT(*) FROM wallet_devices WHERE device_hash = ?`, r.device_hash);
        maxOn = Math.max(maxOn, total);
        if (earlier >= max)
            limited = true;
    }
    return { devices: rows.length, limited, maxWalletsOnDevice: maxOn };
}
function trusted(db, wallet) {
    const raw = db.get(`SELECT flags FROM wallets WHERE address = ?`, wallet)?.flags;
    try {
        return JSON.parse(raw ?? '{}').trusted === true;
    }
    catch {
        return false;
    }
}
function humanStatus(db, wallet, t = (0, db_ts_1.now)()) {
    const row = db.get(`SELECT verified_at, expires_at FROM human_checks WHERE wallet = ?`, wallet);
    const verified = !!row && row.expires_at > t;
    const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
    return { required: exports.HUMAN.enabled && !trusted(db, wallet), verified, verifiedAt: iso(row?.verified_at), expiresAt: verified ? iso(row.expires_at) : null, siteKey: exports.HUMAN.siteKey };
}
/** Verify a widget token and record the pass. Throws 400 `turnstile_failed` / 503 `human_check_unavailable`. */
async function verifyHuman(db, wallet, body, ip = {}, t = (0, db_ts_1.now)()) {
    const b = (body ?? {});
    const token = typeof b.token === 'string' ? b.token.trim() : '';
    if (!token || token.length > 2048)
        throw new services_ts_1.ServiceError(400, 'turnstile_failed', 'token is required');
    recordDevice(db, wallet, b.fingerprint, t);
    let outcome = { success: true, errorCodes: [] };
    if (exports.HUMAN.enabled) {
        const verifier = exports.HUMAN.verifier ?? createTurnstileVerifier();
        outcome = await verifier(token, ip.ip);
        if (!outcome.success)
            throw new services_ts_1.ServiceError(400, 'turnstile_failed', `Turnstile rejected the token (${outcome.errorCodes.join(', ') || 'no error code'})`, { errorCodes: outcome.errorCodes });
    }
    db.run(`INSERT INTO human_checks (wallet, verified_at, expires_at, ip_net, hostname, action) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(wallet) DO UPDATE SET verified_at = excluded.verified_at, expires_at = excluded.expires_at, ip_net = excluded.ip_net, hostname = excluded.hostname, action = excluded.action`, wallet, t, t + exports.HUMAN.ttlS, ip.net ?? null, outcome.hostname ?? null, outcome.action ?? null);
    return humanStatus(db, wallet, t);
}
/** Settlement-time gate shared by quests ($CG + SKR) — `null` = passes. `flags.trusted` bypasses both checks. */
function rewardGate(db, wallet, t = (0, db_ts_1.now)()) {
    if (trusted(db, wallet))
        return null;
    if (deviceStatus(db, wallet).limited)
        return 'device_limit';
    if (exports.HUMAN.enabled && !humanStatus(db, wallet, t).verified)
        return 'human_check_required';
    return null;
}
/** PvP / season variant: device dedupe only (match rewards are credited at match time — see header). */
function deviceLimited(db, wallet) { return !trusted(db, wallet) && deviceStatus(db, wallet).limited; }
/** `/health.antifraud` summary. */
function humanSummary(db, t = (0, db_ts_1.now)()) {
    return {
        enabled: exports.HUMAN.enabled,
        verifiedWallets: db.scalar(`SELECT COUNT(*) FROM human_checks WHERE expires_at > ?`, t),
        devices: db.scalar(`SELECT COUNT(DISTINCT device_hash) FROM wallet_devices`),
        crowdedDevices: db.scalar(`SELECT COUNT(*) FROM (SELECT device_hash FROM wallet_devices GROUP BY device_hash HAVING COUNT(*) > ?)`, exports.HUMAN.maxWalletsPerDevice),
    };
}

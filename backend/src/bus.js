"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUS_CHANNEL = void 0;
exports.walletsOf = walletsOf;
exports.installBus = installBus;
exports.bus = bus;
exports.publish = publish;
const CHANNEL = process.env.EVENT_BUS_CHANNEL || 'chip:events';
/** Wallet-ish fields an on-chain event may name. Over-notifying is harmless (a socket only ever
 *  receives frames for the wallet it subscribed with); under-notifying would mean a stale UI. */
const WALLET_KEYS = ['owner', 'buyer', 'seller', 'bidder', 'opponent', 'challenger', 'winner', 'claimer', 'staker', 'wallet', 'funder', 'by', 'to', 'admin'];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Which wallets care about this event, derived from its decoded payload. */
function walletsOf(data) {
    if (!data)
        return [];
    const out = new Set();
    for (const k of WALLET_KEYS) {
        const v = data[k];
        if (typeof v === 'string' && B58.test(v))
            out.add(v); // a program-authority field is not a wallet, and `admin` is: the pauser wants to see its own change
    }
    // arrays of {wallet|owner} (e.g. rewards settled for many stakers in one tx)
    for (const v of Object.values(data)) {
        if (!Array.isArray(v))
            continue;
        for (const item of v.slice(0, 64)) {
            const w = item?.wallet ?? item?.owner;
            if (typeof w === 'string' && B58.test(w))
                out.add(w);
        }
    }
    return [...out];
}
function createInproc() {
    const subs = new Set();
    return {
        kind: 'inproc',
        publish(m) { for (const fn of subs) {
            try {
                fn(m);
            }
            catch { /* a bad socket must not break ingest */ }
        } },
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
        async close() { subs.clear(); },
    };
}
async function createRedis(url) {
    const { Redis } = await Promise.resolve().then(() => __importStar(require('ioredis')));
    const pub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    const sub = new Redis(url, { maxRetriesPerRequest: null });
    const subs = new Set();
    await sub.subscribe(CHANNEL);
    sub.on('message', (_ch, raw) => {
        let m;
        try {
            m = JSON.parse(raw);
        }
        catch {
            return;
        }
        for (const fn of subs) {
            try {
                fn(m);
            }
            catch { /* ignore */ }
        }
    });
    pub.on('error', () => { });
    return {
        kind: 'redis',
        publish(m) { try {
            void pub.publish(CHANNEL, JSON.stringify(m)).catch(() => undefined);
        }
        catch { /* ignore */ } },
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
        async close() { subs.clear(); try {
            await sub.quit();
        }
        catch { /* ignore */ } try {
            await pub.quit();
        }
        catch { /* ignore */ } },
    };
}
const NOOP = { kind: 'off', publish() { }, subscribe: () => () => undefined, async close() { } };
let installed = NOOP;
/** Install the process-wide bus. Idempotent; a second call replaces the first (tests). */
async function installBus(kind = process.env.EVENT_BUS ?? 'inproc', url = process.env.REDIS_URL) {
    if (installed !== NOOP)
        await installed.close().catch(() => undefined);
    if (kind === 'redis') {
        if (!url) {
            logBusWarn('EVENT_BUS=redis without REDIS_URL — falling back to the in-process bus');
            installed = createInproc();
            return installed;
        }
        try {
            installed = await createRedis(url);
            return installed;
        }
        catch (e) {
            logBusWarn(`redis bus unavailable (${e.message}) — falling back to the in-process bus`);
        }
    }
    installed = kind === 'inproc' ? createInproc() : NOOP;
    return installed;
}
const logBusWarn = (msg) => { if (process.env.NODE_ENV !== 'test')
    process.stderr.write(`[bus] ${msg}\n`); };
function bus() { return installed; }
function publish(m) { installed.publish(m); }
exports.BUS_CHANNEL = CHANNEL;

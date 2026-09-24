"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signer = exports.rw = exports.ro = exports.eventDiscriminator = exports.accountDiscriminator = exports.ixDiscriminator = void 0;
exports.concat = concat;
exports.ixData = ixData;
exports.optional = optional;
exports.expectDiscriminator = expectDiscriminator;
exports.hasDiscriminator = hasDiscriminator;
exports.eventsFromLogs = eventsFromLogs;
exports.findEvent = findEvent;
exports.parseCustomError = parseCustomError;
// Anchor wire conventions without the Anchor runtime: instruction and
// account discriminators, optional accounts, event parsing from logs.
const sha256_1 = require("@noble/hashes/sha256");
const borsh_1 = require("./borsh");
const cache = new Map();
function disc(prefix, name) {
    const key = `${prefix}:${name}`;
    let d = cache.get(key);
    if (!d) {
        d = (0, sha256_1.sha256)(new TextEncoder().encode(key)).slice(0, 8);
        cache.set(key, d);
    }
    return d;
}
/** `sha256("global:<snake_case_ix>")[..8]` */
const ixDiscriminator = (name) => disc('global', name);
exports.ixDiscriminator = ixDiscriminator;
/** `sha256("account:<PascalCaseStruct>")[..8]` */
const accountDiscriminator = (name) => disc('account', name);
exports.accountDiscriminator = accountDiscriminator;
/** `sha256("event:<PascalCaseEvent>")[..8]` */
const eventDiscriminator = (name) => disc('event', name);
exports.eventDiscriminator = eventDiscriminator;
function concat(...parts) {
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
function ixData(name, args = new Uint8Array()) {
    return concat((0, exports.ixDiscriminator)(name), args);
}
// --- account metas ------------------------------------------------------
const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
exports.ro = ro;
const rw = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
exports.rw = rw;
const signer = (pubkey, writable = true) => ({ pubkey, isSigner: true, isWritable: writable });
exports.signer = signer;
/**
 * Anchor `Option<Account<…>>`: an absent account is passed as the program id
 * itself (readonly, non-signer). Anchor checks `key == program_id` → None.
 */
function optional(pubkey, programId, writable = true) {
    if (!pubkey)
        return (0, exports.ro)(programId);
    return writable ? (0, exports.rw)(pubkey) : (0, exports.ro)(pubkey);
}
// --- account decoding ---------------------------------------------------
function expectDiscriminator(data, name) {
    const d = (0, exports.accountDiscriminator)(name);
    for (let i = 0; i < 8; i++) {
        if (data[i] !== d[i])
            throw new Error(`Account discriminator mismatch: expected ${name}`);
    }
    return new borsh_1.BorshReader(data, 8);
}
function hasDiscriminator(data, name) {
    const d = (0, exports.accountDiscriminator)(name);
    for (let i = 0; i < 8; i++)
        if (data[i] !== d[i])
            return false;
    return true;
}
// --- events from logs ---------------------------------------------------
const PROGRAM_DATA = 'Program data: ';
/** Extract Anchor `emit!` payloads (base64 after "Program data: ") from tx logs. */
function eventsFromLogs(logs) {
    const out = [];
    for (const l of logs) {
        if (!l.startsWith(PROGRAM_DATA))
            continue;
        try {
            const bin = atob(l.slice(PROGRAM_DATA.length));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++)
                bytes[i] = bin.charCodeAt(i);
            out.push(bytes);
        }
        catch {
            /* not base64 — ignore */
        }
    }
    return out;
}
function findEvent(logs, name, decode) {
    const d = (0, exports.eventDiscriminator)(name);
    for (const payload of eventsFromLogs(logs)) {
        let ok = payload.length >= 8;
        for (let i = 0; ok && i < 8; i++)
            ok = payload[i] === d[i];
        if (ok)
            return decode(new borsh_1.BorshReader(payload, 8));
    }
    return undefined;
}
/**
 * Parse `custom program error: 0x1770` style failures. Returns the numeric
 * code and (best effort) which program index in the tx raised it.
 */
function parseCustomError(err) {
    const msg = String(err?.message ?? err ?? '');
    const m = /custom program error: (0x[0-9a-fA-F]+|\d+)/.exec(msg);
    if (!m) {
        const logs = err?.logs;
        if (logs) {
            for (const l of logs) {
                const mm = /Program (\w+) failed: custom program error: (0x[0-9a-fA-F]+)/.exec(l);
                if (mm)
                    return { code: Number(mm[2]), programId: mm[1] };
            }
        }
        return undefined;
    }
    const code = m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
    const logs = err?.logs;
    let programId;
    if (logs) {
        // innermost failure wins: a CPI error is logged by the inner program first and re-logged by every
        // caller with the same code — the inner program's error table is the one that describes it
        for (const l of logs) {
            const mm = /Program (\w+) failed: custom program error/.exec(l);
            if (mm) {
                programId = mm[1];
                break;
            }
        }
    }
    return { code, programId };
}

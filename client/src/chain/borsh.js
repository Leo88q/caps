"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.u32le = exports.u64le = exports.BorshReader = exports.BorshWriter = void 0;
// Minimal Borsh writer/reader — enough for the four GUTTERCAPS programs
// (u8/u16/u32/u64/u128/i64/bool/pubkey/string/fixed arrays/option/vec).
// Hand-rolled on purpose: it keeps us independent from the not-yet-built
// Anchor IDL and from BN.js, and it is ~100 lines that vitest covers.
const web3_js_1 = require("@solana/web3.js");
class BorshWriter {
    chunks = [];
    len = 0;
    push(b) {
        this.chunks.push(b);
        this.len += b.length;
    }
    u8(v) { this.push(Uint8Array.of(v & 0xff)); return this; }
    bool(v) { return this.u8(v ? 1 : 0); }
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); return this; }
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); return this; }
    u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.push(b); return this; }
    i64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); this.push(b); return this; }
    u128(v) {
        const b = new Uint8Array(16);
        const dv = new DataView(b.buffer);
        dv.setBigUint64(0, v & 0xffffffffffffffffn, true);
        dv.setBigUint64(8, v >> 64n, true);
        this.push(b);
        return this;
    }
    pubkey(k) { this.push(k.toBytes()); return this; }
    bytes(b) { this.push(b); return this; }
    string(s) { const enc = new TextEncoder().encode(s); this.u32(enc.length); this.push(enc); return this; }
    option(v, w) { if (v === null || v === undefined)
        return this.u8(0); this.u8(1); w(v); return this; }
    vec(items, w) { this.u32(items.length); for (const i of items)
        w(i); return this; }
    toBytes() {
        const out = new Uint8Array(this.len);
        let o = 0;
        for (const c of this.chunks) {
            out.set(c, o);
            o += c.length;
        }
        return out;
    }
}
exports.BorshWriter = BorshWriter;
class BorshReader {
    buf;
    dv;
    offset = 0;
    constructor(buf, offset = 0) {
        this.buf = buf;
        this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        this.offset = offset;
    }
    get remaining() { return this.buf.length - this.offset; }
    skip(n) { this.offset += n; return this; }
    u8() { return this.buf[this.offset++]; }
    bool() { return this.u8() !== 0; }
    u16() { const v = this.dv.getUint16(this.offset, true); this.offset += 2; return v; }
    u32() { const v = this.dv.getUint32(this.offset, true); this.offset += 4; return v; }
    u64() { const v = this.dv.getBigUint64(this.offset, true); this.offset += 8; return v; }
    i64() { const v = this.dv.getBigInt64(this.offset, true); this.offset += 8; return v; }
    u128() { const lo = this.dv.getBigUint64(this.offset, true); const hi = this.dv.getBigUint64(this.offset + 8, true); this.offset += 16; return (hi << 64n) | lo; }
    pubkey() { const k = new web3_js_1.PublicKey(this.buf.subarray(this.offset, this.offset + 32)); this.offset += 32; return k; }
    bytes(n) { const b = this.buf.slice(this.offset, this.offset + n); this.offset += n; return b; }
    string() { const n = this.u32(); const s = new TextDecoder().decode(this.buf.subarray(this.offset, this.offset + n)); this.offset += n; return s; }
    array(n, r) { const out = []; for (let i = 0; i < n; i++)
        out.push(r()); return out; }
    option(r) { return this.u8() === 0 ? null : r(); }
    vec(r) { return this.array(this.u32(), r); }
}
exports.BorshReader = BorshReader;
const u64le = (v) => new BorshWriter().u64(v).toBytes();
exports.u64le = u64le;
const u32le = (v) => new BorshWriter().u32(v).toBytes();
exports.u32le = u32le;

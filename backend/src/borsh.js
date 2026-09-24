"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BorshWriter = exports.BorshReader = void 0;
// Minimal Borsh reader/writer (u8/u16/u32/u64/u128/i64/bool/pubkey/fixed
// bytes/arrays) — the same conventions as client/src/chain/borsh.ts, kept
// dependency-free so the indexer never needs the Anchor runtime or an IDL.
const web3_js_1 = require("@solana/web3.js");
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
    need(n) { if (this.offset + n > this.buf.length)
        throw new RangeError(`borsh: need ${n} bytes at ${this.offset}, have ${this.remaining}`); }
    u8() { this.need(1); return this.buf[this.offset++]; }
    bool() { return this.u8() !== 0; }
    u16() { this.need(2); const v = this.dv.getUint16(this.offset, true); this.offset += 2; return v; }
    u32() { this.need(4); const v = this.dv.getUint32(this.offset, true); this.offset += 4; return v; }
    u64() { this.need(8); const v = this.dv.getBigUint64(this.offset, true); this.offset += 8; return v; }
    i64() { this.need(8); const v = this.dv.getBigInt64(this.offset, true); this.offset += 8; return v; }
    u128() { this.need(16); const lo = this.dv.getBigUint64(this.offset, true); const hi = this.dv.getBigUint64(this.offset + 8, true); this.offset += 16; return (hi << 64n) | lo; }
    pubkey() { this.need(32); const k = new web3_js_1.PublicKey(this.buf.subarray(this.offset, this.offset + 32)); this.offset += 32; return k; }
    bytes(n) { this.need(n); const b = this.buf.slice(this.offset, this.offset + n); this.offset += n; return b; }
    array(n, r) { const out = []; for (let i = 0; i < n; i++)
        out.push(r()); return out; }
}
exports.BorshReader = BorshReader;
class BorshWriter {
    chunks = [];
    len = 0;
    push(b) { this.chunks.push(b); this.len += b.length; }
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

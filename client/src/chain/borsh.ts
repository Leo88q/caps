// Minimal Borsh writer/reader — enough for the four GUTTERCAPS programs
// (u8/u16/u32/u64/u128/i64/bool/pubkey/string/fixed arrays/option/vec).
// Hand-rolled on purpose: it keeps us independent from the not-yet-built
// Anchor IDL and from BN.js, and it is ~100 lines that vitest covers.
import { PublicKey } from '@solana/web3.js';

export class BorshWriter {
  private chunks: Uint8Array[] = [];
  private len = 0;

  private push(b: Uint8Array) {
    this.chunks.push(b);
    this.len += b.length;
  }

  u8(v: number) { this.push(Uint8Array.of(v & 0xff)); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); return this; }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); return this; }
  u64(v: bigint | number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.push(b); return this; }
  i64(v: bigint | number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); this.push(b); return this; }
  u128(v: bigint) {
    const b = new Uint8Array(16); const dv = new DataView(b.buffer);
    dv.setBigUint64(0, v & 0xffff_ffff_ffff_ffffn, true); dv.setBigUint64(8, v >> 64n, true);
    this.push(b); return this;
  }
  pubkey(k: PublicKey) { this.push(k.toBytes()); return this; }
  bytes(b: Uint8Array) { this.push(b); return this; }
  string(s: string) { const enc = new TextEncoder().encode(s); this.u32(enc.length); this.push(enc); return this; }
  option<T>(v: T | null | undefined, w: (x: T) => void) { if (v === null || v === undefined) return this.u8(0); this.u8(1); w(v); return this; }
  vec<T>(items: readonly T[], w: (x: T) => void) { this.u32(items.length); for (const i of items) w(i); return this; }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

export class BorshReader {
  private dv: DataView;
  offset = 0;
  constructor(public readonly buf: Uint8Array, offset = 0) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.offset = offset;
  }
  get remaining() { return this.buf.length - this.offset; }
  skip(n: number) { this.offset += n; return this; }
  u8() { return this.buf[this.offset++]; }
  bool() { return this.u8() !== 0; }
  u16() { const v = this.dv.getUint16(this.offset, true); this.offset += 2; return v; }
  u32() { const v = this.dv.getUint32(this.offset, true); this.offset += 4; return v; }
  u64() { const v = this.dv.getBigUint64(this.offset, true); this.offset += 8; return v; }
  i64() { const v = this.dv.getBigInt64(this.offset, true); this.offset += 8; return v; }
  u128() { const lo = this.dv.getBigUint64(this.offset, true); const hi = this.dv.getBigUint64(this.offset + 8, true); this.offset += 16; return (hi << 64n) | lo; }
  pubkey() { const k = new PublicKey(this.buf.subarray(this.offset, this.offset + 32)); this.offset += 32; return k; }
  bytes(n: number) { const b = this.buf.slice(this.offset, this.offset + n); this.offset += n; return b; }
  string() { const n = this.u32(); const s = new TextDecoder().decode(this.buf.subarray(this.offset, this.offset + n)); this.offset += n; return s; }
  array<T>(n: number, r: () => T): T[] { const out: T[] = []; for (let i = 0; i < n; i++) out.push(r()); return out; }
  option<T>(r: () => T): T | null { return this.u8() === 0 ? null : r(); }
  vec<T>(r: () => T): T[] { return this.array(this.u32(), r); }
}

export const u64le = (v: bigint | number): Uint8Array => new BorshWriter().u64(v).toBytes();
export const u32le = (v: number): Uint8Array => new BorshWriter().u32(v).toBytes();

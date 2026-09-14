// Emits deterministic golden vectors used by BOTH the TS tests and the Rust
// unit tests in programs/chip_core (tests/golden.rs) so `expandRandomness`
// and `expand` can never drift apart. Run: npm run golden
import { writeFileSync, mkdirSync } from 'node:fs';
import { PACKS, effectiveOdds, expandRandomness, uniformBps } from '../src/packs.ts';

// xorshift64* — same generator both sides could use, but we just ship bytes.
let seed = 0x9e3779b97f4a7c15n;
function next(): bigint {
  seed ^= seed >> 12n; seed ^= (seed << 25n) & 0xffff_ffff_ffff_ffffn; seed ^= seed >> 27n;
  return (seed * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn;
}
function bytes32(): number[] {
  const out: number[] = [];
  while (out.length < 32) { let v = next(); for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; } }
  return out;
}

const skus = ['starter', 'standard', 'premium', 'limited'] as const;
const vectors = [];
for (let n = 0; n < 64; n++) {
  const vrf = bytes32();
  const sku = skus[n % 4];
  const pack = PACKS[sku];
  const pity = [0, 15, 29, 30, 35, 40, 59, 100][n % 8];
  const pool = 10;
  vectors.push({
    sku: n % 4, pity, pool, vrf,
    uniform: [0, 1, 2, 3, 4].map((s) => uniformBps(new Uint8Array(vrf), s)),
    odds: effectiveOdds(pack, pity),
    out: expandRandomness(new Uint8Array(vrf), pack, pity, pool).map((r) => [r.rarity, r.collectionIdx]),
  });
}
mkdirSync('golden', { recursive: true });
writeFileSync('golden/pack_expand.json', JSON.stringify({ version: 1, vectors }, null, 0));
console.log(`wrote golden/pack_expand.json (${vectors.length} vectors)`);

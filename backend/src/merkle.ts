// Reward-root Merkle tree — byte-for-byte the on-chain verifier in
// programs/staking/src/instructions/emission.rs (`verify_proof`, shared by claim_root and
// claim_skr_root) and the client mirror in client/src/chain/merkle.ts:
//   leaf = keccak(0x00 ‖ wallet[32] ‖ amount_le_u64 ‖ kind_u8 ‖ epoch_le_u32)
//   node = keccak(0x01 ‖ min(a, b) ‖ max(a, b))       (sorted pair, ≤ 24 levels)
// The 0x00 / 0x01 domain bytes stop a leaf from being replayed as an inner node; the `kind`
// byte inside the leaf keeps a $CG leaf from being claimed against an SKR root and vice versa.
// The reward oracle (backend/src/reward-oracle.ts) builds the trees it publishes with this file.
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';

export const MAX_PROOF_LEN = 24;
const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

export interface RewardLeafInput {
  wallet: PublicKey | Uint8Array | string;
  amountMicro: bigint | string | number;
  kind: number;
  epoch: number;
}

const walletBytes = (w: PublicKey | Uint8Array | string): Uint8Array =>
  w instanceof Uint8Array ? w : typeof w === 'string' ? new PublicKey(w).toBytes() : w.toBytes();

/** Lexicographic byte compare (what Rust's `[u8; 32] <= [u8; 32]` does). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

export function rewardLeaf(l: RewardLeafInput): Uint8Array {
  const w = walletBytes(l.wallet);
  if (w.length !== 32) throw new Error('wallet must be 32 bytes');
  if (!Number.isInteger(l.kind) || l.kind < 0 || l.kind > 255) throw new Error('kind must fit u8');
  if (!Number.isInteger(l.epoch) || l.epoch < 0 || l.epoch > 0xffff_ffff) throw new Error('epoch must fit u32');
  const amount = BigInt(l.amountMicro);
  if (amount < 0n || amount > 0xffff_ffff_ffff_ffffn) throw new Error('amount must fit u64');
  const buf = new Uint8Array(1 + 32 + 8 + 1 + 4);
  const dv = new DataView(buf.buffer);
  buf[0] = LEAF_PREFIX;
  buf.set(w, 1);
  dv.setBigUint64(33, amount, true);
  buf[41] = l.kind;
  dv.setUint32(42, l.epoch, true);
  return keccak_256(buf);
}

export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const buf = new Uint8Array(1 + 64);
  buf[0] = NODE_PREFIX;
  buf.set(lo, 1);
  buf.set(hi, 33);
  return keccak_256(buf);
}

export function rootFromProof(leaf: Uint8Array, proof: readonly Uint8Array[]): Uint8Array {
  if (proof.length > MAX_PROOF_LEN) throw new Error(`proof too long (${proof.length} > ${MAX_PROOF_LEN})`);
  let node = leaf;
  for (const sib of proof) {
    if (sib.length !== 32) throw new Error('proof node must be 32 bytes');
    node = hashPair(node, sib);
  }
  return node;
}

export function verifyRewardProof(l: RewardLeafInput, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  if (proof.length > MAX_PROOF_LEN) return false;
  return compareBytes(rootFromProof(rewardLeaf(l), proof), root) === 0;
}

/**
 * Build a full tree (odd layers promote the last node unchanged) and one proof per leaf.
 * Leaves are hashed in the given order; callers sort wallets first so a batch is reproducible.
 */
export function buildRewardTree(leaves: readonly RewardLeafInput[]): { root: Uint8Array; proofs: Uint8Array[][] } {
  if (leaves.length === 0) throw new Error('empty tree');
  if (leaves.length > 2 ** MAX_PROOF_LEN) throw new Error('too many leaves');
  let layer = leaves.map(rewardLeaf);
  const proofs: Uint8Array[][] = layer.map(() => []);
  let index = layer.map((_, i) => i); // leaf i currently lives at layer position index[i]
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let p = 0; p < layer.length; p += 2) {
      if (p + 1 === layer.length) { next.push(layer[p]); continue; }
      next.push(hashPair(layer[p], layer[p + 1]));
    }
    index = index.map((pos, leafIdx) => {
      const sibling = pos % 2 === 0 ? pos + 1 : pos - 1;
      if (sibling < layer.length) proofs[leafIdx].push(layer[sibling]);
      return pos >> 1;
    });
    layer = next;
  }
  return { root: layer[0], proofs };
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): Uint8Array => {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('bad hex');
  return Uint8Array.from(clean.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
};

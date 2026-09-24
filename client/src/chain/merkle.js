"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromHex = exports.toHex = exports.MAX_PROOF_LEN = void 0;
exports.compareBytes = compareBytes;
exports.rewardLeaf = rewardLeaf;
exports.hashPair = hashPair;
exports.rootFromProof = rootFromProof;
exports.verifyRewardProof = verifyRewardProof;
exports.buildRewardTree = buildRewardTree;
// Reward-root Merkle tree — byte-for-byte the on-chain verifier in
// programs/staking/src/instructions/emission.rs (`verify_proof`, shared by
// claim_root and claim_skr_root):
//   leaf = keccak(0x00 ‖ wallet[32] ‖ amount_le_u64 ‖ kind_u8 ‖ epoch_le_u32)
//   node = keccak(0x01 ‖ min(a, b) ‖ max(a, b))       (sorted pair, ≤ 24 levels)
// The 0x00 / 0x01 domain bytes stop a leaf from being replayed as an inner node
// (second-preimage attack); the `kind` byte inside the leaf keeps a $CG leaf
// from being claimed against an SKR root and vice versa.
const sha3_1 = require("@noble/hashes/sha3");
exports.MAX_PROOF_LEN = 24;
const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
const walletBytes = (w) => (w instanceof Uint8Array ? w : w.toBytes());
/** Lexicographic byte compare (what Rust's `[u8; 32] <= [u8; 32]` does). */
function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
}
function rewardLeaf(l) {
    const w = walletBytes(l.wallet);
    if (w.length !== 32)
        throw new Error('wallet must be 32 bytes');
    if (!Number.isInteger(l.kind) || l.kind < 0 || l.kind > 255)
        throw new Error('kind must fit u8');
    if (!Number.isInteger(l.epoch) || l.epoch < 0 || l.epoch > 0xffff_ffff)
        throw new Error('epoch must fit u32');
    const amount = BigInt(l.amountMicro);
    if (amount < 0n || amount > 0xffffffffffffffffn)
        throw new Error('amount must fit u64');
    const buf = new Uint8Array(1 + 32 + 8 + 1 + 4);
    const dv = new DataView(buf.buffer);
    buf[0] = LEAF_PREFIX;
    buf.set(w, 1);
    dv.setBigUint64(33, amount, true);
    buf[41] = l.kind;
    dv.setUint32(42, l.epoch, true);
    return (0, sha3_1.keccak_256)(buf);
}
function hashPair(a, b) {
    const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
    const buf = new Uint8Array(1 + 64);
    buf[0] = NODE_PREFIX;
    buf.set(lo, 1);
    buf.set(hi, 33);
    return (0, sha3_1.keccak_256)(buf);
}
/** Fold a proof up to the root. */
function rootFromProof(leaf, proof) {
    if (proof.length > exports.MAX_PROOF_LEN)
        throw new Error(`proof too long (${proof.length} > ${exports.MAX_PROOF_LEN})`);
    let node = leaf;
    for (const sib of proof) {
        if (sib.length !== 32)
            throw new Error('proof node must be 32 bytes');
        node = hashPair(node, sib);
    }
    return node;
}
function verifyRewardProof(l, proof, root) {
    if (proof.length > exports.MAX_PROOF_LEN)
        return false;
    return compareBytes(rootFromProof(rewardLeaf(l), proof), root) === 0;
}
/**
 * Build a full tree the way the oracle job does (odd layers promote the last
 * node unchanged). Used by tests and the mock API; the backend uses the same
 * algorithm so client-side pre-checks match what `publish_root` received.
 */
function buildRewardTree(leaves) {
    if (leaves.length === 0)
        throw new Error('empty tree');
    let layer = leaves.map(rewardLeaf);
    const proofs = layer.map(() => []);
    let index = layer.map((_, i) => i); // leaf i currently lives at layer position index[i]
    while (layer.length > 1) {
        const next = [];
        for (let p = 0; p < layer.length; p += 2) {
            if (p + 1 === layer.length) {
                next.push(layer[p]);
                continue;
            }
            next.push(hashPair(layer[p], layer[p + 1]));
        }
        index = index.map((pos, leafIdx) => {
            const sibling = pos % 2 === 0 ? pos + 1 : pos - 1;
            if (sibling < layer.length)
                proofs[leafIdx].push(layer[sibling]);
            return pos >> 1;
        });
        layer = next;
    }
    return { root: layer[0], proofs };
}
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
exports.toHex = toHex;
const fromHex = (h) => {
    const clean = h.startsWith('0x') ? h.slice(2) : h;
    if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean))
        throw new Error('bad hex');
    return Uint8Array.from(clean.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
};
exports.fromHex = fromHex;

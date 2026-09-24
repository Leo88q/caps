"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertBubblegumOwner = assertBubblegumOwner;
exports.bubblegumProofMetas = bubblegumProofMetas;
exports.assertHash32 = assertHash32;
exports.assertFreshProof = assertFreshProof;
exports.v2LeafHash = v2LeafHash;
exports.foldCompressionProof = foldCompressionProof;
exports.discoverLeafNonce = discoverLeafNonce;
exports.verifyBubblegumProofLocal = verifyBubblegumProofLocal;
const sha3_1 = require("@noble/hashes/sha3");
function assertBubblegumOwner(proof, owner) {
    if (!proof.leafOwner.equals(owner) && !proof.leafDelegate.equals(owner)) {
        throw new Error('Bubblegum leaf owner/delegate mismatch');
    }
}
/** Remaining proof node metas. Bubblegum's fixed accounts are added by each ix builder. */
function bubblegumProofMetas(proof, writable = false) {
    return proof.proof.map((pubkey) => ({ pubkey, isSigner: false, isWritable: writable }));
}
function assertHash32(value, label) {
    if (value.byteLength !== 32)
        throw new Error(`${label} must be exactly 32 bytes`);
}
function assertFreshProof(proof) {
    assertHash32(proof.root, 'Bubblegum root');
    assertHash32(proof.dataHash, 'Bubblegum data hash');
    assertHash32(proof.creatorHash, 'Bubblegum creator hash');
    assertHash32(proof.collectionHash, 'Bubblegum collection hash');
    assertHash32(proof.assetDataHash, 'Bubblegum asset data hash');
    if (!Number.isInteger(proof.flags) || proof.flags < 0 || proof.flags > 255)
        throw new Error('Bubblegum flags must be a byte');
    if (proof.leafIndex < 0n || proof.leafNonce < 0n)
        throw new Error('Bubblegum leaf coordinates must be non-negative');
}
function v2LeafHash(l) {
    for (const [h, n] of [[l.dataHash, 'dataHash'], [l.creatorHash, 'creatorHash'], [l.collectionHash, 'collectionHash'], [l.assetDataHash, 'assetDataHash']]) {
        if (h.length !== 32)
            throw new Error(`V2 leaf ${n} must be 32 bytes`);
    }
    if (!Number.isInteger(l.flags) || l.flags < 0 || l.flags > 255)
        throw new Error('V2 leaf flags must be a byte');
    if (l.nonce < 0n || l.nonce > 0xffffffffffffffffn)
        throw new Error('V2 leaf nonce must fit u64');
    const buf = new Uint8Array(1 + 32 * 3 + 8 + 32 * 4 + 1);
    const dv = new DataView(buf.buffer);
    buf[0] = 2;
    buf.set(l.assetId.toBytes(), 1);
    buf.set(l.owner.toBytes(), 33);
    buf.set(l.delegate.toBytes(), 65);
    dv.setBigUint64(97, l.nonce, true);
    buf.set(l.dataHash, 105);
    buf.set(l.creatorHash, 137);
    buf.set(l.collectionHash, 169);
    buf.set(l.assetDataHash, 201);
    buf[233] = l.flags;
    return (0, sha3_1.keccak_256)(buf);
}
/** Index-directed concurrent-Merkle-tree fold (`hash_to_parent`): bit i of the index picks the side. */
function foldCompressionProof(leaf, index, nodes) {
    if (leaf.length !== 32)
        throw new Error('leaf must be 32 bytes');
    let node = leaf, idx = index;
    for (const sib of nodes) {
        if (sib.length !== 32)
            throw new Error('proof node must be 32 bytes');
        const buf = new Uint8Array(64);
        if (idx & 1n) {
            buf.set(sib, 0);
            buf.set(node, 32);
        }
        else {
            buf.set(node, 0);
            buf.set(sib, 32);
        }
        node = (0, sha3_1.keccak_256)(buf);
        idx >>= 1n;
    }
    return node;
}
const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/**
 * Find the live V2 leaf nonce by local verification over a `BubblegumProof`.
 * Normally 0 transfers have happened and this is just `leafIndex`; the search
 * window keeps a raced leaf recoverable. Only full-length proofs
 * (`proof.length == maxDepth`, from our own `BubblegumTreeMeta`) are checkable;
 * short (canopied) proofs return `leafIndex` unchecked — on-chain `verify_leaf`
 * still authenticates them. Throws on owner drift or an inconsistent pair.
 */
function discoverLeafNonce(proof, maxDepth, maxTransfers = 8, expectedOwner) {
    if (expectedOwner && (!proof.leafOwner.equals(expectedOwner) || !proof.leafDelegate.equals(expectedOwner))) {
        throw new Error('Bubblegum leaf owner/delegate is not the expected buyer (leaf moved?)');
    }
    if (proof.leafIndex > 0xffffffffn)
        throw new Error('leaf index must fit u32');
    if (proof.proof.length !== maxDepth)
        return proof.leafIndex; // canopied path: on-chain verify_leaf is the check
    const nodes = proof.proof.map((p) => Uint8Array.from(p.toBytes()));
    for (let t = 0n; t <= BigInt(Math.max(0, maxTransfers)); t++) {
        const nonce = proof.leafIndex + t;
        if (nonce > 0xffffffffffffffffn)
            break;
        const leaf = v2LeafHash({
            assetId: proof.assetId, owner: proof.leafOwner, delegate: proof.leafDelegate, nonce,
            dataHash: proof.dataHash, creatorHash: proof.creatorHash, collectionHash: proof.collectionHash,
            assetDataHash: proof.assetDataHash, flags: proof.flags,
        });
        if (bytesEq(foldCompressionProof(leaf, proof.leafIndex, nodes), proof.root))
            return nonce;
    }
    throw new Error('Bubblegum proof does not fold to the DAS root for the V2 leaf (stale/inconsistent pair — refetch)');
}
/** Fresh-mint-only preflight: `discoverLeafNonce` with a zero search window. */
function verifyBubblegumProofLocal(proof, maxDepth, expectedOwner) {
    return discoverLeafNonce(proof, maxDepth, 0, expectedOwner);
}

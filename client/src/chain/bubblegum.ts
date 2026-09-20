/**
 * Bubblegum V2 proof transport shared by UI transaction builders.
 *
 * The backend owns DAS fetching and returns the same normalized fields. This
 * module intentionally does not decode display JSON and does not infer owner
 * from an asset id; callers must provide a fresh proof for every leaf write.
 */
import { PublicKey, type AccountMeta } from '@solana/web3.js';

export interface BubblegumProof {
  assetId: PublicKey;
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
  merkleTree: PublicKey;
  root: Uint8Array;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  collectionHash?: Uint8Array;
  assetDataHash?: Uint8Array;
  leafNonce: bigint;
  leafIndex: bigint;
  proof: PublicKey[];
}

export function assertBubblegumOwner(proof: BubblegumProof, owner: PublicKey): void {
  if (!proof.leafOwner.equals(owner) && !proof.leafDelegate.equals(owner)) {
    throw new Error('Bubblegum leaf owner/delegate mismatch');
  }
}

/** Remaining proof node metas. Bubblegum's fixed accounts are added by each ix builder. */
export function bubblegumProofMetas(proof: BubblegumProof, writable = false): AccountMeta[] {
  return proof.proof.map((pubkey) => ({ pubkey, isSigner: false, isWritable: writable }));
}

export function assertHash32(value: Uint8Array, label: string): void {
  if (value.byteLength !== 32) throw new Error(`${label} must be exactly 32 bytes`);
}

export function assertFreshProof(proof: BubblegumProof): void {
  assertHash32(proof.root, 'Bubblegum root');
  assertHash32(proof.dataHash, 'Bubblegum data hash');
  assertHash32(proof.creatorHash, 'Bubblegum creator hash');
  if (proof.collectionHash) assertHash32(proof.collectionHash, 'Bubblegum collection hash');
  if (proof.assetDataHash) assertHash32(proof.assetDataHash, 'Bubblegum asset data hash');
  if (proof.leafIndex < 0n || proof.leafNonce < 0n) throw new Error('Bubblegum leaf coordinates must be non-negative');
}

import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { DasError, combineDasAssetProof, normalizeDasAsset, normalizeDasProof } from '../src/das.ts';

const key = () => Keypair.generate().publicKey.toBase58();
const assetId = key();
const tree = key();
const owner = key();
const root = key();
const hash = key();
const proof = [key(), key()];

function rawAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: assetId,
    interface: 'V1_NFT',
    ownership: { owner, delegate: null, frozen: false },
    compression: {
      compressed: true,
      tree,
      leaf_id: 1,
      seq: 7,
      data_hash: hash,
      creator_hash: hash,
      collection_hash: hash,
      asset_data_hash: hash,
      flags: 0,
    },
    ...overrides,
  };
}

function rawProof(overrides: Record<string, unknown> = {}) {
  return { root, proof, tree_id: tree, node_index: 5, leaf_id: 1, ...overrides };
}

describe('Bubblegum DAS normalization', () => {
  it('normalizes a V2-compatible compressed asset and proof', () => {
    const value = combineDasAssetProof(rawAsset(), rawProof());
    expect(value.asset.assetId.toBase58()).toBe(assetId);
    expect(value.asset.owner.toBase58()).toBe(owner);
    expect(value.asset.delegate.toBase58()).toBe(owner);
    expect(value.asset.leafId).toBe(1n);
    expect(value.proof.leafIndex).toBe(1n);
    expect(value.proofAccounts).toHaveLength(2);
  });

  it('fails closed when V2 commitments or flags are absent', () => {
    const compression = { ...rawAsset().compression };
    delete (compression as Record<string, unknown>).asset_data_hash;
    expect(() => normalizeDasAsset({ ...rawAsset(), compression })).toThrowError(/asset_data_hash/);
    const noFlags = { ...rawAsset().compression };
    delete (noFlags as Record<string, unknown>).flags;
    expect(() => normalizeDasAsset({ ...rawAsset(), compression: noFlags })).toThrowError(/flags/);
  });

  it('accepts a canopy-truncated proof when DAS supplies the explicit leaf id', () => {
    const value = normalizeDasProof({ root, proof: [], tree_id: tree, node_index: 1_049_000, leaf_id: 1 });
    expect(value.leafIndex).toBe(1n);
  });

  it('fails closed for an uncompressed asset', () => {
    expect(() => normalizeDasAsset({ ...rawAsset(), compression: { compressed: false } })).toThrowError(DasError);
  });

  it('fails closed when asset and proof refer to different trees', () => {
    expect(() => combineDasAssetProof(rawAsset(), rawProof({ tree_id: key() }))).toThrowError(/tree/);
  });

  it('fails closed for a forged leaf index', () => {
    expect(() => normalizeDasProof(rawProof({ leaf_id: 0 }))).toThrowError(/leaf_id/);
  });

  it('fails closed for a proof that is too deep', () => {
    expect(() => normalizeDasProof({ ...rawProof(), proof: Array.from({ length: 31 }, key), node_index: 2 ** 31 + 1 })).toThrowError(/proof length/);
  });
});

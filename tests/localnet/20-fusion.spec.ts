// T-L-F — compressed fusion: Bubblegum V2 claims are the only material
// representation. No test in this suite creates or opens an MPL-Core asset.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodeCompressedMintClaim } from '@/chain/accounts';
import { fuseCompressedClaimsIx, stageCompressedChipIx } from '@/chain/ix/chipCore';
import { compressedMintClaimPda } from '@/chain/pdas';
import { Err, expectFail } from './helpers/expect';
import { binariesPresent, getEnv, tokenBalance, type Env } from './helpers/env';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);

async function stageClaim(env: Env, owner: Keypair, nonce: bigint, rarity: number, collectionIdx: number): Promise<PublicKey> {
  const claim = compressedMintClaimPda(owner.publicKey, nonce)[0];
  await env.chain.send([
    stageCompressedChipIx({
      admin: env.admin.publicKey,
      buyer: owner.publicKey,
      collectionIdx,
      claimNonce: nonce,
      rarity,
      level: 1,
      gameIndex: nonce,
      expiresAt: (await env.chain.now()) + 7n * 86_400n,
    }),
  ], { signers: [env.admin], label: `stage compressed fusion material ${nonce}` });
  return claim;
}

suite('T-L-F compressed fusion', () => {
  let env: Env;
  beforeAll(async () => { env = await getEnv(); });

  it('fuses three claim-bound Common chips into a new V2 claim and burns the fee', async () => {
    const owner = await env.player({ cg: 100_000_000n });
    const materials = await Promise.all([
      stageClaim(env, owner, 50_001n, 0, 0),
      stageClaim(env, owner, 50_002n, 0, 2),
      stageClaim(env, owner, 50_003n, 0, 4),
    ]);
    const resultNonce = 50_004n;
    const result = compressedMintClaimPda(owner.publicKey, resultNonce)[0];
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    const burnedBefore = (await env.ledger()).burnedTotal;

    await env.chain.send([
      fuseCompressedClaimsIx({
        owner: owner.publicKey,
        resultClaimNonce: resultNonce,
        resultCollectionIdx: 2,
        cgMint: env.mints.cg,
        materialClaims: materials,
      }),
    ], { signers: [owner], label: 'fuse compressed claims' });

    const claim = decodeCompressedMintClaim((await env.chain.getAccount(result))!.data);
    expect(claim.buyer.equals(owner.publicKey)).toBe(true);
    expect(claim.collectionIdx).toBe(2);
    expect(claim.rarity).toBe(1);
    expect(claim.level).toBe(1);
    expect(claim.settlement.equals(PublicKey.default)).toBe(true);
    expect(claim.indexReserved).toBe(false);
    expect(claim.minted).toBe(false);
    expect(claim.consumed).toBe(false);
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, owner.publicKey))).toBe(2_500_000n);
    expect((await env.ledger()).burnedTotal - burnedBefore).toBe(2_500_000n);
    for (const material of materials) {
      expect(decodeCompressedMintClaim((await env.chain.getAccount(material))!.data).consumed).toBe(true);
    }

    // A consumed claim cannot be used a second time, even if the caller still
    // has the original DAS/claim transport record.
    await expectFail(env.chain.send([
      fuseCompressedClaimsIx({ owner: owner.publicKey, resultClaimNonce: 50_005n, resultCollectionIdx: 2, cgMint: env.mints.cg, materialClaims: materials }),
    ], { signers: [owner] }), Err.chip('InvalidChipState'), 'consumed compressed material');
  });

  it('enforces rarity and same-collection rules before charging compressed fusion', async () => {
    const owner = await env.player({ cg: 100_000_000n });
    const mixed = await Promise.all([
      stageClaim(env, owner, 51_001n, 0, 0),
      stageClaim(env, owner, 51_002n, 1, 0),
      stageClaim(env, owner, 51_003n, 0, 0),
    ]);
    await expectFail(env.chain.send([
      fuseCompressedClaimsIx({ owner: owner.publicKey, resultClaimNonce: 51_004n, resultCollectionIdx: 0, cgMint: env.mints.cg, materialClaims: mixed }),
    ], { signers: [owner] }), Err.chip('MaterialRarityMismatch'), 'mixed compressed rarities');

    const same = await Promise.all([
      stageClaim(env, owner, 51_101n, 1, 3),
      stageClaim(env, owner, 51_102n, 1, 3),
      stageClaim(env, owner, 51_103n, 1, 3),
    ]);
    await expectFail(env.chain.send([
      fuseCompressedClaimsIx({ owner: owner.publicKey, resultClaimNonce: 51_104n, resultCollectionIdx: 4, cgMint: env.mints.cg, materialClaims: same }),
    ], { signers: [owner] }), Err.chip('MaterialCollectionMismatch'), 'wrong compressed result collection');

  });
});

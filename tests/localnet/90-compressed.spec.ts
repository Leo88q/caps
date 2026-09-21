// Bubblegum V2 migration gate: the pack roll must enter the claim-bound
// compressed settlement path before any DAS asset/proof is available.
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeCompressedMintClaim, decodeCompressedPackSettlement } from '@/chain/accounts';
import { compressedClaimNonce } from '@/chain/ix/chipCore';
import { stakeCompressedChipIx, unstakeCompressedChipIx } from '@/chain/ix/staking';
import { compressedMintClaimPda, compressedSettlementPda, pendingPackPda } from '@/chain/pdas';
import { binariesPresent, getEnv, type Env } from './helpers/env';
import { Currency, SKU, buyPack, loadPending, openCompressedPack, revealPack, valueOf } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
if (!bins.ok && !process.env.LOCALNET_RPC) {
  console.warn(`[tests/localnet] compressed suite skipped — missing program binaries:\n  ${bins.missing.join('\n  ')}`);
}

suite('T-V compressed pack settlement', () => {
  let env: Env;

  beforeAll(async () => {
    env = await getEnv();
  });

  it('stakes and unstakes a claim without converting it into a Core asset', async () => {
    const owner = await env.player({ usdc: 1_000_000_000n, cg: 100_000_000n });
    const purchase = await buyPack(env, owner, { sku: SKU.STANDARD, currency: Currency.USDC });
    const value = valueOf('compressed-stake');
    await revealPack(env, purchase, value);
    const opened = await openCompressedPack(env, owner.publicKey, purchase.nonce, 0, value);
    const claim = compressedMintClaimPda(owner.publicKey, opened.event.claimNonces[0])[0];

    await env.chain.send([stakeCompressedChipIx({ owner: owner.publicKey, claim })], { signers: [owner] });
    const staked = decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data);
    expect(staked.buyer.equals(owner.publicKey)).toBe(true);
    expect(staked.staked).toBe(true);
    expect(staked.listed).toBe(false);

    await env.chain.send([unstakeCompressedChipIx({ owner: owner.publicKey, claim, cgMint: env.mints.cg })], { signers: [owner] });
    expect(decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data).staked).toBe(false);
  });

  it('creates claim-bound V2 settlement records without inventing DAS asset ids', async () => {
    const buyer = await env.player({ usdc: 1_000_000_000n });
    const purchase = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const value = valueOf('compressed-settlement');

    await revealPack(env, purchase, value);
    const opened = await openCompressedPack(env, buyer.publicKey, purchase.nonce, 0, value);

    expect(opened.event.buyer.equals(buyer.publicKey)).toBe(true);
    expect(opened.event.nonce).toBe(purchase.nonce);
    expect(opened.event.packNo).toBe(0);
    expect(opened.event.count).toBe(opened.rolled.length);
    expect(opened.event.claimNonces).toHaveLength(opened.event.count);

    const settlementAddress = compressedSettlementPda(buyer.publicKey, purchase.nonce)[0];
    const settlementAccount = await env.chain.getAccount(settlementAddress);
    expect(settlementAccount).not.toBeNull();
    const settlement = decodeCompressedPackSettlement(settlementAccount!.data);
    expect(settlement.buyer.equals(buyer.publicKey)).toBe(true);
    expect(settlement.pending.equals(purchase.pending)).toBe(true);
    expect(settlement.totalClaims).toBe(opened.event.count);
    expect(settlement.registeredClaims).toBe(0);
    expect(settlement.cancelledClaims).toBe(0);

    const pending = await loadPending(env.chain, pendingPackPda(buyer.publicKey, purchase.nonce)[0]);
    expect(pending?.opened).toBe(1);

    for (let i = 0; i < opened.event.claimNonces.length; i++) {
      const claimNonce = compressedClaimNonce(purchase.nonce, 0, i);
      expect(opened.event.claimNonces[i]).toBe(claimNonce);
      const claimAddress = compressedMintClaimPda(buyer.publicKey, claimNonce)[0];
      const claimAccount = await env.chain.getAccount(claimAddress);
      expect(claimAccount).not.toBeNull();
      const claim = decodeCompressedMintClaim(claimAccount!.data);
      expect(claim.buyer.equals(buyer.publicKey)).toBe(true);
      expect(claim.settlement.equals(settlementAddress)).toBe(true);
      expect(claim.collectionIdx).toBe(opened.rolled[i].collectionIdx);
      expect(claim.rarity).toBe(opened.rolled[i].rarity);
      expect(claim.indexReserved).toBe(true);
      expect(claim.minted).toBe(false);
    }
  });
});

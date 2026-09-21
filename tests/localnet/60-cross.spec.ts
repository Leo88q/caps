// T-L-X — cross-program invariants for the full-closed Bubblegum V2 claim path.
// Claims stay chip_core-owned; market and staking may only mutate them through
// authenticated CPI authority PDAs.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { ixData, rw, signer } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { decodeCompressedMintClaim } from '@/chain/accounts';
import { CHIP_CORE_ID } from '@/chain/ids';
import { cancelCompressedIx, buyCompressedSolIx, listCompressedIx } from '@/chain/ix/market';
import { stakeCompressedChipIx, unstakeCompressedChipIx } from '@/chain/ix/staking';
import { cancelCompressedClaimIx } from '@/chain/ix/chipCore';
import { compressedChipStakePda, compressedListingPda, compressedMintClaimPda } from '@/chain/pdas';
import { BUYBACK, TREASURY, binariesPresent, getEnv, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { stageClaim } from './helpers/flows';
import { Currency, SKU, buyPack, mintCompressedChips, revealAndOpenCompressedAll, valueOf } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const SOL = 1_000_000_000n;
const DAY = 86_400n;

function setCompressedClaimListedIx(a: { caller: PublicKey; claim: PublicKey; expectedOwner: PublicKey; listed: boolean }): TransactionInstruction {
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.caller), rw(a.claim)],
    data: Buffer.from(ixData('set_compressed_claim_listed', new BorshWriter().pubkey(a.expectedOwner).bool(a.listed).toBytes())),
  });
}

function transferCompressedClaimIx(a: { caller: PublicKey; claim: PublicKey; expectedSeller: PublicKey; newOwner: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.caller), rw(a.claim)],
    data: Buffer.from(ixData('transfer_compressed_claim', new BorshWriter().pubkey(a.expectedSeller).pubkey(a.newOwner).toBytes())),
  });
}

function setCompressedClaimStakedIx(a: { caller: PublicKey; claim: PublicKey; expectedOwner: PublicKey; staked: boolean }): TransactionInstruction {
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.caller), rw(a.claim)],
    data: Buffer.from(ixData('set_compressed_claim_staked', new BorshWriter().pubkey(a.expectedOwner).bool(a.staked).toBytes())),
  });
}

suite('T-L-X compressed cross-program', () => {
  let env: Env;
  beforeAll(async () => { env = await getEnv(); });

  it('X01 one claim through staking and the custom market: stake → list rejected → unstake → list → buy → new owner stakes', async () => {
    const seller = await env.player({ usdc: 5_000_000_000n, cg: 1_000_000_000n });
    const buyer = await env.player({ sol: 30n * SOL, cg: 1_000_000_000n });
    const c = await stageClaim(env, seller, 70_001n);

    await env.chain.send([stakeCompressedChipIx({ owner: seller.publicKey, claim: c.claim })], { signers: [seller], label: 'stake compressed claim' });
    expect(decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data).staked).toBe(true);
    expect(await env.chain.getAccount(compressedChipStakePda(c.claim)[0])).not.toBeNull();

    await expectFail(
      env.chain.send([listCompressedIx({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller] }),
      Err.market('CompressedClaimNotTradable'), 'list a staked claim',
    );
    await env.chain.send([unstakeCompressedChipIx({ owner: seller.publicKey, claim: c.claim, cgMint: env.mints.cg })], { signers: [seller] });
    await env.chain.send([listCompressedIx({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller], label: 'list compressed claim' });

    await env.chain.send([buyCompressedSolIx({ buyer: buyer.publicKey, claim: c.claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey })], { signers: [buyer], label: 'buy compressed claim' });
    const transferred = decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data);
    expect(transferred.buyer.equals(buyer.publicKey)).toBe(true);
    expect(transferred.origin.equals(seller.publicKey)).toBe(true);
    expect(compressedMintClaimPda(transferred.origin, c.claimNonce)[0].equals(c.claim)).toBe(true);
    expect(transferred.listed).toBe(false);
    expect(await env.chain.getAccount(compressedListingPda(c.claim)[0])).toBeNull();

    await expectFail(
      env.chain.send([stakeCompressedChipIx({ owner: seller.publicKey, claim: c.claim })], { signers: [seller] }),
      Err.staking('NotOwner'), 'previous owner stakes',
    );
    await env.chain.send([stakeCompressedChipIx({ owner: buyer.publicKey, claim: c.claim })], { signers: [buyer], label: 'new owner stakes' });
    expect(decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data).staked).toBe(true);
  });

  it('X02 chip_core claim transitions reject wallet and foreign callers', async () => {
    const owner = await env.player({ usdc: 5_000_000_000n, cg: 1_000_000_000n });
    const c = await stageClaim(env, owner, 70_002n);
    await expectFail(
      env.chain.send([setCompressedClaimListedIx({ caller: owner.publicKey, claim: c.claim, expectedOwner: owner.publicKey, listed: true })], { signers: [owner] }),
      Err.chip('NotProgramCaller'), 'wallet as market authority',
    );
    const fake = Keypair.generate();
    await env.chain.airdrop(fake.publicKey, SOL);
    await expectFail(
      env.chain.send([setCompressedClaimListedIx({ caller: fake.publicKey, claim: c.claim, expectedOwner: owner.publicKey, listed: true })], { signers: [owner, fake] }),
      Err.chip('NotProgramCaller'), 'foreign signer as market authority',
    );
    await expectFail(
      env.chain.send([transferCompressedClaimIx({ caller: owner.publicKey, claim: c.claim, expectedSeller: owner.publicKey, newOwner: fake.publicKey })], { signers: [owner] }),
      Err.chip('NotProgramCaller'), 'wallet as transfer authority',
    );
    expect(decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data).listed).toBe(false);
    await env.chain.send([listCompressedIx({ seller: owner.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [owner] });
    await env.chain.send([cancelCompressedIx({ seller: owner.publicKey, claim: c.claim })], { signers: [owner] });
    expect(decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data).listed).toBe(false);
  });

  it('X03 cancelled compressed listings cannot be bought and leave the claim with its seller', async () => {
    const seller = await env.player({ usdc: 5_000_000_000n });
    const buyer = await env.player({ sol: 30n * SOL });
    const c = await stageClaim(env, seller, 70_003n);
    await env.chain.send([listCompressedIx({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller] });
    await env.chain.send([cancelCompressedIx({ seller: seller.publicKey, claim: c.claim })], { signers: [seller] });
    await expectAnyFail(
      env.chain.send([buyCompressedSolIx({ buyer: buyer.publicKey, claim: c.claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey })], { signers: [buyer] }),
      'buy a cancelled compressed listing',
    );
    const claim = decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data);
    expect(claim.buyer.equals(seller.publicKey)).toBe(true);
    expect(claim.listed).toBe(false);
  });

  it('X04 a wallet cannot set the authoritative compressed staking flag', async () => {
    const owner = await env.player({ usdc: 5_000_000_000n });
    const c = await stageClaim(env, owner, 70_004n);
    await expectFail(
      env.chain.send([setCompressedClaimStakedIx({ caller: owner.publicKey, claim: c.claim, expectedOwner: owner.publicKey, staked: true })], { signers: [owner] }),
      Err.chip('NotProgramCaller'), 'wallet as staking authority',
    );
    expect(decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data).staked).toBe(false);
  });

  it('X05 only the listing seller may cancel a compressed listing', async () => {
    const seller = await env.player({ usdc: 5_000_000_000n });
    const stranger = await env.player({ sol: 5n * SOL });
    const c = await stageClaim(env, seller, 70_005n);
    await env.chain.send([listCompressedIx({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller] });
    await expectFail(
      env.chain.send([cancelCompressedIx({ seller: stranger.publicKey, claim: c.claim })], { signers: [stranger] }),
      Err.market('NotSeller'), 'stranger cancels compressed listing',
    );
    await env.chain.send([cancelCompressedIx({ seller: seller.publicKey, claim: c.claim })], { signers: [seller] });
  });

  it('X06 compressed self-trade is rejected before the claim transfer', async () => {
    const seller = await env.player({ usdc: 5_000_000_000n, sol: 5n * SOL });
    const c = await stageClaim(env, seller, 70_006n);
    await env.chain.send([listCompressedIx({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller] });
    await expectFail(
      env.chain.send([buyCompressedSolIx({ buyer: seller.publicKey, claim: c.claim, seller: seller.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey })], { signers: [seller] }),
      Err.market('SelfTrade'), 'seller buys own compressed listing',
    );
    await env.chain.send([cancelCompressedIx({ seller: seller.publicKey, claim: c.claim })], { signers: [seller] });
  });

  it('X07 listing binds the seller to the claim owner, not a caller-supplied wallet', async () => {
    const owner = await env.player({ usdc: 5_000_000_000n });
    const impostor = await env.player({ usdc: 5_000_000_000n });
    const c = await stageClaim(env, owner, 70_007n);
    await expectFail(
      env.chain.send([listCompressedIx({ seller: impostor.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [impostor] }),
      Err.market('CompressedClaimNotTradable'), 'impostor lists compressed claim',
    );
    expect(decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data).listed).toBe(false);
  });

  it('X08 SEC-F01 a pre-mint pack claim bound to an open settlement CANNOT be listed (would brick the settlement forever)', async () => {
    const owner = await env.player({ usdc: 5_000_000_000n });
    const [c] = await mintCompressedChips(env, owner, 1, valueOf('X08'));
    const claim = decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data);
    expect(claim.minted).toBe(false);
    expect(claim.settlement.equals(PublicKey.default)).toBe(false); // pack claims are settlement-bound
    await expectFail(
      env.chain.send([listCompressedIx({ seller: owner.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [owner] }),
      Err.chip('InvalidChipState'), 'list a pre-mint settlement-bound claim',
    );
    expect(decodeCompressedMintClaim((await env.chain.getAccount(c.claim))!.data).listed).toBe(false);
  });

  it('X09 SEC-F03 a staked claim survives its deadline — cancel is refused, so zombie weight is impossible', async () => {
    if (!env.chain.canWarp) return;
    const owner = await env.player({ usdc: 5_000_000_000n });
    const b = await buyPack(env, owner, { sku: SKU.STANDARD, qty: 1, currency: Currency.USDC });
    const [r] = await revealAndOpenCompressedAll(env, owner, b, valueOf('X09'));
    const claimNonce = r.event.claimNonces[0];
    const claim = compressedMintClaimPda(owner.publicKey, claimNonce)[0];
    await env.chain.send([stakeCompressedChipIx({ owner: owner.publicKey, claim })], { signers: [owner], label: 'stake before deadline' });
    // past the 7-day claim deadline the claim is cancellable for a normal owner — but NOT while staked
    await env.chain.warpSeconds(8n * DAY + 1n);
    await expectFail(
      env.chain.send([cancelCompressedClaimIx({ buyer: owner.publicKey, claimNonce, nonce: b.nonce })], { signers: [owner] }),
      Err.chip('InvalidChipState'), 'cancel a staked claim',
    );
    // claim account still exists (not closed behind the stake's back)
    expect(await env.chain.getAccount(claim)).not.toBeNull();
    // unstake and the same cancel goes through — the refund window keeps working for honest users
    await env.chain.send([unstakeCompressedChipIx({ owner: owner.publicKey, claim, cgMint: env.mints.cg })], { signers: [owner] });
    await env.chain.send([cancelCompressedClaimIx({ buyer: owner.publicKey, claimNonce, nonce: b.nonce })], { signers: [owner] });
    expect(await env.chain.getAccount(claim)).toBeNull();
  });

  it('X10 SEC-F04 an expired unminted claim cannot be staked', async () => {
    if (!env.chain.canWarp) return;
    const owner = await env.player({ usdc: 5_000_000_000n });
    const b = await buyPack(env, owner, { sku: SKU.STANDARD, qty: 1, currency: Currency.USDC });
    const [r] = await revealAndOpenCompressedAll(env, owner, b, valueOf('X10'));
    const claim = compressedMintClaimPda(owner.publicKey, r.event.claimNonces[0])[0];
    await env.chain.warpSeconds(8n * DAY + 1n);
    await expectFail(
      env.chain.send([stakeCompressedChipIx({ owner: owner.publicKey, claim })], { signers: [owner] }),
      Err.staking('ClaimExpired'), 'stake an expired claim',
    );
  });
});

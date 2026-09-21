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
import { compressedChipStakePda, compressedListingPda } from '@/chain/pdas';
import { BUYBACK, TREASURY, binariesPresent, getEnv, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { mintCompressedChips, valueOf } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const SOL = 1_000_000_000n;

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

suite('T-L-X compressed cross-program', () => {
  let env: Env;
  beforeAll(async () => { env = await getEnv(); });

  it('X01 one claim through staking and the custom market: stake → list rejected → unstake → list → buy → new owner stakes', async () => {
    const seller = await env.player({ usdc: 5_000_000_000n, cg: 1_000_000_000n });
    const buyer = await env.player({ sol: 30n * SOL, cg: 1_000_000_000n });
    const [c] = await mintCompressedChips(env, seller, 1, valueOf('X01'));

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
    const [c] = await mintCompressedChips(env, owner, 1, valueOf('X02'));
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
    const [c] = await mintCompressedChips(env, seller, 1, valueOf('X03'));
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
});

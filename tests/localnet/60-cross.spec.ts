// T-L-X — cross-program invariants (docs/06 §3.5 "Cross-program"): the chip_core hooks the
// market / staking / arena programs call by CPI (`set_chip_flag`, `deliver_sold`, `level_up`)
// must be unusable from anywhere else, and the flags they set must be mutually exclusive.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { ixData, ro, rw, signer } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { CHIP_FLAG, decodeChipStake, decodeCoreAssetHeader } from '@/chain/accounts';
import { CHIP_CORE_ID, MPL_CORE_ID, SYSTEM_PROGRAM_ID } from '@/chain/ids';
import { MarketCurrency, buyIx, cancelListingIx, listIx } from '@/chain/ix/market';
import { stakeChipIx, unstakeChipIx } from '@/chain/ix/staking';
import { chipStakePda, chipStatePda, collectionMetaPda, configPda, listingPda, marketAuthPda, stakeAuthPda } from '@/chain/pdas';
import { BUYBACK, TREASURY, binariesPresent, getEnv, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { loadChip, mintChips, valueOf } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const SOL = 1_000_000_000n;

// ---------------------------------------------------------------- raw builders for the CPI-only hooks
// (the client has none on purpose — these instructions are never sent by a wallet)

function setChipFlagIx(a: { caller: PublicKey; payer: PublicKey; asset: PublicKey; collectionIdx: number; coreCollection: PublicKey; flag: number; set: boolean; expectedOwner: PublicKey }): TransactionInstruction {
  const args = new BorshWriter().u8(a.flag).bool(a.set).pubkey(a.expectedOwner).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.caller, false), signer(a.payer), ro(configPda()[0]), rw(a.asset), rw(chipStatePda(a.asset)[0]),
      ro(collectionMetaPda(a.collectionIdx)[0]), rw(a.coreCollection), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('set_chip_flag', args)),
  });
}

function deliverSoldIx(a: { caller: PublicKey; payer: PublicKey; asset: PublicKey; collectionIdx: number; coreCollection: PublicKey; newOwner: PublicKey; expectedSeller: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.caller, false), signer(a.payer), ro(configPda()[0]), rw(a.asset), rw(chipStatePda(a.asset)[0]),
      ro(collectionMetaPda(a.collectionIdx)[0]), rw(a.coreCollection), ro(a.newOwner), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('deliver_sold', new BorshWriter().pubkey(a.expectedSeller).toBytes())),
  });
}

function levelUpIx(a: { caller: PublicKey; payer: PublicKey; asset: PublicKey; levels: number }): TransactionInstruction {
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.caller, false), signer(a.payer), ro(configPda()[0]), rw(a.asset), rw(chipStatePda(a.asset)[0])],
    data: Buffer.from(ixData('level_up', new BorshWriter().u8(a.levels).toBytes())),
  });
}

suite('T-L-X cross-program', () => {
  let env: Env;
  beforeAll(async () => { env = await getEnv(); });

  it('X01 one chip through every program: stake → list rejected → unstake → list → buy → the new owner stakes it', async () => {
    const seller = await env.player({ usdc: 5_000_000_000n, cg: 1_000_000_000n });
    const buyer = await env.player({ sol: 30n * SOL, cg: 1_000_000_000n });
    const [c] = await mintChips(env, seller, 1, valueOf('X01'));
    const ref = { asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) };

    // stake — flag STAKED, Core asset frozen by chip_core (PermanentFreezeDelegate via the collection PDA)
    await env.chain.send([stakeChipIx({ owner: seller.publicKey, ...ref })], { signers: [seller], label: 'stake' });
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.STAKED).toBe(CHIP_FLAG.STAKED);
    const stake = decodeChipStake((await env.chain.getAccount(chipStakePda(c.asset)[0]))!.data);
    expect(stake.owner.equals(seller.publicKey)).toBe(true);
    expect(stake.weight).toBeGreaterThan(0n);

    // a staked chip cannot be listed: market lets it through (no STAKED check of its own), chip_core's
    // set_chip_flag(LISTED) refuses because the chip is not free
    await expectFail(
      env.chain.send([listIx({ seller: seller.publicKey, ...ref, price: 2n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] }),
      Err.chip('ChipNotFree'), 'list while staked',
    );
    // ...nor staked twice (init on a live ChipStake PDA)
    await expectAnyFail(env.chain.send([stakeChipIx({ owner: seller.publicKey, ...ref })], { signers: [seller] }), 'double stake');

    // unstake — flag cleared, chip free again
    await env.chain.send([unstakeChipIx({ owner: seller.publicKey, ...ref, cgMint: env.mints.cg })], { signers: [seller], label: 'unstake' });
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.STAKED).toBe(0);
    expect(await env.chain.getAccount(chipStakePda(c.asset)[0])).toBeNull();

    // list — now a listed chip cannot be staked (staking checks is_free itself)
    await env.chain.send([listIx({ seller: seller.publicKey, ...ref, price: 2n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller], label: 'list' });
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.LISTED).toBe(CHIP_FLAG.LISTED);
    await expectFail(env.chain.send([stakeChipIx({ owner: seller.publicKey, ...ref })], { signers: [seller] }), Err.staking('ChipNotFree'), 'stake while listed');

    // buy — deliver_sold moves the asset, LISTED cleared, listing closed
    await env.chain.send([buyIx({
      buyer: buyer.publicKey, seller: seller.publicKey, ...ref, expectedPrice: 2n * SOL, expectedCurrency: MarketCurrency.SOL,
      treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc, skrMint: env.mints.skr,
    })], { signers: [buyer], label: 'buy' });
    expect(decodeCoreAssetHeader((await env.chain.getAccount(c.asset))!.data).owner.equals(buyer.publicKey)).toBe(true);
    expect((await loadChip(env.chain, c.asset))!.flags & (CHIP_FLAG.LISTED | CHIP_FLAG.STAKED)).toBe(0);
    expect(await env.chain.getAccount(listingPda(c.asset)[0])).toBeNull();

    // the previous owner has no rights left: stake / list / cancel all fail on the ownership check
    await expectFail(env.chain.send([stakeChipIx({ owner: seller.publicKey, ...ref })], { signers: [seller] }), Err.staking('NotOwner'), 'old owner stakes');
    await expectFail(env.chain.send([listIx({ seller: seller.publicKey, ...ref, price: 2n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] }), Err.market('NotOwner'), 'old owner lists');
    await expectAnyFail(env.chain.send([cancelListingIx({ seller: seller.publicKey, ...ref })], { signers: [seller] }), 'cancel a closed listing');

    // the new owner stakes it — the full loop closes
    await env.chain.send([stakeChipIx({ owner: buyer.publicKey, ...ref })], { signers: [buyer], label: 'new owner stakes' });
    const stake2 = decodeChipStake((await env.chain.getAccount(chipStakePda(c.asset)[0]))!.data);
    expect(stake2.owner.equals(buyer.publicKey)).toBe(true);
    expect(stake2.weight).toBe(stake.weight);
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.STAKED).toBe(CHIP_FLAG.STAKED);
  });

  it('X02 set_chip_flag: only the [market_auth] / [stake_auth] PDA of the pinned program may call it; a wallet, a PDA with the same seed under another program, or the PDA passed unsigned → rejected', async () => {
    const owner = await env.player({ usdc: 5_000_000_000n, cg: 1_000_000_000n });
    const [c] = await mintChips(env, owner, 1, valueOf('X02'));
    const ref = { asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) };

    // (a) the owner himself as `caller` → NotProgramCaller
    await expectFail(
      env.chain.send([setChipFlagIx({ caller: owner.publicKey, payer: owner.publicKey, ...ref, flag: CHIP_FLAG.LISTED, set: true, expectedOwner: owner.publicKey })], { signers: [owner] }),
      Err.chip('NotProgramCaller'), 'wallet as caller',
    );
    // (b) a fresh keypair pretending to be the market authority → NotProgramCaller
    const fake = Keypair.generate();
    await env.chain.airdrop(fake.publicKey, SOL);
    await expectFail(
      env.chain.send([setChipFlagIx({ caller: fake.publicKey, payer: owner.publicKey, ...ref, flag: CHIP_FLAG.STAKED, set: true, expectedOwner: owner.publicKey })], { signers: [owner, fake] }),
      Err.chip('NotProgramCaller'), 'random signer as caller',
    );
    // (c) the same seed derived under ANOTHER program id ("market_auth" of the staking program, "stake_auth"
    //     of the market program): the address differs from the pinned derivation → NotProgramCaller.
    //     (A PDA can only sign through its own program, so the tx cannot even carry that signature — the
    //     signer check fires first; either way the flag is never set.)
    const crossMarketAuth = PublicKey.findProgramAddressSync([Buffer.from('market_auth')], stakeAuthPda()[0])[0];
    const f1 = await expectAnyFail(
      env.chain.send([setChipFlagIx({ caller: crossMarketAuth, payer: owner.publicKey, ...ref, flag: CHIP_FLAG.LISTED, set: true, expectedOwner: owner.publicKey })], { signers: [owner] }),
      'foreign-program PDA as caller',
    );
    expect(f1.code === undefined || f1.code === Err.chip('NotProgramCaller').code || f1.code === 2002 /* ConstraintSigner */).toBe(true);
    // (d) the real market_auth address without its signature → rejected by the runtime / signer check
    const f2 = await expectAnyFail(
      env.chain.send([setChipFlagIx({ caller: marketAuthPda()[0], payer: owner.publicKey, ...ref, flag: CHIP_FLAG.LISTED, set: true, expectedOwner: owner.publicKey })], { signers: [owner] }),
      'unsigned market_auth',
    );
    expect(f2.code === undefined || f2.code === 2002).toBe(true);
    // (e) flags other than LISTED / STAKED (SOULBOUND, FUSING) are not settable through this hook at all
    await expectFail(
      env.chain.send([setChipFlagIx({ caller: owner.publicKey, payer: owner.publicKey, ...ref, flag: CHIP_FLAG.SOULBOUND, set: true, expectedOwner: owner.publicKey })], { signers: [owner] }),
      Err.chip('InvalidChipState'), 'SOULBOUND via set_chip_flag',
    );
    // nothing changed and the asset is still transferable through the market (sanity: list works)
    expect((await loadChip(env.chain, c.asset))!.flags & (CHIP_FLAG.LISTED | CHIP_FLAG.STAKED)).toBe(0);
    await env.chain.send([listIx({ seller: owner.publicKey, ...ref, price: 2n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [owner], label: 'list after attacks' });
    await env.chain.send([cancelListingIx({ seller: owner.publicKey, ...ref })], { signers: [owner], label: 'cancel' });
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.LISTED).toBe(0);
  });

  it('X03 deliver_sold: a wallet caller → NotProgramCaller; through the market only for LISTED chips (cancelled listing → buy fails, asset stays with the seller)', async () => {
    const seller = await env.player({ usdc: 5_000_000_000n, cg: 1_000_000_000n });
    const thief = await env.player({ sol: 30n * SOL });
    const [c] = await mintChips(env, seller, 1, valueOf('X03'));
    const ref = { asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) };

    // direct call by anyone (even with the right seller/owner) → NotProgramCaller, before any state is read
    await expectFail(
      env.chain.send([deliverSoldIx({ caller: thief.publicKey, payer: thief.publicKey, ...ref, newOwner: thief.publicKey, expectedSeller: seller.publicKey })], { signers: [thief] }),
      Err.chip('NotProgramCaller'), 'wallet deliver_sold',
    );
    // unsigned market_auth → runtime signer failure
    const f = await expectAnyFail(
      env.chain.send([deliverSoldIx({ caller: marketAuthPda()[0], payer: thief.publicKey, ...ref, newOwner: thief.publicKey, expectedSeller: seller.publicKey })], { signers: [thief] }),
      'unsigned market_auth deliver_sold',
    );
    expect(f.code === undefined || f.code === 2002).toBe(true);

    // the legitimate path needs a live listing: list → cancel → buy must fail (listing PDA gone), owner unchanged
    await env.chain.send([listIx({ seller: seller.publicKey, ...ref, price: 2n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
    await env.chain.send([cancelListingIx({ seller: seller.publicKey, ...ref })], { signers: [seller] });
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.LISTED).toBe(0);
    await expectFail(
      env.chain.send([buyIx({
        buyer: thief.publicKey, seller: seller.publicKey, ...ref, expectedPrice: 2n * SOL, expectedCurrency: MarketCurrency.SOL,
        treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc, skrMint: env.mints.skr,
      })], { signers: [thief] }),
      Err.anchor('AccountNotInitialized'), 'buy a cancelled listing',
    );
    expect(decodeCoreAssetHeader((await env.chain.getAccount(c.asset))!.data).owner.equals(seller.publicKey)).toBe(true);
  });

  it('X04 level_up: only the arena [arena_auth] PDA; owner / admin / staking PDA seeds → NotProgramCaller, level unchanged', async () => {
    const owner = await env.player({ usdc: 5_000_000_000n, cg: 1_000_000_000n });
    const [c] = await mintChips(env, owner, 1, valueOf('X04'));
    const before = (await loadChip(env.chain, c.asset))!.level;
    for (const [who, label] of [[owner, 'owner'], [env.admin, 'admin']] as const) {
      await expectFail(
        env.chain.send([levelUpIx({ caller: who.publicKey, payer: who.publicKey, asset: c.asset, levels: 1 })], { signers: [who] }),
        Err.chip('NotProgramCaller'), `level_up by ${label}`,
      );
    }
    // "arena_auth" derived under the staking program id → not the pinned arena PDA (cannot sign anyway)
    const wrongPda = PublicKey.findProgramAddressSync([Buffer.from('arena_auth')], stakeAuthPda()[0])[0];
    await expectAnyFail(env.chain.send([levelUpIx({ caller: wrongPda, payer: owner.publicKey, asset: c.asset, levels: 1 })], { signers: [owner] }), 'foreign arena_auth');
    // wrong chip PDA for the asset (seeds mismatch) is caught before the caller check matters
    const [other] = await mintChips(env, owner, 1, valueOf('X04b'));
    const bad = levelUpIx({ caller: owner.publicKey, payer: owner.publicKey, asset: c.asset, levels: 1 });
    bad.keys[4] = rw(chipStatePda(other.asset)[0]);
    await expectFail(env.chain.send([bad], { signers: [owner] }), Err.anchor('ConstraintSeeds'), 'chip PDA of another asset');
    expect((await loadChip(env.chain, c.asset))!.level).toBe(before);
  });
});

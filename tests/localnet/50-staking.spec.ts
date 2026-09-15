// T-L-S — staking / emission / Merkle roots / SKR prize pool (docs/06 §3.5 "Стейкинг").
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createTransferInstruction } from '@solana/spl-token';
import { ixData, ro, rw, signer } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import {
  CHIP_FLAG, decodeChipStake, decodeEmissionState, decodePool, decodeRewardRoot, decodeSetBonus, decodeSkrPool, decodeTokenStake,
} from '@/chain/accounts';
import { STAKING_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@/chain/ids';
import { MarketCurrency, listIx } from '@/chain/ix/market';
import { claimChipIx, claimRootIx, claimSkrRootIx, fundSkrIx, stakeCgIx, stakeChipIx, unstakeCgIx, unstakeChipIx } from '@/chain/ix/staking';
import { buildRewardTree } from '@/chain/merkle';
import { ata, chipPoolPda, chipStakePda, claimReceiptPda, emissionPda, rewardRootPda, setBonusPda, skrPoolPda, tokenPoolPda, tokenStakePda } from '@/chain/pdas';
import { EMISSION_SPLIT, RARITY_PROFILES } from '@guttercaps/economy';
import { QUEST_ORACLE, SEASON_ORACLE, SET_ORACLE, TREASURY, binariesPresent, getEnv, tokenBalance, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { loadChip, mintChips, valueOf } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const CG = 1_000_000n;
const DAY = 86_400n;
const ACC = 1_000_000_000_000n;

// ---- admin / oracle builders (no client counterparts: backend-only paths; account order = programs/staking) ----
const emissionAdmin = (name: string, admin: PublicKey, args: Uint8Array) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), rw(emissionPda()[0])], data: Buffer.from(ixData(name, args)) });
const tickDayIx = (cranker: PublicKey) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(cranker, false), rw(emissionPda()[0]), rw(tokenPoolPda()[0]), rw(chipPoolPda()[0])], data: Buffer.from(ixData('tick_day')) });
const reportBurnIx = (reporter: PublicKey, amount: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(reporter, false), rw(emissionPda()[0])], data: Buffer.from(ixData('report_burn', new BorshWriter().u64(amount).toBytes())) });
const publishRootIx = (oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle), rw(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('publish_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeRootIx = (admin: PublicKey, kind: number, epoch: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), rw(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0])], data: Buffer.from(ixData('revoke_root')) });
const syncSetBonusIx = (oracle: PublicKey, payer: PublicKey, owner: PublicKey, sets: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle, false), signer(payer), ro(emissionPda()[0]), ro(owner), rw(setBonusPda(owner)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('sync_set_bonus', new BorshWriter().u8(sets).toBytes())) });
const publishSkrRootIx = (oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle), ro(emissionPda()[0]), rw(skrPoolPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('publish_skr_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeSkrRootIx = (admin: PublicKey, kind: number, epoch: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(skrPoolPda()[0]), rw(rewardRootPda(kind, epoch)[0])], data: Buffer.from(ixData('revoke_skr_root')) });
const withdrawSkrIx = (admin: PublicKey, skrMint: PublicKey, to: PublicKey, amount: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(skrPoolPda()[0]), rw(ata(skrMint, skrPoolPda()[0])), rw(to), ro(TOKEN_PROGRAM_ID)], data: Buffer.from(ixData('withdraw_skr', new BorshWriter().u64(amount).toBytes())) });
const syncSkrPoolIx = (skrMint: PublicKey) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [rw(skrPoolPda()[0]), ro(ata(skrMint, skrPoolPda()[0]))], data: Buffer.from(ixData('sync_skr_pool')) });
const setSkrPoolIx = (admin: PublicKey, maxRootBudget: bigint | null, paused: boolean | null) => {
  const w = new BorshWriter(); w.option(maxRootBudget, (v) => w.u64(v)); w.option(paused, (v) => w.bool(v));
  return new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(skrPoolPda()[0])], data: Buffer.from(ixData('set_skr_pool', w.toBytes())) });
};

let epochCounter = 100;
const nextEpoch = () => ++epochCounter;

suite('T-L-S staking', () => {
  let env: Env;
  let staker: Keypair;
  const emission = async () => decodeEmissionState((await env.chain.getAccount(emissionPda()[0]))!.data);
  const pool = async (k: 'token' | 'chip') => decodePool((await env.chain.getAccount((k === 'token' ? tokenPoolPda : chipPoolPda)()[0]))!.data);
  const skrPool = async () => decodeSkrPool((await env.chain.getAccount(skrPoolPda()[0]))!.data);
  const skrInvariant = async () => { const p = await skrPool(); expect(await tokenBalance(env.chain, env.mints.skr, skrPoolPda()[0])).toBeGreaterThanOrEqual(p.budget + p.reserved); return p; };

  beforeAll(async () => {
    env = await getEnv();
    staker = await env.player({ usdc: 100_000_000_000n, cg: 1_000_000n * CG, skr: 1_000_000n * CG });
  });

  it('S01 init_emission state + tick_day: slices = guarded budget × split, second tick the same day → DayAlreadyClosed', async () => {
    const e0 = await emission();
    expect(e0.admin.equals(env.admin.publicKey)).toBe(true);
    expect(e0.cgMint.equals(env.mints.cg)).toBe(true);
    expect(e0.splitBps).toEqual([EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve].map((p) => p * 100));
    expect(e0.questOracle.equals(QUEST_ORACLE.publicKey)).toBe(true);
    // day 0 tick (allowed once while nothing was minted)
    await env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] });
    const e1 = await emission();
    const cp = await pool('chip'); const tp = await pool('token');
    // year 0: play bucket 550 M × 18 % / 365 = 271 232.876… $CG/day; guard with 0 burn → 30 % floor
    const dailyCap = (550_000_000n * CG * 18n) / 100n / 365n;
    const guarded = (dailyCap * 3000n) / 10_000n;
    expect(cp.budgetRemaining).toBe((guarded * BigInt(e0.splitBps[0])) / 10_000n);
    expect(tp.budgetRemaining).toBe((guarded * BigInt(e0.splitBps[1])) / 10_000n);
    expect(cp.budgetPerSec).toBe(cp.budgetRemaining / DAY);
    expect(e1.sliceBudget[2]).toBe(e0.sliceBudget[2] + (guarded * BigInt(e0.splitBps[2])) / 10_000n);
    await expectFail(env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] }), Err.staking('DayAlreadyClosed'));
  });

  it('S02 stake_cg flex → claim after 1 day = budget_per_sec × 86 400 × share (sole staker gets the whole slice); unstake returns principal', async () => {
    if (!env.chain.canWarp) return;
    const amount = 1_000n * CG;
    const before = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 0, amount, cgMint: env.mints.cg })], { signers: [staker] });
    expect(before - (await tokenBalance(env.chain, env.mints.cg, staker.publicKey))).toBe(amount);
    const st = decodeTokenStake((await env.chain.getAccount(tokenStakePda(staker.publicKey, 0)[0]))!.data);
    expect(st.amount).toBe(amount);
    expect(st.weight).toBe(amount); // flex boost 1.0
    const tp0 = await pool('token');
    await env.chain.warpSeconds(DAY);
    const b0 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 0, amount: 0n, cgMint: env.mints.cg })], { signers: [staker] }); // claim only
    const claimed = (await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b0;
    const expected = tp0.budgetPerSec * DAY > tp0.budgetRemaining ? tp0.budgetRemaining : tp0.budgetPerSec * DAY;
    // sole staker: reward = min(rate × dt, remaining); precision loss ≤ 1 micro
    expect(claimed >= expected - 1n && claimed <= expected).toBe(true);
    expect((await emission()).mintedTotal).toBeGreaterThanOrEqual(claimed);
    const b1 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 0, amount, cgMint: env.mints.cg })], { signers: [staker] });
    expect((await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b1).toBe(amount); // no penalty on flex
    // below minimum / bad tier
    await expectFail(env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 0, amount: 9n * CG, cgMint: env.mints.cg })], { signers: [staker] }), Err.staking('BelowMinimum'));
    await expectFail(env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 4, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] }), Err.staking('InvalidTier'));
  });

  it('S03 90-day tier: weight × 2.2, early exit burns 10 % of principal (record_internal_burn → burn_today), after unlock no penalty', async () => {
    const amount = 1_000n * CG;
    await env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 2, amount, cgMint: env.mints.cg })], { signers: [staker] });
    const st = decodeTokenStake((await env.chain.getAccount(tokenStakePda(staker.publicKey, 2)[0]))!.data);
    expect(st.weight).toBe((amount * 22_000n) / 10_000n);
    expect(st.unlockAt - (await env.chain.now())).toBeGreaterThanOrEqual(90n * DAY - 60n);
    const burn0 = (await emission()).burnToday;
    const b0 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 2, amount: 500n * CG, cgMint: env.mints.cg })], { signers: [staker] });
    const got = (await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b0;
    expect(got).toBeGreaterThanOrEqual(450n * CG); // 500 − 10 % penalty (+ any pending reward)
    expect(got).toBeLessThan(451n * CG + 10n * CG);
    expect((await emission()).burnToday - burn0).toBe(50n * CG);
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(90n * DAY + 1n);
    const b1 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 2, amount: 500n * CG, cgMint: env.mints.cg })], { signers: [staker] });
    expect((await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b1).toBeGreaterThanOrEqual(500n * CG);
  });

  it('S04 set_split: Δ > 10 pp or < 7 days since last change → SplitGuard; sum ≠ 10 000 → SplitSum; non-admin → has_one', async () => {
    const split = (v: number[]) => { const w = new BorshWriter(); for (const x of v) w.u16(x); return w.toBytes(); };
    await expectFail(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3000, 1500, 1700, 2300, 1501]))], { signers: [env.admin] }), Err.staking('SplitSum'));
    await expectFail(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([4001, 499, 1700, 2300, 1500]))], { signers: [env.admin] }), Err.staking('SplitGuard'), 'Δ 1 001');
    // within Δ but too soon after init (split_changed_at = init time)
    const e = await emission();
    if ((await env.chain.now()) - e.splitChangedAt < 7n * DAY) await expectFail(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3100, 1400, 1700, 2300, 1500]))], { signers: [env.admin] }), Err.staking('SplitGuard'), 'too soon');
    if (env.chain.canWarp) {
      await env.chain.warpSeconds(7n * DAY + 1n);
      await env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3100, 1400, 1700, 2300, 1500]))], { signers: [env.admin] });
      expect((await emission()).splitBps).toEqual([3100, 1400, 1700, 2300, 1500]);
      await env.chain.warpSeconds(7n * DAY + 1n);
      await env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3000, 1500, 1700, 2300, 1500]))], { signers: [env.admin] });
    }
    const stranger = await env.player();
    await expectFail(env.chain.send([emissionAdmin('set_split', stranger.publicKey, split([3000, 1500, 1700, 2300, 1500]))], { signers: [stranger] }), Err.anchor('ConstraintHasOne'));
  });

  it('S05 report_burn: only a registered program PDA ["burn_reporter"] may report; a wallet → NotBurnReporter; tick_day rolls burn_today into the ring and the guard grows', async () => {
    await expectFail(env.chain.send([reportBurnIx(env.admin.publicKey, 1n)], { signers: [env.admin] }), Err.staking('NotBurnReporter'));
    // the PDAs cannot sign from a test — covered by the CPI paths (unstake penalty above wrote burn_today) and by the guard math below
    if (!env.chain.canWarp) return;
    const e0 = await emission();
    expect(e0.burnToday).toBeGreaterThan(0n);
    await env.chain.warpSeconds(DAY);
    await env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] });
    const e1 = await emission();
    expect(e1.burnToday).toBe(0n);
    expect(e1.burnRing.reduce((s, x) => s + x, 0n)).toBeGreaterThanOrEqual(e0.burnToday);
    const dailyCap = (550_000_000n * CG * 18n) / 100n / 365n;
    const avg = e1.burnRing.reduce((s, x) => s + x, 0n) / 7n;
    const guarded = (dailyCap * 3000n) / 10_000n + (avg * 12_500n) / 10_000n;
    const cp = await pool('chip');
    expect(cp.budgetRemaining).toBe(((guarded < dailyCap ? guarded : dailyCap) * BigInt(e1.splitBps[0])) / 10_000n);
  });

  it('S06 stake_chip: CPI sets F_STAKED + freezes, weight = stake_weight × 1e6 × level × set bonus; unstake clears; staked chip cannot be listed', async () => {
    const chips = await mintChips(env, staker, 1, valueOf('S06'));
    const c = chips[0];
    await env.chain.send([stakeChipIx({ owner: staker.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) })], { signers: [staker] });
    const st = (await loadChip(env.chain, c.asset))!;
    expect(st.flags & CHIP_FLAG.STAKED).toBe(CHIP_FLAG.STAKED);
    const cs = decodeChipStake((await env.chain.getAccount(chipStakePda(c.asset)[0]))!.data);
    expect(cs.weight).toBe(BigInt(RARITY_PROFILES[c.rarity].stakeWeight) * CG);
    expect((await pool('chip')).totalWeight).toBeGreaterThanOrEqual(cs.weight);
    await expectFail(env.chain.send([listIx({ seller: staker.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price: 1_000_000_000n, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [staker] }), Err.anchor('ConstraintRaw'), 'list a staked chip');
    await expectFail(env.chain.send([stakeChipIx({ owner: staker.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) })], { signers: [staker] }), Err.anchor('ConstraintSeeds'), 'stake twice (init on live PDA)');
    if (env.chain.canWarp) {
      await env.chain.warpSeconds(3600n);
      const b0 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
      await env.chain.send([claimChipIx({ owner: staker.publicKey, asset: c.asset, cgMint: env.mints.cg })], { signers: [staker] });
      expect(await tokenBalance(env.chain, env.mints.cg, staker.publicKey)).toBeGreaterThan(b0);
      await expectFail(env.chain.send([claimChipIx({ owner: staker.publicKey, asset: c.asset, cgMint: env.mints.cg })], { signers: [staker] }), Err.staking('NothingToClaim'), 'claim twice in the same second');
    }
    await env.chain.send([unstakeChipIx({ owner: staker.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), cgMint: env.mints.cg })], { signers: [staker] });
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.STAKED).toBe(0);
    expect(await env.chain.getAccount(chipStakePda(c.asset)[0])).toBeNull();
    // someone else's chip
    const other = await env.player({ usdc: 10_000_000_000n });
    const theirs = await mintChips(env, other, 1, valueOf('S06b'));
    await expectFail(env.chain.send([stakeChipIx({ owner: staker.publicKey, asset: theirs[0].asset, collectionIdx: theirs[0].collectionIdx, coreCollection: env.coreOf(theirs[0].collectionIdx) })], { signers: [staker] }), Err.staking('NotOwner'));
  });

  it('S07 sync_set_bonus: set oracle only; 1 set → ×1.12 on the next claim re-weigh; 11 → TooManySets', async () => {
    const chips = await mintChips(env, staker, 1, valueOf('S07'));
    const c = chips[0];
    await expectFail(env.chain.send([syncSetBonusIx(env.admin.publicKey, env.admin.publicKey, staker.publicKey, 1)], { signers: [env.admin] }), Err.staking('BadOracle'), 'admin is not the set oracle');
    await expectFail(env.chain.send([syncSetBonusIx(SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 11)], { signers: [SET_ORACLE, env.admin] }), Err.staking('TooManySets'));
    await env.chain.send([syncSetBonusIx(SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 1)], { signers: [SET_ORACLE, env.admin] });
    expect(decodeSetBonus((await env.chain.getAccount(setBonusPda(staker.publicKey)[0]))!.data).completedSets).toBe(1);
    await env.chain.send([stakeChipIx({ owner: staker.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) })], { signers: [staker] });
    const cs = decodeChipStake((await env.chain.getAccount(chipStakePda(c.asset)[0]))!.data);
    expect(cs.weight).toBe((BigInt(RARITY_PROFILES[c.rarity].stakeWeight) * CG * 11_200n) / 10_000n);
    await env.chain.send([syncSetBonusIx(SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 0)], { signers: [SET_ORACLE, env.admin] });
    await env.chain.send([unstakeChipIx({ owner: staker.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), cgMint: env.mints.cg })], { signers: [staker] });
  });

  it('S08 paused emission: stake_cg → Paused, unstake still works', async () => {
    await env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] });
    await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new BorshWriter().bool(true).toBytes())], { signers: [env.admin] });
    await expectFail(env.chain.send([stakeCgIx({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] }), Err.staking('Paused'));
    await env.chain.send([unstakeCgIx({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] });
    await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new BorshWriter().bool(false).toBytes())], { signers: [env.admin] });
  });

  it('S10–S13 $CG Merkle roots: publish (oracle + slice budget), timelock, claim mints + receipt, replay refused, foreign proof, revoke returns the remainder, proof depth ≤ 24', async () => {
    const wallets = [staker, await env.player({ cg: CG }), await env.player({ cg: CG })];
    const amounts = [10n * CG, 20n * CG, 30n * CG];
    const epoch = nextEpoch();
    const kind = 2; // quests
    const { root, proofs } = buildRewardTree(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind, epoch })));
    const e0 = await emission();
    const budget = 60n * CG;
    expect(e0.sliceBudget[kind]).toBeGreaterThanOrEqual(budget);
    await expectFail(env.chain.send([publishRootIx(SEASON_ORACLE.publicKey, kind, epoch, root, budget)], { signers: [SEASON_ORACLE] }), Err.staking('BadOracle'), 'season oracle on quests kind');
    await expectFail(env.chain.send([publishRootIx(QUEST_ORACLE.publicKey, kind, epoch, root, e0.sliceBudget[kind] + 1n)], { signers: [QUEST_ORACLE] }), Err.staking('BudgetExceeded'));
    await env.chain.send([publishRootIx(QUEST_ORACLE.publicKey, kind, epoch, root, budget)], { signers: [QUEST_ORACLE] });
    expect((await emission()).sliceBudget[kind]).toBe(e0.sliceBudget[kind] - budget);
    const rr = decodeRewardRoot((await env.chain.getAccount(rewardRootPda(kind, epoch)[0]))!.data);
    expect(Array.from(rr.root)).toEqual(Array.from(root));
    const claim = (i: number, amount = amounts[i], proof = proofs[i]) => env.chain.send([claimRootIx({ wallet: wallets[i].publicKey, kind, epoch, amount, proof, cgMint: env.mints.cg })], { signers: [wallets[i]] });
    await expectFail(claim(0), Err.staking('RootTimelocked'));
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const b0 = await tokenBalance(env.chain, env.mints.cg, wallets[0].publicKey);
    await claim(0);
    expect((await tokenBalance(env.chain, env.mints.cg, wallets[0].publicKey)) - b0).toBe(amounts[0]);
    expect(await env.chain.getAccount(claimReceiptPda(rewardRootPda(kind, epoch)[0], wallets[0].publicKey)[0])).not.toBeNull();
    await expectAnyFail(claim(0), 'claim twice (receipt init)');
    await expectFail(claim(1, 21n * CG), Err.staking('BadProof'), 'wrong amount');
    await expectFail(claim(1, amounts[1], proofs[2]), Err.staking('BadProof'), 'foreign proof');
    await expectFail(claim(1, amounts[1], Array.from({ length: 25 }, () => new Uint8Array(32))), Err.staking('BadProof'), '25-deep proof');
    // SKR kinds are rejected by the $CG claim path
    await expectFail(env.chain.send([publishRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, budget)], { signers: [QUEST_ORACLE] }), Err.staking('BadOracle'), 'kind 5 via publish_root');
    // revoke → remainder back to the slice, further claims → RootRevoked
    const e1 = await emission();
    await expectFail(env.chain.send([revokeRootIx(QUEST_ORACLE.publicKey, kind, epoch)], { signers: [QUEST_ORACLE] }), Err.anchor('ConstraintHasOne'), 'oracle revokes');
    await env.chain.send([revokeRootIx(env.admin.publicKey, kind, epoch)], { signers: [env.admin] });
    expect((await emission()).sliceBudget[kind]).toBe(e1.sliceBudget[kind] + budget - amounts[0]);
    await expectFail(claim(1), Err.staking('RootRevoked'));
    await expectFail(env.chain.send([revokeRootIx(env.admin.publicKey, kind, epoch)], { signers: [env.admin] }), Err.staking('RootRevoked'), 'revoke twice');
  });

  it('S14 SKR pool: init state (max_root_budget = 100 000 SKR default), fund_skr moves SKR → budget, SkrFunded; zero → ZeroAmount', async () => {
    const p0 = await skrInvariant();
    expect(p0.skrMint.equals(env.mints.skr)).toBe(true);
    expect(p0.vault.equals(ata(env.mints.skr, skrPoolPda()[0]))).toBe(true);
    expect(p0.maxRootBudget).toBe(100_000n * CG);
    expect(p0.paused).toBe(false);
    await env.chain.send([fundSkrIx({ funder: staker.publicKey, amount: 1_000n * CG, skrMint: env.mints.skr })], { signers: [staker] });
    const p1 = await skrInvariant();
    expect(p1.budget).toBe(p0.budget + 1_000n * CG);
    expect(p1.fundedTotal).toBe(p0.fundedTotal + 1_000n * CG);
    await expectFail(env.chain.send([fundSkrIx({ funder: staker.publicKey, amount: 0n, skrMint: env.mints.skr })], { signers: [staker] }), Err.staking('ZeroAmount'));
  });

  it('S15–S17 SKR roots: publish_skr_root(kind 5) by the quest oracle reserves budget; wrong oracle / kind / over budget rejected; claim transfers from the vault; revoke returns the remainder', async () => {
    const wallets = [staker, await env.player({ skr: CG })];
    const amounts = [100n * CG, 200n * CG];
    const epoch = nextEpoch();
    const { root, proofs } = buildRewardTree(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind: 5, epoch })));
    const p0 = await skrInvariant();
    await expectFail(env.chain.send([publishSkrRootIx(SEASON_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [SEASON_ORACLE] }), Err.staking('BadOracle'), 'season oracle on kind 5');
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 6, epoch, root, 300n * CG)], { signers: [QUEST_ORACLE] }), Err.staking('BadOracle'), 'quest oracle on kind 6');
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 2, epoch, root, 300n * CG)], { signers: [QUEST_ORACLE] }), Err.staking('WrongRootCurrency'), '$CG kind via SKR path');
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, p0.budget + 1n)], { signers: [QUEST_ORACLE] }), Err.staking('SkrBudgetExceeded'), 'over budget');
    await env.chain.send([setSkrPoolIx(env.admin.publicKey, 250n * CG, null)], { signers: [env.admin] });
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [QUEST_ORACLE] }), Err.staking('SkrBudgetExceeded'), 'over per-root cap');
    await env.chain.send([setSkrPoolIx(env.admin.publicKey, 100_000n * CG, null)], { signers: [env.admin] });
    await env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [QUEST_ORACLE] });
    const p1 = await skrInvariant();
    expect(p1.budget).toBe(p0.budget - 300n * CG);
    expect(p1.reserved).toBe(p0.reserved + 300n * CG);
    const claim = (i: number) => env.chain.send([claimSkrRootIx({ wallet: wallets[i].publicKey, kind: 5, epoch, amount: amounts[i], proof: proofs[i], skrMint: env.mints.skr })], { signers: [wallets[i]] });
    await expectFail(claim(0), Err.staking('RootTimelocked'));
    // the same leaf through the $CG path → WrongRootCurrency
    await expectFail(env.chain.send([claimRootIx({ wallet: wallets[0].publicKey, kind: 2, epoch, amount: amounts[0], proof: proofs[0], cgMint: env.mints.cg })], { signers: [wallets[0]] }), Err.anchor('AccountNotInitialized'), 'kind 2 root of this epoch does not exist');
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const s0 = await tokenBalance(env.chain, env.mints.skr, wallets[0].publicKey);
    await claim(0);
    expect((await tokenBalance(env.chain, env.mints.skr, wallets[0].publicKey)) - s0).toBe(amounts[0]);
    const p2 = await skrInvariant();
    expect(p2.reserved).toBe(p1.reserved - amounts[0]);
    expect(p2.paidTotal).toBe(p1.paidTotal + amounts[0]);
    await expectAnyFail(claim(0), 'claim twice');
    // revoke_root (the $CG admin path) on an SKR kind → WrongRootCurrency; revoke_skr_root returns the remainder
    await expectFail(env.chain.send([revokeRootIx(env.admin.publicKey, 5, epoch)], { signers: [env.admin] }), Err.staking('WrongRootCurrency'));
    await env.chain.send([revokeSkrRootIx(env.admin.publicKey, 5, epoch)], { signers: [env.admin] });
    const p3 = await skrInvariant();
    expect(p3.reserved).toBe(p2.reserved - amounts[1]);
    expect(p3.budget).toBe(p2.budget + amounts[1]);
    await expectFail(claim(1), Err.staking('RootRevoked'));
  });

  it('S18–S20 withdraw_skr only from unreserved budget; sync_skr_pool absorbs direct transfers; pause blocks publish/claim but not fund', async () => {
    const p0 = await skrInvariant();
    await expectFail(env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, ata(env.mints.skr, TREASURY.publicKey), p0.budget + 1n)], { signers: [env.admin] }), Err.staking('SkrBudgetExceeded'));
    const t0 = await tokenBalance(env.chain, env.mints.skr, TREASURY.publicKey);
    await env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, ata(env.mints.skr, TREASURY.publicKey), p0.budget)], { signers: [env.admin] });
    expect((await tokenBalance(env.chain, env.mints.skr, TREASURY.publicKey)) - t0).toBe(p0.budget);
    const p1 = await skrInvariant();
    expect(p1.budget).toBe(0n);
    // direct SPL transfer + permissionless sync
    await env.chain.send([createTransferInstruction(ata(env.mints.skr, staker.publicKey), ata(env.mints.skr, skrPoolPda()[0]), staker.publicKey, 77n * CG)], { signers: [staker] });
    await env.chain.send([syncSkrPoolIx(env.mints.skr)], { signers: [env.admin] });
    const p2 = await skrInvariant();
    expect(p2.budget).toBe(77n * CG);
    expect(p2.fundedTotal).toBe(p1.fundedTotal + 77n * CG);
    // pause
    await env.chain.send([setSkrPoolIx(env.admin.publicKey, null, true)], { signers: [env.admin] });
    const epoch = nextEpoch();
    const { root } = buildRewardTree([{ wallet: staker.publicKey, amountMicro: CG, kind: 5, epoch }]);
    await expectFail(env.chain.send([publishSkrRootIx(QUEST_ORACLE.publicKey, 5, epoch, root, CG)], { signers: [QUEST_ORACLE] }), Err.staking('SkrPoolPaused'));
    await env.chain.send([fundSkrIx({ funder: staker.publicKey, amount: CG, skrMint: env.mints.skr })], { signers: [staker] });
    await env.chain.send([setSkrPoolIx(env.admin.publicKey, null, false)], { signers: [env.admin] });
    const stranger = await env.player();
    await expectFail(env.chain.send([setSkrPoolIx(stranger.publicKey, null, true)], { signers: [stranger] }), Err.anchor('ConstraintHasOne'));
    await skrInvariant();
    expect(ACC).toBe(1_000_000_000_000n);
  });
});

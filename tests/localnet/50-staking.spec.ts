// T-L-S — staking / emission / Merkle roots / SKR prize pool (docs/06 §3.5 "Стейкинг").
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createTransferInstruction } from '@solana/spl-token';
import { ixData, ro, rw, signer } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import {
  CHIP_FLAG, decodeChipStake, decodeEmissionState, decodePlayerItems, decodePool, decodeRewardRoot, decodeSetBonus, decodeSkrPool, decodeTokenStake,
} from '@/chain/accounts';
import { STAKING_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@/chain/ids';
import { MarketCurrency, listIx } from '@/chain/ix/market';
import { claimChipIx, claimItemRootIx, claimRootIx, claimSkrRootIx, fundSkrIx, fundSliceIx, stakeCgIx, stakeChipIx, unstakeCgIx, unstakeChipIx } from '@/chain/ix/staking';
import { buildRewardTree } from '@/chain/merkle';
import { ata, chipPoolPda, chipStakePda, claimReceiptPda, emissionPda, playerItemsPda, rewardRootPda, seasonPoolAuthPda, setBonusPda, skrPoolPda, tokenPoolPda, tokenStakePda } from '@/chain/pdas';
import { EMISSION_SPLIT, RARITY_PROFILES } from '@guttercaps/economy';
import { QUEST_ORACLE, SEASON_ORACLE, SET_ORACLE, TREASURY, binariesPresent, getEnv, mintCg, tokenBalance, type Env } from './helpers/env';
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
/** set_oracles(OraclePatch { quest?, season?, set?, burn? }) — SEC-M1 added `burn_oracle` as the 4th Option */
const setOraclesIx = (admin: PublicKey, p: { quest?: PublicKey; season?: PublicKey; set?: PublicKey; burn?: PublicKey }) => {
  const w = new BorshWriter();
  for (const k of [p.quest, p.season, p.set, p.burn]) w.option(k, (v) => w.pubkey(v));
  return emissionAdmin('set_oracles', admin, w.toBytes());
};
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
const publishItemRootIx = (oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(oracle), ro(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)], data: Buffer.from(ixData('publish_item_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeItemRootIx = (admin: PublicKey, kind: number, epoch: number) =>
  new TransactionInstruction({ programId: STAKING_ID, keys: [signer(admin, false), ro(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0])], data: Buffer.from(ixData('revoke_item_root')) });
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

  it('S05 report_burn: a wallet → NotBurnReporter; SEC-M1 burn oracle (set_oracles) may report, clamped at 3 × daily cap; admin clears it; tick_day rolls burn_today into the ring and the guard grows', async () => {
    const dailyCap = (550_000_000n * CG * 18n) / 100n / 365n;
    await expectFail(env.chain.send([reportBurnIx(env.admin.publicKey, 1n)], { signers: [env.admin] }), Err.staking('NotBurnReporter'), 'admin is not a reporter');
    const burnOracle = await env.player();
    await expectFail(env.chain.send([reportBurnIx(burnOracle.publicKey, 1n)], { signers: [burnOracle] }), Err.staking('NotBurnReporter'), 'before designation');
    // only the admin may designate; other oracles untouched by a burn-only patch
    await expectFail(env.chain.send([setOraclesIx(burnOracle.publicKey, { burn: burnOracle.publicKey })], { signers: [burnOracle] }), Err.anchor('ConstraintHasOne'), 'stranger set_oracles');
    const before = await emission();
    await env.chain.send([setOraclesIx(env.admin.publicKey, { burn: burnOracle.publicKey })], { signers: [env.admin] });
    const e0 = await emission();
    expect(e0.burnOracle.equals(burnOracle.publicKey)).toBe(true);
    expect(e0.questOracle.equals(before.questOracle) && e0.seasonOracle.equals(before.seasonOracle) && e0.setOracle.equals(before.setOracle)).toBe(true);
    // the oracle reports; burn_today grows by exactly the amount…
    await env.chain.send([reportBurnIx(burnOracle.publicKey, 7n * CG)], { signers: [burnOracle] });
    expect((await emission()).burnToday).toBe(e0.burnToday + 7n * CG);
    // …and is clamped at BURN_SANITY_MULT × daily cap — a lying oracle cannot push the guard past the schedule
    await env.chain.send([reportBurnIx(burnOracle.publicKey, 10n * dailyCap)], { signers: [burnOracle] });
    expect((await emission()).burnToday).toBe(3n * dailyCap);
    // Pubkey::default() clears the role
    await env.chain.send([setOraclesIx(env.admin.publicKey, { burn: PublicKey.default })], { signers: [env.admin] });
    await expectFail(env.chain.send([reportBurnIx(burnOracle.publicKey, 1n)], { signers: [burnOracle] }), Err.staking('NotBurnReporter'), 'cleared oracle');
    // program PDAs cannot sign from a test — the CPI path is covered by the unstake penalty (record_internal_burn) and the guard math below
    if (!env.chain.canWarp) return;
    const e1 = await emission();
    expect(e1.burnToday).toBeGreaterThan(0n);
    await env.chain.warpSeconds(DAY);
    await env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] });
    const e2 = await emission();
    expect(e2.burnToday).toBe(0n);
    expect(e2.burnRing.reduce((s, x) => s + x, 0n)).toBeGreaterThanOrEqual(e1.burnToday);
    const avg = e2.burnRing.reduce((s, x) => s + x, 0n) / 7n;
    const guarded = (dailyCap * 3000n) / 10_000n + (avg * 12_500n) / 10_000n;
    const cp = await pool('chip');
    // 3 × cap in one ring slot → 7-day average 0.43 × cap → guard = 0.30 + 1.25 × 0.43 ≈ 0.84 × cap (below the ceiling): the guard really moved off the floor
    expect(guarded).toBeGreaterThan((dailyCap * 3000n) / 10_000n);
    expect(cp.budgetRemaining).toBe(((guarded < dailyCap ? guarded : dailyCap) * BigInt(e2.splitBps[0])) / 10_000n);
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
    await expectFail(env.chain.send([listIx({ seller: staker.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price: 1_000_000_000n, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [staker] }), Err.chip('ChipNotFree'), 'list a staked chip (market has no STAKED check; chip_core set_chip_flag refuses via CPI)');
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

  it('S22 item roots (#27): publish_item_root(kind 8) by the quest oracle only, caps 1 000 / 10, claim_item_root CPIs grant_booster via ["rewarder"] → PlayerItems, receipt blocks replay, revoke blocks claims', async () => {
    const wallets = [staker, await env.player(), await env.player()];
    const amounts = [2n, 10n, 11n]; // boosters; the 11 leaf must be refused at claim (chip_core count ≤ 10)
    const epoch = nextEpoch();
    const { root, proofs } = buildRewardTree(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind: 8, epoch })));
    await expectFail(env.chain.send([publishItemRootIx(SEASON_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [SEASON_ORACLE] }), Err.staking('BadOracle'), 'season oracle on kind 8');
    await expectFail(env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 2, epoch, root, 23n)], { signers: [QUEST_ORACLE] }), Err.staking('WrongRootCurrency'), '$CG kind via item path');
    await expectFail(env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 1_001n)], { signers: [QUEST_ORACLE] }), Err.staking('ItemBudgetExceeded'), 'over per-root cap');
    await expectFail(env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 0n)], { signers: [QUEST_ORACLE] }), Err.staking('ZeroAmount'));
    await expectFail(env.chain.send([publishRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [QUEST_ORACLE] }), Err.staking('BadOracle'), 'kind 8 via publish_root');
    const e0 = await emission();
    await env.chain.send([publishItemRootIx(QUEST_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [QUEST_ORACLE] });
    expect((await emission()).sliceBudget).toEqual(e0.sliceBudget); // nothing reserved from any slice
    const rr = decodeRewardRoot((await env.chain.getAccount(rewardRootPda(8, epoch)[0]))!.data);
    expect(rr.kind).toBe(8); expect(rr.budget).toBe(23n);
    const claim = (i: number, amount = amounts[i], proof = proofs[i]) => env.chain.send([claimItemRootIx({ wallet: wallets[i].publicKey, kind: 8, epoch, amount, proof })], { signers: [wallets[i]] });
    await expectFail(claim(0), Err.staking('RootTimelocked'));
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const boosters = async (w: Keypair) => { const a = await env.chain.getAccount(playerItemsPda(w.publicKey)[0]); return a ? decodePlayerItems(a.data).boosters : 0; };
    const b0 = await boosters(wallets[0]);
    await claim(0);
    expect((await boosters(wallets[0])) - b0).toBe(2);          // PlayerItems credited by the CPI (created on first claim if needed)
    expect(await env.chain.getAccount(claimReceiptPda(rewardRootPda(8, epoch)[0], wallets[0].publicKey)[0])).not.toBeNull();
    await expectAnyFail(claim(0), 'claim twice (receipt init)');
    await expectFail(claim(1, 9n), Err.staking('BadProof'), 'wrong amount');
    await claim(1);
    expect(await boosters(wallets[1])).toBe(10);
    expect(decodeRewardRoot((await env.chain.getAccount(rewardRootPda(8, epoch)[0]))!.data).claimed).toBe(12n);
    // the 11-booster leaf is refused client-side and on-chain (per-claim cap = chip_core grant_booster cap)
    expect(() => claimItemRootIx({ wallet: wallets[2].publicKey, kind: 8, epoch, amount: 11n, proof: proofs[2] })).toThrow(/1\.\.10/);
    // a $CG / SKR claim on the item root → WrongRootCurrency
    await expectFail(env.chain.send([claimRootIx({ wallet: wallets[1].publicKey, kind: 2, epoch, amount: amounts[1], proof: proofs[1], cgMint: env.mints.cg })], { signers: [wallets[1]] }), Err.anchor('AccountNotInitialized'), 'kind 2 root of this epoch does not exist');
    // revoke: $CG admin path refuses the kind; revoke_item_root blocks further claims (nothing to refund)
    await expectFail(env.chain.send([revokeRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] }), Err.staking('WrongRootCurrency'));
    await expectFail(env.chain.send([revokeItemRootIx(QUEST_ORACLE.publicKey, 8, epoch)], { signers: [QUEST_ORACLE] }), Err.anchor('ConstraintHasOne'), 'oracle revokes');
    await env.chain.send([revokeItemRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] });
    await expectFail(claim(2, 10n, proofs[2]), Err.staking('RootRevoked'));
    await expectFail(env.chain.send([revokeItemRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] }), Err.staking('RootRevoked'), 'revoke twice');
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

  it('S21 SEC-L5 fund_slice: season oracle / admin burn the season pool into slice_budget[3] (recycled_total, SliceFunded); wrong kind / zero / over balance / stranger / quest oracle rejected; a kind-3 claim of the recycled amount leaves minted_total untouched', async () => {
    // the arena's season pool = $CG ATA of staking's ["season_pool"] PDA; seed it like resolve_battle would (rake_pool transfer)
    const poolAuth = seasonPoolAuthPda()[0];
    await mintCg(env.chain, env.admin, env.mints.cg, poolAuth, 10n * CG);
    const e0 = await emission();
    const supply0 = await tokenBalance(env.chain, env.mints.cg, poolAuth);
    expect(supply0).toBeGreaterThanOrEqual(10n * CG);
    const fund = (authority: Keypair, amount: bigint, kind?: number) => env.chain.send([fundSliceIx({ authority: authority.publicKey, amount, cgMint: env.mints.cg, kind })], { signers: [authority] });
    await expectFail(fund(SEASON_ORACLE, CG, 2), Err.staking('WrongSlice'), 'quests slice has no token source');
    await expectFail(fund(SEASON_ORACLE, 0n), Err.staking('ZeroAmount'));
    await expectFail(fund(SEASON_ORACLE, supply0 + 1n), Err.staking('InsufficientPool'));
    await expectFail(fund(QUEST_ORACLE, CG), Err.staking('Unauthorized'), 'quest oracle');
    await expectFail(fund(staker, CG), Err.staking('Unauthorized'), 'stranger');
    // season oracle recycles 4 $CG: pool −4, slice[3] +4, recycled_total +4, burn ring untouched (not demand)
    await fund(SEASON_ORACLE, 4n * CG);
    const e1 = await emission();
    expect((await tokenBalance(env.chain, env.mints.cg, poolAuth))).toBe(supply0 - 4n * CG);
    expect(e1.sliceBudget[3]).toBe(e0.sliceBudget[3] + 4n * CG);
    expect(e1.recycledTotal).toBe(e0.recycledTotal + 4n * CG);
    expect(e1.burnToday).toBe(e0.burnToday);
    expect(e1.mintedTotal).toBe(e0.mintedTotal);
    // admin may fund too
    await fund(env.admin, CG);
    expect((await emission()).recycledTotal).toBe(e0.recycledTotal + 5n * CG);
    // paused → blocked (like publish_root), unpause restores
    await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new BorshWriter().bool(true).toBytes())], { signers: [env.admin] });
    await expectFail(fund(SEASON_ORACLE, CG), Err.staking('Paused'));
    await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new BorshWriter().bool(false).toBytes())], { signers: [env.admin] });
    // a kind-3 root paid from the recycled budget: claim mints 3 $CG but minted_total (schedule) does not move, recycled_minted does
    const epoch = nextEpoch();
    const { root, proofs } = buildRewardTree([{ wallet: staker.publicKey, amountMicro: 3n * CG, kind: 3, epoch }]);
    await env.chain.send([publishRootIx(SEASON_ORACLE.publicKey, 3, epoch, root, 3n * CG)], { signers: [SEASON_ORACLE] });
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(3601n);
    const e2 = await emission();
    const b0 = await tokenBalance(env.chain, env.mints.cg, staker.publicKey);
    await env.chain.send([claimRootIx({ wallet: staker.publicKey, kind: 3, epoch, amount: 3n * CG, proof: proofs[0], cgMint: env.mints.cg })], { signers: [staker] });
    const e3 = await emission();
    expect((await tokenBalance(env.chain, env.mints.cg, staker.publicKey)) - b0).toBe(3n * CG);
    expect(e3.mintedTotal).toBe(e2.mintedTotal);
    expect(e3.recycledMinted).toBe(e2.recycledMinted + 3n * CG);
    expect(e3.recycledMinted).toBeLessThanOrEqual(e3.recycledTotal);
  });
});

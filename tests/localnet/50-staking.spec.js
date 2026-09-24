"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-L-S — staking / emission / Merkle roots / SKR prize pool (docs/06 §3.5 "Стейкинг").
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const anchor_1 = require("@/chain/anchor");
const borsh_1 = require("@/chain/borsh");
const accounts_1 = require("@/chain/accounts");
const ids_1 = require("@/chain/ids");
const market_1 = require("@/chain/ix/market");
const staking_1 = require("@/chain/ix/staking");
const rng_1 = require("@/chain/ix/rng");
const merkle_1 = require("@/chain/merkle");
const pdas_1 = require("@/chain/pdas");
const economy_1 = require("@guttercaps/economy");
const env_1 = require("./helpers/env");
const expect_1 = require("./helpers/expect");
const flows_1 = require("./helpers/flows");
const sbmock_1 = require("./helpers/sbmock");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const CG = 1000000n;
const DAY = 86400n;
const ACC = 1000000000000n;
// ---- admin / oracle builders (no client counterparts: backend-only paths; account order = programs/staking) ----
const emissionAdmin = (name, admin, args) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0])], data: Buffer.from((0, anchor_1.ixData)(name, args)) });
const tickDayIx = (cranker) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(cranker, false), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.tokenPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('tick_day')) });
const reportBurnIx = (reporter, amount) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(reporter, false), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('report_burn', new borsh_1.BorshWriter().u64(amount).toBytes())) });
/** set_oracles(OraclePatch { quest?, season?, set?, burn? }) — SEC-M1 added `burn_oracle` as the 4th Option */
const setOraclesIx = (admin, p) => {
    const w = new borsh_1.BorshWriter();
    for (const k of [p.quest, p.season, p.set, p.burn])
        w.option(k, (v) => w.pubkey(v));
    return emissionAdmin('set_oracles', admin, w.toBytes());
};
const publishRootIx = (oracle, kind, epoch, root, budget) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(oracle), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.rewardRootPda)(kind, epoch)[0]), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)], data: Buffer.from((0, anchor_1.ixData)('publish_root', new borsh_1.BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeRootIx = (admin, kind, epoch) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.rewardRootPda)(kind, epoch)[0])], data: Buffer.from((0, anchor_1.ixData)('revoke_root')) });
const syncSetBonusIx = (oracle, payer, owner, sets) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(oracle, false), (0, anchor_1.signer)(payer), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.ro)(owner), (0, anchor_1.rw)((0, pdas_1.setBonusPda)(owner)[0]), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)], data: Buffer.from((0, anchor_1.ixData)('sync_set_bonus', new borsh_1.BorshWriter().u8(sets).toBytes())) });
const publishSkrRootIx = (oracle, kind, epoch, root, budget) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(oracle), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.skrPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.rewardRootPda)(kind, epoch)[0]), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)], data: Buffer.from((0, anchor_1.ixData)('publish_skr_root', new borsh_1.BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeSkrRootIx = (admin, kind, epoch) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.skrPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.rewardRootPda)(kind, epoch)[0])], data: Buffer.from((0, anchor_1.ixData)('revoke_skr_root')) });
const withdrawSkrIx = (admin, skrMint, to, amount) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.skrPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.ata)(skrMint, (0, pdas_1.skrPoolPda)()[0])), (0, anchor_1.rw)(to), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID)], data: Buffer.from((0, anchor_1.ixData)('withdraw_skr', new borsh_1.BorshWriter().u64(amount).toBytes())) });
const syncSkrPoolIx = (skrMint) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.rw)((0, pdas_1.skrPoolPda)()[0]), (0, anchor_1.ro)((0, pdas_1.ata)(skrMint, (0, pdas_1.skrPoolPda)()[0]))], data: Buffer.from((0, anchor_1.ixData)('sync_skr_pool')) });
const publishItemRootIx = (oracle, kind, epoch, root, budget) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(oracle), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.rewardRootPda)(kind, epoch)[0]), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)], data: Buffer.from((0, anchor_1.ixData)('publish_item_root', new borsh_1.BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeItemRootIx = (admin, kind, epoch) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.rewardRootPda)(kind, epoch)[0])], data: Buffer.from((0, anchor_1.ixData)('revoke_item_root')) });
const publishChipRootIx = (oracle, kind, epoch, root, budget) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(oracle), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.rewardRootPda)(kind, epoch)[0]), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)], data: Buffer.from((0, anchor_1.ixData)('publish_chip_root', new borsh_1.BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes())) });
const revokeChipRootIx = (admin, kind, epoch) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.rewardRootPda)(kind, epoch)[0])], data: Buffer.from((0, anchor_1.ixData)('revoke_chip_root')) });
const setSkrPoolIx = (admin, maxRootBudget, paused) => {
    const w = new borsh_1.BorshWriter();
    w.option(maxRootBudget, (v) => w.u64(v));
    w.option(paused, (v) => w.bool(v));
    return new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.skrPoolPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('set_skr_pool', w.toBytes())) });
};
/** claim_item_root with an arbitrary kind — claimItemRootIx guards the kind client-side (correctly), but the
 *  "wrong root currency" negative has to reach the chain to prove the on-chain check fires (S23). */
const claimItemRootRawIx = (wallet, kind, epoch, amount, proof) => {
    const [root] = (0, pdas_1.rewardRootPda)(kind, epoch);
    const w = new borsh_1.BorshWriter().u64(amount);
    w.vec(proof, (p) => w.bytes(p));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(wallet), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)(root), (0, anchor_1.rw)((0, pdas_1.claimReceiptPda)(root, wallet)[0]),
            (0, anchor_1.ro)((0, pdas_1.rewarderPda)()[0]), (0, anchor_1.ro)((0, pdas_1.configPda)()[0]), (0, anchor_1.rw)((0, pdas_1.playerItemsPda)(wallet)[0]), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('claim_item_root', w.toBytes())),
    });
};
let epochCounter = 100;
const nextEpoch = () => ++epochCounter;
suite('T-L-S staking', () => {
    let env;
    let staker;
    const emission = async () => (0, accounts_1.decodeEmissionState)((await env.chain.getAccount((0, pdas_1.emissionPda)()[0])).data);
    const pool = async (k) => (0, accounts_1.decodePool)((await env.chain.getAccount((k === 'token' ? pdas_1.tokenPoolPda : pdas_1.chipPoolPda)()[0])).data);
    const skrPool = async () => (0, accounts_1.decodeSkrPool)((await env.chain.getAccount((0, pdas_1.skrPoolPda)()[0])).data);
    const skrInvariant = async () => { const p = await skrPool(); (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.skr, (0, pdas_1.skrPoolPda)()[0])).toBeGreaterThanOrEqual(p.budget + p.reserved); return p; };
    (0, vitest_1.beforeAll)(async () => {
        env = await (0, env_1.getEnv)();
        staker = await env.player({ usdc: 100000000000n, cg: 1000000n * CG, skr: 1000000n * CG });
    });
    (0, vitest_1.it)('S01 init_emission state + tick_day: slices = guarded budget × split, second tick the same day → DayAlreadyClosed', async () => {
        const e0 = await emission();
        (0, vitest_1.expect)(e0.admin.equals(env.admin.publicKey)).toBe(true);
        (0, vitest_1.expect)(e0.cgMint.equals(env.mints.cg)).toBe(true);
        (0, vitest_1.expect)(e0.splitBps).toEqual([economy_1.EMISSION_SPLIT.chipStaking, economy_1.EMISSION_SPLIT.tokenStaking, economy_1.EMISSION_SPLIT.quests, economy_1.EMISSION_SPLIT.pvpSeason, economy_1.EMISSION_SPLIT.eventsReserve].map((p) => p * 100));
        (0, vitest_1.expect)(e0.questOracle.equals(env_1.QUEST_ORACLE.publicKey)).toBe(true);
        // day 0 tick (allowed once while nothing was minted)
        await env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] });
        const e1 = await emission();
        const cp = await pool('chip');
        const tp = await pool('token');
        // year 0: play bucket 550 M × 18 % / 365 = 271 232.876… $CG/day; guard with 0 burn → 30 % floor
        const dailyCap = (550000000n * CG * 18n) / 100n / 365n;
        const guarded = (dailyCap * 3000n) / 10000n;
        (0, vitest_1.expect)(cp.budgetRemaining).toBe((guarded * BigInt(e0.splitBps[0])) / 10000n);
        (0, vitest_1.expect)(tp.budgetRemaining).toBe((guarded * BigInt(e0.splitBps[1])) / 10000n);
        (0, vitest_1.expect)(cp.budgetPerSec).toBe(cp.budgetRemaining / DAY);
        (0, vitest_1.expect)(e1.sliceBudget[2]).toBe(e0.sliceBudget[2] + (guarded * BigInt(e0.splitBps[2])) / 10000n);
        await (0, expect_1.expectFail)(env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] }), expect_1.Err.staking('DayAlreadyClosed'));
    });
    (0, vitest_1.it)('S02 stake_cg flex → claim after 1 day = budget_per_sec × 86 400 × share (sole staker gets the whole slice); unstake returns principal', async () => {
        if (!env.chain.canWarp)
            return;
        const amount = 1000n * CG;
        const before = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey);
        await env.chain.send([(0, staking_1.stakeCgIx)({ owner: staker.publicKey, tier: 0, amount, cgMint: env.mints.cg })], { signers: [staker] });
        (0, vitest_1.expect)(before - (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey))).toBe(amount);
        const st = (0, accounts_1.decodeTokenStake)((await env.chain.getAccount((0, pdas_1.tokenStakePda)(staker.publicKey, 0)[0])).data);
        (0, vitest_1.expect)(st.amount).toBe(amount);
        (0, vitest_1.expect)(st.weight).toBe(amount); // flex boost 1.0
        const tp0 = await pool('token');
        await env.chain.warpSeconds(DAY);
        const b0 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey);
        await env.chain.send([(0, staking_1.unstakeCgIx)({ owner: staker.publicKey, tier: 0, amount: 0n, cgMint: env.mints.cg })], { signers: [staker] }); // claim only
        const claimed = (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey)) - b0;
        const expected = tp0.budgetPerSec * DAY > tp0.budgetRemaining ? tp0.budgetRemaining : tp0.budgetPerSec * DAY;
        // sole staker: reward = min(rate × dt, remaining); precision loss ≤ 1 micro
        (0, vitest_1.expect)(claimed >= expected - 1n && claimed <= expected).toBe(true);
        (0, vitest_1.expect)((await emission()).mintedTotal).toBeGreaterThanOrEqual(claimed);
        const b1 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey);
        await env.chain.send([(0, staking_1.unstakeCgIx)({ owner: staker.publicKey, tier: 0, amount, cgMint: env.mints.cg })], { signers: [staker] });
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey)) - b1).toBe(amount); // no penalty on flex
        // below minimum / bad tier
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.stakeCgIx)({ owner: staker.publicKey, tier: 0, amount: 9n * CG, cgMint: env.mints.cg })], { signers: [staker] }), expect_1.Err.staking('BelowMinimum'));
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.stakeCgIx)({ owner: staker.publicKey, tier: 4, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] }), expect_1.Err.staking('InvalidTier'));
    });
    (0, vitest_1.it)('S03 90-day tier: weight × 2.2, early exit burns 10 % of principal (record_internal_burn → burn_today), after unlock no penalty', async () => {
        const amount = 1000n * CG;
        await env.chain.send([(0, staking_1.stakeCgIx)({ owner: staker.publicKey, tier: 2, amount, cgMint: env.mints.cg })], { signers: [staker] });
        const st = (0, accounts_1.decodeTokenStake)((await env.chain.getAccount((0, pdas_1.tokenStakePda)(staker.publicKey, 2)[0])).data);
        (0, vitest_1.expect)(st.weight).toBe((amount * 22000n) / 10000n);
        (0, vitest_1.expect)(st.unlockAt - (await env.chain.now())).toBeGreaterThanOrEqual(90n * DAY - 60n);
        const burn0 = (await emission()).burnToday;
        const b0 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey);
        await env.chain.send([(0, staking_1.unstakeCgIx)({ owner: staker.publicKey, tier: 2, amount: 500n * CG, cgMint: env.mints.cg })], { signers: [staker] });
        const got = (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey)) - b0;
        (0, vitest_1.expect)(got).toBeGreaterThanOrEqual(450n * CG); // 500 − 10 % penalty (+ any pending reward)
        (0, vitest_1.expect)(got).toBeLessThan(451n * CG + 10n * CG);
        (0, vitest_1.expect)((await emission()).burnToday - burn0).toBe(50n * CG);
        if (!env.chain.canWarp)
            return;
        await env.chain.warpSeconds(90n * DAY + 1n);
        const b1 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey);
        await env.chain.send([(0, staking_1.unstakeCgIx)({ owner: staker.publicKey, tier: 2, amount: 500n * CG, cgMint: env.mints.cg })], { signers: [staker] });
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey)) - b1).toBeGreaterThanOrEqual(500n * CG);
    });
    (0, vitest_1.it)('S04 set_split: Δ > 10 pp or < 7 days since last change → SplitGuard; sum ≠ 10 000 → SplitSum; non-admin → has_one', async () => {
        const split = (v) => { const w = new borsh_1.BorshWriter(); for (const x of v)
            w.u16(x); return w.toBytes(); };
        await (0, expect_1.expectFail)(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3000, 1500, 1700, 2300, 1501]))], { signers: [env.admin] }), expect_1.Err.staking('SplitSum'));
        await (0, expect_1.expectFail)(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([4001, 499, 1700, 2300, 1500]))], { signers: [env.admin] }), expect_1.Err.staking('SplitGuard'), 'Δ 1 001');
        // within Δ but too soon after init (split_changed_at = init time)
        const e = await emission();
        if ((await env.chain.now()) - e.splitChangedAt < 7n * DAY)
            await (0, expect_1.expectFail)(env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3100, 1400, 1700, 2300, 1500]))], { signers: [env.admin] }), expect_1.Err.staking('SplitGuard'), 'too soon');
        if (env.chain.canWarp) {
            await env.chain.warpSeconds(7n * DAY + 1n);
            await env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3100, 1400, 1700, 2300, 1500]))], { signers: [env.admin] });
            (0, vitest_1.expect)((await emission()).splitBps).toEqual([3100, 1400, 1700, 2300, 1500]);
            await env.chain.warpSeconds(7n * DAY + 1n);
            await env.chain.send([emissionAdmin('set_split', env.admin.publicKey, split([3000, 1500, 1700, 2300, 1500]))], { signers: [env.admin] });
        }
        const stranger = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([emissionAdmin('set_split', stranger.publicKey, split([3000, 1500, 1700, 2300, 1500]))], { signers: [stranger] }), expect_1.Err.staking('Unauthorized'));
    });
    (0, vitest_1.it)('S05 report_burn: a wallet → NotBurnReporter; SEC-M1 burn oracle (set_oracles) may report, clamped at 3 × daily cap; admin clears it; tick_day rolls burn_today into the ring and the guard grows', async () => {
        const dailyCap = (550000000n * CG * 18n) / 100n / 365n;
        await (0, expect_1.expectFail)(env.chain.send([reportBurnIx(env.admin.publicKey, 1n)], { signers: [env.admin] }), expect_1.Err.staking('NotBurnReporter'), 'admin is not a reporter');
        const burnOracle = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([reportBurnIx(burnOracle.publicKey, 1n)], { signers: [burnOracle] }), expect_1.Err.staking('NotBurnReporter'), 'before designation');
        // only the admin may designate; other oracles untouched by a burn-only patch
        await (0, expect_1.expectFail)(env.chain.send([setOraclesIx(burnOracle.publicKey, { burn: burnOracle.publicKey })], { signers: [burnOracle] }), expect_1.Err.staking('Unauthorized'), 'stranger set_oracles');
        const before = await emission();
        await env.chain.send([setOraclesIx(env.admin.publicKey, { burn: burnOracle.publicKey })], { signers: [env.admin] });
        const e0 = await emission();
        (0, vitest_1.expect)(e0.burnOracle.equals(burnOracle.publicKey)).toBe(true);
        (0, vitest_1.expect)(e0.questOracle.equals(before.questOracle) && e0.seasonOracle.equals(before.seasonOracle) && e0.setOracle.equals(before.setOracle)).toBe(true);
        // the oracle reports; burn_today grows by exactly the amount…
        await env.chain.send([reportBurnIx(burnOracle.publicKey, 7n * CG)], { signers: [burnOracle] });
        (0, vitest_1.expect)((await emission()).burnToday).toBe(e0.burnToday + 7n * CG);
        // …and is clamped at BURN_SANITY_MULT × daily cap — a lying oracle cannot push the guard past the schedule
        await env.chain.send([reportBurnIx(burnOracle.publicKey, 10n * dailyCap)], { signers: [burnOracle] });
        (0, vitest_1.expect)((await emission()).burnToday).toBe(3n * dailyCap);
        // Pubkey::default() clears the role
        await env.chain.send([setOraclesIx(env.admin.publicKey, { burn: web3_js_1.PublicKey.default })], { signers: [env.admin] });
        await (0, expect_1.expectFail)(env.chain.send([reportBurnIx(burnOracle.publicKey, 1n)], { signers: [burnOracle] }), expect_1.Err.staking('NotBurnReporter'), 'cleared oracle');
        // program PDAs cannot sign from a test — the CPI path is covered by the unstake penalty (record_internal_burn) and the guard math below
        if (!env.chain.canWarp)
            return;
        const e1 = await emission();
        (0, vitest_1.expect)(e1.burnToday).toBeGreaterThan(0n);
        await env.chain.warpSeconds(DAY);
        await env.chain.send([tickDayIx(env.admin.publicKey)], { signers: [env.admin] });
        const e2 = await emission();
        (0, vitest_1.expect)(e2.burnToday).toBe(0n);
        (0, vitest_1.expect)(e2.burnRing.reduce((s, x) => s + x, 0n)).toBeGreaterThanOrEqual(e1.burnToday);
        const avg = e2.burnRing.reduce((s, x) => s + x, 0n) / 7n;
        const guarded = (dailyCap * 3000n) / 10000n + (avg * 12500n) / 10000n;
        const cp = await pool('chip');
        // 3 × cap in one ring slot → 7-day average 0.43 × cap → guard = 0.30 + 1.25 × 0.43 ≈ 0.84 × cap (below the ceiling): the guard really moved off the floor
        (0, vitest_1.expect)(guarded).toBeGreaterThan((dailyCap * 3000n) / 10000n);
        (0, vitest_1.expect)(cp.budgetRemaining).toBe(((guarded < dailyCap ? guarded : dailyCap) * BigInt(e2.splitBps[0])) / 10000n);
    });
    (0, vitest_1.it)('S06 stake_compressed_chip: authenticated CPI sets claim.staked; unstake clears; staked claims cannot be listed', async () => {
        const chips = await (0, flows_1.mintCompressedChips)(env, staker, 1, (0, flows_1.valueOf)('S06'));
        const c = chips[0];
        await env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: staker.publicKey, claim: c.claim })], { signers: [staker] });
        let claim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data);
        (0, vitest_1.expect)(claim.staked).toBe(true);
        const cs = (0, accounts_1.decodeCompressedChipStake)((await env.chain.getAccount((0, pdas_1.compressedChipStakePda)(c.claim)[0])).data);
        (0, vitest_1.expect)(cs.weight).toBe(BigInt(economy_1.RARITY_PROFILES[c.rarity].stakeWeight) * CG);
        (0, vitest_1.expect)((await pool('chip')).totalWeight).toBeGreaterThanOrEqual(cs.weight);
        await (0, expect_1.expectFail)(env.chain.send([(0, market_1.listCompressedIx)({ seller: staker.publicKey, claim: c.claim, price: 1000000000n, currency: market_1.MarketCurrency.SOL })], { signers: [staker] }), expect_1.Err.market('CompressedClaimNotTradable'), 'list a staked claim');
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: staker.publicKey, claim: c.claim })], { signers: [staker] }), expect_1.Err.system(0), 'stake twice (init on live PDA)');
        await env.chain.send([(0, staking_1.unstakeCompressedChipIx)({ owner: staker.publicKey, claim: c.claim, cgMint: env.mints.cg })], { signers: [staker] });
        claim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data);
        (0, vitest_1.expect)(claim.staked).toBe(false);
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.compressedChipStakePda)(c.claim)[0])).toBeNull();
        const other = await env.player({ usdc: 10000000000n });
        const theirs = await (0, flows_1.mintCompressedChips)(env, other, 1, (0, flows_1.valueOf)('S06b'));
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: staker.publicKey, claim: theirs[0].claim })], { signers: [staker] }), expect_1.Err.staking('NotOwner'));
    });
    (0, vitest_1.it)('S07 sync_set_bonus: set oracle only; compressed stake weight includes the ×1.12 set bonus; 11 → TooManySets', async () => {
        const chips = await (0, flows_1.mintCompressedChips)(env, staker, 1, (0, flows_1.valueOf)('S07'));
        const c = chips[0];
        await (0, expect_1.expectFail)(env.chain.send([syncSetBonusIx(env.admin.publicKey, env.admin.publicKey, staker.publicKey, 1)], { signers: [env.admin] }), expect_1.Err.staking('BadOracle'), 'admin is not the set oracle');
        await (0, expect_1.expectFail)(env.chain.send([syncSetBonusIx(env_1.SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 11)], { signers: [env_1.SET_ORACLE, env.admin] }), expect_1.Err.staking('TooManySets'));
        await env.chain.send([syncSetBonusIx(env_1.SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 1)], { signers: [env_1.SET_ORACLE, env.admin] });
        (0, vitest_1.expect)((0, accounts_1.decodeSetBonus)((await env.chain.getAccount((0, pdas_1.setBonusPda)(staker.publicKey)[0])).data).completedSets).toBe(1);
        await env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: staker.publicKey, claim: c.claim })], { signers: [staker] });
        const cs = (0, accounts_1.decodeCompressedChipStake)((await env.chain.getAccount((0, pdas_1.compressedChipStakePda)(c.claim)[0])).data);
        (0, vitest_1.expect)(cs.weight).toBe((BigInt(economy_1.RARITY_PROFILES[c.rarity].stakeWeight) * CG * 11200n) / 10000n);
        await env.chain.send([syncSetBonusIx(env_1.SET_ORACLE.publicKey, env.admin.publicKey, staker.publicKey, 0)], { signers: [env_1.SET_ORACLE, env.admin] });
        await env.chain.send([(0, staking_1.unstakeCompressedChipIx)({ owner: staker.publicKey, claim: c.claim, cgMint: env.mints.cg })], { signers: [staker] });
    });
    (0, vitest_1.it)('S08 paused emission: stake_cg → Paused, unstake still works', async () => {
        await env.chain.send([(0, staking_1.stakeCgIx)({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] });
        await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new borsh_1.BorshWriter().bool(true).toBytes())], { signers: [env.admin] });
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.stakeCgIx)({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] }), expect_1.Err.staking('Paused'));
        await env.chain.send([(0, staking_1.unstakeCgIx)({ owner: staker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [staker] });
        await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new borsh_1.BorshWriter().bool(false).toBytes())], { signers: [env.admin] });
    });
    (0, vitest_1.it)('S10–S13 $CG Merkle roots: publish (oracle + slice budget), timelock, claim mints + receipt, replay refused, foreign proof, revoke returns the remainder, proof depth ≤ 24', async () => {
        const wallets = [staker, await env.player({ cg: CG }), await env.player({ cg: CG })];
        const amounts = [10n * CG, 20n * CG, 30n * CG];
        const epoch = nextEpoch();
        const kind = 2; // quests
        const { root, proofs } = (0, merkle_1.buildRewardTree)(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind, epoch })));
        const e0 = await emission();
        const budget = 60n * CG;
        (0, vitest_1.expect)(e0.sliceBudget[kind]).toBeGreaterThanOrEqual(budget);
        await (0, expect_1.expectFail)(env.chain.send([publishRootIx(env_1.SEASON_ORACLE.publicKey, kind, epoch, root, budget)], { signers: [env_1.SEASON_ORACLE] }), expect_1.Err.staking('BadOracle'), 'season oracle on quests kind');
        await (0, expect_1.expectFail)(env.chain.send([publishRootIx(env_1.QUEST_ORACLE.publicKey, kind, epoch, root, e0.sliceBudget[kind] + 1n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('BudgetExceeded'));
        await env.chain.send([publishRootIx(env_1.QUEST_ORACLE.publicKey, kind, epoch, root, budget)], { signers: [env_1.QUEST_ORACLE] });
        (0, vitest_1.expect)((await emission()).sliceBudget[kind]).toBe(e0.sliceBudget[kind] - budget);
        const rr = (0, accounts_1.decodeRewardRoot)((await env.chain.getAccount((0, pdas_1.rewardRootPda)(kind, epoch)[0])).data);
        (0, vitest_1.expect)(Array.from(rr.root)).toEqual(Array.from(root));
        const claim = (i, amount = amounts[i], proof = proofs[i]) => env.chain.send([(0, staking_1.claimRootIx)({ wallet: wallets[i].publicKey, kind, epoch, amount, proof, cgMint: env.mints.cg })], { signers: [wallets[i]] });
        await (0, expect_1.expectFail)(claim(0), expect_1.Err.staking('RootTimelocked'));
        if (!env.chain.canWarp)
            return;
        await env.chain.warpSeconds(3601n);
        const b0 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, wallets[0].publicKey);
        await claim(0);
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, wallets[0].publicKey)) - b0).toBe(amounts[0]);
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.claimReceiptPda)((0, pdas_1.rewardRootPda)(kind, epoch)[0], wallets[0].publicKey)[0])).not.toBeNull();
        await (0, expect_1.expectAnyFail)(claim(0), 'claim twice (receipt init)');
        await (0, expect_1.expectFail)(claim(1, 21n * CG), expect_1.Err.staking('BadProof'), 'wrong amount');
        await (0, expect_1.expectFail)(claim(1, amounts[1], proofs[2]), expect_1.Err.staking('BadProof'), 'foreign proof');
        await (0, expect_1.expectFail)(claim(1, amounts[1], Array.from({ length: 25 }, () => new Uint8Array(32))), expect_1.Err.staking('BadProof'), '25-deep proof');
        // SKR kinds are rejected by the $CG claim path
        await (0, expect_1.expectFail)(env.chain.send([publishRootIx(env_1.QUEST_ORACLE.publicKey, 5, epoch, root, budget)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('BadOracle'), 'kind 5 via publish_root');
        // revoke → remainder back to the slice, further claims → RootRevoked
        const e1 = await emission();
        await (0, expect_1.expectFail)(env.chain.send([revokeRootIx(env_1.QUEST_ORACLE.publicKey, kind, epoch)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('Unauthorized'), 'oracle revokes');
        await env.chain.send([revokeRootIx(env.admin.publicKey, kind, epoch)], { signers: [env.admin] });
        (0, vitest_1.expect)((await emission()).sliceBudget[kind]).toBe(e1.sliceBudget[kind] + budget - amounts[0]);
        await (0, expect_1.expectFail)(claim(1), expect_1.Err.staking('RootRevoked'));
        await (0, expect_1.expectFail)(env.chain.send([revokeRootIx(env.admin.publicKey, kind, epoch)], { signers: [env.admin] }), expect_1.Err.staking('RootRevoked'), 'revoke twice');
    });
    (0, vitest_1.it)('S14 SKR pool: init state (max_root_budget = 100 000 SKR default), fund_skr moves SKR → budget, SkrFunded; zero → ZeroAmount', async () => {
        const p0 = await skrInvariant();
        (0, vitest_1.expect)(p0.skrMint.equals(env.mints.skr)).toBe(true);
        (0, vitest_1.expect)(p0.vault.equals((0, pdas_1.ata)(env.mints.skr, (0, pdas_1.skrPoolPda)()[0]))).toBe(true);
        (0, vitest_1.expect)(p0.maxRootBudget).toBe(100000n * CG);
        (0, vitest_1.expect)(p0.paused).toBe(false);
        await env.chain.send([(0, staking_1.fundSkrIx)({ funder: staker.publicKey, amount: 1000n * CG, skrMint: env.mints.skr })], { signers: [staker] });
        const p1 = await skrInvariant();
        (0, vitest_1.expect)(p1.budget).toBe(p0.budget + 1000n * CG);
        (0, vitest_1.expect)(p1.fundedTotal).toBe(p0.fundedTotal + 1000n * CG);
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.fundSkrIx)({ funder: staker.publicKey, amount: 0n, skrMint: env.mints.skr })], { signers: [staker] }), expect_1.Err.staking('ZeroAmount'));
    });
    (0, vitest_1.it)('S15–S17 SKR roots: publish_skr_root(kind 5) by the quest oracle reserves budget; wrong oracle / kind / over budget rejected; claim transfers from the vault; revoke returns the remainder', async () => {
        const wallets = [staker, await env.player({ skr: CG })];
        const amounts = [100n * CG, 200n * CG];
        const epoch = nextEpoch();
        const { root, proofs } = (0, merkle_1.buildRewardTree)(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind: 5, epoch })));
        const p0 = await skrInvariant();
        await (0, expect_1.expectFail)(env.chain.send([publishSkrRootIx(env_1.SEASON_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [env_1.SEASON_ORACLE] }), expect_1.Err.staking('BadOracle'), 'season oracle on kind 5');
        await (0, expect_1.expectFail)(env.chain.send([publishSkrRootIx(env_1.QUEST_ORACLE.publicKey, 6, epoch, root, 300n * CG)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('BadOracle'), 'quest oracle on kind 6');
        await (0, expect_1.expectFail)(env.chain.send([publishSkrRootIx(env_1.QUEST_ORACLE.publicKey, 2, epoch, root, 300n * CG)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('WrongRootCurrency'), '$CG kind via SKR path');
        await (0, expect_1.expectFail)(env.chain.send([publishSkrRootIx(env_1.QUEST_ORACLE.publicKey, 5, epoch, root, p0.budget + 1n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('SkrBudgetExceeded'), 'over budget');
        await env.chain.send([setSkrPoolIx(env.admin.publicKey, 250n * CG, null)], { signers: [env.admin] });
        await (0, expect_1.expectFail)(env.chain.send([publishSkrRootIx(env_1.QUEST_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('SkrBudgetExceeded'), 'over per-root cap');
        await env.chain.send([setSkrPoolIx(env.admin.publicKey, 100000n * CG, null)], { signers: [env.admin] });
        await env.chain.send([publishSkrRootIx(env_1.QUEST_ORACLE.publicKey, 5, epoch, root, 300n * CG)], { signers: [env_1.QUEST_ORACLE] });
        const p1 = await skrInvariant();
        (0, vitest_1.expect)(p1.budget).toBe(p0.budget - 300n * CG);
        (0, vitest_1.expect)(p1.reserved).toBe(p0.reserved + 300n * CG);
        const claim = (i) => env.chain.send([(0, staking_1.claimSkrRootIx)({ wallet: wallets[i].publicKey, kind: 5, epoch, amount: amounts[i], proof: proofs[i], skrMint: env.mints.skr })], { signers: [wallets[i]] });
        await (0, expect_1.expectFail)(claim(0), expect_1.Err.staking('RootTimelocked'));
        // the same leaf through the $CG path → WrongRootCurrency
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.claimRootIx)({ wallet: wallets[0].publicKey, kind: 2, epoch, amount: amounts[0], proof: proofs[0], cgMint: env.mints.cg })], { signers: [wallets[0]] }), expect_1.Err.anchor('AccountNotInitialized'), 'kind 2 root of this epoch does not exist');
        if (!env.chain.canWarp)
            return;
        await env.chain.warpSeconds(3601n);
        const s0 = await (0, env_1.tokenBalance)(env.chain, env.mints.skr, wallets[0].publicKey);
        await claim(0);
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.skr, wallets[0].publicKey)) - s0).toBe(amounts[0]);
        const p2 = await skrInvariant();
        (0, vitest_1.expect)(p2.reserved).toBe(p1.reserved - amounts[0]);
        (0, vitest_1.expect)(p2.paidTotal).toBe(p1.paidTotal + amounts[0]);
        await (0, expect_1.expectAnyFail)(claim(0), 'claim twice');
        // revoke_root (the $CG admin path) on an SKR kind → WrongRootCurrency; revoke_skr_root returns the remainder
        await (0, expect_1.expectFail)(env.chain.send([revokeRootIx(env.admin.publicKey, 5, epoch)], { signers: [env.admin] }), expect_1.Err.staking('WrongRootCurrency'));
        await env.chain.send([revokeSkrRootIx(env.admin.publicKey, 5, epoch)], { signers: [env.admin] });
        const p3 = await skrInvariant();
        (0, vitest_1.expect)(p3.reserved).toBe(p2.reserved - amounts[1]);
        (0, vitest_1.expect)(p3.budget).toBe(p2.budget + amounts[1]);
        await (0, expect_1.expectFail)(claim(1), expect_1.Err.staking('RootRevoked'));
    });
    (0, vitest_1.it)('S22 item roots (#27): publish_item_root(kind 8) by the quest oracle only, caps 1 000 / 10, claim_item_root CPIs grant_booster via ["rewarder"] → PlayerItems, receipt blocks replay, revoke blocks claims', async () => {
        const wallets = [staker, await env.player(), await env.player()];
        const amounts = [2n, 10n, 11n]; // boosters; the 11 leaf must be refused at claim (chip_core count ≤ 10)
        const epoch = nextEpoch();
        const { root, proofs } = (0, merkle_1.buildRewardTree)(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: amounts[i], kind: 8, epoch })));
        await (0, expect_1.expectFail)(env.chain.send([publishItemRootIx(env_1.SEASON_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [env_1.SEASON_ORACLE] }), expect_1.Err.staking('BadOracle'), 'season oracle on kind 8');
        await (0, expect_1.expectFail)(env.chain.send([publishItemRootIx(env_1.QUEST_ORACLE.publicKey, 2, epoch, root, 23n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('WrongRootCurrency'), '$CG kind via item path');
        await (0, expect_1.expectFail)(env.chain.send([publishItemRootIx(env_1.QUEST_ORACLE.publicKey, 8, epoch, root, 1001n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('ItemBudgetExceeded'), 'over per-root cap');
        await (0, expect_1.expectFail)(env.chain.send([publishItemRootIx(env_1.QUEST_ORACLE.publicKey, 8, epoch, root, 0n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('ZeroAmount'));
        await (0, expect_1.expectFail)(env.chain.send([publishRootIx(env_1.QUEST_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('BadOracle'), 'kind 8 via publish_root');
        const e0 = await emission();
        await env.chain.send([publishItemRootIx(env_1.QUEST_ORACLE.publicKey, 8, epoch, root, 23n)], { signers: [env_1.QUEST_ORACLE] });
        (0, vitest_1.expect)((await emission()).sliceBudget).toEqual(e0.sliceBudget); // nothing reserved from any slice
        const rr = (0, accounts_1.decodeRewardRoot)((await env.chain.getAccount((0, pdas_1.rewardRootPda)(8, epoch)[0])).data);
        (0, vitest_1.expect)(rr.kind).toBe(8);
        (0, vitest_1.expect)(rr.budget).toBe(23n);
        const claim = (i, amount = amounts[i], proof = proofs[i]) => env.chain.send([(0, staking_1.claimItemRootIx)({ wallet: wallets[i].publicKey, kind: 8, epoch, amount, proof })], { signers: [wallets[i]] });
        await (0, expect_1.expectFail)(claim(0), expect_1.Err.staking('RootTimelocked'));
        if (!env.chain.canWarp)
            return;
        await env.chain.warpSeconds(3601n);
        const boosters = async (w) => { const a = await env.chain.getAccount((0, pdas_1.playerItemsPda)(w.publicKey)[0]); return a ? (0, accounts_1.decodePlayerItems)(a.data).boosters : 0; };
        const b0 = await boosters(wallets[0]);
        await claim(0);
        (0, vitest_1.expect)((await boosters(wallets[0])) - b0).toBe(2); // PlayerItems credited by the CPI (created on first claim if needed)
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.claimReceiptPda)((0, pdas_1.rewardRootPda)(8, epoch)[0], wallets[0].publicKey)[0])).not.toBeNull();
        await (0, expect_1.expectAnyFail)(claim(0), 'claim twice (receipt init)');
        await (0, expect_1.expectFail)(claim(1, 9n), expect_1.Err.staking('BadProof'), 'wrong amount');
        await claim(1);
        (0, vitest_1.expect)(await boosters(wallets[1])).toBe(10);
        (0, vitest_1.expect)((0, accounts_1.decodeRewardRoot)((await env.chain.getAccount((0, pdas_1.rewardRootPda)(8, epoch)[0])).data).claimed).toBe(12n);
        // the 11-booster leaf is refused client-side and on-chain (per-claim cap = chip_core grant_booster cap)
        (0, vitest_1.expect)(() => (0, staking_1.claimItemRootIx)({ wallet: wallets[2].publicKey, kind: 8, epoch, amount: 11n, proof: proofs[2] })).toThrow(/1\.\.10/);
        // a $CG / SKR claim on the item root → WrongRootCurrency
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.claimRootIx)({ wallet: wallets[1].publicKey, kind: 2, epoch, amount: amounts[1], proof: proofs[1], cgMint: env.mints.cg })], { signers: [wallets[1]] }), expect_1.Err.anchor('AccountNotInitialized'), 'kind 2 root of this epoch does not exist');
        // revoke: $CG admin path refuses the kind; revoke_item_root blocks further claims (nothing to refund)
        await (0, expect_1.expectFail)(env.chain.send([revokeRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] }), expect_1.Err.staking('WrongRootCurrency'));
        await (0, expect_1.expectFail)(env.chain.send([revokeItemRootIx(env_1.QUEST_ORACLE.publicKey, 8, epoch)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('Unauthorized'), 'oracle revokes');
        await env.chain.send([revokeItemRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] });
        await (0, expect_1.expectFail)(claim(2, 10n, proofs[2]), expect_1.Err.staking('RootRevoked'));
        await (0, expect_1.expectFail)(env.chain.send([revokeItemRootIx(env.admin.publicKey, 8, epoch)], { signers: [env.admin] }), expect_1.Err.staking('RootRevoked'), 'revoke twice');
    });
    (0, vitest_1.it)('S23 chip voucher roots (#28): publish_chip_root(kind 9) quest oracle only, budget = leaf count ≤ 500; claim_chip_root(amount = template) CPIs open_voucher → free 1-chip PendingPack committed to Switchboard; the chip opens with the template odds, soulbound; receipt / revoke / bad template refused', async () => {
        const wallets = [staker, await env.player(), await env.player()];
        const templates = [0n, 1n, 4n]; // template 4 does not exist — its leaf must be refused at claim (MAX_CHIP_TEMPLATE = 3)
        const epoch = nextEpoch();
        const { root, proofs } = (0, merkle_1.buildRewardTree)(wallets.map((w, i) => ({ wallet: w.publicKey, amountMicro: templates[i], kind: 9, epoch })));
        await (0, expect_1.expectFail)(env.chain.send([publishChipRootIx(env_1.SEASON_ORACLE.publicKey, 9, epoch, root, 3n)], { signers: [env_1.SEASON_ORACLE] }), expect_1.Err.staking('BadOracle'), 'season oracle on kind 9');
        await (0, expect_1.expectFail)(env.chain.send([publishChipRootIx(env_1.QUEST_ORACLE.publicKey, 8, epoch, root, 3n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('WrongRootCurrency'), 'item kind via chip path');
        await (0, expect_1.expectFail)(env.chain.send([publishChipRootIx(env_1.QUEST_ORACLE.publicKey, 9, epoch, root, 501n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('ChipBudgetExceeded'), 'over per-root cap');
        await (0, expect_1.expectFail)(env.chain.send([publishChipRootIx(env_1.QUEST_ORACLE.publicKey, 9, epoch, root, 0n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('ZeroAmount'));
        await (0, expect_1.expectFail)(env.chain.send([publishItemRootIx(env_1.QUEST_ORACLE.publicKey, 9, epoch, root, 3n)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('WrongRootCurrency'), 'kind 9 via publish_item_root');
        const e0 = await emission();
        await env.chain.send([publishChipRootIx(env_1.QUEST_ORACLE.publicKey, 9, epoch, root, 2n)], { signers: [env_1.QUEST_ORACLE] }); // budget 2 = the two valid vouchers
        (0, vitest_1.expect)((await emission()).sliceBudget).toEqual(e0.sliceBudget); // nothing reserved from any slice
        const rr = (0, accounts_1.decodeRewardRoot)((await env.chain.getAccount((0, pdas_1.rewardRootPda)(9, epoch)[0])).data);
        (0, vitest_1.expect)(rr.kind).toBe(9);
        (0, vitest_1.expect)(rr.budget).toBe(2n);
        // one tx per voucher: init_randomness(0, nonce) + claim_chip_root(template, proof, nonce) — exactly the buy_pack shape
        const claimVoucher = async (i, nonce, amount = templates[i], proof = proofs[i]) => {
            const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, wallets[i].publicKey, nonce);
            return env.chain.send([
                (0, rng_1.initRandomnessIx)({ ...rng, queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
                (0, staking_1.claimChipRootIx)({ wallet: wallets[i].publicKey, kind: 9, epoch, amount, proof, nonce, queue: env_1.SB_QUEUE, oracle: env_1.SB_ORACLE }),
            ], { signers: [wallets[i]], label: 'claim_chip_root' });
        };
        await (0, expect_1.expectFail)(claimVoucher(0, 9001n), expect_1.Err.staking('RootTimelocked'));
        if (!env.chain.canWarp)
            return;
        await env.chain.warpSeconds(3601n);
        const balBefore = await env.chain.balance(wallets[0].publicKey);
        await claimVoucher(0, 9002n);
        // the CPI created a free 1-chip PendingPack pinned to template 0 (paid 0, sku 0, qty 1, no pity snapshot use)
        const pendingKey = (0, pdas_1.pendingPackPda)(wallets[0].publicKey, 9002n)[0];
        const p = (await (0, flows_1.loadPending)(env.chain, pendingKey));
        (0, vitest_1.expect)(p).toMatchObject({ sku: 0, qty: 1, opened: 0, paidLamports: 0n, paidUsdc: 0n, paidCg: 0n, paidSkr: 0n, voucher: true, soulboundDays: economy_1.QUEST_CHIP_TEMPLATES[0].soulboundDays });
        (0, vitest_1.expect)(p.voucherOdds).toEqual([...economy_1.QUEST_CHIP_TEMPLATES[0].odds]);
        (0, vitest_1.expect)(p.randomness.equals((0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, wallets[0].publicKey, 9002n).randomness)).toBe(true);
        (0, vitest_1.expect)(balBefore - (await env.chain.balance(wallets[0].publicKey))).toBeGreaterThan(0n); // wallet fronts the rents (pending + randomness + receipt + 1 chip reserve)
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.claimReceiptPda)((0, pdas_1.rewardRootPda)(9, epoch)[0], wallets[0].publicKey)[0])).not.toBeNull();
        (0, vitest_1.expect)((0, accounts_1.decodeRewardRoot)((await env.chain.getAccount((0, pdas_1.rewardRootPda)(9, epoch)[0])).data).claimed).toBe(1n); // counts vouchers, not templates
        await (0, expect_1.expectAnyFail)(claimVoucher(0, 9003n), 'claim twice (receipt init)');
        // the crank / player opens it through the Bubblegum V2 claim path: ONE chip, rolled with the template odds.
        const [open] = await (0, flows_1.revealAndOpenCompressedAll)(env, wallets[0], { nonce: 9002n, randomness: p.randomness }, (0, flows_1.valueOf)('pack'));
        (0, vitest_1.expect)(open.event.count).toBe(1);
        (0, vitest_1.expect)(open.event.claimNonces).toHaveLength(1);
        (0, vitest_1.expect)(economy_1.QUEST_CHIP_TEMPLATES[0].odds[open.rolled[0].rarity]).toBeGreaterThan(0); // only rarities the template can roll
        const compressedClaim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount((0, pdas_1.compressedMintClaimPda)(wallets[0].publicKey, open.event.claimNonces[0])[0])).data);
        (0, vitest_1.expect)(compressedClaim.buyer.equals(wallets[0].publicKey)).toBe(true);
        (0, vitest_1.expect)(compressedClaim.minted).toBe(false);
        (0, vitest_1.expect)(await env.chain.getAccount(pendingKey)).not.toBeNull(); // compressed settlement remains until DAS registration/cancellation
        // bad template: the leaf says 4 → refused client-side (0..3) and on-chain (ChipBudgetExceeded before the proof check)
        (0, vitest_1.expect)(() => (0, staking_1.claimChipRootIx)({ wallet: wallets[2].publicKey, kind: 9, epoch, amount: 4n, proof: proofs[2], nonce: 9004n, queue: env_1.SB_QUEUE, oracle: env_1.SB_ORACLE })).toThrow(/0\.\.3/);
        await (0, expect_1.expectFail)(claimVoucher(1, 9005n, 2n), expect_1.Err.staking('BadProof'), 'wrong template for the proof');
        // an item / $CG claim on the chip root → WrongRootCurrency (the kind-9 root exists, so it is the currency check that fires)
        await (0, expect_1.expectFail)(env.chain.send([claimItemRootRawIx(wallets[1].publicKey, 9, epoch, 1n, proofs[1])], { signers: [wallets[1]] }), expect_1.Err.staking('WrongRootCurrency'));
        // revoke: item path refuses the kind; revoke_chip_root blocks the remaining claim
        await (0, expect_1.expectFail)(env.chain.send([revokeItemRootIx(env.admin.publicKey, 9, epoch)], { signers: [env.admin] }), expect_1.Err.staking('WrongRootCurrency'));
        await (0, expect_1.expectFail)(env.chain.send([revokeChipRootIx(env_1.QUEST_ORACLE.publicKey, 9, epoch)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('Unauthorized'), 'oracle revokes');
        await env.chain.send([revokeChipRootIx(env.admin.publicKey, 9, epoch)], { signers: [env.admin] });
        await (0, expect_1.expectFail)(claimVoucher(1, 9006n), expect_1.Err.staking('RootRevoked'));
        await (0, expect_1.expectFail)(env.chain.send([revokeChipRootIx(env.admin.publicKey, 9, epoch)], { signers: [env.admin] }), expect_1.Err.staking('RootRevoked'), 'revoke twice');
    });
    (0, vitest_1.it)('S24 SEC-F18 voucher whose oracle never reveals: cancel_stale_pack refuses before the stale window (NotStale, not the old voucher constraint), then closes the PendingPack and returns the fronted rent + 1-chip reserve to the beneficiary; close_randomness reclaims the Switchboard rent afterwards', async () => {
        if (!env.chain.canWarp || process.env.LOCALNET_RPC)
            return; // needs slot warps + the sb_mock layout (lut_slot)
        const wallet = await env.player();
        const epoch = nextEpoch();
        const { root, proofs } = (0, merkle_1.buildRewardTree)([{ wallet: wallet.publicKey, amountMicro: 1n, kind: 9, epoch }]);
        await env.chain.send([publishChipRootIx(env_1.QUEST_ORACLE.publicKey, 9, epoch, root, 1n)], { signers: [env_1.QUEST_ORACLE] });
        await env.chain.warpSeconds(3601n); // ROOT_TIMELOCK
        const nonce = 9101n;
        const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, wallet.publicKey, nonce);
        await env.chain.send([
            (0, rng_1.initRandomnessIx)({ ...rng, queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
            (0, staking_1.claimChipRootIx)({ wallet: wallet.publicKey, kind: 9, epoch, amount: 1n, proof: proofs[0], nonce, queue: env_1.SB_QUEUE, oracle: env_1.SB_ORACLE }),
        ], { signers: [wallet], label: 'claim_chip_root' });
        const pendingKey = (0, pdas_1.pendingPackPda)(wallet.publicKey, nonce)[0];
        const p = (await (0, flows_1.loadPending)(env.chain, pendingKey));
        (0, vitest_1.expect)(p.voucher).toBe(true);
        (0, vitest_1.expect)(p.paidLamports + p.paidUsdc + p.paidCg + p.paidSkr).toBe(0n);
        const led0 = await env.ledger();
        // inside the oracle window the refusal is the stale check itself — before the fix `constraint = !pending.voucher`
        // answered InvalidChipState here and after the window alike, and the reserve was gone for good
        await (0, expect_1.expectFail)((0, flows_1.cancelStale)(env, wallet, { nonce, randomness: p.randomness }), expect_1.Err.chip('NotStale'));
        await env.chain.warpSlots(10800n + 1n); // STALE_PACK_SLOTS
        const escrowed = await env.chain.balance(pendingKey); // pending rent + RENT_RESERVE_PER_CHIP, both fronted by the beneficiary
        (0, vitest_1.expect)(escrowed).toBeGreaterThan(8000000n);
        const before = await env.chain.balance(wallet.publicKey);
        await (0, flows_1.cancelStale)(env, wallet, { nonce, randomness: p.randomness });
        (0, vitest_1.expect)((0, expect_1.lamportsClose)((await env.chain.balance(wallet.publicKey)) - before, escrowed, 20000n)).toBe(true); // − tx fee
        (0, vitest_1.expect)(await (0, flows_1.loadPending)(env.chain, pendingKey)).toBeNull();
        // nothing was purchased, so nothing is released: the liability shards are exactly where they were
        const led = await env.ledger();
        (0, vitest_1.expect)([led.liabLamports, led.liabUsdc, led.liabCg, led.liabSkr]).toEqual([led0.liabLamports, led0.liabUsdc, led0.liabCg, led0.liabSkr]);
        // with the pending gone the Switchboard account is unpinned: close_randomness (permissionless) sends its rent to the beneficiary
        const lut = (await (0, sbmock_1.randomnessAccount)(env.chain, p.randomness)).lutSlot;
        const ownerBefore = await env.chain.balance(wallet.publicKey);
        await env.chain.send([(0, rng_1.closeRandomnessIx)({ ...rng, payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin] });
        (0, vitest_1.expect)(await env.chain.getAccount(p.randomness)).toBeNull();
        (0, vitest_1.expect)((await env.chain.balance(wallet.publicKey)) - ownerBefore).toBe(await env.chain.rentExempt(480));
    });
    (0, vitest_1.it)('S18–S20 withdraw_skr only from unreserved budget; sync_skr_pool absorbs direct transfers; pause blocks publish/claim but not fund', async () => {
        const p0 = await skrInvariant();
        await (0, expect_1.expectFail)(env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, (0, pdas_1.ata)(env.mints.skr, env_1.TREASURY.publicKey), p0.budget + 1n)], { signers: [env.admin] }), expect_1.Err.staking('SkrBudgetExceeded'));
        const t0 = await (0, env_1.tokenBalance)(env.chain, env.mints.skr, env_1.TREASURY.publicKey);
        await env.chain.send([withdrawSkrIx(env.admin.publicKey, env.mints.skr, (0, pdas_1.ata)(env.mints.skr, env_1.TREASURY.publicKey), p0.budget)], { signers: [env.admin] });
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.skr, env_1.TREASURY.publicKey)) - t0).toBe(p0.budget);
        const p1 = await skrInvariant();
        (0, vitest_1.expect)(p1.budget).toBe(0n);
        // direct SPL transfer + permissionless sync
        await env.chain.send([(0, spl_token_1.createTransferInstruction)((0, pdas_1.ata)(env.mints.skr, staker.publicKey), (0, pdas_1.ata)(env.mints.skr, (0, pdas_1.skrPoolPda)()[0]), staker.publicKey, 77n * CG)], { signers: [staker] });
        await env.chain.send([syncSkrPoolIx(env.mints.skr)], { signers: [env.admin] });
        const p2 = await skrInvariant();
        (0, vitest_1.expect)(p2.budget).toBe(77n * CG);
        (0, vitest_1.expect)(p2.fundedTotal).toBe(p1.fundedTotal + 77n * CG);
        // pause
        await env.chain.send([setSkrPoolIx(env.admin.publicKey, null, true)], { signers: [env.admin] });
        const epoch = nextEpoch();
        const { root } = (0, merkle_1.buildRewardTree)([{ wallet: staker.publicKey, amountMicro: CG, kind: 5, epoch }]);
        await (0, expect_1.expectFail)(env.chain.send([publishSkrRootIx(env_1.QUEST_ORACLE.publicKey, 5, epoch, root, CG)], { signers: [env_1.QUEST_ORACLE] }), expect_1.Err.staking('SkrPoolPaused'));
        await env.chain.send([(0, staking_1.fundSkrIx)({ funder: staker.publicKey, amount: CG, skrMint: env.mints.skr })], { signers: [staker] });
        await env.chain.send([setSkrPoolIx(env.admin.publicKey, null, false)], { signers: [env.admin] });
        const stranger = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([setSkrPoolIx(stranger.publicKey, null, true)], { signers: [stranger] }), expect_1.Err.staking('Unauthorized'));
        await skrInvariant();
        (0, vitest_1.expect)(ACC).toBe(1000000000000n);
    });
    (0, vitest_1.it)('S21 SEC-L5 fund_slice: season oracle / admin burn the season pool into slice_budget[3] (recycled_total, SliceFunded); wrong kind / zero / over balance / stranger / quest oracle rejected; a kind-3 claim of the recycled amount leaves minted_total untouched', async () => {
        // the arena's season pool = $CG ATA of staking's ["season_pool"] PDA; seed it like resolve_battle would (rake_pool transfer)
        const poolAuth = (0, pdas_1.seasonPoolAuthPda)()[0];
        await (0, env_1.mintCg)(env.chain, env.admin, env.mints.cg, poolAuth, 10n * CG);
        const e0 = await emission();
        const supply0 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, poolAuth);
        (0, vitest_1.expect)(supply0).toBeGreaterThanOrEqual(10n * CG);
        const fund = (authority, amount, kind) => env.chain.send([(0, staking_1.fundSliceIx)({ authority: authority.publicKey, amount, cgMint: env.mints.cg, kind })], { signers: [authority] });
        await (0, expect_1.expectFail)(fund(env_1.SEASON_ORACLE, CG, 2), expect_1.Err.staking('WrongSlice'), 'quests slice has no token source');
        await (0, expect_1.expectFail)(fund(env_1.SEASON_ORACLE, 0n), expect_1.Err.staking('ZeroAmount'));
        await (0, expect_1.expectFail)(fund(env_1.SEASON_ORACLE, supply0 + 1n), expect_1.Err.staking('InsufficientPool'));
        await (0, expect_1.expectFail)(fund(env_1.QUEST_ORACLE, CG), expect_1.Err.staking('Unauthorized'), 'quest oracle');
        await (0, expect_1.expectFail)(fund(staker, CG), expect_1.Err.staking('Unauthorized'), 'stranger');
        // season oracle recycles 4 $CG: pool −4, slice[3] +4, recycled_total +4, burn ring untouched (not demand)
        await fund(env_1.SEASON_ORACLE, 4n * CG);
        const e1 = await emission();
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, poolAuth))).toBe(supply0 - 4n * CG);
        (0, vitest_1.expect)(e1.sliceBudget[3]).toBe(e0.sliceBudget[3] + 4n * CG);
        (0, vitest_1.expect)(e1.recycledTotal).toBe(e0.recycledTotal + 4n * CG);
        (0, vitest_1.expect)(e1.burnToday).toBe(e0.burnToday);
        (0, vitest_1.expect)(e1.mintedTotal).toBe(e0.mintedTotal);
        // admin may fund too
        await fund(env.admin, CG);
        (0, vitest_1.expect)((await emission()).recycledTotal).toBe(e0.recycledTotal + 5n * CG);
        // paused → blocked (like publish_root), unpause restores
        await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new borsh_1.BorshWriter().bool(true).toBytes())], { signers: [env.admin] });
        await (0, expect_1.expectFail)(fund(env_1.SEASON_ORACLE, CG), expect_1.Err.staking('Paused'));
        await env.chain.send([emissionAdmin('set_paused', env.admin.publicKey, new borsh_1.BorshWriter().bool(false).toBytes())], { signers: [env.admin] });
        // a kind-3 root paid from the recycled budget: claim mints 3 $CG but minted_total (schedule) does not move, recycled_minted does
        const epoch = nextEpoch();
        const { root, proofs } = (0, merkle_1.buildRewardTree)([{ wallet: staker.publicKey, amountMicro: 3n * CG, kind: 3, epoch }]);
        await env.chain.send([publishRootIx(env_1.SEASON_ORACLE.publicKey, 3, epoch, root, 3n * CG)], { signers: [env_1.SEASON_ORACLE] });
        if (!env.chain.canWarp)
            return;
        await env.chain.warpSeconds(3601n);
        const e2 = await emission();
        const b0 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey);
        await env.chain.send([(0, staking_1.claimRootIx)({ wallet: staker.publicKey, kind: 3, epoch, amount: 3n * CG, proof: proofs[0], cgMint: env.mints.cg })], { signers: [staker] });
        const e3 = await emission();
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, staker.publicKey)) - b0).toBe(3n * CG);
        (0, vitest_1.expect)(e3.mintedTotal).toBe(e2.mintedTotal);
        (0, vitest_1.expect)(e3.recycledMinted).toBe(e2.recycledMinted + 3n * CG);
        (0, vitest_1.expect)(e3.recycledMinted).toBeLessThanOrEqual(e3.recycledTotal);
    });
});

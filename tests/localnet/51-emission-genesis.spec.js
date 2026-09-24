"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-L-S (SEC-G01 / SEC-G02) — `tick_day` around a scheduled genesis (docs/06 §3.5 "Стейкинг").
//
// The shared environment (helpers/env.ts) initialises the emission singleton with `genesis_ts = now − 10`,
// so a *future* genesis — the `GENESIS_TS` launch-scheduling path of scripts/setup.ts — needs its own
// chain: this spec boots a private LiteSVM with just the staking program and a fresh $CG mint.
//
// Before the fix `((now - genesis_ts) / DAY) as u32` wrapped the negative pre-genesis day count to
// 4 294 967 295, the first (permissionless) tick stored it as `day_index`, and no later tick could ever
// satisfy `today > day_index` again — emission dead until a program upgrade (SEC-G01). The day-0
// exception is additionally pinned to the live pools so it cannot be replayed (SEC-G02).
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const anchor_1 = require("@/chain/anchor");
const accounts_1 = require("@/chain/accounts");
const ids_1 = require("@/chain/ids");
const pdas_1 = require("@/chain/pdas");
const chain_1 = require("./helpers/chain");
const env_1 = require("./helpers/env");
const expect_1 = require("./helpers/expect");
const bins = (0, env_1.binariesPresent)();
// LiteSVM only: the RPC back-end cannot boot a second chain and its emission singleton is already live
const suite = vitest_1.describe.skipIf(!bins.ok || !!process.env.LOCALNET_RPC);
const DAY = 86400n;
const tickDayIx = (cranker) => new web3_js_1.TransactionInstruction({ programId: ids_1.STAKING_ID, keys: [(0, anchor_1.signer)(cranker, false), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.tokenPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('tick_day')) });
suite('T-L-S emission genesis (SEC-G01 / SEC-G02)', () => {
    let chain;
    let admin;
    let genesis;
    const emission = async () => (0, accounts_1.decodeEmissionState)((await chain.getAccount((0, pdas_1.emissionPda)()[0])).data);
    const pool = async (k) => (0, accounts_1.decodePool)((await chain.getAccount((k === 'token' ? pdas_1.tokenPoolPda : pdas_1.chipPoolPda)()[0])).data);
    const tick = (who) => chain.send([tickDayIx(who.publicKey)], { signers: [who], label: 'tick_day' });
    (0, vitest_1.beforeAll)(async () => {
        chain = await chain_1.LiteSvmChain.create((0, env_1.programBinaries)().filter((p) => p.id.equals(ids_1.STAKING_ID)));
        admin = chain.admin;
        const mint = web3_js_1.Keypair.generate();
        await chain.send([
            web3_js_1.SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(await chain.rentExempt(spl_token_1.MINT_SIZE)), space: spl_token_1.MINT_SIZE, programId: spl_token_1.TOKEN_PROGRAM_ID }),
            (0, spl_token_1.createInitializeMint2Instruction)(mint.publicKey, 6, admin.publicKey, null),
        ], { signers: [admin, mint], label: 'create $CG mint' });
        genesis = (await chain.now()) + 3n * DAY; // launch scheduled three days out
        await chain.send([(0, env_1.initEmissionIx)({ admin: admin.publicKey, cgMint: mint.publicKey, genesisTs: genesis })], { signers: [admin], label: 'init_emission (future genesis)' });
    });
    (0, vitest_1.it)('G01 tick_day before genesis → BeforeGenesis (anyone may crank; nothing is recorded)', async () => {
        const e0 = await emission();
        (0, vitest_1.expect)(e0.genesisTs).toBe(genesis);
        (0, vitest_1.expect)(e0.dayIndex).toBe(0);
        const stranger = web3_js_1.Keypair.generate();
        await chain.airdrop(stranger.publicKey, 1000000000n);
        await (0, expect_1.expectFail)(tick(stranger), expect_1.Err.staking('BeforeGenesis'), 'stranger, 3 days early');
        await chain.warpSeconds(3n * DAY - 30n);
        await (0, expect_1.expectFail)(tick(admin), expect_1.Err.staking('BeforeGenesis'), 'admin, 30 s early');
        const e1 = await emission();
        (0, vitest_1.expect)(e1.dayIndex).toBe(0);
        (0, vitest_1.expect)(e1.sliceBudget.every((b) => b === 0n)).toBe(true);
        (0, vitest_1.expect)((await pool('chip')).budgetPerSec).toBe(0n);
    });
    (0, vitest_1.it)('G01/G02 first tick at genesis opens day 0 exactly once; the calendar keeps counting from genesis afterwards', async () => {
        await chain.warpSeconds(60n); // now = genesis + 30 s
        await tick(admin);
        const e1 = await emission();
        (0, vitest_1.expect)(e1.dayIndex).toBe(0);
        const cp = await pool('chip');
        const tp = await pool('token');
        (0, vitest_1.expect)(cp.budgetPerSec).toBeGreaterThan(0n);
        (0, vitest_1.expect)(tp.budgetRemaining).toBeGreaterThan(0n);
        // SEC-G02: the day-0 exception is spent — a replay is refused even though nothing has been minted yet
        await (0, expect_1.expectFail)(tick(admin), expect_1.Err.staking('DayAlreadyClosed'), 'replay of day 0');
        (0, vitest_1.expect)((await pool('chip')).budgetRemaining).toBe(cp.budgetRemaining);
        // the pre-genesis attempts left no trace: day 1 arrives one DAY after genesis, not after the first tick
        await chain.warpSeconds(DAY - 60n); // now = genesis + DAY − 30 s
        await (0, expect_1.expectFail)(tick(admin), expect_1.Err.staking('DayAlreadyClosed'), 'still day 0');
        await chain.warpSeconds(60n); // now = genesis + DAY + 30 s
        await tick(admin);
        (0, vitest_1.expect)((await emission()).dayIndex).toBe(1);
        await (0, expect_1.expectFail)(tick(admin), expect_1.Err.staking('DayAlreadyClosed'), 'second tick of day 1');
    });
});

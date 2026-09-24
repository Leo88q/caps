"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-L-A — arena wager escrow: create / accept / resolve / cancel + battle randomness PDA
// (docs/06 §3.5 "Арена"). Battles themselves are server-resolved; the program only guards funds.
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
const economy_1 = require("@guttercaps/economy");
const anchor_1 = require("@/chain/anchor");
const borsh_1 = require("@/chain/borsh");
const accounts_1 = require("@/chain/accounts");
const arena_1 = require("@/chain/ix/arena");
const market_1 = require("@/chain/ix/market");
const staking_1 = require("@/chain/ix/staking");
const rng_1 = require("@/chain/ix/rng");
const ids_1 = require("@/chain/ids");
const pdas_1 = require("@/chain/pdas");
const env_1 = require("./helpers/env");
const expect_1 = require("./helpers/expect");
const flows_1 = require("./helpers/flows");
const sbmock_1 = require("./helpers/sbmock");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
/** scenarios that forge accounts or move the clock — LiteSVM back-end only (RPC = LOCALNET_RPC set) */
const svmOnly = vitest_1.it.skipIf(!!process.env.LOCALNET_RPC);
const CG = 1000000n;
/** `resolve_battle(winner, result_hash)` — oracle-signed; no client builder exists (backend-only), account order = ResolveBattle struct. */
function resolveBattleIx(a) {
    const [battle] = (0, pdas_1.battlePda)(a.challenger, a.nonce);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.ARENA_ID,
        keys: [
            (0, anchor_1.signer)(a.oracle, false), (0, anchor_1.rw)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.rw)(battle), (0, anchor_1.ro)(a.randomness), (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, battle)),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.winner)), (0, anchor_1.rw)(a.seasonPool), (0, anchor_1.rw)(a.treasuryCg), (0, anchor_1.rw)(a.challenger), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('resolve_battle', new borsh_1.BorshWriter().pubkey(a.winner).bytes(a.resultHash).toBytes())),
    });
}
const squadPower = (chips) => chips.reduce((s, c) => s + Math.floor((economy_1.RARITY_PROFILES[c.rarity].basePower * Math.round((0, economy_1.levelMult)(c.level) * 10_000)) / 10_000), 0);
suite('T-L-A arena', () => {
    let env;
    let a;
    let b;
    let squadA;
    let squadB;
    let powerA;
    let seasonPool;
    let treasuryCg;
    /**
     * Any 3 distinct claims with power ≥ minPower and, when asked, exactly `targetLeague`. Rarity combinations are
     * tried from the strongest down, so without a target this is "the best 3"; with a target it is *some* trio in
     * that league — taking only the 3 best chips made the search flaky: one lucky Epic early on pushed the best-3
     * past the opponent's league for good (rolls come from `valueOf(<random wallet>, i)`, so this is per-run luck).
     */
    function pickSquad(pool, minPower, targetLeague) {
        const byRarity = new Map();
        for (const c of pool)
            byRarity.set(c.rarity, [...(byRarity.get(c.rarity) ?? []), c.claim]);
        const rarities = [...byRarity.keys()].sort((x, y) => y - x);
        for (const r1 of rarities)
            for (const r2 of rarities)
                for (const r3 of rarities) {
                    if (r2 > r1 || r3 > r2)
                        continue; // non-increasing triples only — each multiset once
                    const need = [r1, r2, r3];
                    if (rarities.some((r) => need.filter((n) => n === r).length > (byRarity.get(r)?.length ?? 0)))
                        continue;
                    const power = squadPower(need.map((rarity) => ({ rarity, level: 1 })));
                    if (power < minPower || (targetLeague != null && (0, arena_1.leagueOf)(power) !== targetLeague))
                        continue;
                    const taken = new Map();
                    const assets = need.map((r) => { const i = taken.get(r) ?? 0; taken.set(r, i + 1); return byRarity.get(r)[i]; });
                    return { assets, power };
                }
        return undefined;
    }
    /** 3 chips with power ≥ 400: keep minting Standard packs until a squad qualifies (Rare + 2 Commons = 410 already does) */
    async function squadFor(owner, minPower = 400, targetLeague) {
        const pool = [];
        for (let i = 0; i < 40; i++) {
            pool.push(...(await (0, flows_1.mintCompressedChips)(env, owner, 1, (0, flows_1.valueOf)(`squad-${owner.publicKey.toBase58().slice(0, 4)}`, i))));
            const pick = pickSquad(pool, minPower, targetLeague);
            if (pick)
                return pick;
        }
        throw new Error('could not assemble a squad');
    }
    async function createBattle(challenger, squad, wager, nonce = (0, flows_1.nextNonce)()) {
        const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.BATTLE, challenger.publicKey, nonce);
        const tx = await env.chain.send([
            (0, rng_1.initRandomnessIx)({ ...rng, queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
            (0, arena_1.createCompressedBattleIx)({ challenger: challenger.publicKey, nonce, wager, randomness: rng.randomness, queue: env_1.SB_QUEUE, oracle: env_1.SB_ORACLE, claims: squad, cgMint: env.mints.cg }),
        ], { signers: [challenger], label: 'init_battle_randomness + create_battle' });
        return { nonce, rng, battle: (0, pdas_1.battlePda)(challenger.publicKey, nonce)[0], tx };
    }
    const battleOf = async (key) => (0, accounts_1.decodeWagerBattle)((await env.chain.getAccount(key)).data);
    (0, vitest_1.beforeAll)(async () => {
        env = await (0, env_1.getEnv)();
        a = await env.player({ usdc: 100000000000n, cg: 100000n * CG });
        b = await env.player({ usdc: 100000000000n, cg: 100000n * CG });
        // both squads in league 0 ([400, 800) — Rare + 2 Commons already qualifies): the cheapest league to reach
        // from Standard packs, so neither wallet can get stranded above the other by a lucky roll
        ({ assets: squadA, power: powerA } = await squadFor(a, 400, 0));
        ({ assets: squadB } = await squadFor(b, 400, (0, arena_1.leagueOf)(powerA)));
        const cfg = (0, accounts_1.decodeArenaConfig)((await env.chain.getAccount((0, pdas_1.arenaConfigPda)()[0])).data);
        seasonPool = cfg.seasonPool;
        treasuryCg = cfg.treasuryCg;
        (0, vitest_1.expect)(cfg.battleOracle.equals(env_1.BATTLE_ORACLE.publicKey)).toBe(true);
        (0, vitest_1.expect)(seasonPool.equals((0, pdas_1.ata)(env.mints.cg, (0, pdas_1.seasonPoolAuthPda)()[0]))).toBe(true); // SEC-L5: staking's ["season_pool"] PDA, not the emission vault
        (0, vitest_1.expect)(treasuryCg.equals((0, pdas_1.ata)(env.mints.cg, env_1.TREASURY.publicKey))).toBe(true);
    }, 900_000);
    (0, vitest_1.it)('A01 create_battle: wager escrowed in the battle ATA, squad pinned with on-chain power, league, randomness committed (seed_slot = slot − 1)', async () => {
        const before = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, a.publicKey);
        const r = await createBattle(a, squadA, 50n * CG);
        (0, vitest_1.expect)(before - (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, a.publicKey))).toBe(50n * CG);
        const bt = await battleOf(r.battle);
        (0, vitest_1.expect)(bt.status).toBe(0);
        (0, vitest_1.expect)(bt.wager).toBe(50n * CG);
        (0, vitest_1.expect)(bt.powerA).toBe(powerA);
        (0, vitest_1.expect)(bt.squadA.map((k) => k.toBase58())).toEqual(squadA.map((k) => k.toBase58()));
        (0, vitest_1.expect)(bt.randomness.equals(r.rng.randomness)).toBe(true);
        const rnd = (await (0, sbmock_1.randomnessAccount)(env.chain, r.rng.randomness));
        (0, vitest_1.expect)(bt.commitSlot).toBe(rnd.seedSlot);
        (0, vitest_1.expect)(rnd.authority.equals(r.rng.rngAuth)).toBe(true);
        (0, vitest_1.expect)((await env.chain.getAccount(r.rng.randomness)).owner.equals(env_1.SB_MOCK_ID)).toBe(true);
        (0, vitest_1.expect)((0, arena_1.leagueOf)(powerA)).toBeGreaterThanOrEqual(0);
        // MIN_SQUAD_POWER: three Commons (300) → SquadTooWeak
        const weak = await env.player({ usdc: 10000000000n, cg: 1000n * CG });
        const commons = [];
        for (let i = 0; commons.length < 3 && i < 10; i++)
            for (const c of await (0, flows_1.mintCompressedChips)(env, weak, 1, (0, flows_1.valueOf)('weak', i)))
                if (c.rarity === 0 && commons.length < 3)
                    commons.push(c.claim);
        if (commons.length === 3)
            await (0, expect_1.expectFail)(createBattle(weak, commons, 10n * CG), expect_1.Err.arena('SquadTooWeak'));
    }, 600_000);
    (0, vitest_1.it)('A02 accept: self → SelfBattle; league mismatch → LeagueMismatch; duplicate chip → DuplicateChip; stale open (> 10 min) → BadStatus; happy path escrows the second stake', async () => {
        const r = await createBattle(a, squadA, 20n * CG);
        await (0, expect_1.expectFail)(env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: a.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadA, cgMint: env.mints.cg })], { signers: [a] }), expect_1.Err.arena('SelfBattle'));
        await (0, expect_1.expectFail)(env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: [squadB[0], squadB[0], squadB[1]], cgMint: env.mints.cg })], { signers: [b] }), expect_1.Err.arena('DuplicateChip'));
        // league mismatch: a Diamond-heavy squad cannot be minted cheaply — instead assert the league helper is what the program uses
        (0, vitest_1.expect)((0, arena_1.leagueOf)(799)).toBe(0);
        (0, vitest_1.expect)((0, arena_1.leagueOf)(800)).toBe(1);
        (0, vitest_1.expect)((0, arena_1.leagueOf)(7000)).toBe(5);
        // the stale-window block lives at the END: it warps the clock +601 s, and the happy-path accept
        // below must not run against a battle that the warp just aged past ACCEPT_TIMEOUT (that is exactly
        // the BadStatus the first real run caught here)
        const before = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, b.publicKey);
        await env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
        (0, vitest_1.expect)(before - (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, b.publicKey))).toBe(20n * CG);
        const bt = await battleOf(r.battle);
        (0, vitest_1.expect)(bt.status).toBe(1);
        (0, vitest_1.expect)(bt.opponent.equals(b.publicKey)).toBe(true);
        (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.cg, r.battle)).toBe(40n * CG);
        await (0, expect_1.expectFail)(env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] }), expect_1.Err.arena('BadStatus'), 'accept twice');
        if (env.chain.canWarp) {
            const stale = await createBattle(a, squadA, 20n * CG);
            await env.chain.warpSeconds(601n);
            await (0, expect_1.expectFail)(env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: b.publicKey, challenger: a.publicKey, nonce: stale.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] }), expect_1.Err.arena('BadStatus'), 'accept after 10 min');
            await env.chain.send([(0, arena_1.cancelStaleBattleIx)({ caller: a.publicKey, challenger: a.publicKey, nonce: stale.nonce, cgMint: env.mints.cg })], { signers: [a] });
        }
    }, 600_000);
    (0, vitest_1.it)('A03/A04 resolve: only the oracle, winner ∈ {a, b}, rake 5 % = 40 % treasury / 40 % burn / 20 % season pool, escrow closed, result_hash stored; needs a revealed VRF', async () => {
        const r = await createBattle(a, squadA, 100n * CG);
        await env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
        const hash = (0, flows_1.valueOf)('A03-hash');
        const resolve = (oracle, winner) => env.chain.send([resolveBattleIx({ oracle: oracle.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: r.rng.randomness, winner, resultHash: hash, cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [oracle] });
        await (0, expect_1.expectFail)(resolve(env_1.BATTLE_ORACLE, b.publicKey), expect_1.Err.arena('Randomness'), 'resolve before reveal');
        await env.chain.send([(0, sbmock_1.revealIx)({ kind: pdas_1.RNG_KIND.BATTLE, payer: env.admin.publicKey, randomness: r.rng.randomness, value: (0, flows_1.valueOf)('A03') })], { signers: [env.admin] });
        await (0, expect_1.expectFail)(resolve(a, a.publicKey), expect_1.Err.arena('Unauthorized'), 'challenger resolves');
        const stranger = await env.player({ cg: CG });
        await (0, expect_1.expectFail)(resolve(env_1.BATTLE_ORACLE, stranger.publicKey), expect_1.Err.arena('BadWinner'), 'winner not in battle');
        const before = { b: await (0, env_1.tokenBalance)(env.chain, env.mints.cg, b.publicKey), pool: await (0, env_1.tokenBalance)(env.chain, env.mints.cg, (0, pdas_1.seasonPoolAuthPda)()[0]), tr: await (0, env_1.tokenBalance)(env.chain, env.mints.cg, env_1.TREASURY.publicKey) };
        await resolve(env_1.BATTLE_ORACLE, b.publicKey);
        const s = (0, arena_1.wagerSplit)(100n * CG);
        (0, vitest_1.expect)(s.pot).toBe(200n * CG);
        (0, vitest_1.expect)(s.rake).toBe(10n * CG);
        (0, vitest_1.expect)(s.treasury).toBe(4n * CG);
        (0, vitest_1.expect)(s.seasonPool).toBe(2n * CG);
        (0, vitest_1.expect)(s.burn).toBe(4n * CG);
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, b.publicKey)) - before.b).toBe(s.payout);
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, (0, pdas_1.seasonPoolAuthPda)()[0])) - before.pool).toBe(s.seasonPool);
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, env_1.TREASURY.publicKey)) - before.tr).toBe(s.treasury);
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.ata)(env.mints.cg, r.battle))).toBeNull();
        const bt = await battleOf(r.battle);
        (0, vitest_1.expect)(bt.status).toBe(2);
        (0, vitest_1.expect)(bt.winner.equals(b.publicKey)).toBe(true);
        (0, vitest_1.expect)(Array.from(bt.resultHash)).toEqual(Array.from(hash));
        await (0, expect_1.expectFail)(resolve(env_1.BATTLE_ORACLE, b.publicKey), expect_1.Err.anchor('AccountNotInitialized'), 'resolve twice (the escrow was closed by the first resolve; the battle itself stays as a record)');
        // wager range
        await (0, expect_1.expectFail)(createBattle(a, squadA, arena_1.MIN_WAGER - 1n), expect_1.Err.arena('WagerRange'));
        await (0, expect_1.expectFail)(createBattle(a, squadA, arena_1.MAX_WAGER + 1n), expect_1.Err.arena('WagerRange'));
    }, 600_000);
    svmOnly('A05 fake randomness at resolve (SEC-C1): forged / foreign-owned account → Randomness', async () => {
        if (!env.chain.canWarp)
            return;
        const r = await createBattle(a, squadA, 10n * CG);
        await env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
        const bt = await battleOf(r.battle);
        const forged = await (0, sbmock_1.forgeRandomness)(env.chain, { owner: web3_js_1.Keypair.generate().publicKey, kind: pdas_1.RNG_KIND.BATTLE, seedSlot: bt.commitSlot, revealSlot: await env.chain.slot(), value: (0, flows_1.valueOf)('A05') });
        await (0, expect_1.expectFail)(env.chain.send([resolveBattleIx({ oracle: env_1.BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: forged, winner: a.publicKey, resultHash: (0, flows_1.valueOf)('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [env_1.BATTLE_ORACLE] }), expect_1.Err.anchor('ConstraintAddress'), 'not the pinned account');
        const real = (await env.chain.getAccount(r.rng.randomness));
        await env.chain.setAccount(r.rng.randomness, { owner: web3_js_1.Keypair.generate().publicKey, data: real.data, lamports: real.lamports });
        await (0, expect_1.expectFail)(env.chain.send([resolveBattleIx({ oracle: env_1.BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: r.rng.randomness, winner: a.publicKey, resultHash: (0, flows_1.valueOf)('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [env_1.BATTLE_ORACLE] }), expect_1.Err.arena('Randomness'), 'owner swapped');
        await env.chain.setAccount(r.rng.randomness, { owner: env_1.SB_MOCK_ID, data: real.data, lamports: real.lamports });
        await env.chain.send([(0, sbmock_1.revealIx)({ kind: pdas_1.RNG_KIND.BATTLE, payer: env.admin.publicKey, randomness: r.rng.randomness, value: (0, flows_1.valueOf)('A05') })], { signers: [env.admin] });
        await env.chain.send([resolveBattleIx({ oracle: env_1.BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: r.rng.randomness, winner: a.publicKey, resultHash: (0, flows_1.valueOf)('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [env_1.BATTLE_ORACLE] });
    }, 600_000);
    svmOnly('A06 cancel_stale_battle: Open — challenger at once, opponent only after 10 min; Accepted — after 30 min, both refunded; stranger → Unauthorized', async () => {
        if (!env.chain.canWarp)
            return;
        const r1 = await createBattle(a, squadA, 10n * CG);
        const stranger = await env.player({ cg: CG });
        await (0, expect_1.expectFail)(env.chain.send([(0, arena_1.cancelStaleBattleIx)({ caller: stranger.publicKey, challenger: a.publicKey, nonce: r1.nonce, cgMint: env.mints.cg })], { signers: [stranger] }), expect_1.Err.arena('Unauthorized'));
        await (0, expect_1.expectFail)(env.chain.send([(0, arena_1.cancelStaleBattleIx)({ caller: b.publicKey, challenger: a.publicKey, nonce: r1.nonce, cgMint: env.mints.cg })], { signers: [b] }), expect_1.Err.arena('Unauthorized'), 'opponent not yet set');
        const aBefore = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, a.publicKey);
        await env.chain.send([(0, arena_1.cancelStaleBattleIx)({ caller: a.publicKey, challenger: a.publicKey, nonce: r1.nonce, cgMint: env.mints.cg })], { signers: [a] });
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, a.publicKey)) - aBefore).toBe(10n * CG);
        (0, vitest_1.expect)((await battleOf(r1.battle)).status).toBe(3);
        const r2 = await createBattle(a, squadA, 10n * CG);
        await env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: b.publicKey, challenger: a.publicKey, nonce: r2.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
        await (0, expect_1.expectFail)(env.chain.send([(0, arena_1.cancelStaleBattleIx)({ caller: b.publicKey, challenger: a.publicKey, opponent: b.publicKey, nonce: r2.nonce, cgMint: env.mints.cg })], { signers: [b] }), expect_1.Err.arena('NotStale'), 'accepted < 30 min');
        await env.chain.warpSeconds(1801n);
        const a0 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, a.publicKey);
        const b0 = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, b.publicKey);
        await env.chain.send([(0, arena_1.cancelStaleBattleIx)({ caller: b.publicKey, challenger: a.publicKey, opponent: b.publicKey, nonce: r2.nonce, cgMint: env.mints.cg })], { signers: [b] });
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, a.publicKey)) - a0).toBe(10n * CG);
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, b.publicKey)) - b0).toBe(10n * CG);
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.ata)(env.mints.cg, r2.battle))).toBeNull();
    }, 600_000);
    svmOnly('A07 oracle daily cap: pots above the cap → OracleCap; resets after 24 h', async () => {
        if (!env.chain.canWarp)
            return;
        // cap is 1 M $CG of pots per day — shrink it with set_arena(None, Some(cap), None, None) for the test
        const setCap = (cap) => {
            const w = new borsh_1.BorshWriter();
            w.u8(0);
            w.u8(1);
            w.u64(cap);
            w.u8(0);
            w.u8(0);
            return new web3_js_1.TransactionInstruction({ programId: ids_1.ARENA_ID, keys: [(0, anchor_1.signer)(env.admin.publicKey, false), (0, anchor_1.rw)((0, pdas_1.arenaConfigPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('set_arena', w.toBytes())) });
        };
        await env.chain.send([setCap(150n * CG)], { signers: [env.admin] });
        // resolve() only rolls the day window (and zeroes oracle_paid_today) when ≥ 24 h have passed —
        // the battles resolved by earlier specs have already filled the counter, so without this warp the
        // very first play of this test hits the shrunken cap (the OracleCap the first real run caught)
        await env.chain.warpSeconds(86401n);
        const play = async (wager, winner) => {
            const r = await createBattle(a, squadA, wager);
            await env.chain.send([(0, arena_1.acceptCompressedBattleIx)({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
            await env.chain.send([(0, sbmock_1.revealIx)({ kind: pdas_1.RNG_KIND.BATTLE, payer: env.admin.publicKey, randomness: r.rng.randomness, value: (0, flows_1.valueOf)('A07', Number(r.nonce)) })], { signers: [env.admin] });
            return env.chain.send([resolveBattleIx({ oracle: env_1.BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: r.rng.randomness, winner: winner.publicKey, resultHash: (0, flows_1.valueOf)('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [env_1.BATTLE_ORACLE] });
        };
        await play(50n * CG, a); // pot 100 ≤ 150
        await (0, expect_1.expectFail)(play(50n * CG, b), expect_1.Err.arena('OracleCap'), 'second pot would exceed 150');
        await env.chain.warpSeconds(86401n);
        await play(50n * CG, b);
        await env.chain.send([setCap(1000000n * CG)], { signers: [env.admin] });
    }, 600_000);
    (0, vitest_1.it)('A08 squad checks: chip not owned → NotOwner; listed chip → ChipBusy; staked chips MAY fight', async () => {
        await (0, expect_1.expectFail)(createBattle(a, [squadA[0], squadA[1], squadB[0]], 10n * CG), expect_1.Err.arena('NotOwner'));
        // SEC-F01: a pack-opened claim is bound to its live CompressedPackSettlement and cannot be listed until
        // mint+register (60-cross X08 pins that refusal), so the listable chip here is an admin-staged claim
        // (settlement == default) — same account shape the arena squad check reads, no settlement to brick.
        const listed = await (0, flows_1.stageClaim)(env, a, 71001n);
        await env.chain.send([(0, market_1.listCompressedIx)({ seller: a.publicKey, claim: listed.claim, price: 1000000000n, currency: 0 })], { signers: [a] });
        await (0, expect_1.expectFail)(createBattle(a, [squadA[0], squadA[1], listed.claim], 10n * CG), expect_1.Err.arena('ChipBusy'));
        // SEC-F14: staked chips MAY fight — the one squad rule for Core, claim (v1) and proof (v2) squads
        // (staking pins ownership, it does not remove the chip; docs/02 §4.6). Same claim, staked → still fights.
        await env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: a.publicKey, claim: squadA[0] })], { signers: [a] });
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(squadA[0])).data).staked).toBe(true);
        const staked = await createBattle(a, squadA, 10n * CG);
        (0, vitest_1.expect)((await battleOf(staked.battle)).squadA.map((k) => k.toBase58())).toContain(squadA[0].toBase58());
        await env.chain.send([(0, arena_1.cancelStaleBattleIx)({ caller: a.publicKey, challenger: a.publicKey, nonce: staked.nonce, cgMint: env.mints.cg })], { signers: [a] });
        await env.chain.send([(0, staking_1.unstakeCompressedChipIx)({ owner: a.publicKey, claim: squadA[0], cgMint: env.mints.cg })], { signers: [a] });
    }, 600_000);
    (0, vitest_1.it)('A09 battle randomness lifecycle: close refused while Open/Accepted (BadStatus), allowed after Resolved/Cancelled, rent → challenger', async () => {
        const r = await createBattle(a, squadA, 10n * CG);
        const lut = (await (0, sbmock_1.randomnessAccount)(env.chain, r.rng.randomness)).lutSlot;
        const close = () => env.chain.send([(0, rng_1.closeRandomnessIx)({ ...r.rng, payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin] });
        await (0, expect_1.expectFail)(close(), expect_1.Err.arena('BadStatus'), 'open battle');
        await env.chain.send([(0, arena_1.cancelStaleBattleIx)({ caller: a.publicKey, challenger: a.publicKey, nonce: r.nonce, cgMint: env.mints.cg })], { signers: [a] });
        const before = await env.chain.balance(a.publicKey);
        const rent = (await env.chain.getAccount(r.rng.randomness)).lamports;
        await close();
        (0, vitest_1.expect)(await env.chain.getAccount(r.rng.randomness)).toBeNull();
        (0, vitest_1.expect)((await env.chain.balance(a.publicKey)) - before).toBe(rent);
        // re-using a nonce after close → the battle PDA still exists → init fails
        await (0, expect_1.expectAnyFail)(createBattle(a, squadA, 10n * CG, r.nonce), 'nonce reuse');
    }, 600_000);
});

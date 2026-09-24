"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodePacks = encodePacks;
// T-L-G — admin & global (docs/06 §3.5 "Общие / админ").
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
const lore_1 = require("@/shared/lib/lore");
const accounts_1 = require("@/chain/accounts");
const borsh_1 = require("@/chain/borsh");
const anchor_1 = require("@/chain/anchor");
const pdas_1 = require("@/chain/pdas");
const economy_1 = require("@guttercaps/economy");
const env_1 = require("./helpers/env");
const expect_1 = require("./helpers/expect");
const flows_1 = require("./helpers/flows");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
if (!bins.ok && !process.env.LOCALNET_RPC)
    console.warn(`[tests/localnet] skipped — missing program binaries:\n  ${bins.missing.join('\n  ')}\n  run \`anchor build -- --features localnet\` and \`npm run localnet:fixtures\` (see tests/localnet/README.md)`);
/** Encode `[PackDef; 4]` from the live config with a patch applied to one SKU (Borsh layout = PackDef 42 B). */
function encodePacks(env, patch) {
    const w = new borsh_1.BorshWriter();
    env.config.packs.forEach((p0, i) => {
        const p = { ...p0, ...(patch[i] ?? {}) };
        w.u8(p.chips).u32(p.priceUsdCents).u64(p.priceCgMicro);
        for (const o of p.oddsBps)
            w.u16(o);
        w.u8(p.floor).u8(p.dailyCap).u8(p.pityTier).u16(p.pityHardAt).u16(p.pitySoftStart).u16(p.pitySoftStepBps).bool(p.featuredOnly).bool(p.enabled);
    });
    return w.toBytes();
}
suite('T-L-G admin', () => {
    let env;
    (0, vitest_1.beforeAll)(async () => { env = await (0, env_1.getEnv)(); });
    (0, vitest_1.it)('G01 initialize + 10 create_collection: config, vault rent floor, CollectionMeta from lore, Core collection with update authority = meta PDA', async () => {
        const cfg = env.config;
        (0, vitest_1.expect)(cfg.admin.equals(env.admin.publicKey)).toBe(true);
        (0, vitest_1.expect)(cfg.treasury.equals(env_1.TREASURY.publicKey)).toBe(true);
        (0, vitest_1.expect)(cfg.collectionsCreated).toBe(lore_1.COLLECTIONS.length);
        (0, vitest_1.expect)(cfg.paused).toBe(false);
        (0, vitest_1.expect)(cfg.packs.map((p) => p.priceUsdCents)).toEqual([economy_1.PACKS.starter, economy_1.PACKS.standard, economy_1.PACKS.premium, economy_1.PACKS.limited].map((p) => p.priceUsdCents));
        (0, vitest_1.expect)(cfg.marketFeeBps).toBe(750);
        (0, vitest_1.expect)(cfg.skrDiscountBps).toBe(500);
        (0, vitest_1.expect)(await env.chain.balance((0, pdas_1.vaultPda)()[0])).toBeGreaterThanOrEqual(await env.chain.rentExempt(0));
        for (let i = 0; i < lore_1.COLLECTIONS.length; i++) {
            const meta = (0, accounts_1.decodeCollectionMeta)((await env.chain.getAccount((0, pdas_1.collectionMetaPda)(i)[0])).data);
            (0, vitest_1.expect)(meta.idx).toBe(i);
            (0, vitest_1.expect)(meta.symbol).toBe(lore_1.COLLECTIONS[i].symbol);
            (0, vitest_1.expect)(meta.minted).toBe(0n);
            const core = await env.chain.getAccount(meta.coreCollection);
            (0, vitest_1.expect)(core, `core collection ${i}`).not.toBeNull();
            (0, vitest_1.expect)(core.owner.toBase58()).toBe('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
            const header = (0, accounts_1.decodeCoreCollectionHeader)(core.data);
            (0, vitest_1.expect)(header.name).toBe(lore_1.COLLECTIONS[i].name);
            (0, vitest_1.expect)(header.updateAuthority?.equals((0, pdas_1.collectionMetaPda)(i)[0])).toBe(true);
        }
    });
    (0, vitest_1.it)('G01b create_collection: 11th index, non-sequential index and a non-admin signer are rejected', async () => {
        const core = web3_js_1.Keypair.generate();
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.createCollectionIx)({ admin: env.admin.publicKey, idx: 10, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [env.admin, core] }), expect_1.Err.chip('InvalidCollection'), 'idx 10');
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.createCollectionIx)({ admin: env.admin.publicKey, idx: 3, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [env.admin, core] }), expect_1.Err.system(0), 'existing idx (init on a live PDA)');
        const stranger = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.createCollectionIx)({ admin: stranger.publicKey, idx: 10, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [stranger, core] }), expect_1.Err.chip('Unauthorized'), 'stranger');
    });
    (0, vitest_1.it)('G02 set_params: full patch bumps params_version; every guard-rail rejects', async () => {
        const before = await env.refreshConfig();
        await env.chain.send([(0, env_1.setParamsIx)(env.admin.publicKey, { marketFeeBps: 800, skrDiscountBps: 700, featuredCollection: 2 })], { signers: [env.admin] });
        const after = await env.refreshConfig();
        (0, vitest_1.expect)(after.paramsVersion).toBe(before.paramsVersion + 1);
        (0, vitest_1.expect)(after.marketFeeBps).toBe(800);
        (0, vitest_1.expect)(after.skrDiscountBps).toBe(700);
        (0, vitest_1.expect)(after.featuredCollection).toBe(2);
        // restore defaults so later specs see the documented fee schedule
        await env.chain.send([(0, env_1.setParamsIx)(env.admin.publicKey, { marketFeeBps: 750, skrDiscountBps: 500, featuredCollection: 0 })], { signers: [env.admin] });
        env.config = await env.refreshConfig();
        const admin = env.admin.publicKey;
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { marketFeeBps: 1001 })], { signers: [env.admin] }), expect_1.Err.chip('FeeTooHigh'), 'fee > 10 %');
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { skrDiscountBps: 1501 })], { signers: [env.admin] }), expect_1.Err.chip('FeeTooHigh'), 'skr discount > 15 %');
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { featuredCollection: 10 })], { signers: [env.admin] }), expect_1.Err.chip('InvalidCollection'), 'featured ≥ created');
        const odds = [...env.config.packs[1].oddsBps];
        odds[0] += 1;
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { packs: encodePacks(env, { 1: { oddsBps: odds } }) })], { signers: [env.admin] }), expect_1.Err.chip('OddsSumInvalid'), 'odds ≠ 10 000');
        const top = [...env.config.packs[1].oddsBps];
        top[0] -= 300;
        top[7] += 300; // Legend+ + Diamond = 320 bps > 200 on Standard
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { packs: encodePacks(env, { 1: { oddsBps: top } }) })], { signers: [env.admin] }), expect_1.Err.chip('OddsGuardRail'), 'top-2 guard rail');
        const cheap = encodePacks(env, { 1: { priceUsdCents: 49 } });
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { packs: cheap })], { signers: [env.admin] }), expect_1.Err.chip('OddsGuardRail'), 'price < $0.50');
        const pity = encodePacks(env, { 1: { pityHardAt: 5 } });
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { packs: pity })], { signers: [env.admin] }), expect_1.Err.chip('OddsGuardRail'), 'pity_hard_at < 10');
        const chips = encodePacks(env, { 2: { chips: 6 } });
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { packs: chips })], { signers: [env.admin] }), expect_1.Err.chip('InvalidQuantity'), 'chips > 5');
        // SEC-F13: the $CG pack price may move at most x1/2..x2 per set_params call, with a 1M $CG cap
        const cgNow = env.config.packs[1].priceCgMicro;
        (0, vitest_1.expect)(cgNow > 0n).toBe(true);
        const cgJump = encodePacks(env, { 1: { priceCgMicro: cgNow * 3n } });
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { packs: cgJump })], { signers: [env.admin] }), expect_1.Err.chip('CgPriceGuardRail'), '$CG price jump x3');
        const cgCap = encodePacks(env, { 1: { priceCgMicro: 1000000000001n } });
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(admin, { packs: cgCap })], { signers: [env.admin] }), expect_1.Err.chip('CgPriceGuardRail'), '$CG price over the 1M cap');
        const cgDouble = encodePacks(env, { 1: { priceCgMicro: cgNow * 2n } });
        await env.chain.send([(0, env_1.setParamsIx)(admin, { packs: cgDouble })], { signers: [env.admin] });
        const cgBack = encodePacks(env, { 1: { priceCgMicro: cgNow } });
        await env.chain.send([(0, env_1.setParamsIx)(admin, { packs: cgBack })], { signers: [env.admin] });
        const stranger = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(stranger.publicKey, { marketFeeBps: 100 })], { signers: [stranger] }), expect_1.Err.chip('Unauthorized'), 'non-admin');
    });
    (0, vitest_1.it)('G03 set_paused: buy_pack → Paused while paused, admin-only, unpause restores', async () => {
        await env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, true)], { signers: [env.admin] });
        (0, vitest_1.expect)((await env.refreshConfig()).paused).toBe(true);
        const buyer = await env.player({ usdc: 100000000n });
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC }), expect_1.Err.chip('Paused'), 'buy while paused');
        const stranger = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setPausedIx)(stranger.publicKey, false)], { signers: [stranger] }), expect_1.Err.chip('Unauthorized'), 'stranger unpause');
        await env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, false)], { signers: [env.admin] });
        (0, vitest_1.expect)((await env.refreshConfig()).paused).toBe(false);
        await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
    });
    // All three programs attach their own Unauthorized to the admin/pauser constraints
    // (has_one = admin @ <Program>Error::Unauthorized / a custom constraint on the pauser) — the anchor
    // framework codes (2001/2003) never surface for these paths.
    const unauthorizedOf = { chip_core: expect_1.Err.chip('Unauthorized'), staking: expect_1.Err.staking('Unauthorized'), arena: expect_1.Err.arena('Unauthorized') };
    (0, vitest_1.it)('G03b pauser role (SEC-H2): pauser may `pause` on chip_core / staking / arena but cannot un-pause or change params; admin does both; cleared pauser loses the right', async () => {
        const pauser = await env.player();
        const stranger = await env.player();
        const pausedOf = {
            chip_core: async () => (await env.refreshConfig()).paused,
            staking: async () => (0, accounts_1.decodeEmissionState)((await env.chain.getAccount((0, pdas_1.emissionPda)()[0])).data).paused,
            arena: async () => (0, accounts_1.decodeArenaConfig)((await env.chain.getAccount((0, pdas_1.arenaConfigPda)()[0])).data).paused,
        };
        for (const program of ['chip_core', 'staking', 'arena']) {
            // nobody but admin before a pauser is set (Pubkey::default() never matches a real signer)
            await (0, expect_1.expectFail)(env.chain.send([(0, env_1.pauseIx)(program, pauser.publicKey)], { signers: [pauser] }), unauthorizedOf[program], `${program}: pause before designation`);
            await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setPauserIx)(program, stranger.publicKey, pauser.publicKey)], { signers: [stranger] }), unauthorizedOf[program], `${program}: stranger sets pauser`);
            const designated = await env.chain.send([(0, env_1.setPauserIx)(program, env.admin.publicKey, pauser.publicKey)], { signers: [env.admin] });
            // SEC-G05: the rotation is an event (`PauserChanged{by, pauser}`, same shape in all three programs) — the
            // indexer's `authority_changes` and the AuthorityChangeIndexed alert depend on it
            const ev = (0, anchor_1.findEvent)(designated.logs, 'PauserChanged', (r) => ({ by: r.pubkey(), pauser: r.pubkey() }));
            (0, vitest_1.expect)(ev, `${program}: PauserChanged emitted`).toBeDefined();
            (0, vitest_1.expect)(ev.by.equals(env.admin.publicKey)).toBe(true);
            (0, vitest_1.expect)(ev.pauser.equals(pauser.publicKey)).toBe(true);
            // pauser: pause OK (idempotent), un-pause impossible (no instruction accepts it), stranger refused
            await env.chain.send([(0, env_1.pauseIx)(program, pauser.publicKey)], { signers: [pauser], label: `${program}: pauser pauses` });
            (0, vitest_1.expect)(await pausedOf[program]()).toBe(true);
            await env.chain.send([(0, env_1.pauseIx)(program, pauser.publicKey)], { signers: [pauser], label: `${program}: pause twice` });
            await (0, expect_1.expectFail)(env.chain.send([(0, env_1.unpauseIx)(program, pauser.publicKey)], { signers: [pauser] }), unauthorizedOf[program], `${program}: pauser un-pauses`);
            await (0, expect_1.expectFail)(env.chain.send([(0, env_1.pauseIx)(program, stranger.publicKey)], { signers: [stranger] }), unauthorizedOf[program], `${program}: stranger pauses`);
            if (program === 'chip_core') {
                const buyer = await env.player({ usdc: 100000000n });
                await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC }), expect_1.Err.chip('Paused'), 'buy while pauser-paused');
                await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(pauser.publicKey, { marketFeeBps: 100 })], { signers: [pauser] }), expect_1.Err.chip('Unauthorized'), 'pauser cannot set_params');
            }
            // admin: un-pause, and `pause` also works for the admin itself
            await env.chain.send([(0, env_1.unpauseIx)(program, env.admin.publicKey)], { signers: [env.admin] });
            (0, vitest_1.expect)(await pausedOf[program]()).toBe(false);
            await env.chain.send([(0, env_1.pauseIx)(program, env.admin.publicKey)], { signers: [env.admin] });
            (0, vitest_1.expect)(await pausedOf[program]()).toBe(true);
            await env.chain.send([(0, env_1.unpauseIx)(program, env.admin.publicKey)], { signers: [env.admin] });
            // clearing the pauser revokes the right
            await env.chain.send([(0, env_1.setPauserIx)(program, env.admin.publicKey, web3_js_1.PublicKey.default)], { signers: [env.admin] });
            await (0, expect_1.expectFail)(env.chain.send([(0, env_1.pauseIx)(program, pauser.publicKey)], { signers: [pauser] }), unauthorizedOf[program], `${program}: cleared pauser`);
            (0, vitest_1.expect)(await pausedOf[program]()).toBe(false);
        }
        (0, vitest_1.expect)((await env.refreshConfig()).pauser.equals(web3_js_1.PublicKey.default)).toBe(true);
    });
    (0, vitest_1.it)('G04 propose_admin / accept_admin: two-step hand-over, only the proposed key may accept, round-trip back', async () => {
        const next = await env.player();
        const stranger = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.acceptAdminIx)(stranger.publicKey)], { signers: [stranger] }), expect_1.Err.chip('Unauthorized'), 'accept without proposal');
        await env.chain.send([(0, env_1.proposeAdminIx)(env.admin.publicKey, next.publicKey)], { signers: [env.admin] });
        (0, vitest_1.expect)((await env.refreshConfig()).pendingAdmin.equals(next.publicKey)).toBe(true);
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.acceptAdminIx)(stranger.publicKey)], { signers: [stranger] }), expect_1.Err.chip('Unauthorized'), 'stranger accepts');
        await env.chain.send([(0, env_1.acceptAdminIx)(next.publicKey)], { signers: [next] });
        let cfg = await env.refreshConfig();
        (0, vitest_1.expect)(cfg.admin.equals(next.publicKey)).toBe(true);
        (0, vitest_1.expect)(cfg.pendingAdmin.equals(web3_js_1.PublicKey.default)).toBe(true);
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, true)], { signers: [env.admin] }), expect_1.Err.chip('Unauthorized'), 'old admin');
        // hand it back for the rest of the suite
        await env.chain.send([(0, env_1.proposeAdminIx)(next.publicKey, env.admin.publicKey)], { signers: [next] });
        await env.chain.send([(0, env_1.acceptAdminIx)(env.admin.publicKey)], { signers: [env.admin] });
        cfg = await env.refreshConfig();
        (0, vitest_1.expect)(cfg.admin.equals(env.admin.publicKey)).toBe(true);
    });
    (0, vitest_1.it)('G05 sweep_vault never dips below liabilities: compressed open keeps liab_usdc until DAS settlement', async () => {
        const buyer = await env.player({ usdc: 100000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const led = await env.ledger();
        (0, vitest_1.expect)(led.liabUsdc).toBeGreaterThanOrEqual(b.paid);
        // #12: the liability sits in the buyer's shard only; config carries no counters any more
        const shard = await env.ledgerShard((0, pdas_1.ledgerShardOf)(buyer.publicKey));
        (0, vitest_1.expect)(shard.liabUsdc).toBeGreaterThanOrEqual(b.paid);
        const vault = (0, pdas_1.vaultPda)()[0];
        await env.chain.send([(0, env_1.sweepVaultIx)({ admin: env.admin.publicKey, treasury: env_1.TREASURY.publicKey, mint: env.mints.usdc })], { signers: [env.admin] });
        (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.usdc, vault)).toBeGreaterThanOrEqual(led.liabUsdc);
        const treasuryAfterFirstSweep = await (0, env_1.tokenBalance)(env.chain, env.mints.usdc, env_1.TREASURY.publicKey);
        // A compressed open creates claims but does not release payment liability.
        // Mint/DAS registration and explicit settlement must happen first.
        await (0, flows_1.revealAndOpenCompressedAll)(env, buyer, b, (0, flows_1.valueOf)('G05'));
        const liabAfter = (await env.ledger()).liabUsdc;
        (0, vitest_1.expect)(liabAfter).toBe(led.liabUsdc);
        await env.chain.send([(0, env_1.sweepVaultIx)({ admin: env.admin.publicKey, treasury: env_1.TREASURY.publicKey, mint: env.mints.usdc })], { signers: [env.admin] });
        (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.usdc, vault)).toBeGreaterThanOrEqual(liabAfter);
        (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.usdc, env_1.TREASURY.publicKey)).toBe(treasuryAfterFirstSweep);
        // SOL leg never below liab_lamports + rent floor
        const solBuyer = await env.player();
        const sb = await (0, flows_1.buyPack)(env, solBuyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL });
        await env.chain.send([(0, env_1.sweepVaultIx)({ admin: env.admin.publicKey, treasury: env_1.TREASURY.publicKey })], { signers: [env.admin] });
        const led2 = await env.ledger();
        (0, vitest_1.expect)(await env.chain.balance(vault)).toBeGreaterThanOrEqual(led2.liabLamports + (await env.chain.rentExempt(0)));
        (0, vitest_1.expect)(led2.liabLamports).toBeGreaterThanOrEqual(sb.paid);
        const stranger = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.sweepVaultIx)({ admin: stranger.publicKey, treasury: env_1.TREASURY.publicKey })], { signers: [stranger] }), expect_1.Err.chip('Unauthorized'), 'stranger sweep');
    });
    (0, vitest_1.it)('G05b (#12) sweep_vault needs every ledger shard: a missing / duplicated / foreign shard is rejected, never treated as zero liability', async () => {
        const all = (0, pdas_1.allLedgerPdas)();
        const sweep = (shards) => env.chain.send([(0, env_1.sweepVaultIx)({ admin: env.admin.publicKey, treasury: env_1.TREASURY.publicKey, shards })], { signers: [env.admin] });
        await (0, expect_1.expectFail)(sweep(all.slice(0, pdas_1.LEDGER_SHARDS - 1)), expect_1.Err.chip('InvalidShard'), 'one shard missing');
        await (0, expect_1.expectFail)(sweep([all[1], all[0], ...all.slice(2)]), expect_1.Err.chip('InvalidShard'), 'shards out of order');
        await (0, expect_1.expectFail)(sweep([all[0], all[0], ...all.slice(2)]), expect_1.Err.chip('InvalidShard'), 'duplicated shard');
        await (0, expect_1.expectFail)(sweep([(0, pdas_1.configPda)()[0], ...all.slice(1)]), expect_1.Err.anchor('AccountDiscriminatorMismatch'), 'foreign account in a shard slot');
        // init_ledger is idempotent-by-failure: a second init of an existing shard fails (system program: account already in use), shard ≥ N is InvalidShard
        await (0, expect_1.expectAnyFail)(env.chain.send([(0, env_1.initLedgerIx)({ payer: env.admin.publicKey, shard: 0 })], { signers: [env.admin] }), 're-init shard 0');
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.initLedgerIx)({ payer: env.admin.publicKey, shard: pdas_1.LEDGER_SHARDS })], { signers: [env.admin] }), expect_1.Err.chip('InvalidShard'), 'shard out of range');
        // the happy path still works and every shard carries its own id + bump
        await sweep(all);
        for (let i = 0; i < pdas_1.LEDGER_SHARDS; i++)
            (0, vitest_1.expect)((await env.ledgerShard(i)).shard).toBe(i);
    });
    (0, vitest_1.it)('G06 grant_booster: admin grants ≤ 10, PlayerItems created; a stranger → Unauthorized; > 10 → InvalidQuantity', async () => {
        const owner = await env.player();
        await env.chain.send([(0, env_1.grantBoosterIx)({ authority: env.admin.publicKey, payer: env.admin.publicKey, owner: owner.publicKey, count: 3 })], { signers: [env.admin] });
        const items = (0, accounts_1.decodePlayerItems)((await env.chain.getAccount((0, pdas_1.playerItemsPda)(owner.publicKey)[0])).data);
        (0, vitest_1.expect)(items.owner.equals(owner.publicKey)).toBe(true);
        (0, vitest_1.expect)(items.boosters).toBe(3);
        const stranger = await env.player();
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.grantBoosterIx)({ authority: stranger.publicKey, payer: stranger.publicKey, owner: owner.publicKey, count: 1 })], { signers: [stranger] }), expect_1.Err.chip('Unauthorized'), 'stranger grants');
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.grantBoosterIx)({ authority: env.admin.publicKey, payer: env.admin.publicKey, owner: owner.publicKey, count: 11 })], { signers: [env.admin] }), expect_1.Err.chip('InvalidQuantity'), '> 10');
        (0, vitest_1.expect)((0, accounts_1.decodePlayerItems)((await env.chain.getAccount((0, pdas_1.playerItemsPda)(owner.publicKey)[0])).data).boosters).toBe(3);
        (0, vitest_1.expect)((0, pdas_1.configPda)()[0]).toBeInstanceOf(web3_js_1.PublicKey);
    });
});

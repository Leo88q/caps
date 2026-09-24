"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-L-C — packs: buy / reveal / open / refund / randomness PDA (docs/06 §3.5 "Паки").
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
const economy_1 = require("@guttercaps/economy");
const accounts_1 = require("@/chain/accounts");
const chipCore_1 = require("@/chain/ix/chipCore");
const anchor_1 = require("@/chain/anchor");
const rng_1 = require("@/chain/ix/rng");
const pdas_1 = require("@/chain/pdas");
const packFlow_1 = require("@/chain/flows/packFlow");
const ids_1 = require("@/chain/ids");
const env_1 = require("./helpers/env");
const _00_admin_spec_1 = require("./00-admin.spec");
const expect_1 = require("./helpers/expect");
const flows_1 = require("./helpers/flows");
const pyth_1 = require("./helpers/pyth");
const sbmock_1 = require("./helpers/sbmock");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
/** scenarios that forge accounts or move the clock — LiteSVM back-end only (RPC = LOCALNET_RPC set) */
const svmOnly = vitest_1.it.skipIf(!!process.env.LOCALNET_RPC);
const STALE = 10800n;
const RENT_RESERVE_PER_CHIP = 8000000n; // SEC-L3
const DAY = 86400n;
suite('T-L-C packs', () => {
    let env;
    const warp = () => env.chain.canWarp;
    (0, vitest_1.beforeAll)(async () => { env = await (0, env_1.getEnv)(); });
    (0, vitest_1.it)('C01 Starter: 1 per wallet, 3 Bubblegum V2 claims expire after 7 d; registration values are bound before mint', async () => {
        const buyer = await env.player();
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STARTER, currency: flows_1.Currency.SOL });
        (0, vitest_1.expect)((await (0, flows_1.loadPity)(env.chain, buyer.publicKey)).starterClaimed).toBe(true);
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STARTER, currency: flows_1.Currency.SOL }), expect_1.Err.chip('StarterAlreadyClaimed'), 'second starter');
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STARTER, qty: 2, currency: flows_1.Currency.USDC }), expect_1.Err.chip('StarterAlreadyClaimed'), 'starter qty 2');
        const [open] = await (0, flows_1.revealAndOpenCompressedAll)(env, buyer, b, (0, flows_1.valueOf)('C01'));
        (0, vitest_1.expect)(open.event.count).toBe(3);
        const settlementKey = (0, pdas_1.compressedSettlementPda)(buyer.publicKey, b.nonce)[0];
        const now = await env.chain.now();
        for (let i = 0; i < open.event.count; i++) {
            const claimKey = (0, pdas_1.compressedMintClaimPda)(buyer.publicKey, open.event.claimNonces[i])[0];
            const claim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(claimKey)).data);
            (0, vitest_1.expect)(claim.buyer.equals(buyer.publicKey)).toBe(true);
            (0, vitest_1.expect)(claim.settlement.equals(settlementKey)).toBe(true);
            (0, vitest_1.expect)(claim.collectionIdx).toBe(open.rolled[i].collectionIdx);
            (0, vitest_1.expect)(claim.rarity).toBe(open.rolled[i].rarity);
            (0, vitest_1.expect)(claim.level).toBe(1);
            (0, vitest_1.expect)(claim.expiresAt).toBeGreaterThanOrEqual(now + 7n * DAY - 60n);
            (0, vitest_1.expect)(claim.indexReserved).toBe(true);
            (0, vitest_1.expect)(claim.minted).toBe(false);
        }
    });
    (0, vitest_1.it)('C02 Standard in SOL through Pyth: lamports = units_for_cents(price − conf) ± 1; max_lamports below quote → Slippage; stale price → StalePrice; conf > 2 % → PriceUncertain (SEC-M2); foreign owner → rejected', async () => {
        const buyer = await env.player();
        const vault = (0, flows_1.vaultKey)();
        const vaultBefore = await env.chain.balance(vault);
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL });
        const expected = (0, flows_1.quoteUnits)(env, flows_1.SKU.STANDARD, 1, flows_1.Currency.SOL);
        // $4.99 at $150.00 with the fixture's 0.1 % conf → charged at $149.85 (price − conf): 0.033299966 SOL
        (0, vitest_1.expect)(expected).toBe((499n * 1000000000n * 100000000n) / 100n / (15000000000n - 15000000n));
        (0, vitest_1.expect)(expected).toBeGreaterThan((499n * 1000000000n * 100000000n) / 100n / 15000000000n); // the buyer never gets the optimistic edge
        (0, vitest_1.expect)((0, expect_1.lamportsClose)(await env.chain.balance(vault), vaultBefore + expected, 1n)).toBe(true);
        const pending = (await (0, flows_1.loadPending)(env.chain, b.pending));
        (0, vitest_1.expect)(pending.paidLamports).toBe(expected);
        (0, vitest_1.expect)(await env.chain.balance(b.pending)).toBeGreaterThanOrEqual(3n * RENT_RESERVE_PER_CHIP);
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL, maxUnits: expected - 1n }), expect_1.Err.chip('Slippage'), 'max below quote');
        if (warp()) {
            await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL, stalePrice: 61n }), expect_1.Err.chip('StalePrice'), 'price 61 s old');
            // SEC-M2: conf/price = 2 % + 1 unit → PriceUncertain; exactly 2 % → accepted (and priced at price − conf)
            await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL, conf: { sol: 300000001n } }), expect_1.Err.chip('PriceUncertain'), 'conf 2 % + 1');
            const wide = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL, conf: { sol: 300000000n }, maxUnits: (expected * 105n) / 100n });
            (0, vitest_1.expect)((await (0, flows_1.loadPending)(env.chain, wide.pending)).paidLamports).toBe((499n * 1000000000n * 100000000n) / 100n / (15000000000n - 300000000n));
            const fake = await (0, pyth_1.forgePriceAccount)(env.chain, env.pyth.sol, web3_js_1.Keypair.generate().publicKey);
            await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL, priceUpdate: fake }), expect_1.Err.chip('StalePrice'), 'foreign price owner');
            await (0, pyth_1.refreshPyth)(env.chain, env.pyth);
        }
        // SKR feed passed for a SOL purchase → feed id mismatch → StalePrice
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL, priceUpdate: env.pyth.skr.account }), expect_1.Err.chip('StalePrice'), 'wrong feed');
        (0, vitest_1.expect)(ids_1.PYTH_RECEIVER_ID.toBase58()).toBe('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
    });
    (0, vitest_1.it)('C03 USDC / $CG / SKR: exact amounts, liab_* accounting, SKR promo discount stacks', async () => {
        const buyer = await env.player({ usdc: 1000000000n, cg: 10000000000n, skr: 100000000000n });
        const vault = (0, flows_1.vaultKey)();
        const led0 = await env.ledger();
        const shards0 = await Promise.all(Array.from({ length: pdas_1.LEDGER_SHARDS }, (_, i) => env.ledgerShard(i)));
        const before = { usdc: await (0, env_1.tokenBalance)(env.chain, env.mints.usdc, vault), cg: await (0, env_1.tokenBalance)(env.chain, env.mints.cg, vault), skr: await (0, env_1.tokenBalance)(env.chain, env.mints.skr, vault) };
        const u = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        (0, vitest_1.expect)(u.paid).toBe(4990000n);
        const c = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.CG });
        (0, vitest_1.expect)(c.paid).toBe(750000000n);
        const s = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SKR });
        // $4.99 − 5 % SKR promo = $4.7405 → 474 cents (integer) at $0.0174 − 0.1 % conf (SEC-M2: price − conf) → 272 686 479 micro-SKR
        (0, vitest_1.expect)(s.paid).toBe((474n * 1000000n * 100000000n) / 100n / (1740000n - 1740n));
        (0, vitest_1.expect)(s.paid).toBe((0, flows_1.quoteUnits)(env, flows_1.SKU.STANDARD, 1, flows_1.Currency.SKR));
        (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.usdc, vault)).toBe(before.usdc + u.paid);
        (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.cg, vault)).toBe(before.cg + c.paid);
        (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.skr, vault)).toBe(before.skr + s.paid);
        const led = await env.ledger();
        (0, vitest_1.expect)(led.liabUsdc - led0.liabUsdc).toBe(u.paid);
        (0, vitest_1.expect)(led.liabCg - led0.liabCg).toBe(c.paid);
        (0, vitest_1.expect)(led.liabSkr - led0.liabSkr).toBe(s.paid);
        // #12: all three landed in the buyer's own shard and nowhere else
        const mine = (0, pdas_1.ledgerShardOf)(buyer.publicKey);
        for (let i = 0; i < pdas_1.LEDGER_SHARDS; i++) {
            const sh = await env.ledgerShard(i);
            const exp = i === mine ? [u.paid, c.paid, s.paid] : [0n, 0n, 0n];
            (0, vitest_1.expect)([sh.liabUsdc - shards0[i].liabUsdc, sh.liabCg - shards0[i].liabCg, sh.liabSkr - shards0[i].liabSkr]).toEqual(exp);
        }
        for (const b of [u, c, s]) {
            const p = (await (0, flows_1.loadPending)(env.chain, b.pending));
            (0, vitest_1.expect)([p.paidUsdc, p.paidCg, p.paidSkr].filter((x) => x > 0n)).toHaveLength(1);
        }
        // Starter and Limited cannot be paid in $CG (price_cg_micro = 0)
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, (await env.player({ cg: 1000000000n })), { sku: flows_1.SKU.STARTER, currency: flows_1.Currency.CG }), expect_1.Err.chip('CurrencyNotAccepted'), 'starter in $CG');
        // mint mismatch: buyer passes his USDC ATA for a $CG purchase
        const wrong = await env.player({ usdc: 1000000000n });
        await (0, expect_1.expectFail)(env.chain.send([
            (0, rng_1.initRandomnessIx)({ ...(0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, wrong.publicKey, 7n), queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
            (0, chipCore_1.buyPackIx)({ buyer: wrong.publicKey, sku: flows_1.SKU.STANDARD, qty: 1, currency: flows_1.Currency.CG, nonce: 7n, maxLamports: 0n, randomness: (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, wrong.publicKey, 7n).randomness, queue: env_1.SB_QUEUE, oracle: env_1.SB_ORACLE, usdcMint: env.mints.usdc, cgMint: env.mints.usdc, skrMint: env.mints.skr }),
        ], { signers: [wrong] }), expect_1.Err.chip('CurrencyNotAccepted'), 'wrong mint');
    });
    (0, vitest_1.it)('C04 bundles ×5 / ×10 / ×25: price with discount, PendingPack.qty, rent reserve × chips × qty; qty 0 / 26 rejected', async () => {
        const buyer = await env.player({ usdc: 10000000000n });
        for (const [qty, disc] of [[5, 700], [10, 1200], [25, 1800]]) {
            const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, qty, currency: flows_1.Currency.USDC });
            const cents = (499n * BigInt(qty) * BigInt(10_000 - disc)) / 10000n;
            (0, vitest_1.expect)(b.paid).toBe(cents * 10000n);
            const p = (await (0, flows_1.loadPending)(env.chain, b.pending));
            (0, vitest_1.expect)(p.qty).toBe(qty);
            (0, vitest_1.expect)(p.opened).toBe(0);
            (0, vitest_1.expect)(await env.chain.balance(b.pending)).toBeGreaterThanOrEqual(RENT_RESERVE_PER_CHIP * 3n * BigInt(qty));
        }
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, qty: 26, currency: flows_1.Currency.USDC }), expect_1.Err.chip('InvalidQuantity'), 'qty 26');
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, qty: 0, currency: flows_1.Currency.USDC }), expect_1.Err.chip('InvalidQuantity'), 'qty 0');
        // Limited never gets a bundle discount
        const lim = await env.player({ usdc: 10000000000n });
        await env.chain.send([(0, env_1.setParamsIx)(env.admin.publicKey, { packs: (0, _00_admin_spec_1.encodePacks)(env, { 3: { enabled: true } }) })], { signers: [env.admin] });
        env.config = await env.refreshConfig();
        const l = await (0, flows_1.buyPack)(env, lim, { sku: flows_1.SKU.LIMITED, qty: 5, currency: flows_1.Currency.USDC });
        (0, vitest_1.expect)(l.paid).toBe(2499n * 5n * 10000n);
    });
    (0, vitest_1.it)('C05 Limited: daily_cap 5 → the 6th of the day → DailyCapReached, resets after 24 h; disabled SKU → SkuDisabled', async () => {
        const buyer = await env.player({ usdc: 100000000000n });
        await env.chain.send([(0, env_1.setParamsIx)(env.admin.publicKey, { packs: (0, _00_admin_spec_1.encodePacks)(env, { 3: { enabled: true } }) })], { signers: [env.admin] });
        env.config = await env.refreshConfig();
        await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.LIMITED, qty: 3, currency: flows_1.Currency.USDC });
        await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.LIMITED, qty: 2, currency: flows_1.Currency.USDC });
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.LIMITED, qty: 1, currency: flows_1.Currency.USDC }), expect_1.Err.chip('DailyCapReached'), '6th limited');
        (0, vitest_1.expect)((await (0, flows_1.loadPity)(env.chain, buyer.publicKey)).boughtToday[flows_1.SKU.LIMITED]).toBe(5);
        if (warp()) {
            await env.chain.warpSeconds(DAY + 1n);
            await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.LIMITED, qty: 1, currency: flows_1.Currency.USDC });
            (0, vitest_1.expect)((await (0, flows_1.loadPity)(env.chain, buyer.publicKey)).boughtToday[flows_1.SKU.LIMITED]).toBe(1);
        }
        await env.chain.send([(0, env_1.setParamsIx)(env.admin.publicKey, { packs: (0, _00_admin_spec_1.encodePacks)(env, { 3: { enabled: false } }) })], { signers: [env.admin] });
        env.config = await env.refreshConfig();
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.LIMITED, qty: 1, currency: flows_1.Currency.USDC }), expect_1.Err.chip('SkuDisabled'), 'disabled');
    });
    (0, vitest_1.it)('C06 paused: buy → Paused, but an already-paid purchase opens into V2 claims', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        await env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, true)], { signers: [env.admin] });
        try {
            await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC }), expect_1.Err.chip('Paused'));
            const [open] = await (0, flows_1.revealAndOpenCompressedAll)(env, buyer, b, (0, flows_1.valueOf)('C06'));
            (0, vitest_1.expect)(open.event.count).toBe(3);
            (0, vitest_1.expect)((await (0, flows_1.loadPending)(env.chain, b.pending)).opened).toBe(1);
            const settlement = (0, accounts_1.decodeCompressedPackSettlement)((await env.chain.getAccount((0, pdas_1.compressedSettlementPda)(buyer.publicKey, b.nonce)[0])).data);
            (0, vitest_1.expect)(settlement.totalClaims).toBe(3);
        }
        finally {
            await env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, false)], { signers: [env.admin] });
        }
    });
    (0, vitest_1.it)('C07 open ×3: reveal + open_compressed_pack in ONE tx → deterministic V2 claims, pity, collection reservations, and pending settlement', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const value = (0, flows_1.valueOf)('C07');
        const pityBefore = (await (0, flows_1.loadPity)(env.chain, buyer.publicKey)).counters[flows_1.SKU.STANDARD];
        const cfg = await env.refreshConfig();
        const led = await env.ledger();
        const metasBefore = await Promise.all(Array.from({ length: cfg.collectionsCreated }, async (_, i) => (0, accounts_1.decodeCollectionMeta)((await env.chain.getAccount((0, pdas_1.collectionMetaPda)(i)[0])).data).minted));
        const { ix, rolled } = await (0, flows_1.openCompressedPackInstruction)(env, buyer.publicKey, b.nonce, 0, value, buyer.publicKey);
        const tx = await env.chain.send([(0, sbmock_1.revealIx)({ kind: pdas_1.RNG_KIND.PACK, payer: buyer.publicKey, randomness: b.randomness, value }), ix], { signers: [buyer], label: 'reveal+open_compressed' });
        const ev = (0, anchor_1.findEvent)(tx.logs, 'CompressedClaimsCreated', accounts_1.readCompressedClaimsCreated);
        (0, vitest_1.expect)(ev.count).toBe(3);
        (0, vitest_1.expect)(rolled.map((r) => r.collectionIdx)).toEqual(vitest_1.expect.any(Array));
        (0, vitest_1.expect)((await (0, flows_1.loadPity)(env.chain, buyer.publicKey)).counters[flows_1.SKU.STANDARD]).toBe(pityBefore + (rolled.some((r) => r.rarity >= 6) ? 0 : 1));
        for (let i = 0; i < ev.count; i++) {
            const claim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount((0, pdas_1.compressedMintClaimPda)(buyer.publicKey, ev.claimNonces[i])[0])).data);
            (0, vitest_1.expect)(claim.collectionIdx).toBe(rolled[i].collectionIdx);
            (0, vitest_1.expect)(claim.rarity).toBe(rolled[i].rarity);
            (0, vitest_1.expect)(claim.level).toBe(1);
            (0, vitest_1.expect)(claim.indexReserved).toBe(true);
            (0, vitest_1.expect)(claim.minted).toBe(false);
        }
        const metasAfter = await Promise.all(Array.from({ length: cfg.collectionsCreated }, async (_, i) => (0, accounts_1.decodeCollectionMeta)((await env.chain.getAccount((0, pdas_1.collectionMetaPda)(i)[0])).data).minted));
        const delta = metasAfter.map((m, i) => m - metasBefore[i]);
        rolled.forEach((r) => { delta[r.collectionIdx] -= 1n; });
        (0, vitest_1.expect)(delta.every((d) => d === 0n)).toBe(true);
        (0, vitest_1.expect)((await (0, flows_1.loadPending)(env.chain, b.pending)).opened).toBe(1);
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedPackSettlement)((await env.chain.getAccount((0, pdas_1.compressedSettlementPda)(buyer.publicKey, b.nonce)[0])).data).totalClaims).toBe(3);
        (0, vitest_1.expect)((await env.ledger()).liabUsdc).toBe(led.liabUsdc);
        const rnd = (await (0, sbmock_1.randomnessAccount)(env.chain, b.randomness));
        (0, vitest_1.expect)(rnd.revealSlot).toBeGreaterThan(0n);
        (0, vitest_1.expect)(Array.from(rnd.value)).toEqual(Array.from(value));
        (0, vitest_1.expect)(tx.cu).toBeLessThan(1400000n);
    });
    (0, vitest_1.it)('C08 bundle ×5 opened in 5 separate transactions / slots: revealed value persists and each slot binds claims to the same settlement', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, qty: 5, currency: flows_1.Currency.USDC });
        const value = (0, flows_1.valueOf)('C08');
        await (0, flows_1.revealPack)(env, b, value);
        const cfg = await env.refreshConfig();
        for (let packNo = 0; packNo < 5; packNo++) {
            if (warp())
                await env.chain.warpSlots(50n);
            const pity = (await (0, flows_1.loadPity)(env.chain, buyer.publicKey)).counters[flows_1.SKU.STANDARD];
            const r = await (0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, packNo, value);
            const expected = (0, economy_1.expandRandomness)((0, packFlow_1.packSeed)(value, 5, packNo), (0, packFlow_1.toEconPack)(flows_1.SKU.STANDARD, cfg.packs[flows_1.SKU.STANDARD]), pity, cfg.collectionsCreated);
            (0, vitest_1.expect)(r.rolled.map((x) => x.rarity)).toEqual(expected.map((x) => x.rarity));
            (0, vitest_1.expect)(r.rolled.map((x) => x.collectionIdx)).toEqual(expected.map((x) => x.collectionIdx));
            const p = await (0, flows_1.loadPending)(env.chain, b.pending);
            (0, vitest_1.expect)(p.opened).toBe(packNo + 1);
            (0, vitest_1.expect)(p.revealed).toBe(true);
            (0, vitest_1.expect)(Array.from(p.value)).toEqual(Array.from(value));
            const settlement = (0, accounts_1.decodeCompressedPackSettlement)((await env.chain.getAccount((0, pdas_1.compressedSettlementPda)(buyer.publicKey, b.nonce)[0])).data);
            (0, vitest_1.expect)(settlement.totalClaims).toBe((packNo + 1) * 3);
            for (const claimNonce of r.event.claimNonces) {
                const claim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount((0, pdas_1.compressedMintClaimPda)(buyer.publicKey, claimNonce)[0])).data);
                (0, vitest_1.expect)(claim.settlement.equals((0, pdas_1.compressedSettlementPda)(buyer.publicKey, b.nonce)[0])).toBe(true);
            }
        }
        // Claims still await Bubblegum mint/DAS registration; the compressed path
        // must not close the paid purchase or release its liability early.
        (0, vitest_1.expect)(await (0, flows_1.loadPending)(env.chain, b.pending)).not.toBeNull();
        await (0, expect_1.expectAnyFail)(env.chain.send([(0, chipCore_1.openCompressedPackIx)({ payer: env.admin.publicKey, buyer: buyer.publicKey, nonce: b.nonce, packNo: 5, chips: 3, randomness: (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, b.nonce).randomness, collectionIdx: [0, 0, 0] })], { signers: [env.admin] }), 'open after qty');
    });
    (0, vitest_1.it)('C09 bundle ×25 Premium: 25 compressed opens, each ≤ 400 k CU, reserve remains until async settlement', async () => {
        const buyer = await env.player({ usdc: 10000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.PREMIUM, qty: 25, currency: flows_1.Currency.USDC });
        (0, vitest_1.expect)(b.paid).toBe(((1299n * 25n * 8200n) / 10000n) * 10000n);
        const value = (0, flows_1.valueOf)('C09');
        await (0, flows_1.revealPack)(env, b, value);
        const cranker = await env.player();
        const crankerBefore = await env.chain.balance(cranker.publicKey);
        let maxCu = 0n;
        let claims = 0;
        for (let i = 0; i < 25; i++) {
            const r = await (0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, i, value, cranker);
            (0, vitest_1.expect)(r.event.count).toBe(5);
            claims += r.event.count;
            if (r.tx.cu > maxCu)
                maxCu = r.tx.cu;
        }
        (0, vitest_1.expect)(maxCu).toBeLessThanOrEqual(400000n);
        // A third-party cranker is reimbursed from the pending reserve for claim rent.
        const crankerAfter = await env.chain.balance(cranker.publicKey);
        (0, vitest_1.expect)(crankerBefore - crankerAfter).toBeLessThan(25n * 200000n);
        (0, vitest_1.expect)(claims).toBe(125);
        (0, vitest_1.expect)((await (0, flows_1.loadPending)(env.chain, b.pending)).opened).toBe(25);
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedPackSettlement)((await env.chain.getAccount((0, pdas_1.compressedSettlementPda)(buyer.publicKey, b.nonce)[0])).data).totalClaims).toBe(125);
        console.info(`[T-L-C09] max open_compressed_pack CU (5 claims) = ${maxCu}`);
    });
    svmOnly('C10 fake randomness (SEC-C1): a byte-identical RandomnessAccountData under a foreign owner → RandomnessMismatch at buy and at open', async () => {
        if (!warp())
            return;
        const buyer = await env.player({ usdc: 1000000000n });
        // (a) at buy: the PDA address is fixed by seeds, so plant the forged account AT the PDA address under a foreign owner
        const nonce = 4242n;
        const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, nonce);
        await (0, sbmock_1.forgeRandomness)(env.chain, { owner: web3_js_1.Keypair.generate().publicKey, kind: pdas_1.RNG_KIND.PACK, seedSlot: 0n, revealSlot: 0n, value: (0, flows_1.valueOf)('C10'), address: rng.randomness });
        await (0, expect_1.expectFail)((0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC, nonce, skipInit: true }), expect_1.Err.chip('RandomnessMismatch'), 'forged owner at buy');
        // (b) at open: a legit purchase, but the pending account is pinned to ITS randomness — a forged revealed account elsewhere is rejected by the pin
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const forged = await (0, sbmock_1.forgeRandomness)(env.chain, { owner: web3_js_1.Keypair.generate().publicKey, kind: pdas_1.RNG_KIND.PACK, seedSlot: (await (0, flows_1.loadPending)(env.chain, b.pending)).commitSlot, revealSlot: await env.chain.slot(), value: (0, flows_1.valueOf)('C10') });
        const { ix } = await (0, flows_1.openCompressedPackInstruction)(env, buyer.publicKey, b.nonce, 0, (0, flows_1.valueOf)('C10'), buyer.publicKey, { collectionOverride: [0, 0, 0] });
        ix.keys[3] = { ...ix.keys[3], pubkey: forged };
        await (0, expect_1.expectFail)(env.chain.send([ix], { signers: [buyer] }), expect_1.Err.chip('RandomnessMismatch'), 'forged at open');
        // (c) even the REAL pinned address, if its owner were swapped, fails the owner check
        const real = (await env.chain.getAccount(b.randomness));
        await env.chain.setAccount(b.randomness, { owner: web3_js_1.Keypair.generate().publicKey, data: real.data, lamports: real.lamports });
        await (0, expect_1.expectFail)((0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, 0, (0, flows_1.valueOf)('C10')), expect_1.Err.chip('RandomnessMismatch'), 'owner swapped on the pinned account');
        await env.chain.setAccount(b.randomness, { owner: env_1.SB_MOCK_ID, data: real.data, lamports: real.lamports });
    });
    (0, vitest_1.it)('C11 cancel_stale_pack before STALE_PACK_SLOTS → NotStale', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        await (0, expect_1.expectFail)((0, flows_1.cancelStale)(env, buyer, b, env.mints.usdc), expect_1.Err.chip('NotStale'), 'immediately');
        if (!warp())
            return;
        await env.chain.warpSlots(STALE - 5n);
        await (0, expect_1.expectFail)((0, flows_1.cancelStale)(env, buyer, b, env.mints.usdc), expect_1.Err.chip('NotStale'), 'one slot short');
    });
    svmOnly('C12 after reveal: cancel → RandomnessAlreadyRevealed even past the window; open still OK 1 000 slots later (C2)', async () => {
        if (!warp())
            return;
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        await (0, flows_1.revealPack)(env, b, (0, flows_1.valueOf)('C12'));
        await env.chain.warpSlots(STALE + 10n);
        await (0, expect_1.expectFail)((0, flows_1.cancelStale)(env, buyer, b, env.mints.usdc), expect_1.Err.chip('RandomnessAlreadyRevealed'), 'cancel after reveal');
        await env.chain.warpSlots(1000n);
        const r = await (0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, 0, (0, flows_1.valueOf)('C12'));
        (0, vitest_1.expect)(r.event.count).toBe(3);
        (0, vitest_1.expect)((await (0, flows_1.loadPending)(env.chain, b.pending)).opened).toBe(1);
    });
    svmOnly('C13 no reveal after STALE_PACK_SLOTS → 100 % refund in all four currencies, liab_* back to baseline, PendingPack closed', async () => {
        if (!warp())
            return;
        const buyer = await env.player({ usdc: 1000000000n, cg: 10000000000n, skr: 100000000000n });
        const led0 = await env.ledger();
        const sol = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SOL });
        const usdc = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const cg = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.CG });
        const skr = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.SKR });
        await env.chain.warpSlots(STALE + 1n);
        const solBefore = await env.chain.balance(buyer.publicKey);
        const reserve = await env.chain.balance(sol.pending);
        await (0, flows_1.cancelStale)(env, buyer, sol);
        const solAfter = await env.chain.balance(buyer.publicKey);
        (0, vitest_1.expect)((0, expect_1.lamportsClose)(solAfter - solBefore, sol.paid + reserve, 20000n)).toBe(true); // refund + reserve + rent − fee
        const tok = async (m) => (0, env_1.tokenBalance)(env.chain, m, buyer.publicKey);
        const u0 = await tok(env.mints.usdc);
        await (0, flows_1.cancelStale)(env, buyer, usdc, env.mints.usdc);
        (0, vitest_1.expect)((await tok(env.mints.usdc)) - u0).toBe(usdc.paid);
        const c0 = await tok(env.mints.cg);
        await (0, flows_1.cancelStale)(env, buyer, cg, env.mints.cg);
        (0, vitest_1.expect)((await tok(env.mints.cg)) - c0).toBe(cg.paid);
        const s0 = await tok(env.mints.skr);
        await (0, flows_1.cancelStale)(env, buyer, skr, env.mints.skr);
        (0, vitest_1.expect)((await tok(env.mints.skr)) - s0).toBe(skr.paid);
        const led = await env.ledger();
        (0, vitest_1.expect)(led.liabLamports).toBe(led0.liabLamports);
        (0, vitest_1.expect)(led.liabUsdc).toBe(led0.liabUsdc);
        (0, vitest_1.expect)(led.liabCg).toBe(led0.liabCg);
        (0, vitest_1.expect)(led.liabSkr).toBe(led0.liabSkr);
        for (const b of [sol, usdc, cg, skr])
            (0, vitest_1.expect)(await (0, flows_1.loadPending)(env.chain, b.pending)).toBeNull();
        // the reveal is refused afterwards? No — the oracle account is still un-revealed; a late reveal is harmless (nothing pins it) and close_randomness returns the rent
        await (0, flows_1.revealPack)(env, sol, (0, flows_1.valueOf)('late'));
        const lut = (await (0, sbmock_1.randomnessAccount)(env.chain, sol.randomness)).lutSlot;
        const ownerBefore = await env.chain.balance(buyer.publicKey);
        await env.chain.send([(0, rng_1.closeRandomnessIx)({ ...(0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, sol.nonce), payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin] });
        (0, vitest_1.expect)(await env.chain.getAccount(sol.randomness)).toBeNull();
        (0, vitest_1.expect)((await env.chain.balance(buyer.publicKey)) - ownerBefore).toBe(await env.chain.rentExempt(480));
    });
    (0, vitest_1.it)('C14 crank race: two open_compressed_pack calls for the same pack_no — the second fails and claims remain consistent', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, qty: 2, currency: flows_1.Currency.USDC });
        const value = (0, flows_1.valueOf)('C14');
        await (0, flows_1.revealPack)(env, b, value);
        const { ix } = await (0, flows_1.openCompressedPackInstruction)(env, buyer.publicKey, b.nonce, 0, value, env.admin.publicKey);
        await env.chain.send([ix], { signers: [env.admin] });
        await (0, expect_1.expectFail)(env.chain.send([ix], { signers: [env.admin] }), expect_1.Err.chip('InvalidQuantity'), 'replayed pack_no 0');
        (0, vitest_1.expect)((await (0, flows_1.loadPending)(env.chain, b.pending)).opened).toBe(1);
        await (0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, 1, value);
        (0, vitest_1.expect)((await (0, flows_1.loadPending)(env.chain, b.pending)).opened).toBe(2);
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedPackSettlement)((await env.chain.getAccount((0, pdas_1.compressedSettlementPda)(buyer.publicKey, b.nonce)[0])).data).totalClaims).toBe(6);
    });
    (0, vitest_1.it)('C15 wrong remaining_accounts: a collection/tree account that does not match the roll → InvalidCollection; wrong count → InvalidQuantity', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const value = (0, flows_1.valueOf)('C15');
        await (0, flows_1.revealPack)(env, b, value);
        const { rolled } = await (0, flows_1.openCompressedPackInstruction)(env, buyer.publicKey, b.nonce, 0, value, env.admin.publicKey);
        const wrong = rolled.map((r) => (r.collectionIdx + 1) % env.config.collectionsCreated);
        await (0, expect_1.expectFail)((0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, 0, value, env.admin, { collectionOverride: wrong }), expect_1.Err.chip('InvalidCollection'), 'shifted collections');
        const short = (0, chipCore_1.openCompressedPackIx)({ payer: env.admin.publicKey, buyer: buyer.publicKey, nonce: b.nonce, packNo: 0, chips: 2, randomness: b.randomness, collectionIdx: rolled.slice(0, 2).map((r) => r.collectionIdx) });
        await (0, expect_1.expectFail)(env.chain.send([short], { signers: [env.admin] }), expect_1.Err.chip('InvalidQuantity'), '2 of 3 claims');
        await (0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, 0, value);
    });
    (0, vitest_1.it)('C16 pity: after hard_at − 1 Standard packs without a Legend the next one guarantees ≥ Legend on the last slot (pity counter pre-seeded by earlier opens in this run)', async () => {
        const buyer = await env.player({ usdc: 100000000000n });
        const hardAt = env.config.packs[flows_1.SKU.STANDARD].pityHardAt; // 60
        // drive the counter up with a value that never rolls ≥ Legend: pick per-pack values by search
        const econ = (0, packFlow_1.toEconPack)(flows_1.SKU.STANDARD, env.config.packs[flows_1.SKU.STANDARD]);
        const noLegend = (pity) => { for (let s = 0; s < 5000; s++) {
            const v = (0, flows_1.valueOf)('C16-none', s);
            if ((0, economy_1.expandRandomness)(v, econ, pity, 10).every((r) => r.rarity < 6))
                return v;
        } throw new Error('no value'); };
        // bundles of 25 + 25 + 9 = 59 opens; the same 32-byte value serves a whole bundle because sub-seeds are keccak-derived → search per pack instead
        let counter = (await (0, flows_1.loadPity)(env.chain, buyer.publicKey))?.counters[flows_1.SKU.STANDARD] ?? 0;
        const need = hardAt - 1 - counter;
        for (let done = 0; done < need;) {
            const qty = Math.min(25, need - done);
            const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, qty, currency: flows_1.Currency.USDC });
            // find one base value whose every sub-seed avoids Legend at the counters it will see
            let base;
            for (let s = 0; s < 20_000 && !base; s++) {
                const v = (0, flows_1.valueOf)('C16-bundle', s);
                let ok = true;
                for (let p = 0; p < qty && ok; p++)
                    ok = (0, economy_1.expandRandomness)((0, packFlow_1.packSeed)(v, qty, p), econ, counter + p, 10).every((r) => r.rarity < 6);
                if (ok)
                    base = v;
            }
            if (!base)
                throw new Error('no bundle value without Legend');
            await (0, flows_1.revealPack)(env, b, base);
            for (let p = 0; p < qty; p++)
                await (0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, p, base);
            done += qty;
            counter += qty;
        }
        (0, vitest_1.expect)((await (0, flows_1.loadPity)(env.chain, buyer.publicKey)).counters[flows_1.SKU.STANDARD]).toBe(hardAt - 1);
        // the 60th: pick a value whose raw roll is < Legend on the last slot → program must lift it to Legend
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, qty: 1, currency: flows_1.Currency.USDC });
        const v = noLegend(0);
        const raw = (0, economy_1.expandRandomness)(v, { ...econ, pity: null }, 0, 10);
        (0, vitest_1.expect)(raw[2].rarity).toBeLessThan(6);
        const [r] = await (0, flows_1.revealAndOpenCompressedAll)(env, buyer, b, v);
        (0, vitest_1.expect)(r.rolled[2].rarity).toBeGreaterThanOrEqual(6);
        (0, vitest_1.expect)((await (0, flows_1.loadPity)(env.chain, buyer.publicKey)).counters[flows_1.SKU.STANDARD]).toBe(0);
        (0, vitest_1.expect)(economy_1.PACKS.standard.pity?.hardAt).toBe(hardAt);
    }, 600_000);
    (0, vitest_1.it)('C17 rng PDA (SEC-C3 part 2): authority ≠ rng_auth → RandomnessAuthority; already committed → RandomnessUsed; non-PDA address → seeds error', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const mk = (randomness, nonce) => (0, chipCore_1.buyPackIx)({ buyer: buyer.publicKey, sku: flows_1.SKU.STANDARD, qty: 1, currency: flows_1.Currency.USDC, nonce, maxLamports: 0n, randomness, queue: env_1.SB_QUEUE, oracle: env_1.SB_ORACLE, usdcMint: env.mints.usdc, cgMint: env.mints.cg, skrMint: env.mints.skr });
        // (a) a mock account created directly with the buyer as authority, at a non-PDA address → Anchor seeds constraint
        const stray = web3_js_1.Keypair.generate();
        await env.chain.send([(0, sbmock_1.mockInitIx)({ payer: buyer.publicKey, randomness: stray.publicKey, authority: buyer.publicKey, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer, stray] });
        await (0, expect_1.expectFail)(env.chain.send([mk(stray.publicKey, 9001n)], { signers: [buyer] }), expect_1.Err.anchor('ConstraintSeeds'), 'non-PDA randomness');
        // (b) the right PDA address but authority ≠ rng_auth (forged via set_raw on a legit init) → RandomnessAuthority
        if (warp()) {
            const nonce = 9002n;
            const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, nonce);
            await env.chain.send([(0, rng_1.initRandomnessIx)({ ...rng, queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer] });
            await env.chain.send([(0, sbmock_1.setRawIx)({ payer: buyer.publicKey, randomness: rng.randomness, payload: (0, sbmock_1.encodeRandomnessPayload)({ authority: buyer.publicKey }) })], { signers: [buyer] });
            await (0, expect_1.expectFail)(env.chain.send([mk(rng.randomness, nonce)], { signers: [buyer] }), expect_1.Err.chip('RandomnessAuthority'), 'authority ≠ rng_auth');
            // (c) already committed (seed_slot > 0) → RandomnessUsed
            const nonce2 = 9003n;
            const rng2 = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, nonce2);
            await env.chain.send([(0, rng_1.initRandomnessIx)({ ...rng2, queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer] });
            await env.chain.send([(0, sbmock_1.setRawIx)({ payer: buyer.publicKey, randomness: rng2.randomness, payload: (0, sbmock_1.encodeRandomnessPayload)({ authority: (0, pdas_1.rngAuthPda)(pdas_1.RNG_KIND.PACK)[0], seedSlot: 5n }) })], { signers: [buyer] });
            await (0, expect_1.expectFail)(env.chain.send([mk(rng2.randomness, nonce2)], { signers: [buyer] }), expect_1.Err.chip('RandomnessUsed'), 'seed_slot > 0');
        }
    });
    (0, vitest_1.it)('C18 init_randomness + buy_pack in one tx: seed_slot == slot − 1, authority == rng_auth, PendingPack.randomness == rngPda; re-init same nonce → RandomnessUsed', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const rnd = (await (0, sbmock_1.randomnessAccount)(env.chain, b.randomness));
        const p = (await (0, flows_1.loadPending)(env.chain, b.pending));
        (0, vitest_1.expect)(rnd.authority.equals((0, pdas_1.rngAuthPda)(pdas_1.RNG_KIND.PACK)[0])).toBe(true);
        (0, vitest_1.expect)(rnd.queue.equals(env_1.SB_QUEUE)).toBe(true);
        (0, vitest_1.expect)(rnd.revealSlot).toBe(0n);
        (0, vitest_1.expect)(p.commitSlot).toBe(rnd.seedSlot);
        (0, vitest_1.expect)(p.randomness.equals((0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, b.nonce).randomness)).toBe(true);
        (0, vitest_1.expect)(rnd.seedSlot).toBeGreaterThan(0n);
        const acc = (await env.chain.getAccount(b.randomness));
        (0, vitest_1.expect)(acc.owner.equals(env_1.SB_MOCK_ID)).toBe(true);
        (0, vitest_1.expect)(acc.data.length).toBe(480);
        await (0, expect_1.expectFail)(env.chain.send([(0, rng_1.initRandomnessIx)({ ...(0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, b.nonce), queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer] }), expect_1.Err.chip('RandomnessUsed'), 're-init');
        // kind 2 (battle) is arena-only in chip_core
        const bad = (0, rng_1.initRandomnessIx)({ ...(0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, 777n), queue: env_1.SB_QUEUE, recentSlot: 1n });
        bad.data = Buffer.from(bad.data);
        bad.data[8] = 2; // kind byte
        await (0, expect_1.expectAnyFail)(env.chain.send([bad], { signers: [buyer] }), 'kind 2 via chip_core');
    });
    (0, vitest_1.it)('C19 reveal_randomness by a stranger with the (mock) oracle signature → reveal_slot > 0; open by any payer; reveal twice → error', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const stranger = await env.player();
        await (0, flows_1.revealPack)(env, b, (0, flows_1.valueOf)('C19'), stranger);
        const rnd = (await (0, sbmock_1.randomnessAccount)(env.chain, b.randomness));
        (0, vitest_1.expect)(rnd.revealSlot).toBeGreaterThan(0n);
        (0, vitest_1.expect)(Array.from(rnd.value)).toEqual(Array.from((0, flows_1.valueOf)('C19')));
        await (0, expect_1.expectFail)((0, flows_1.revealPack)(env, b, (0, flows_1.valueOf)('other'), stranger), expect_1.Err.chip('RandomnessAlreadyRevealed'), 'second reveal');
        const r = await (0, flows_1.openCompressedPack)(env, buyer.publicKey, b.nonce, 0, (0, flows_1.valueOf)('C19'), stranger);
        (0, vitest_1.expect)(r.event.count).toBe(3);
        (0, vitest_1.expect)((await (0, flows_1.loadPending)(env.chain, b.pending)).opened).toBe(1);
        // a reveal for a never-committed account (init only) → RandomnessExpired (seed_slot == 0)
        const nonce = 4711n;
        const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, nonce);
        await env.chain.send([(0, rng_1.initRandomnessIx)({ ...rng, queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n })], { signers: [buyer] });
        await (0, expect_1.expectFail)(env.chain.send([(0, sbmock_1.revealIx)({ kind: pdas_1.RNG_KIND.PACK, payer: stranger.publicKey, randomness: rng.randomness, value: (0, flows_1.valueOf)('x') })], { signers: [stranger] }), expect_1.Err.chip('RandomnessExpired'), 'reveal before commit');
    });
    (0, vitest_1.it)('C20 close_randomness: compressed claims keep PendingPack and randomness alive until asynchronous settlement', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const b = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, b.nonce);
        const lut = (await (0, sbmock_1.randomnessAccount)(env.chain, b.randomness)).lutSlot;
        const close = (payer) => env.chain.send([(0, rng_1.closeRandomnessIx)({ ...rng, payer: payer.publicKey, lutSlot: lut })], { signers: [payer] });
        await (0, expect_1.expectFail)(close(env.admin), expect_1.Err.chip('InvalidChipState'), 'pending still open');
        await (0, flows_1.revealAndOpenCompressedAll)(env, buyer, b, (0, flows_1.valueOf)('C20'));
        // Unlike the legacy path, opening compressed claims does not close the
        // purchase: mint/DAS registration must settle every claim first. Closing
        // randomness while that settlement is pending remains forbidden.
        await (0, expect_1.expectFail)(close(env.admin), expect_1.Err.chip('InvalidChipState'), 'compressed settlement still pending');
        const other = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const bad = (0, rng_1.closeRandomnessIx)({ ...(0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, other.nonce), payer: env.admin.publicKey, lutSlot: lut });
        bad.keys[4] = { pubkey: (0, pdas_1.pendingPackPda)(buyer.publicKey, b.nonce)[0], isSigner: false, isWritable: false };
        await (0, expect_1.expectFail)(env.chain.send([bad], { signers: [env.admin] }), expect_1.Err.chip('RandomnessMismatch'), 'wrong pending');
        (0, vitest_1.expect)((0, flows_1.ataOf)(env.mints.cg, env_1.TREASURY.publicKey)).toBeInstanceOf(web3_js_1.PublicKey);
    });
});

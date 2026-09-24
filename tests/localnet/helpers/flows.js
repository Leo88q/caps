"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.valueOf = exports.RNG_KIND = exports.PACKS = exports.ataOf = exports.vaultKey = exports.nextNonce = exports.Currency = exports.SKU = void 0;
exports.quoteUnits = quoteUnits;
exports.buyPack = buyPack;
exports.loadPending = loadPending;
exports.loadPity = loadPity;
exports.loadChip = loadChip;
exports.revealPack = revealPack;
exports.openPackInstruction = openPackInstruction;
exports.openPack = openPack;
exports.openCompressedPackInstruction = openCompressedPackInstruction;
exports.openCompressedPack = openCompressedPack;
exports.revealAndOpenCompressedAll = revealAndOpenCompressedAll;
exports.revealAndOpenAll = revealAndOpenAll;
exports.stageClaim = stageClaim;
exports.mintCompressedChips = mintCompressedChips;
exports.cancelStale = cancelStale;
exports.commitClaimFusion = commitClaimFusion;
exports.loadPendingClaimFusion = loadPendingClaimFusion;
exports.mineFusionValue = mineFusionValue;
exports.revealClaimFusion = revealClaimFusion;
exports.cancelStaleClaimFusion = cancelStaleClaimFusion;
const spl_token_1 = require("@solana/spl-token");
const economy_1 = require("@guttercaps/economy");
Object.defineProperty(exports, "PACKS", { enumerable: true, get: function () { return economy_1.PACKS; } });
const anchor_1 = require("@/chain/anchor");
const accounts_1 = require("@/chain/accounts");
const chipCore_1 = require("@/chain/ix/chipCore");
Object.defineProperty(exports, "Currency", { enumerable: true, get: function () { return chipCore_1.Currency; } });
const rng_1 = require("@/chain/ix/rng");
const spl_1 = require("@/chain/ix/spl");
const pdas_1 = require("@/chain/pdas");
Object.defineProperty(exports, "RNG_KIND", { enumerable: true, get: function () { return pdas_1.RNG_KIND; } });
const packFlow_1 = require("@/chain/flows/packFlow");
const env_1 = require("./env");
const pyth_1 = require("./pyth");
const sbmock_1 = require("./sbmock");
Object.defineProperty(exports, "valueOf", { enumerable: true, get: function () { return sbmock_1.valueOf; } });
exports.SKU = { STARTER: 0, STANDARD: 1, PREMIUM: 2, LIMITED: 3 };
let nonceCounter = 1000n;
const nextNonce = () => ++nonceCounter;
exports.nextNonce = nextNonce;
/** Expected units for a SOL / SKR purchase at the fixture prices (same math as the program). */
function quoteUnits(env, sku, qty, currency) {
    const def = env.config.packs[sku];
    const bundle = qty >= 25 ? 1800 : qty >= 10 ? 1200 : qty >= 5 ? 700 : 0;
    let discount = sku === exports.SKU.LIMITED || sku === exports.SKU.STARTER ? 0 : bundle;
    if (currency === chipCore_1.Currency.SKR)
        discount = Math.min(discount + env.config.skrDiscountBps, 3000);
    const cents = (BigInt(def.priceUsdCents) * BigInt(qty) * BigInt(10_000 - discount)) / 10000n;
    if (currency === chipCore_1.Currency.SOL)
        return (0, pyth_1.unitsForCents)(cents, env.pyth.sol);
    if (currency === chipCore_1.Currency.SKR)
        return (0, pyth_1.unitsForCents)(cents, env.pyth.skr);
    if (currency === chipCore_1.Currency.USDC)
        return cents * 10000n;
    return (def.priceCgMicro * BigInt(qty) * BigInt(10_000 - discount)) / 10000n;
}
/**
 * `init_randomness + buy_pack` in ONE transaction (exactly what PackFlow.buy sends).
 * Refreshes the Pyth fixtures first so the 60 s window holds after clock warps.
 */
async function buyPack(env, buyer, o) {
    const { chain } = env;
    const qty = o.qty ?? 1;
    const currency = o.currency ?? chipCore_1.Currency.SOL;
    const nonce = o.nonce ?? (0, exports.nextNonce)();
    const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.PACK, buyer.publicKey, nonce);
    const randomness = o.randomness ?? rng.randomness;
    if (chain.kind === 'litesvm')
        await (0, pyth_1.refreshPyth)(chain, env.pyth, { ageS: o.stalePrice ?? 0n, conf: o.conf });
    const volatile = currency === chipCore_1.Currency.SOL || currency === chipCore_1.Currency.SKR;
    const quoted = volatile ? quoteUnits(env, o.sku, qty, currency) : 0n;
    const ixs = [...(o.extraIxs ?? [])];
    if (!o.skipInit)
        ixs.push((0, rng_1.initRandomnessIx)({ ...rng, queue: env_1.SB_QUEUE, recentSlot: (await chain.slot()) - 1n }));
    ixs.push((0, chipCore_1.buyPackIx)({
        buyer: buyer.publicKey, sku: o.sku, qty, currency, nonce,
        maxLamports: volatile ? (o.maxUnits ?? (quoted * 101n) / 100n) : 0n,
        randomness, queue: env_1.SB_QUEUE, oracle: env_1.SB_ORACLE,
        priceUpdate: volatile ? (o.priceUpdate ?? (currency === chipCore_1.Currency.SKR ? env.pyth.skr.account : env.pyth.sol.account)) : undefined,
        usdcMint: env.mints.usdc, cgMint: env.mints.cg, skrMint: env.mints.skr,
    }));
    const tx = await chain.send(ixs, { signers: [buyer], label: `buy_pack sku=${o.sku} qty=${qty} cur=${currency}` });
    const pending = (0, pdas_1.pendingPackPda)(buyer.publicKey, nonce)[0];
    return { nonce, randomness, pending, tx, paid: volatile ? quoted : quoteUnits(env, o.sku, qty, currency) };
}
async function loadPending(chain, key) {
    const a = await chain.getAccount(key);
    return a && a.data.length ? (0, accounts_1.decodePendingPack)(a.data) : null;
}
async function loadPity(chain, wallet) {
    const a = await chain.getAccount((0, pdas_1.pityPda)(wallet)[0]);
    return a ? (0, accounts_1.decodePlayerPity)(a.data) : null;
}
async function loadChip(chain, asset) {
    const a = await chain.getAccount((0, pdas_1.chipStatePda)(asset)[0]);
    return a && a.data.length ? (0, accounts_1.decodeChipState)(a.data) : null;
}
/** Permissionless reveal of a pack randomness account with a chosen value (defaults to a label-derived one). */
async function revealPack(env, b, value = (0, sbmock_1.valueOf)('pack'), payer = env.admin) {
    return env.chain.send([(0, sbmock_1.revealIx)({ kind: pdas_1.RNG_KIND.PACK, payer: payer.publicKey, randomness: b.randomness, value })], { signers: [payer], label: 'reveal_randomness' });
}
/**
 * Build the `open_pack` instruction for pack `packNo` — simulates `expandRandomness` off-chain
 * (with the live PackDef + pity counter) to know which collection accounts to pass, as the crank does.
 */
async function openPackInstruction(env, buyer, nonce, packNo, value, payer, opts = {}) {
    const { chain } = env;
    const pending = (await loadPending(chain, (0, pdas_1.pendingPackPda)(buyer, nonce)[0]));
    const cfg = await env.refreshConfig();
    const def = cfg.packs[pending.sku];
    // (#28) a quest chip voucher: 1 chip, template odds, no floor / pity, every district — same as the crank's voucherEconPack
    const econ = pending.voucher ? (0, packFlow_1.voucherEconPack)(pending) : (0, packFlow_1.toEconPack)(pending.sku, def);
    const pool = !pending.voucher && def.featuredOnly ? [cfg.featuredCollection] : Array.from({ length: cfg.collectionsCreated }, (_, i) => i);
    const pity = opts.pityOverride ?? (await loadPity(chain, buyer))?.counters[pending.sku] ?? 0;
    const rolls = (0, economy_1.expandRandomness)((0, packFlow_1.packSeed)(value, pending.qty, packNo), econ, pity, pool.length);
    const rolled = rolls.map((r) => ({ rarity: r.rarity, collectionIdx: pool[r.collectionIdx] }));
    const rolledCollections = opts.rolledOverride ?? rolled.map((r) => r.collectionIdx);
    const ix = (0, chipCore_1.openPackIx)({
        payer, buyer, nonce, packNo, qty: pending.qty, randomness: pending.randomness, rolledCollections, coreCollectionOf: env.coreOf,
        cg: pending.paidCg > 0n ? { cgMint: env.mints.cg, treasury: env.config.treasury } : undefined,
    });
    return { ix, rolled };
}
/** Open one pack of a purchase (value must already be revealed or persisted). */
async function openPack(env, buyer, nonce, packNo, value, payer = env.admin, opts = {}) {
    const { ix, rolled } = await openPackInstruction(env, buyer, nonce, packNo, value, payer.publicKey, opts);
    const tx = await env.chain.send([...(opts.prepend ?? []), ix], { signers: [payer], label: `open_pack #${packNo}` });
    const event = (0, anchor_1.findEvent)(tx.logs, 'PackOpened', accounts_1.readPackOpened);
    if (!event)
        throw new Error(`PackOpened event missing:\n${tx.logs.join('\n')}`);
    const pending = (0, pdas_1.pendingPackPda)(buyer, nonce)[0];
    const assets = rolled.map((_, i) => (0, pdas_1.assetPda)(pending, packNo, i)[0]);
    return { tx, event, rolled, assets };
}
/** Build the compressed roll-to-claim instruction without sending it. The
 * collection accounts are caller-supplied transport data; the program
 * recomputes the roll and rejects a mismatched account, which is useful for
 * negative localnet coverage as well as cranker clients. */
async function openCompressedPackInstruction(env, buyer, nonce, packNo, value, payer, opts = {}) {
    const pending = (await loadPending(env.chain, (0, pdas_1.pendingPackPda)(buyer, nonce)[0]));
    const cfg = await env.refreshConfig();
    const def = pending.voucher ? (0, packFlow_1.voucherEconPack)(pending) : (0, packFlow_1.toEconPack)(pending.sku, cfg.packs[pending.sku]);
    const pool = !pending.voucher && cfg.packs[pending.sku].featuredOnly
        ? [cfg.featuredCollection]
        : Array.from({ length: cfg.collectionsCreated }, (_, i) => i);
    const pity = opts.pityOverride ?? (await loadPity(env.chain, buyer))?.counters[pending.sku] ?? 0;
    const rolls = (0, economy_1.expandRandomness)((0, packFlow_1.packSeed)(value, pending.qty, packNo), def, pity, pool.length);
    const rolled = rolls.map((r) => ({ rarity: r.rarity, collectionIdx: pool[r.collectionIdx] }));
    const ix = (0, chipCore_1.openCompressedPackIx)({
        payer,
        buyer,
        nonce,
        packNo,
        chips: rolled.length,
        collectionIdx: opts.collectionOverride ?? rolled.map((r) => r.collectionIdx),
        randomness: pending.randomness,
    });
    return { ix, rolled };
}
/**
 * V2 replacement for `openPack`: resolve the deterministic roll into
 * claim-bound compressed chips without pretending that DAS has already
 * returned an asset id or proof. Bubblegum minting and registration are
 * deliberately separate follow-up transactions.
 */
async function openCompressedPack(env, buyer, nonce, packNo, value, payer = env.admin, opts = {}) {
    const { ix, rolled } = await openCompressedPackInstruction(env, buyer, nonce, packNo, value, payer.publicKey, opts);
    const tx = await env.chain.send([ix], { signers: [payer], label: `open_compressed_pack #${packNo}` });
    const event = (0, anchor_1.findEvent)(tx.logs, 'CompressedClaimsCreated', accounts_1.readCompressedClaimsCreated);
    if (!event)
        throw new Error(`CompressedClaimsCreated event missing:\n${tx.logs.join('\\n')}`);
    return { tx, event, rolled };
}
/** Reveal + open every pack of a purchase through the compressed claim path.
 * The purchase remains open until Bubblegum mint/registration settles each
 * claim; this helper intentionally does not finalize the settlement. */
async function revealAndOpenCompressedAll(env, buyer, b, value = (0, sbmock_1.valueOf)('pack'), payer = env.admin) {
    await revealPack(env, b, value, payer);
    const pending = (await loadPending(env.chain, (0, pdas_1.pendingPackPda)(buyer.publicKey, b.nonce)[0]));
    const out = [];
    for (let i = pending.opened; i < pending.qty; i++) {
        out.push(await openCompressedPack(env, buyer.publicKey, b.nonce, i, value, payer));
    }
    return out;
}
/** Reveal + open every pack of a purchase; returns one OpenResult per pack. */
async function revealAndOpenAll(env, buyer, b, value = (0, sbmock_1.valueOf)('pack'), payer = env.admin) {
    await revealPack(env, b, value, payer);
    const pending = (await loadPending(env.chain, (0, pdas_1.pendingPackPda)(buyer.publicKey, b.nonce)[0]));
    const out = [];
    for (let i = pending.opened; i < pending.qty; i++) {
        const prepend = i === pending.qty - 1 && pending.paidCg > 0n
            ? [(0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(payer.publicKey, (0, exports.ataOf)(env.mints.cg, env.config.treasury), env.config.treasury, env.mints.cg)]
            : [];
        out.push(await openPack(env, buyer.publicKey, b.nonce, i, value, payer, { prepend }));
    }
    return out;
}
/** A wallet with freshly opened Bubblegum V2 claim accounts. The claim PDA is the
 * economic handle until the asynchronous DAS mint/registration step completes. */
/**
 * An admin-staged pack claim: `settlement == default`, no settlement to brick.
 *
 * This is the shape every scenario needs when a claim must be **listable**. Since SEC-F01
 * (`set_compressed_claim_listed`, `chip_core/src/instructions/compressed.rs`) a claim still bound to a live
 * `CompressedPackSettlement` may only trade once it is `minted && registered` — selling it earlier locks the
 * purchase liability in the vault forever (60-cross X08 pins the refusal). A pack-flow claim from
 * `mintCompressedChips` above *is* settlement-bound and therefore not listable; staged claims are exempt and
 * list/buy/stake against them exactly like the market specs do.
 */
async function stageClaim(env, owner, nonce, rarity = 0, collectionIdx = 0) {
    const claim = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, nonce)[0];
    await env.chain.send([
        (0, chipCore_1.stageCompressedChipIx)({
            admin: env.admin.publicKey,
            buyer: owner.publicKey,
            collectionIdx,
            claimNonce: nonce,
            rarity,
            level: 1,
            gameIndex: nonce,
            expiresAt: (await env.chain.now()) + 7n * 86400n,
        }),
    ], { signers: [env.admin], label: `stage claim ${nonce}` });
    return { claim, claimNonce: nonce };
}
async function mintCompressedChips(env, owner, packs = 1, value) {
    const out = [];
    for (let p = 0; p < packs; p++) {
        const b = await buyPack(env, owner, { sku: exports.SKU.STANDARD, qty: 1, currency: chipCore_1.Currency.USDC });
        const [r] = await revealAndOpenCompressedAll(env, owner, b, value ?? (0, sbmock_1.valueOf)('mintCompressedChips', Number(b.nonce)));
        for (const claimNonce of r.event.claimNonces) {
            const claim = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, claimNonce)[0];
            const state = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(claim)).data);
            out.push({ claim, claimNonce, collectionIdx: state.collectionIdx, rarity: state.rarity, state });
        }
    }
    return out;
}
function cancelStale(env, buyer, b, paidMint) {
    return env.chain.send([(0, chipCore_1.cancelStalePackIx)({ buyer: buyer.publicKey, nonce: b.nonce, randomness: b.randomness, paidMint })], { signers: [buyer], label: 'cancel_stale_pack' });
}
/**
 * `init_randomness (kind 3) + fuse_claims_commit` in ONE transaction (exactly what
 * ClaimFusionFlow.fuse sends). The nonce doubles as the result claim nonce at reveal, so it must
 * not collide with a live claim PDA of the owner — `nextNonce()` (~1xxx) never overlaps staged
 * (50_0xx+) or pack-claim (`purchase * 128 + …`) nonces.
 */
async function commitClaimFusion(env, owner, o) {
    const nonce = o.nonce ?? (0, exports.nextNonce)();
    const rng = (0, rng_1.rngAccounts)(pdas_1.RNG_KIND.CLAIM_FUSION, owner.publicKey, nonce);
    const tx = await env.chain.send([
        (0, rng_1.initRandomnessIx)({ ...rng, queue: env_1.SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
        (0, chipCore_1.fuseClaimsCommitIx)({
            owner: owner.publicKey, nonce, resultCollectionIdx: o.resultCollectionIdx, useBooster: o.useBooster ?? false,
            randomness: rng.randomness, queue: env_1.SB_QUEUE, oracle: env_1.SB_ORACLE, cgMint: env.mints.cg, materials: o.materials,
        }),
    ], { signers: [owner], label: `fuse_claims_commit nonce=${nonce}` });
    return { nonce, randomness: rng.randomness, pending: (0, pdas_1.claimFusionPda)(owner.publicKey, nonce)[0], tx };
}
async function loadPendingClaimFusion(chain, key) {
    const a = await chain.getAccount(key);
    return a && a.data.length ? (0, accounts_1.decodePendingClaimFusion)(a.data) : null;
}
/**
 * Mine a deterministic oracle value whose roll succeeds/fails `recipe`
 * (`uniformBps(value, 0)` vs `FUSION_RECIPES[recipe].successBps` — the same comparison
 * `fuse_claims_reveal` makes). Returns the value and the expected roll for the event assertion.
 */
function mineFusionValue(label, recipe, wantSuccess) {
    const threshold = economy_1.FUSION_RECIPES[recipe].successBps;
    for (let salt = 0; salt < 10_000; salt++) {
        const value = (0, sbmock_1.valueOf)(label, salt);
        const roll = (0, economy_1.uniformBps)(value, 0);
        if (wantSuccess ? roll < threshold : roll >= threshold)
            return { value, roll };
    }
    throw new Error(`no ${wantSuccess ? 'success' : 'failure'} value for recipe ${recipe} in 10k salts`);
}
/**
 * Permissionless reveal through the mock, then `fuse_claims_reveal` as `payer` (two sends, like
 * `revealAndOpenCompressedAll`). `resultClaimNonce == commit nonce` by protocol convention.
 */
async function revealClaimFusion(env, owner, c, materials, value, payer = env.admin) {
    const pending = (await loadPendingClaimFusion(env.chain, (0, pdas_1.claimFusionPda)(owner, c.nonce)[0]));
    await env.chain.send([(0, sbmock_1.revealIx)({ kind: pdas_1.RNG_KIND.CLAIM_FUSION, payer: payer.publicKey, randomness: c.randomness, value })], { signers: [payer], label: 'reveal_randomness (kind 3)' });
    const tx = await env.chain.send([
        (0, chipCore_1.fuseClaimsRevealIx)({
            payer: payer.publicKey, owner, nonce: c.nonce, resultClaimNonce: c.nonce,
            resultCollectionIdx: pending.resultCollectionIdx, randomness: c.randomness, cgMint: env.mints.cg, materials,
        }),
    ], { signers: [payer], label: `fuse_claims_reveal nonce=${c.nonce}` });
    const event = (0, anchor_1.findEvent)(tx.logs, 'ClaimFusionRevealed', accounts_1.readClaimFusionRevealed);
    if (!event)
        throw new Error(`ClaimFusionRevealed event missing:\n${tx.logs.join('\n')}`);
    return { tx, event };
}
/** Refund path for an un-revealed fusion past `STALE_PACK_SLOTS` (fee back, materials un-consumed). */
function cancelStaleClaimFusion(env, owner, c, materials) {
    return env.chain.send([(0, chipCore_1.cancelStaleClaimFusionIx)({ owner: owner.publicKey, nonce: c.nonce, randomness: c.randomness, cgMint: env.mints.cg, materials })], { signers: [owner], label: 'cancel_stale_claim_fusion' });
}
const vaultKey = () => (0, pdas_1.vaultPda)()[0];
exports.vaultKey = vaultKey;
const ataOf = (mint, owner) => (0, spl_1.createAtaIdempotentIx)(owner, owner, mint).keys[1].pubkey;
exports.ataOf = ataOf;

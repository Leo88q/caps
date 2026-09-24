"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PackFlow = exports.SKU_IDS = void 0;
exports.toEconPack = toEconPack;
exports.voucherEconPack = voucherEconPack;
exports.fetchGameConfig = fetchGameConfig;
exports.fetchCoreCollections = fetchCoreCollections;
exports.fetchCollectionMetas = fetchCollectionMetas;
exports.fetchTreeMetas = fetchTreeMetas;
exports.packSeed = packSeed;
exports.rentReserve = rentReserve;
// Commit → reveal → open → settle state machine for packs. Pure orchestration: no
// React here; the UI subscribes through the `txs` store callbacks.
//
// V2 pipeline (mirrors the crank in backend/src/crank.ts): `open_compressed_pack`
// per pack_no, then per chip `mint_compressed_chip` → DAS resolve by
// `{symbol} #{game_index}` → local V2 preflight → `register_compressed_chip`,
// then `finalize_compressed_pack`. Every step is resumable: re-running `open()`
// skips whatever the crank (or an earlier attempt) already settled.
const web3_js_1 = require("@solana/web3.js");
const sha3_1 = require("@noble/hashes/sha3");
const economy_1 = require("@guttercaps/economy");
const config_1 = require("@/app/config");
const tx_1 = require("../tx");
const switchboard_1 = require("../switchboard");
const chipCore_1 = require("../ix/chipCore");
const spl_1 = require("../ix/spl");
const das_1 = require("../das");
const claimSettle_1 = require("./claimSettle");
const pdas_1 = require("../pdas");
const accounts_1 = require("../accounts");
const anchor_1 = require("../anchor");
exports.SKU_IDS = ['starter', 'standard', 'premium', 'limited'];
/** Convert on-chain PackDef → economy PackDef (so expandRandomness uses LIVE params, not defaults). */
function toEconPack(sku, p) {
    const base = economy_1.PACKS[exports.SKU_IDS[sku]];
    return {
        ...base,
        chips: p.chips,
        priceUsdCents: p.priceUsdCents,
        priceCgMicro: p.priceCgMicro === 0n ? null : Number(p.priceCgMicro),
        oddsBps: p.oddsBps,
        floor: p.floor,
        dailyCap: p.dailyCap === 0 ? null : p.dailyCap,
        pity: p.pityTier === 0 ? null : { tier: p.pityTier, hardAt: p.pityHardAt, softStart: p.pitySoftStart, softStepBps: p.pitySoftStepBps },
        pool: p.featuredOnly ? 'featured' : 'all',
    };
}
/**
 * (#28) The synthetic PackDef a quest chip voucher is opened with — mirrors chip_core `PackDef::voucher`
 * (and the crank's `voucherEconPack`): ONE chip, the template odds, no floor, no pity, all districts.
 */
function voucherEconPack(p) {
    return { ...economy_1.PACKS.starter, name: 'Quest chip', chips: 1, priceUsdCents: 0, priceCgMicro: null, oddsBps: p.voucherOdds, floor: 0, dailyCap: null, pity: null, pool: 'all' };
}
async function fetchGameConfig(connection) {
    const info = await connection.getAccountInfo((0, pdas_1.configPda)()[0], 'confirmed');
    if (!info)
        throw new Error('GameConfig not found — program not initialized on this cluster');
    return (0, accounts_1.decodeGameConfig)(new Uint8Array(info.data));
}
async function fetchCoreCollections(connection, count) {
    const keys = Array.from({ length: count }, (_, i) => (0, pdas_1.collectionMetaPda)(i)[0]);
    const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
    const m = new Map();
    infos.forEach((info, i) => { if (info)
        m.set(i, (0, accounts_1.decodeCollectionMeta)(new Uint8Array(info.data)).coreCollection); });
    return m;
}
/** Full collection metas (the settle step needs `symbol` for the DAS name match). */
async function fetchCollectionMetas(connection, count) {
    const keys = Array.from({ length: count }, (_, i) => (0, pdas_1.collectionMetaPda)(i)[0]);
    const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
    const m = new Map();
    infos.forEach((info, i) => { if (info)
        m.set(i, (0, accounts_1.decodeCollectionMeta)(new Uint8Array(info.data))); });
    return m;
}
/** Bubblegum tree bindings (merkle tree / config / maxDepth for the local proof preflight). */
async function fetchTreeMetas(connection, idxs) {
    const infos = await connection.getMultipleAccountsInfo(idxs.map((i) => (0, pdas_1.bubblegumTreeMetaPda)(i)[0]), 'confirmed');
    const m = new Map();
    infos.forEach((info, k) => { if (info)
        m.set(idxs[k], (0, accounts_1.decodeBubblegumTreeMeta)(new Uint8Array(info.data))); });
    return m;
}
/** Per-pack 32-byte seed: single pack = value; bundle = keccak(value ‖ pack_no). */
function packSeed(value, qty, packNo) {
    if (qty === 1)
        return value;
    const buf = new Uint8Array(33);
    buf.set(value, 0);
    buf[32] = packNo;
    return (0, sha3_1.keccak_256)(buf);
}
class PackFlow {
    deps;
    state;
    cfg;
    constructor(deps, init) {
        this.deps = deps;
        this.state = { phase: 'quote', nonce: init.nonce ?? (0, pdas_1.freshNonce)(), sku: init.sku, qty: init.qty, currency: init.currency, openSignatures: [], opened: [] };
    }
    set(patch) {
        this.state = { ...this.state, ...patch };
        this.deps.onState(this.state);
    }
    /** Step 1 — create+commit randomness and pay, in ONE transaction. */
    async buy() {
        const { connection, wallet } = this.deps;
        try {
            this.cfg ??= await fetchGameConfig(connection);
            const def = this.cfg.packs[this.state.sku];
            if (!def.enabled)
                throw new Error('This pack is currently disabled');
            // program-owned randomness PDA ["rng", 0, buyer, nonce] (SEC-C3 part 2): init here, commit inside buy_pack
            const rnd = await (0, switchboard_1.prepareRandomness)(connection, wallet.publicKey, pdas_1.RNG_KIND.PACK, this.state.nonce, this.deps.quote?.switchboardQueue);
            this.set({ phase: 'signing', randomness: rnd.randomness });
            const ixs = [...rnd.ixs];
            // vault ATAs must exist for SPL payments — idempotent create is cheap
            const skrMint = this.cfg.skrMint.equals(web3_js_1.PublicKey.default) ? undefined : this.cfg.skrMint;
            const payMint = (0, chipCore_1.payMintFor)(this.state.currency, { usdcMint: this.cfg.usdcMint, cgMint: this.cfg.cgMint, skrMint });
            if (this.state.currency !== chipCore_1.Currency.SOL && !payMint)
                throw new Error('This currency is not enabled on this cluster');
            if (payMint)
                ixs.push((0, spl_1.createAtaIdempotentIx)(wallet.publicKey, vaultOwner(), payMint));
            const volatile = this.state.currency === chipCore_1.Currency.SOL || this.state.currency === chipCore_1.Currency.SKR;
            const fallbackFeed = this.state.currency === chipCore_1.Currency.SKR ? this.cfg.pythSkrUsdFeed : this.cfg.pythSolUsdFeed;
            ixs.push((0, chipCore_1.buyPackIx)({
                buyer: wallet.publicKey,
                sku: this.state.sku,
                qty: this.state.qty,
                currency: this.state.currency,
                nonce: this.state.nonce,
                maxLamports: volatile ? (this.deps.quote?.maxLamports ?? 0n) : 0n,
                randomness: rnd.randomness,
                queue: rnd.queue,
                oracle: rnd.oracle,
                priceUpdate: volatile ? (this.deps.quote?.priceUpdateAccount ?? fallbackFeed) : undefined,
                usdcMint: this.cfg.usdcMint,
                cgMint: this.cfg.cgMint,
                skrMint,
            }));
            const { signature } = await (0, tx_1.sendTx)(connection, wallet, ixs, {
                cuLimit: 500_000,
                onSent: (sig) => this.set({ buySignature: sig }),
            });
            this.set({ phase: 'committed', buySignature: signature });
        }
        catch (e) {
            this.set({ phase: 'error', error: e instanceof tx_1.TxError ? e.message : String(e?.message ?? e) });
            throw e;
        }
    }
    /** Step 2 — reveal, open every pack, then settle every chip (resumable at any step). */
    async open() {
        const { connection, wallet } = this.deps;
        try {
            this.cfg ??= await fetchGameConfig(connection);
            const [pendingKey] = (0, pdas_1.pendingPackPda)(wallet.publicKey, this.state.nonce);
            let pending = await this.loadPending(pendingKey);
            if (!pending)
                throw new Error('Pending pack not found (already opened?)');
            const randomness = pending.randomness;
            this.set({ randomness, phase: 'revealing' });
            // Do we already have the value? Persisted in PendingPack by the first open (SEC-C2: bundles
            // never re-read the oracle account), else on the randomness account (crank / earlier attempt).
            let value = pending.revealed ? pending.value : ((await (0, switchboard_1.readRandomness)(connection, wallet.publicKey, randomness))?.value ?? null);
            let revealIx = undefined;
            if (!value) {
                const slot = await connection.getSlot('confirmed');
                if (BigInt(slot) > pending.commitSlot + chipCore_1.STALE_PACK_SLOTS) {
                    // try one last time to fetch a reveal; if the oracle never answered → stale path
                    try {
                        const r = await (0, switchboard_1.prepareReveal)(connection, wallet.publicKey, pdas_1.RNG_KIND.PACK, randomness, { maxWaitMs: 15_000, onAttempt: (n) => this.set({ revealAttempt: n }) });
                        revealIx = r.ix;
                        value = r.value;
                    }
                    catch {
                        this.set({ phase: 'stale' });
                        return;
                    }
                }
                else {
                    const r = await (0, switchboard_1.prepareReveal)(connection, wallet.publicKey, pdas_1.RNG_KIND.PACK, randomness, { onAttempt: (n) => this.set({ revealAttempt: n }) });
                    revealIx = r.ix;
                    value = r.value;
                }
            }
            const def = this.cfg.packs[pending.sku];
            // (#28) a quest chip voucher ignores config.packs: 1 chip with the template odds, every district in the pool
            const econ = pending.voucher ? voucherEconPack(pending) : toEconPack(pending.sku, def);
            const pool = !pending.voucher && def.featuredOnly ? [this.cfg.featuredCollection] : Array.from({ length: this.cfg.collectionsCreated }, (_, i) => i);
            const metas = await fetchCollectionMetas(connection, this.cfg.collectionsCreated);
            const trees = await fetchTreeMetas(connection, pool);
            const lookupTables = await (0, tx_1.appLookupTables)(connection, this.deps.lookupTable);
            const das = new das_1.DasClient({ endpoint: this.deps.dasEndpoint ?? config_1.DAS_RPC_URL });
            this.set({ phase: 'opening' });
            for (let packNo = pending.opened; packNo < pending.qty; packNo++) {
                // pity counter can change between packs of one bundle → re-read
                const pityInfo = await connection.getAccountInfo((0, pdas_1.pityPda)(wallet.publicKey)[0], 'confirmed');
                const pity = pityInfo ? (0, accounts_1.decodePlayerPity)(new Uint8Array(pityInfo.data)).counters[pending.sku] : 0;
                const rolls = (0, economy_1.expandRandomness)(packSeed(value, pending.qty, packNo), econ, pity, pool.length);
                // The rolls are recomputed on chain; the prediction only selects the collection/tree accounts.
                const collectionIdx = rolls.map((r) => pool[r.collectionIdx]);
                const ixs = [(0, chipCore_1.openCompressedPackIx)({
                        payer: wallet.publicKey, buyer: pending.buyer, nonce: pending.nonce, packNo, chips: econ.chips, collectionIdx, randomness,
                    })];
                try {
                    // reveal + open share one transaction only when they fit (our static LUT — docs/06 §4.2 вывод 3);
                    // otherwise the reveal goes first on its own: once it lands it is a chain fact, so a failed open just retries
                    if (revealIx && !(0, tx_1.fitsInTx)(wallet.publicKey, [revealIx, ...ixs], lookupTables)) {
                        await (0, tx_1.sendTx)(connection, wallet, [revealIx], { cuLimit: 150_000, skipPreflight: true, lookupTables });
                        revealIx = undefined;
                    }
                    const withReveal = revealIx ? [revealIx, ...ixs] : ixs;
                    const { signature, logs } = await (0, tx_1.sendTx)(connection, wallet, withReveal, { cuLimit: 800_000, skipPreflight: !!revealIx, lookupTables });
                    const ev = (0, anchor_1.findEvent)(logs, 'CompressedClaimsCreated', accounts_1.readCompressedClaimsCreated);
                    if (!ev)
                        throw new Error('open transaction landed without a CompressedClaimsCreated event');
                    this.set({ openSignatures: [...this.state.openSignatures, signature] });
                }
                catch (e) {
                    // lost the race against the crank → re-read and continue
                    const fresh = await this.loadPending(pendingKey);
                    if (!fresh || fresh.opened > packNo) {
                        pending = fresh ?? pending;
                        revealIx = undefined;
                        if (!fresh)
                            break;
                        packNo = fresh.opened - 1;
                        continue;
                    }
                    throw e;
                }
                revealIx = undefined;
            }
            // Settle every chip (mint → DAS resolve → register), then finalize. Skips whatever is
            // already settled, so racing the crank is harmless — and re-running after an error resumes.
            this.set({ phase: 'settling' });
            const ctx = { pending, econ, das, metas, trees, lookupTables };
            for (let packNo = 0; packNo < pending.qty; packNo++) {
                const pityBefore = await this.readPity(pending);
                const assets = [], rarities = [], collections = [];
                for (let i = 0; i < econ.chips; i++) {
                    const settled = await this.settleChip(ctx, packNo, i);
                    if (settled) {
                        assets.push(settled.asset);
                        rarities.push(settled.rarity);
                        collections.push(settled.collectionIdx);
                    }
                }
                // The UI still renders `PackOpenedEvent`s: synthesize one per pack from the settled claims
                // (assets = Bubblegum leaf ids, rarities/collections from the claim accounts).
                this.set({
                    opened: [...this.state.opened, {
                            buyer: pending.buyer, sku: pending.sku, nonce: pending.nonce, assets, rarities, collections,
                            count: assets.length, roll: packSeed(value, pending.qty, packNo), pityBefore, pityAfter: await this.readPity(pending),
                        }],
                });
            }
            await this.finalizePack(ctx);
            this.set({ phase: 'done' });
        }
        catch (e) {
            this.set({ phase: 'error', error: e instanceof tx_1.TxError ? e.message : String(e?.message ?? e) });
            throw e;
        }
    }
    async readPity(pending) {
        const info = await this.deps.connection.getAccountInfo((0, pdas_1.pityPda)(pending.buyer)[0], 'confirmed');
        return info ? (0, accounts_1.decodePlayerPity)(new Uint8Array(info.data)).counters[pending.sku] : 0;
    }
    /** Mint (if needed) and register one claim. Returns null for cancelled/expired/consumed claims. */
    async settleChip(ctx, packNo, chipNo) {
        return (0, claimSettle_1.settleClaim)({
            connection: this.deps.connection, wallet: this.deps.wallet, das: ctx.das, buyer: ctx.pending.buyer,
            metas: ctx.metas, trees: ctx.trees, lookupTables: ctx.lookupTables,
            onSignature: (sig) => this.set({ openSignatures: [...this.state.openSignatures, sig] }),
        }, (0, chipCore_1.compressedClaimNonce)(ctx.pending.nonce, packNo, chipNo));
    }
    async finalizePack(ctx) {
        const { connection, wallet } = this.deps;
        const { pending, lookupTables } = ctx;
        const cfg = this.cfg;
        const info = await connection.getAccountInfo((0, pdas_1.compressedSettlementPda)(pending.buyer, pending.nonce)[0], 'confirmed');
        if (!info)
            throw new Error('Settlement account not found (opens incomplete?)');
        const settlement = (0, accounts_1.decodeCompressedPackSettlement)(new Uint8Array(info.data));
        const done = settlement.registeredClaims + settlement.cancelledClaims;
        if (done < settlement.totalClaims) {
            throw new Error(`${settlement.totalClaims - done} of ${settlement.totalClaims} chips are still unsettled (expired claims must be cancelled first) — re-run after cancelling`);
        }
        const ixs = [];
        let cg;
        if (pending.paidCg > 0n) {
            ixs.push((0, spl_1.createAtaIdempotentIx)(wallet.publicKey, cfg.treasury, cfg.cgMint));
            cg = { cgMint: cfg.cgMint, vaultCg: (0, pdas_1.ata)(cfg.cgMint, (0, pdas_1.vaultPda)()[0]), treasuryCg: (0, pdas_1.ata)(cfg.cgMint, cfg.treasury) };
        }
        let refundToken;
        if (settlement.cancelledClaims > 0) {
            const mint = pending.paidUsdc > 0n ? cfg.usdcMint : pending.paidSkr > 0n ? cfg.skrMint : pending.paidCg > 0n ? cfg.cgMint : null;
            if (mint)
                refundToken = { vault: (0, pdas_1.ata)(mint, (0, pdas_1.vaultPda)()[0]), buyer: (0, pdas_1.ata)(mint, pending.buyer) };
        }
        ixs.push((0, chipCore_1.finalizeCompressedPackIx)({ payer: wallet.publicKey, buyer: pending.buyer, nonce: pending.nonce, cg, refundToken }));
        const { signature, logs } = await (0, tx_1.sendTx)(connection, wallet, ixs, { cuLimit: 300_000, lookupTables });
        const ev = (0, anchor_1.findEvent)(logs, 'CompressedPackSettled', accounts_1.readCompressedPackSettled);
        if (!ev)
            throw new Error('finalize transaction landed without a CompressedPackSettled event');
        this.set({ openSignatures: [...this.state.openSignatures, signature] });
    }
    /** Cancel one expired-unminted claim so `finalize` can proceed (re-run `open()` afterwards). */
    async cancelClaim(claimNonce) {
        const { connection, wallet } = this.deps;
        const { signature } = await (0, tx_1.sendTx)(connection, wallet, [
            (0, chipCore_1.cancelCompressedClaimIx)({ buyer: wallet.publicKey, claimNonce, nonce: this.state.nonce }),
        ], { cuLimit: 150_000 });
        return signature;
    }
    /** Read every claim of this purchase for the UI (expired ones get a cancel button). */
    async claims() {
        const { connection, wallet } = this.deps;
        const [pendingKey] = (0, pdas_1.pendingPackPda)(wallet.publicKey, this.state.nonce);
        const pending = await this.loadPending(pendingKey);
        if (!pending)
            return [];
        this.cfg ??= await fetchGameConfig(connection);
        const chips = pending.voucher ? 1 : this.cfg.packs[pending.sku].chips;
        const nonces = [];
        for (let packNo = 0; packNo < pending.qty; packNo++)
            for (let i = 0; i < chips; i++)
                nonces.push((0, chipCore_1.compressedClaimNonce)(pending.nonce, packNo, i));
        const infos = await connection.getMultipleAccountsInfo(nonces.map((n) => (0, pdas_1.compressedMintClaimPda)(pending.buyer, n)[0]), 'confirmed');
        return nonces.map((claimNonce, k) => ({ claimNonce, claim: infos[k] ? (0, accounts_1.decodeCompressedMintClaim)(new Uint8Array(infos[k].data)) : null }));
    }
    /**
     * Rent reclaim (SEC-M7): after the last open (or a refund) the randomness account is no longer
     * pinned — close it and get ≈ 0.006 SOL back. Separate, optional signature; the crank does the
     * same for players who skip it. Returns null when there is nothing to close.
     */
    async reclaimRent() {
        const { connection, wallet } = this.deps;
        const ix = await (0, switchboard_1.prepareClose)(connection, wallet.publicKey, pdas_1.RNG_KIND.PACK, wallet.publicKey, this.state.nonce);
        if (!ix)
            return null;
        const { signature } = await (0, tx_1.sendTx)(connection, wallet, [ix], { cuLimit: 120_000 });
        return signature;
    }
    /** Oracle never answered (> STALE_PACK_SLOTS ≈ 72 min, reveal expired) → 100 % refund from the vault. */
    async refund() {
        const { connection, wallet } = this.deps;
        this.cfg ??= await fetchGameConfig(connection);
        const [pendingKey] = (0, pdas_1.pendingPackPda)(wallet.publicKey, this.state.nonce);
        const pending = await this.loadPending(pendingKey);
        if (!pending)
            throw new Error('Nothing to refund');
        const paidMint = pending.paidUsdc > 0n ? this.cfg.usdcMint : pending.paidSkr > 0n ? this.cfg.skrMint : pending.paidCg > 0n ? this.cfg.cgMint : undefined;
        const { signature } = await (0, tx_1.sendTx)(connection, wallet, [
            (0, chipCore_1.cancelStalePackIx)({ buyer: wallet.publicKey, nonce: pending.nonce, randomness: pending.randomness, paidMint }),
        ], { cuLimit: 150_000 });
        this.set({ phase: 'done' });
        return signature;
    }
    async loadPending(key) {
        const info = await this.deps.connection.getAccountInfo(key, 'confirmed');
        return info ? (0, accounts_1.decodePendingPack)(new Uint8Array(info.data)) : null;
    }
}
exports.PackFlow = PackFlow;
const vaultOwner = () => (0, pdas_1.vaultPda)()[0];
/** What the buyer pays up-front (before the Pyth SOL conversion). */
function rentReserve(chips, qty) {
    return chipCore_1.RENT_RESERVE_PER_CHIP * BigInt(chips) * BigInt(qty);
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-L-F — compressed fusion: Bubblegum V2 claims are the only material
// representation. No test in this suite creates or opens an MPL-Core asset.
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
const economy_1 = require("@guttercaps/economy");
const anchor_1 = require("@/chain/anchor");
const accounts_1 = require("@/chain/accounts");
const chipCore_1 = require("@/chain/ix/chipCore");
const pdas_1 = require("@/chain/pdas");
const expect_1 = require("./helpers/expect");
const env_1 = require("./helpers/env");
const flows_1 = require("./helpers/flows");
const sbmock_1 = require("./helpers/sbmock");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const STALE = 10800n; // STALE_PACK_SLOTS
const DAY = 86400n;
async function stageClaim(env, owner, nonce, rarity, collectionIdx) {
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
    ], { signers: [env.admin], label: `stage compressed fusion material ${nonce}` });
    return claim;
}
suite('T-L-F compressed fusion', () => {
    let env;
    (0, vitest_1.beforeAll)(async () => { env = await (0, env_1.getEnv)(); });
    (0, vitest_1.it)('fuses three claim-bound Common chips into a new V2 claim and burns the fee', async () => {
        const owner = await env.player({ cg: 100000000n });
        const materials = await Promise.all([
            stageClaim(env, owner, 50001n, 0, 0),
            stageClaim(env, owner, 50002n, 0, 2),
            stageClaim(env, owner, 50003n, 0, 4),
        ]);
        const resultNonce = 50004n;
        const result = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, resultNonce)[0];
        const cgBefore = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey);
        const burnedBefore = (await env.ledger()).burnedTotal;
        await env.chain.send([
            (0, chipCore_1.fuseCompressedClaimsIx)({
                owner: owner.publicKey,
                resultClaimNonce: resultNonce,
                resultCollectionIdx: 2,
                cgMint: env.mints.cg,
                materialClaims: materials,
            }),
        ], { signers: [owner], label: 'fuse compressed claims' });
        const claim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(result)).data);
        (0, vitest_1.expect)(claim.buyer.equals(owner.publicKey)).toBe(true);
        (0, vitest_1.expect)(claim.collectionIdx).toBe(2);
        (0, vitest_1.expect)(claim.rarity).toBe(1);
        (0, vitest_1.expect)(claim.level).toBe(1);
        (0, vitest_1.expect)(claim.settlement.equals(web3_js_1.PublicKey.default)).toBe(true);
        (0, vitest_1.expect)(claim.indexReserved).toBe(false);
        (0, vitest_1.expect)(claim.minted).toBe(false);
        (0, vitest_1.expect)(claim.consumed).toBe(false);
        (0, vitest_1.expect)(cgBefore - (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey))).toBe(2500000n);
        (0, vitest_1.expect)((await env.ledger()).burnedTotal - burnedBefore).toBe(2500000n);
        for (const material of materials) {
            (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(material)).data).consumed).toBe(true);
        }
        // A consumed claim cannot be used a second time, even if the caller still
        // has the original DAS/claim transport record.
        await (0, expect_1.expectFail)(env.chain.send([
            (0, chipCore_1.fuseCompressedClaimsIx)({ owner: owner.publicKey, resultClaimNonce: 50005n, resultCollectionIdx: 2, cgMint: env.mints.cg, materialClaims: materials }),
        ], { signers: [owner] }), expect_1.Err.chip('InvalidChipState'), 'consumed compressed material');
    });
    (0, vitest_1.it)('enforces rarity and same-collection rules before charging compressed fusion', async () => {
        const owner = await env.player({ cg: 100000000n });
        const mixed = await Promise.all([
            stageClaim(env, owner, 51001n, 0, 0),
            stageClaim(env, owner, 51002n, 1, 0),
            stageClaim(env, owner, 51003n, 0, 0),
        ]);
        await (0, expect_1.expectFail)(env.chain.send([
            (0, chipCore_1.fuseCompressedClaimsIx)({ owner: owner.publicKey, resultClaimNonce: 51004n, resultCollectionIdx: 0, cgMint: env.mints.cg, materialClaims: mixed }),
        ], { signers: [owner] }), expect_1.Err.chip('MaterialRarityMismatch'), 'mixed compressed rarities');
        const same = await Promise.all([
            stageClaim(env, owner, 51101n, 1, 3),
            stageClaim(env, owner, 51102n, 1, 3),
            stageClaim(env, owner, 51103n, 1, 3),
        ]);
        await (0, expect_1.expectFail)(env.chain.send([
            (0, chipCore_1.fuseCompressedClaimsIx)({ owner: owner.publicKey, resultClaimNonce: 51104n, resultCollectionIdx: 4, cgMint: env.mints.cg, materialClaims: same }),
        ], { signers: [owner] }), expect_1.Err.chip('MaterialCollectionMismatch'), 'wrong compressed result collection');
    });
    (0, vitest_1.it)('H3 commit → reveal success (recipe 4): fee escrowed then burned once, settlement-free result with a 6 h lock, kind-3 rent reclaimed', async () => {
        const owner = await env.player({ cg: 1000000000n });
        const mats = await Promise.all([
            stageClaim(env, owner, 52001n, 4, 0),
            stageClaim(env, owner, 52002n, 4, 2),
            stageClaim(env, owner, 52003n, 4, 4),
        ]);
        const fee = BigInt(economy_1.FUSION_RECIPES[4].feeCgMicro);
        const cgBefore = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey);
        const burnedBefore = (await env.ledger()).burnedTotal;
        const c = await (0, flows_1.commitClaimFusion)(env, owner, { materials: mats, resultCollectionIdx: 2 });
        const pending = (await (0, flows_1.loadPendingClaimFusion)(env.chain, c.pending));
        (0, vitest_1.expect)(pending.owner.equals(owner.publicKey)).toBe(true);
        (0, vitest_1.expect)(pending.nonce).toBe(c.nonce);
        (0, vitest_1.expect)(pending.recipe).toBe(4);
        (0, vitest_1.expect)(pending.boosted).toBe(false);
        (0, vitest_1.expect)(pending.feeEscrowed).toBe(fee);
        (0, vitest_1.expect)(pending.materials.map((m) => m.toBase58())).toEqual(mats.map((m) => m.toBase58()));
        (0, vitest_1.expect)(cgBefore - (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey))).toBe(fee); // escrowed, not burned yet
        (0, vitest_1.expect)((await env.ledger()).burnedTotal - burnedBefore).toBe(0n);
        for (const m of mats)
            (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(m)).data).consumed).toBe(true);
        const committed = (0, anchor_1.findEvent)(c.tx.logs, 'ClaimFusionCommitted', accounts_1.readClaimFusionCommitted);
        (0, vitest_1.expect)(committed.nonce).toBe(c.nonce);
        (0, vitest_1.expect)(committed.recipe).toBe(4);
        // randomness cannot close while the fusion is pending (same pin rule as packs, C20)
        const rng = (0, sbmock_1.rngAccounts)(sbmock_1.RNG_KIND.CLAIM_FUSION, owner.publicKey, c.nonce);
        const lut = (await (0, sbmock_1.randomnessAccount)(env.chain, c.randomness)).lutSlot;
        await (0, expect_1.expectFail)(env.chain.send([(0, sbmock_1.closeRandomnessIx)({ ...rng, payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin] }), expect_1.Err.chip('InvalidChipState'), 'close kind-3 randomness while pending');
        const { value, roll } = (0, flows_1.mineFusionValue)('H3-success', 4, true);
        const r = await (0, flows_1.revealClaimFusion)(env, owner.publicKey, c, mats, value);
        (0, vitest_1.expect)(r.event.success).toBe(true);
        (0, vitest_1.expect)(r.event.rollBps).toBe(roll);
        (0, vitest_1.expect)(r.event.thresholdBps).toBe(economy_1.FUSION_RECIPES[4].successBps);
        (0, vitest_1.expect)(r.event.feeBurned).toBe(fee);
        const resultKey = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, c.nonce)[0];
        (0, vitest_1.expect)(r.event.resultClaim.equals(resultKey)).toBe(true);
        const now = await env.chain.now();
        const result = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(resultKey)).data);
        (0, vitest_1.expect)(result.buyer.equals(owner.publicKey)).toBe(true);
        (0, vitest_1.expect)(result.collectionIdx).toBe(2);
        (0, vitest_1.expect)(result.rarity).toBe(5);
        (0, vitest_1.expect)(result.level).toBe(1);
        (0, vitest_1.expect)(result.settlement.equals(web3_js_1.PublicKey.default)).toBe(true);
        (0, vitest_1.expect)(result.consumed).toBe(false);
        (0, vitest_1.expect)(result.minted).toBe(false);
        (0, vitest_1.expect)(result.lockUntil).toBeGreaterThanOrEqual(now + 6n * 3600n - 120n);
        (0, vitest_1.expect)(result.lockUntil).toBeLessThanOrEqual(now + 6n * 3600n);
        (0, vitest_1.expect)(result.expiresAt).toBeGreaterThanOrEqual(now + 7n * DAY - 120n);
        // fee burned exactly once: escrow → burn, no second charge at reveal
        (0, vitest_1.expect)((await env.ledger()).burnedTotal - burnedBefore).toBe(fee);
        (0, vitest_1.expect)(cgBefore - (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey))).toBe(fee);
        (0, vitest_1.expect)(await (0, flows_1.loadPendingClaimFusion)(env.chain, c.pending)).toBeNull();
        // permissionless close now works and pays the rent to the owner (SEC-M7)
        const ownerLamports = await env.chain.balance(owner.publicKey);
        await env.chain.send([(0, sbmock_1.closeRandomnessIx)({ ...rng, payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin], label: 'close kind-3 randomness' });
        (0, vitest_1.expect)(await env.chain.getAccount(c.randomness)).toBeNull();
        (0, vitest_1.expect)((await env.chain.balance(owner.publicKey)) - ownerLamports).toBeGreaterThan(0n);
    });
    (0, vitest_1.it)('H3 failure: default-pubkey result with no account, lowest-key survivor un-consumed and reusable, fee still burned', async () => {
        const owner = await env.player({ cg: 2000000000n });
        const mats = await Promise.all([
            stageClaim(env, owner, 53001n, 4, 1),
            stageClaim(env, owner, 53002n, 4, 2),
            stageClaim(env, owner, 53003n, 4, 3),
        ]);
        const fee = BigInt(economy_1.FUSION_RECIPES[4].feeCgMicro);
        const burnedBefore = (await env.ledger()).burnedTotal;
        const c = await (0, flows_1.commitClaimFusion)(env, owner, { materials: mats, resultCollectionIdx: 2 });
        const { value, roll } = (0, flows_1.mineFusionValue)('H3-fail', 4, false);
        const r = await (0, flows_1.revealClaimFusion)(env, owner.publicKey, c, mats, value);
        (0, vitest_1.expect)(r.event.success).toBe(false);
        (0, vitest_1.expect)(r.event.rollBps).toBe(roll);
        (0, vitest_1.expect)(r.event.resultClaim.equals(web3_js_1.PublicKey.default)).toBe(true);
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.compressedMintClaimPda)(owner.publicKey, c.nonce)[0])).toBeNull();
        (0, vitest_1.expect)((await env.ledger()).burnedTotal - burnedBefore).toBe(fee); // lost rolls still burn
        // refund_on_fail = 1: the lowest claim key survives, mirrors Core fuse_reveal
        const sorted = [...mats].sort((a, b) => Buffer.compare(a.toBytes(), b.toBytes()));
        for (const m of mats) {
            (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(m)).data).consumed, m.toBase58()).toBe(!m.equals(sorted[0]));
        }
        // the survivor fuses again with two fresh materials
        const fresh = await Promise.all([stageClaim(env, owner, 53101n, 4, 1), stageClaim(env, owner, 53102n, 4, 1)]);
        await (0, flows_1.commitClaimFusion)(env, owner, { materials: [sorted[0], fresh[0], fresh[1]], resultCollectionIdx: 1 });
    });
    (0, vitest_1.it)('H3 commit gates: atomic recipes, duplicates, consumed and settlement-bound materials refused before any charge', async () => {
        const owner = await env.player({ usdc: 5000000000n, cg: 1000000000n });
        const cgBefore = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey);
        // deterministic (100 %) recipes resolve atomically — the randomized path refuses them
        const commons = await Promise.all([
            stageClaim(env, owner, 54001n, 0, 0),
            stageClaim(env, owner, 54002n, 0, 0),
            stageClaim(env, owner, 54003n, 0, 0),
        ]);
        await (0, expect_1.expectFail)((0, flows_1.commitClaimFusion)(env, owner, { materials: commons, resultCollectionIdx: 0 }), expect_1.Err.chip('NoRecipe'), 'atomic recipe via H3');
        const mats = await Promise.all([
            stageClaim(env, owner, 54101n, 4, 0),
            stageClaim(env, owner, 54102n, 4, 1),
            stageClaim(env, owner, 54103n, 4, 2),
        ]);
        await (0, expect_1.expectFail)((0, flows_1.commitClaimFusion)(env, owner, { materials: [mats[0], mats[0], mats[1]], resultCollectionIdx: 0 }), expect_1.Err.chip('DuplicateMaterial'), 'same claim twice');
        const mixed = await stageClaim(env, owner, 54104n, 5, 0);
        await (0, expect_1.expectFail)((0, flows_1.commitClaimFusion)(env, owner, { materials: [mats[0], mats[1], mixed], resultCollectionIdx: 0 }), expect_1.Err.chip('MaterialRarityMismatch'), 'mixed rarities');
        // same-collection recipes pin materials AND the result (recipe 5, Legendary → Mythic)
        const legendary = await Promise.all([
            stageClaim(env, owner, 54201n, 5, 0),
            stageClaim(env, owner, 54202n, 5, 1),
            stageClaim(env, owner, 54203n, 5, 0),
        ]);
        await (0, expect_1.expectFail)((0, flows_1.commitClaimFusion)(env, owner, { materials: legendary, resultCollectionIdx: 0 }), expect_1.Err.chip('MaterialCollectionMismatch'), 'split collections on a same-collection recipe');
        // consumed shells: commit once, then the same materials are dead for a second commit
        await (0, flows_1.commitClaimFusion)(env, owner, { materials: mats, resultCollectionIdx: 1 });
        await (0, expect_1.expectFail)((0, flows_1.commitClaimFusion)(env, owner, { materials: mats, resultCollectionIdx: 1 }), expect_1.Err.chip('InvalidChipState'), 'consumed materials');
        // H3 mirror of X11 (SEC-G03): a pack claim bound to an open settlement is not fusion material
        const b = await (0, flows_1.buyPack)(env, owner, { sku: flows_1.SKU.STANDARD, qty: 1, currency: flows_1.Currency.USDC });
        const [opened] = await (0, flows_1.revealAndOpenCompressedAll)(env, owner, b, (0, flows_1.valueOf)('H3-gates'));
        const packClaim = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, opened.event.claimNonces[0])[0];
        await (0, expect_1.expectFail)((0, flows_1.commitClaimFusion)(env, owner, { materials: [packClaim, mats[0], mats[1]], resultCollectionIdx: 1 }), expect_1.Err.chip('InvalidChipState'), 'settlement-bound pack claim');
        // every refusal happened before the fee transfer
        (0, vitest_1.expect)(cgBefore - (await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey))).toBe(BigInt(economy_1.FUSION_RECIPES[4].feeCgMicro));
    });
    (0, vitest_1.it)('H3 stale: cancel before the window → NotStale; past it the fee refunds 100 % and materials un-consume; revealed randomness cannot cancel', async () => {
        if (!env.chain.canWarp)
            return;
        const owner = await env.player({ cg: 1000000000n });
        const fee = BigInt(economy_1.FUSION_RECIPES[4].feeCgMicro);
        const mats = await Promise.all([
            stageClaim(env, owner, 55001n, 4, 0),
            stageClaim(env, owner, 55002n, 4, 0),
            stageClaim(env, owner, 55003n, 4, 0),
        ]);
        const c = await (0, flows_1.commitClaimFusion)(env, owner, { materials: mats, resultCollectionIdx: 0 });
        await (0, expect_1.expectFail)((0, flows_1.cancelStaleClaimFusion)(env, owner, c, mats), expect_1.Err.chip('NotStale'), 'immediately');
        await env.chain.warpSlots(STALE + 1n);
        const cgBefore = await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey);
        await (0, flows_1.cancelStaleClaimFusion)(env, owner, c, mats);
        (0, vitest_1.expect)((await (0, env_1.tokenBalance)(env.chain, env.mints.cg, owner.publicKey)) - cgBefore).toBe(fee);
        for (const m of mats)
            (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(m)).data).consumed).toBe(false);
        (0, vitest_1.expect)(await (0, flows_1.loadPendingClaimFusion)(env.chain, c.pending)).toBeNull();
        // clean state: the same materials commit again under a fresh nonce
        await (0, flows_1.commitClaimFusion)(env, owner, { materials: mats, resultCollectionIdx: 0 });
        // a revealed (but unsettled) fusion is not refundable
        const mats2 = await Promise.all([
            stageClaim(env, owner, 55101n, 4, 1),
            stageClaim(env, owner, 55102n, 4, 1),
            stageClaim(env, owner, 55103n, 4, 1),
        ]);
        const c2 = await (0, flows_1.commitClaimFusion)(env, owner, { materials: mats2, resultCollectionIdx: 1 });
        await env.chain.send([(0, sbmock_1.revealIx)({ kind: sbmock_1.RNG_KIND.CLAIM_FUSION, payer: env.admin.publicKey, randomness: c2.randomness, value: (0, flows_1.valueOf)('H3-stale') })], { signers: [env.admin], label: 'reveal without settle' });
        await env.chain.warpSlots(STALE + 1n);
        await (0, expect_1.expectFail)((0, flows_1.cancelStaleClaimFusion)(env, owner, c2, mats2), expect_1.Err.chip('RandomnessAlreadyRevealed'), 'cancel after reveal');
    });
    (0, vitest_1.it)('H3 close_expired_claim: live and consumed shells refused; an expired settlement-free shell closes and pays rent to the buyer', async () => {
        if (!env.chain.canWarp)
            return;
        const owner = await env.player({ cg: 1000000000n });
        const live = await stageClaim(env, owner, 56001n, 4, 1);
        const liveNonce = 56001n;
        const shellNonce = 56004n;
        await stageClaim(env, owner, shellNonce, 0, 0);
        const close = (claimNonce) => env.chain.send([(0, chipCore_1.closeExpiredClaimIx)({ buyer: owner.publicKey, claimNonce })], { signers: [owner] });
        await (0, expect_1.expectFail)(close(liveNonce), expect_1.Err.chip('InvalidChipState'), 'not expired yet');
        // consume the live shell through a real commit so the consumed gate is pinned, not just the deadline
        const coMats = await Promise.all([stageClaim(env, owner, 56002n, 4, 1), stageClaim(env, owner, 56003n, 4, 1)]);
        await (0, flows_1.commitClaimFusion)(env, owner, { materials: [live, coMats[0], coMats[1]], resultCollectionIdx: 1 });
        await env.chain.warpSeconds(7n * DAY + 1n);
        await (0, expect_1.expectFail)(close(liveNonce), expect_1.Err.chip('InvalidChipState'), 'consumed shell past its deadline');
        const shellKey = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, shellNonce)[0];
        const rent = (await env.chain.getAccount(shellKey)).lamports;
        const before = await env.chain.balance(owner.publicKey);
        await close(shellNonce);
        (0, vitest_1.expect)(await env.chain.getAccount(shellKey)).toBeNull();
        const gain = (await env.chain.balance(owner.publicKey)) - before;
        (0, vitest_1.expect)(gain).toBeGreaterThan(0n);
        (0, vitest_1.expect)(gain).toBeGreaterThanOrEqual(rent - 50000n); // rent minus the close tx fee
        (0, vitest_1.expect)(gain).toBeLessThanOrEqual(rent);
    });
});

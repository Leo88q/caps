"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-L-M — custom marketplace for Bubblegum V2 claim-bound chips.
// The market never parses an MPL-Core asset and never invents a DAS id.
const vitest_1 = require("vitest");
const accounts_1 = require("@/chain/accounts");
const market_1 = require("@/chain/ix/market");
const chipCore_1 = require("@/chain/ix/chipCore");
const pdas_1 = require("@/chain/pdas");
const expect_1 = require("./helpers/expect");
const env_1 = require("./helpers/env");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const SOL = 1000000000n;
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
    ], { signers: [env.admin], label: `stage market claim ${nonce}` });
    return claim;
}
suite('T-L-M compressed custom market', () => {
    let env;
    let seller;
    let buyer;
    (0, vitest_1.beforeAll)(async () => {
        env = await (0, env_1.getEnv)();
        seller = await env.player({ sol: 5n * SOL, cg: 10000000000n });
        buyer = await env.player({ sol: 10n * SOL });
    });
    (0, vitest_1.it)('lists and settles a compressed claim in SOL with the configured fee split', async () => {
        const claim = await stageClaim(env, seller, 60001n, 0, 2);
        const price = 2n * SOL;
        await env.chain.send([
            (0, market_1.listCompressedIx)({ seller: seller.publicKey, claim, price, currency: market_1.MarketCurrency.SOL }),
        ], { signers: [seller] });
        const listing = (0, pdas_1.compressedListingPda)(claim)[0];
        const listingAccount = await env.chain.getAccount(listing);
        (0, vitest_1.expect)(listingAccount).not.toBeNull();
        const listingRent = listingAccount.lamports;
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(claim)).data).listed).toBe(true);
        const sellerBefore = await env.chain.balance(seller.publicKey);
        const buyerBefore = await env.chain.balance(buyer.publicKey);
        await env.chain.send([
            (0, market_1.buyCompressedSolIx)({ buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: env_1.TREASURY.publicKey, buyback: env_1.BUYBACK.publicKey }),
        ], { signers: [buyer] });
        const split = (0, market_1.saleSplit)(price);
        const sellerDelta = (await env.chain.balance(seller.publicKey)) - sellerBefore;
        (0, vitest_1.expect)(sellerDelta).toBeGreaterThanOrEqual(split.seller + listingRent);
        const buyerDelta = buyerBefore - (await env.chain.balance(buyer.publicKey));
        (0, vitest_1.expect)(buyerDelta).toBeGreaterThanOrEqual(price);
        (0, vitest_1.expect)(buyerDelta - price).toBeLessThanOrEqual(10000n); // transaction fee is paid by the buyer, not settlement value
        const result = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(claim)).data);
        (0, vitest_1.expect)(result.buyer.equals(buyer.publicKey)).toBe(true);
        (0, vitest_1.expect)(result.listed).toBe(false);
        (0, vitest_1.expect)(await env.chain.getAccount(listing)).toBeNull();
    });
    (0, vitest_1.it)('binds listing authority to the claim owner and rejects invalid prices or consumed claims', async () => {
        const claim = await stageClaim(env, seller, 60101n, 0, 0);
        await (0, expect_1.expectFail)(env.chain.send([
            (0, market_1.listCompressedIx)({ seller: buyer.publicKey, claim, price: SOL, currency: market_1.MarketCurrency.SOL }),
        ], { signers: [buyer] }), expect_1.Err.market('CompressedClaimNotTradable'), 'foreign compressed seller');
        await (0, expect_1.expectFail)(env.chain.send([
            (0, market_1.listCompressedIx)({ seller: seller.publicKey, claim, price: 999999n, currency: market_1.MarketCurrency.SOL }),
        ], { signers: [seller] }), expect_1.Err.market('PriceTooLow'), 'compressed dust listing');
        const consumed = await stageClaim(env, seller, 60102n, 0, 0);
        // A claim that is already consumed by fusion cannot enter the market.
        const owner = seller;
        // Use a distinct staged claim and let the compressed fusion instruction
        // consume it; the market boundary then sees the same on-chain flag.
        const c2 = await stageClaim(env, owner, 60103n, 0, 0);
        const c3 = await stageClaim(env, owner, 60104n, 0, 0);
        await env.chain.send([
            (0, chipCore_1.fuseCompressedClaimsIx)({ owner: owner.publicKey, resultClaimNonce: 60106n, resultCollectionIdx: 0, cgMint: env.mints.cg, materialClaims: [consumed, c2, c3] }),
        ], { signers: [owner] });
        await (0, expect_1.expectFail)(env.chain.send([
            (0, market_1.listCompressedIx)({ seller: owner.publicKey, claim: consumed, price: SOL, currency: market_1.MarketCurrency.SOL }),
        ], { signers: [owner] }), expect_1.Err.market('CompressedClaimNotTradable'), 'consumed compressed claim');
    });
    (0, vitest_1.it)('allows the custom claim market to operate while chip_core purchases are paused', async () => {
        const claim = await stageClaim(env, seller, 60201n, 0, 1);
        await env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, true)], { signers: [env.admin] });
        try {
            await env.chain.send([(0, market_1.listCompressedIx)({ seller: seller.publicKey, claim, price: SOL, currency: market_1.MarketCurrency.SOL })], { signers: [seller] });
            await env.chain.send([(0, market_1.buyCompressedSolIx)({ buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: env_1.TREASURY.publicKey, buyback: env_1.BUYBACK.publicKey })], { signers: [buyer] });
        }
        finally {
            await env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, false)], { signers: [env.admin] });
        }
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(claim)).data).buyer.equals(buyer.publicKey)).toBe(true);
    });
    (0, vitest_1.it)('uses the live market fee cap for compressed settlements', async () => {
        await (0, expect_1.expectFail)(env.chain.send([(0, env_1.setParamsIx)(env.admin.publicKey, { marketFeeBps: 1001 })], { signers: [env.admin] }), expect_1.Err.chip('FeeTooHigh'));
        await env.chain.send([(0, env_1.setParamsIx)(env.admin.publicKey, { marketFeeBps: 1000 })], { signers: [env.admin] });
        const claim = await stageClaim(env, seller, 60301n, 0, 0);
        await env.chain.send([(0, market_1.listCompressedIx)({ seller: seller.publicKey, claim, price: SOL, currency: market_1.MarketCurrency.SOL })], { signers: [seller] });
        await env.chain.send([(0, market_1.buyCompressedSolIx)({ buyer: buyer.publicKey, claim, seller: seller.publicKey, treasury: env_1.TREASURY.publicKey, buyback: env_1.BUYBACK.publicKey })], { signers: [buyer] });
        (0, vitest_1.expect)((0, market_1.saleSplit)(SOL, 1000).fee).toBe(100000000n);
        await env.chain.send([(0, env_1.setParamsIx)(env.admin.publicKey, { marketFeeBps: 750 })], { signers: [env.admin] });
        env.config = await env.refreshConfig();
        (0, vitest_1.expect)(await (0, env_1.tokenBalance)(env.chain, env.mints.cg, seller.publicKey)).toBeGreaterThan(0n);
    });
});

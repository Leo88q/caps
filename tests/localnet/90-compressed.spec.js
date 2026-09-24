"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Bubblegum V2 migration gate: the pack roll must enter the claim-bound
// compressed settlement path before any DAS asset/proof is available.
const vitest_1 = require("vitest");
const accounts_1 = require("@/chain/accounts");
const chipCore_1 = require("@/chain/ix/chipCore");
const staking_1 = require("@/chain/ix/staking");
const pdas_1 = require("@/chain/pdas");
const env_1 = require("./helpers/env");
const flows_1 = require("./helpers/flows");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
if (!bins.ok && !process.env.LOCALNET_RPC) {
    console.warn(`[tests/localnet] compressed suite skipped — missing program binaries:\n  ${bins.missing.join('\n  ')}`);
}
suite('T-V compressed pack settlement', () => {
    let env;
    (0, vitest_1.beforeAll)(async () => {
        env = await (0, env_1.getEnv)();
    });
    (0, vitest_1.it)('stakes and unstakes a claim without converting it into a Core asset', async () => {
        const owner = await env.player({ usdc: 1000000000n, cg: 100000000n });
        const purchase = await (0, flows_1.buyPack)(env, owner, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const value = (0, flows_1.valueOf)('compressed-stake');
        await (0, flows_1.revealPack)(env, purchase, value);
        const opened = await (0, flows_1.openCompressedPack)(env, owner.publicKey, purchase.nonce, 0, value);
        const claim = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, opened.event.claimNonces[0])[0];
        await env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: owner.publicKey, claim })], { signers: [owner] });
        const staked = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(claim)).data);
        (0, vitest_1.expect)(staked.buyer.equals(owner.publicKey)).toBe(true);
        (0, vitest_1.expect)(staked.staked).toBe(true);
        (0, vitest_1.expect)(staked.listed).toBe(false);
        await env.chain.send([(0, staking_1.unstakeCompressedChipIx)({ owner: owner.publicKey, claim, cgMint: env.mints.cg })], { signers: [owner] });
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(claim)).data).staked).toBe(false);
    });
    (0, vitest_1.it)('creates claim-bound V2 settlement records without inventing DAS asset ids', async () => {
        const buyer = await env.player({ usdc: 1000000000n });
        const purchase = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        const value = (0, flows_1.valueOf)('compressed-settlement');
        await (0, flows_1.revealPack)(env, purchase, value);
        const opened = await (0, flows_1.openCompressedPack)(env, buyer.publicKey, purchase.nonce, 0, value);
        (0, vitest_1.expect)(opened.event.buyer.equals(buyer.publicKey)).toBe(true);
        (0, vitest_1.expect)(opened.event.nonce).toBe(purchase.nonce);
        (0, vitest_1.expect)(opened.event.packNo).toBe(0);
        (0, vitest_1.expect)(opened.event.count).toBe(opened.rolled.length);
        (0, vitest_1.expect)(opened.event.claimNonces).toHaveLength(opened.event.count);
        const settlementAddress = (0, pdas_1.compressedSettlementPda)(buyer.publicKey, purchase.nonce)[0];
        const settlementAccount = await env.chain.getAccount(settlementAddress);
        (0, vitest_1.expect)(settlementAccount).not.toBeNull();
        const settlement = (0, accounts_1.decodeCompressedPackSettlement)(settlementAccount.data);
        (0, vitest_1.expect)(settlement.buyer.equals(buyer.publicKey)).toBe(true);
        (0, vitest_1.expect)(settlement.pending.equals(purchase.pending)).toBe(true);
        (0, vitest_1.expect)(settlement.totalClaims).toBe(opened.event.count);
        (0, vitest_1.expect)(settlement.registeredClaims).toBe(0);
        (0, vitest_1.expect)(settlement.cancelledClaims).toBe(0);
        const pending = await (0, flows_1.loadPending)(env.chain, (0, pdas_1.pendingPackPda)(buyer.publicKey, purchase.nonce)[0]);
        (0, vitest_1.expect)(pending?.opened).toBe(1);
        for (let i = 0; i < opened.event.claimNonces.length; i++) {
            const claimNonce = (0, chipCore_1.compressedClaimNonce)(purchase.nonce, 0, i);
            (0, vitest_1.expect)(opened.event.claimNonces[i]).toBe(claimNonce);
            const claimAddress = (0, pdas_1.compressedMintClaimPda)(buyer.publicKey, claimNonce)[0];
            const claimAccount = await env.chain.getAccount(claimAddress);
            (0, vitest_1.expect)(claimAccount).not.toBeNull();
            const claim = (0, accounts_1.decodeCompressedMintClaim)(claimAccount.data);
            (0, vitest_1.expect)(claim.buyer.equals(buyer.publicKey)).toBe(true);
            (0, vitest_1.expect)(claim.settlement.equals(settlementAddress)).toBe(true);
            (0, vitest_1.expect)(claim.collectionIdx).toBe(opened.rolled[i].collectionIdx);
            (0, vitest_1.expect)(claim.rarity).toBe(opened.rolled[i].rarity);
            (0, vitest_1.expect)(claim.indexReserved).toBe(true);
            (0, vitest_1.expect)(claim.minted).toBe(false);
        }
    });
});

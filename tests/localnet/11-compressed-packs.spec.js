"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Bubblegum V2 phase-2 localnet coverage: pack rolls become claim-bound
// settlement records before any asynchronous mint/DAS registration occurs.
const vitest_1 = require("vitest");
const accounts_1 = require("@/chain/accounts");
const chipCore_1 = require("@/chain/ix/chipCore");
const pdas_1 = require("@/chain/pdas");
const flows_1 = require("./helpers/flows");
const env_1 = require("./helpers/env");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
if (!bins.ok && !process.env.LOCALNET_RPC) {
    console.warn(`[tests/localnet] compressed pack scenarios skipped — missing program binaries:\n  ${bins.missing.join('\n  ')}`);
}
suite('T-L-V Bubblegum V2 compressed pack settlement', () => {
    let env;
    (0, vitest_1.beforeAll)(async () => {
        env = await (0, env_1.getEnv)();
    });
    (0, vitest_1.it)('rolls to claims while paused, binds every claim to one settlement, then recovers an expired purchase', async () => {
        // The expiry cleanup requires LiteSVM clock control. The validator suite
        // has no safe way to advance a real clock without sleeping for seven days.
        if (!env.chain.canWarp)
            return;
        const buyer = await env.player({ usdc: 1000000000n });
        const purchase = await (0, flows_1.buyPack)(env, buyer, { sku: flows_1.SKU.STANDARD, currency: flows_1.Currency.USDC });
        await env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, true)], { signers: [env.admin] });
        try {
            await (0, flows_1.revealPack)(env, purchase, (0, flows_1.valueOf)('compressed-pack'));
            const opened = await (0, flows_1.openCompressedPack)(env, buyer.publicKey, purchase.nonce, 0, (0, flows_1.valueOf)('compressed-pack'), env.admin);
            (0, vitest_1.expect)(opened.event.buyer.equals(buyer.publicKey)).toBe(true);
            (0, vitest_1.expect)(opened.event.nonce).toBe(purchase.nonce);
            (0, vitest_1.expect)(opened.event.packNo).toBe(0);
            (0, vitest_1.expect)(opened.event.count).toBe(3);
            (0, vitest_1.expect)(opened.event.claimNonces).toHaveLength(3);
            const pending = await (0, flows_1.loadPending)(env.chain, (0, pdas_1.pendingPackPda)(buyer.publicKey, purchase.nonce)[0]);
            (0, vitest_1.expect)(pending?.opened).toBe(1);
            const settlementKey = (0, pdas_1.compressedSettlementPda)(buyer.publicKey, purchase.nonce)[0];
            const settlementAccount = await env.chain.getAccount(settlementKey);
            (0, vitest_1.expect)(settlementAccount).not.toBeNull();
            const settlement = (0, accounts_1.decodeCompressedPackSettlement)(settlementAccount.data);
            (0, vitest_1.expect)(settlement.buyer.equals(buyer.publicKey)).toBe(true);
            (0, vitest_1.expect)(settlement.totalClaims).toBe(3);
            (0, vitest_1.expect)(settlement.registeredClaims).toBe(0);
            (0, vitest_1.expect)(settlement.cancelledClaims).toBe(0);
            for (const claimNonce of opened.event.claimNonces) {
                const claimKey = (0, pdas_1.compressedMintClaimPda)(buyer.publicKey, claimNonce)[0];
                const claimAccount = await env.chain.getAccount(claimKey);
                (0, vitest_1.expect)(claimAccount).not.toBeNull();
                const claim = (0, accounts_1.decodeCompressedMintClaim)(claimAccount.data);
                (0, vitest_1.expect)(claim.buyer.equals(buyer.publicKey)).toBe(true);
                (0, vitest_1.expect)(claim.settlement.equals(settlementKey)).toBe(true);
                (0, vitest_1.expect)(claim.minted).toBe(false);
            }
        }
        finally {
            // A failed compressed assertion must not poison the rest of the shared
            // worker with a paused config.
            await env.chain.send([(0, env_1.setPausedIx)(env.admin.publicKey, false)], { signers: [env.admin] });
        }
        await env.chain.warpSeconds(7n * 86400n + 1n);
        const openedSettlement = (0, pdas_1.compressedSettlementPda)(buyer.publicKey, purchase.nonce)[0];
        const settlement = (0, accounts_1.decodeCompressedPackSettlement)((await env.chain.getAccount(openedSettlement)).data);
        for (let i = 0; i < settlement.totalClaims; i++) {
            const claimNonce = purchase.nonce * 128n + BigInt(i);
            await env.chain.send([(0, chipCore_1.cancelCompressedClaimIx)({ buyer: buyer.publicKey, claimNonce, nonce: purchase.nonce })], { signers: [buyer], label: `cancel compressed claim ${i}` });
        }
        await env.chain.send([
            (0, chipCore_1.finalizeCompressedPackIx)({
                payer: env.admin.publicKey,
                buyer: buyer.publicKey,
                nonce: purchase.nonce,
                refundToken: {
                    vault: (0, pdas_1.ata)(env.mints.usdc, (0, pdas_1.vaultPda)()[0]),
                    buyer: (0, pdas_1.ata)(env.mints.usdc, buyer.publicKey),
                },
            }),
        ], { signers: [env.admin], label: 'finalize expired compressed pack' });
        (0, vitest_1.expect)(await (0, flows_1.loadPending)(env.chain, (0, pdas_1.pendingPackPda)(buyer.publicKey, purchase.nonce)[0])).toBeNull();
        (0, vitest_1.expect)(await env.chain.getAccount(openedSettlement)).toBeNull();
        for (let i = 0; i < 3; i++) {
            (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.compressedMintClaimPda)(buyer.publicKey, purchase.nonce * 128n + BigInt(i))[0])).toBeNull();
        }
    });
});

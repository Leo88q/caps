"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-L-X — cross-program invariants for the full-closed Bubblegum V2 claim path.
// Claims stay chip_core-owned; market and staking may only mutate them through
// authenticated CPI authority PDAs.
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@/chain/anchor");
const borsh_1 = require("@/chain/borsh");
const accounts_1 = require("@/chain/accounts");
const ids_1 = require("@/chain/ids");
const market_1 = require("@/chain/ix/market");
const staking_1 = require("@/chain/ix/staking");
const chipCore_1 = require("@/chain/ix/chipCore");
const pdas_1 = require("@/chain/pdas");
const env_1 = require("./helpers/env");
const expect_1 = require("./helpers/expect");
const flows_1 = require("./helpers/flows");
const flows_2 = require("./helpers/flows");
const bins = (0, env_1.binariesPresent)();
const suite = vitest_1.describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const SOL = 1000000000n;
const DAY = 86400n;
function setCompressedClaimListedIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.caller), (0, anchor_1.rw)(a.claim)],
        data: Buffer.from((0, anchor_1.ixData)('set_compressed_claim_listed', new borsh_1.BorshWriter().pubkey(a.expectedOwner).bool(a.listed).toBytes())),
    });
}
function transferCompressedClaimIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.caller), (0, anchor_1.rw)(a.claim)],
        data: Buffer.from((0, anchor_1.ixData)('transfer_compressed_claim', new borsh_1.BorshWriter().pubkey(a.expectedSeller).pubkey(a.newOwner).toBytes())),
    });
}
function setCompressedClaimStakedIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.caller), (0, anchor_1.rw)(a.claim)],
        data: Buffer.from((0, anchor_1.ixData)('set_compressed_claim_staked', new borsh_1.BorshWriter().pubkey(a.expectedOwner).bool(a.staked).toBytes())),
    });
}
suite('T-L-X compressed cross-program', () => {
    let env;
    (0, vitest_1.beforeAll)(async () => { env = await (0, env_1.getEnv)(); });
    (0, vitest_1.it)('X01 one claim through staking and the custom market: stake → list rejected → unstake → list → buy → new owner stakes', async () => {
        const seller = await env.player({ usdc: 5000000000n, cg: 1000000000n });
        const buyer = await env.player({ sol: 30n * SOL, cg: 1000000000n });
        const c = await (0, flows_1.stageClaim)(env, seller, 70001n);
        await env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: seller.publicKey, claim: c.claim })], { signers: [seller], label: 'stake compressed claim' });
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).staked).toBe(true);
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.compressedChipStakePda)(c.claim)[0])).not.toBeNull();
        await (0, expect_1.expectFail)(env.chain.send([(0, market_1.listCompressedIx)({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller] }), expect_1.Err.market('CompressedClaimNotTradable'), 'list a staked claim');
        await env.chain.send([(0, staking_1.unstakeCompressedChipIx)({ owner: seller.publicKey, claim: c.claim, cgMint: env.mints.cg })], { signers: [seller] });
        await env.chain.send([(0, market_1.listCompressedIx)({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller], label: 'list compressed claim' });
        await env.chain.send([(0, market_1.buyCompressedSolIx)({ buyer: buyer.publicKey, claim: c.claim, seller: seller.publicKey, treasury: env_1.TREASURY.publicKey, buyback: env_1.BUYBACK.publicKey })], { signers: [buyer], label: 'buy compressed claim' });
        const transferred = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data);
        (0, vitest_1.expect)(transferred.buyer.equals(buyer.publicKey)).toBe(true);
        (0, vitest_1.expect)(transferred.origin.equals(seller.publicKey)).toBe(true);
        (0, vitest_1.expect)((0, pdas_1.compressedMintClaimPda)(transferred.origin, c.claimNonce)[0].equals(c.claim)).toBe(true);
        (0, vitest_1.expect)(transferred.listed).toBe(false);
        (0, vitest_1.expect)(await env.chain.getAccount((0, pdas_1.compressedListingPda)(c.claim)[0])).toBeNull();
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: seller.publicKey, claim: c.claim })], { signers: [seller] }), expect_1.Err.staking('NotOwner'), 'previous owner stakes');
        await env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: buyer.publicKey, claim: c.claim })], { signers: [buyer], label: 'new owner stakes' });
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).staked).toBe(true);
    });
    (0, vitest_1.it)('X02 chip_core claim transitions reject wallet and foreign callers', async () => {
        const owner = await env.player({ usdc: 5000000000n, cg: 1000000000n });
        const c = await (0, flows_1.stageClaim)(env, owner, 70002n);
        await (0, expect_1.expectFail)(env.chain.send([setCompressedClaimListedIx({ caller: owner.publicKey, claim: c.claim, expectedOwner: owner.publicKey, listed: true })], { signers: [owner] }), expect_1.Err.chip('NotProgramCaller'), 'wallet as market authority');
        const fake = web3_js_1.Keypair.generate();
        await env.chain.airdrop(fake.publicKey, SOL);
        await (0, expect_1.expectFail)(env.chain.send([setCompressedClaimListedIx({ caller: fake.publicKey, claim: c.claim, expectedOwner: owner.publicKey, listed: true })], { signers: [owner, fake] }), expect_1.Err.chip('NotProgramCaller'), 'foreign signer as market authority');
        await (0, expect_1.expectFail)(env.chain.send([transferCompressedClaimIx({ caller: owner.publicKey, claim: c.claim, expectedSeller: owner.publicKey, newOwner: fake.publicKey })], { signers: [owner] }), expect_1.Err.chip('NotProgramCaller'), 'wallet as transfer authority');
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).listed).toBe(false);
        await env.chain.send([(0, market_1.listCompressedIx)({ seller: owner.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [owner] });
        await env.chain.send([(0, market_1.cancelCompressedIx)({ seller: owner.publicKey, claim: c.claim })], { signers: [owner] });
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).listed).toBe(false);
    });
    (0, vitest_1.it)('X03 cancelled compressed listings cannot be bought and leave the claim with its seller', async () => {
        const seller = await env.player({ usdc: 5000000000n });
        const buyer = await env.player({ sol: 30n * SOL });
        const c = await (0, flows_1.stageClaim)(env, seller, 70003n);
        await env.chain.send([(0, market_1.listCompressedIx)({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller] });
        await env.chain.send([(0, market_1.cancelCompressedIx)({ seller: seller.publicKey, claim: c.claim })], { signers: [seller] });
        await (0, expect_1.expectAnyFail)(env.chain.send([(0, market_1.buyCompressedSolIx)({ buyer: buyer.publicKey, claim: c.claim, seller: seller.publicKey, treasury: env_1.TREASURY.publicKey, buyback: env_1.BUYBACK.publicKey })], { signers: [buyer] }), 'buy a cancelled compressed listing');
        const claim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data);
        (0, vitest_1.expect)(claim.buyer.equals(seller.publicKey)).toBe(true);
        (0, vitest_1.expect)(claim.listed).toBe(false);
    });
    (0, vitest_1.it)('X04 a wallet cannot set the authoritative compressed staking flag', async () => {
        const owner = await env.player({ usdc: 5000000000n });
        const c = await (0, flows_1.stageClaim)(env, owner, 70004n);
        await (0, expect_1.expectFail)(env.chain.send([setCompressedClaimStakedIx({ caller: owner.publicKey, claim: c.claim, expectedOwner: owner.publicKey, staked: true })], { signers: [owner] }), expect_1.Err.chip('NotProgramCaller'), 'wallet as staking authority');
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).staked).toBe(false);
    });
    (0, vitest_1.it)('X05 only the listing seller may cancel a compressed listing', async () => {
        const seller = await env.player({ usdc: 5000000000n });
        const stranger = await env.player({ sol: 5n * SOL });
        const c = await (0, flows_1.stageClaim)(env, seller, 70005n);
        await env.chain.send([(0, market_1.listCompressedIx)({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller] });
        await (0, expect_1.expectFail)(env.chain.send([(0, market_1.cancelCompressedIx)({ seller: stranger.publicKey, claim: c.claim })], { signers: [stranger] }), expect_1.Err.market('NotSeller'), 'stranger cancels compressed listing');
        await env.chain.send([(0, market_1.cancelCompressedIx)({ seller: seller.publicKey, claim: c.claim })], { signers: [seller] });
    });
    (0, vitest_1.it)('X06 compressed self-trade is rejected before the claim transfer', async () => {
        const seller = await env.player({ usdc: 5000000000n, sol: 5n * SOL });
        const c = await (0, flows_1.stageClaim)(env, seller, 70006n);
        await env.chain.send([(0, market_1.listCompressedIx)({ seller: seller.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [seller] });
        await (0, expect_1.expectFail)(env.chain.send([(0, market_1.buyCompressedSolIx)({ buyer: seller.publicKey, claim: c.claim, seller: seller.publicKey, treasury: env_1.TREASURY.publicKey, buyback: env_1.BUYBACK.publicKey })], { signers: [seller] }), expect_1.Err.market('SelfTrade'), 'seller buys own compressed listing');
        await env.chain.send([(0, market_1.cancelCompressedIx)({ seller: seller.publicKey, claim: c.claim })], { signers: [seller] });
    });
    (0, vitest_1.it)('X07 listing binds the seller to the claim owner, not a caller-supplied wallet', async () => {
        const owner = await env.player({ usdc: 5000000000n });
        const impostor = await env.player({ usdc: 5000000000n });
        const c = await (0, flows_1.stageClaim)(env, owner, 70007n);
        await (0, expect_1.expectFail)(env.chain.send([(0, market_1.listCompressedIx)({ seller: impostor.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [impostor] }), expect_1.Err.market('CompressedClaimNotTradable'), 'impostor lists compressed claim');
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).listed).toBe(false);
    });
    (0, vitest_1.it)('X08 SEC-F01 a pre-mint pack claim bound to an open settlement CANNOT be listed (would brick the settlement forever)', async () => {
        const owner = await env.player({ usdc: 5000000000n });
        const [c] = await (0, flows_2.mintCompressedChips)(env, owner, 1, (0, flows_2.valueOf)('X08'));
        const claim = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data);
        (0, vitest_1.expect)(claim.minted).toBe(false);
        (0, vitest_1.expect)(claim.settlement.equals(web3_js_1.PublicKey.default)).toBe(false); // pack claims are settlement-bound
        await (0, expect_1.expectFail)(env.chain.send([(0, market_1.listCompressedIx)({ seller: owner.publicKey, claim: c.claim, price: 2n * SOL, currency: 0 })], { signers: [owner] }), expect_1.Err.chip('InvalidChipState'), 'list a pre-mint settlement-bound claim');
        (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).listed).toBe(false);
    });
    (0, vitest_1.it)('X09 SEC-F03 a staked claim survives its deadline — cancel is refused, so zombie weight is impossible', async () => {
        if (!env.chain.canWarp)
            return;
        const owner = await env.player({ usdc: 5000000000n });
        const b = await (0, flows_2.buyPack)(env, owner, { sku: flows_2.SKU.STANDARD, qty: 1, currency: flows_2.Currency.USDC });
        const [r] = await (0, flows_2.revealAndOpenCompressedAll)(env, owner, b, (0, flows_2.valueOf)('X09'));
        const claimNonce = r.event.claimNonces[0];
        const claim = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, claimNonce)[0];
        await env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: owner.publicKey, claim })], { signers: [owner], label: 'stake before deadline' });
        // past the 7-day claim deadline the claim is cancellable for a normal owner — but NOT while staked
        await env.chain.warpSeconds(8n * DAY + 1n);
        await (0, expect_1.expectFail)(env.chain.send([(0, chipCore_1.cancelCompressedClaimIx)({ buyer: owner.publicKey, claimNonce, nonce: b.nonce })], { signers: [owner] }), expect_1.Err.chip('InvalidChipState'), 'cancel a staked claim');
        // claim account still exists (not closed behind the stake's back)
        (0, vitest_1.expect)(await env.chain.getAccount(claim)).not.toBeNull();
        // unstake and the same cancel goes through — the refund window keeps working for honest users
        await env.chain.send([(0, staking_1.unstakeCompressedChipIx)({ owner: owner.publicKey, claim, cgMint: env.mints.cg })], { signers: [owner] });
        await env.chain.send([(0, chipCore_1.cancelCompressedClaimIx)({ buyer: owner.publicKey, claimNonce, nonce: b.nonce })], { signers: [owner] });
        (0, vitest_1.expect)(await env.chain.getAccount(claim)).toBeNull();
    });
    (0, vitest_1.it)('X10 SEC-F04 an expired unminted claim cannot be staked', async () => {
        if (!env.chain.canWarp)
            return;
        const owner = await env.player({ usdc: 5000000000n });
        const b = await (0, flows_2.buyPack)(env, owner, { sku: flows_2.SKU.STANDARD, qty: 1, currency: flows_2.Currency.USDC });
        const [r] = await (0, flows_2.revealAndOpenCompressedAll)(env, owner, b, (0, flows_2.valueOf)('X10'));
        const claim = (0, pdas_1.compressedMintClaimPda)(owner.publicKey, r.event.claimNonces[0])[0];
        await env.chain.warpSeconds(8n * DAY + 1n);
        await (0, expect_1.expectFail)(env.chain.send([(0, staking_1.stakeCompressedChipIx)({ owner: owner.publicKey, claim })], { signers: [owner] }), expect_1.Err.staking('ClaimExpired'), 'stake an expired claim');
    });
    (0, vitest_1.it)('X11 SEC-G03 a pack claim bound to an open settlement is not fusion material (fuse, then cancel the consumed shells after expiry, would refund the pack and keep the result)', async () => {
        const owner = await env.player({ usdc: 5000000000n, cg: 100000000n });
        const b = await (0, flows_2.buyPack)(env, owner, { sku: flows_2.SKU.STANDARD, qty: 1, currency: flows_2.Currency.USDC });
        const [r] = await (0, flows_2.revealAndOpenCompressedAll)(env, owner, b, (0, flows_2.valueOf)('X11'));
        const pack = r.event.claimNonces.slice(0, 3).map((n) => (0, pdas_1.compressedMintClaimPda)(owner.publicKey, n)[0]);
        for (const c of pack)
            (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c)).data).settlement.equals(web3_js_1.PublicKey.default)).toBe(false);
        const fuse = (materialClaims, resultClaimNonce, resultCollectionIdx) => env.chain.send([(0, chipCore_1.fuseCompressedClaimsIx)({ owner: owner.publicKey, resultClaimNonce, resultCollectionIdx, cgMint: env.mints.cg, materialClaims })], { signers: [owner] });
        // three pack claims — refused before any rarity/recipe check (the gate is the settlement binding, not the roll)
        await (0, expect_1.expectFail)(fuse(pack, 61001n, 0), expect_1.Err.chip('InvalidChipState'), 'fuse settlement-bound pack claims');
        // one pack claim hidden among two admin-staged ones — refused as well
        const staged = [await (0, flows_1.stageClaim)(env, owner, 61002n, 0, 0), await (0, flows_1.stageClaim)(env, owner, 61003n, 0, 2)];
        await (0, expect_1.expectFail)(fuse([staged[0].claim, staged[1].claim, pack[0]], 61004n, 0), expect_1.Err.chip('InvalidChipState'), 'fuse with one pack claim');
        // nothing was consumed, so the settlement keeps every claim it counted
        for (const c of pack)
            (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c)).data).consumed).toBe(false);
        for (const c of staged)
            (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).consumed).toBe(false);
        // the same wallet, settlement-free materials: the claim-based path still works
        const third = await (0, flows_1.stageClaim)(env, owner, 61005n, 0, 4);
        await fuse([staged[0].claim, staged[1].claim, third.claim], 61006n, 2);
        const result = (0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount((0, pdas_1.compressedMintClaimPda)(owner.publicKey, 61006n)[0])).data);
        (0, vitest_1.expect)(result.rarity).toBe(1);
        (0, vitest_1.expect)(result.settlement.equals(web3_js_1.PublicKey.default)).toBe(true); // a fusion result is itself settlement-free
        for (const c of [...staged, third])
            (0, vitest_1.expect)((0, accounts_1.decodeCompressedMintClaim)((await env.chain.getAccount(c.claim)).data).consumed).toBe(true);
    });
});

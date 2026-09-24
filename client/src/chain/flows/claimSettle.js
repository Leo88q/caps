"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settleClaim = settleClaim;
exports.displayClaim = displayClaim;
exports.loadClaimByNonce = loadClaimByNonce;
// Shared compressed-claim settlement: mint → DAS resolve → local V2 preflight →
// register. Used by PackFlow (per pack chip) and ClaimFusionFlow (fusion
// result). Idempotent by construction: already-minted claims skip the mint,
// already-registered ones only resolve the leaf for display — racing the crank
// is harmless.
const web3_js_1 = require("@solana/web3.js");
const tx_1 = require("../tx");
const chipCore_1 = require("../ix/chipCore");
const pdas_1 = require("../pdas");
const accounts_1 = require("../accounts");
const bubblegum_1 = require("../bubblegum");
/**
 * Settle one claim by nonce. Returns null for missing/consumed claims (buyer-cancelled —
 * the settlement counters track them) and for expired-unminted ones (cancel first).
 */
async function settleClaim(ctx, claimNonce) {
    const { connection, wallet, das, buyer, metas, trees, lookupTables } = ctx;
    const [claimKey] = (0, pdas_1.compressedMintClaimPda)(buyer, claimNonce);
    const info = await connection.getAccountInfo(claimKey, 'confirmed');
    const claim = info ? (0, accounts_1.decodeCompressedMintClaim)(new Uint8Array(info.data)) : null;
    if (!claim || claim.consumed)
        return null;
    if (claim.registered)
        return displayClaim(ctx, claim);
    const expired = !claim.minted && claim.expiresAt <= BigInt(Math.floor(Date.now() / 1000));
    if (expired)
        return null;
    const tree = trees.get(claim.collectionIdx);
    if (!tree || !tree.active)
        throw new Error(`collection ${claim.collectionIdx} has no active Bubblegum tree`);
    let live = claim;
    if (!live.minted) {
        const { signature } = await (0, tx_1.sendTx)(connection, wallet, [(0, chipCore_1.mintCompressedChipIx)({
                payer: wallet.publicKey, buyer, collectionIdx: live.collectionIdx, claimNonce,
                treeConfig: tree.treeConfig, merkleTree: tree.merkleTree, coreCollection: tree.coreCollection,
            })], { cuLimit: 500_000, lookupTables });
        ctx.onSignature(signature);
        const reloaded = await connection.getAccountInfo(claimKey, 'confirmed');
        live = reloaded ? (0, accounts_1.decodeCompressedMintClaim)(new Uint8Array(reloaded.data)) : live;
        if (!live.minted)
            throw new Error('mint transaction landed but the claim is still unminted');
        if (live.registered)
            return displayClaim(ctx, live);
    }
    const meta = metas.get(live.collectionIdx);
    if (!meta)
        throw new Error(`collection ${live.collectionIdx} not created`);
    const proof = await das.resolveClaimAsset(buyer, tree.coreCollection, `${meta.symbol} #${live.gameIndex}`);
    proof.leafNonce = (0, bubblegum_1.discoverLeafNonce)(proof, tree.maxDepth, 8, buyer);
    const register = (0, chipCore_1.registerCompressedChipIx)({
        payer: wallet.publicKey, buyer, claimNonce, asset: proof.assetId, merkleTree: tree.merkleTree,
        treeConfig: tree.treeConfig, collectionIdx: live.collectionIdx, owner: buyer, delegate: buyer,
        proof: {
            root: proof.root, dataHash: proof.dataHash, creatorHash: proof.creatorHash, collectionHash: proof.collectionHash,
            assetDataHash: proof.assetDataHash, flags: proof.flags, nonce: proof.leafNonce, index: Number(proof.leafIndex), proofNodes: proof.proof,
        },
        rarity: live.rarity, level: live.level, gameIndex: live.gameIndex,
        settlement: live.settlement.equals(web3_js_1.SystemProgram.programId) ? undefined : live.settlement,
    });
    if (!(0, tx_1.fitsInTx)(wallet.publicKey, [register], lookupTables)) {
        throw new Error('Bubblegum proof does not fit this transaction — the app lookup table is not configured for this wallet (the crank will register this chip instead)');
    }
    const { signature } = await (0, tx_1.sendTx)(connection, wallet, [register], { cuLimit: 600_000, lookupTables });
    ctx.onSignature(signature);
    return { asset: proof.assetId, rarity: live.rarity, collectionIdx: live.collectionIdx, gameIndex: live.gameIndex };
}
/** Resolve an already-registered claim's leaf purely for display (no preflight, no signature). */
async function displayClaim(ctx, claim) {
    const meta = ctx.metas.get(claim.collectionIdx);
    const tree = ctx.trees.get(claim.collectionIdx);
    if (!meta || !tree)
        throw new Error(`collection ${claim.collectionIdx} not created`);
    const proof = await ctx.das.resolveClaimAsset(ctx.buyer, tree.coreCollection, `${meta.symbol} #${claim.gameIndex}`);
    return { asset: proof.assetId, rarity: claim.rarity, collectionIdx: claim.collectionIdx, gameIndex: claim.gameIndex };
}
/** Read one claim by nonce (null when closed). */
async function loadClaimByNonce(connection, buyer, claimNonce) {
    const info = await connection.getAccountInfo((0, pdas_1.compressedMintClaimPda)(buyer, claimNonce)[0], 'confirmed');
    return info ? (0, accounts_1.decodeCompressedMintClaim)(new Uint8Array(info.data)) : null;
}

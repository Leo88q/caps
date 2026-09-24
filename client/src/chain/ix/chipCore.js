"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STALE_PACK_SLOTS = exports.RENT_RESERVE_PER_CHIP = exports.Currency = exports.COMPRESSED_CLAIM_PACK_STRIDE = void 0;
exports.createBubblegumTreeIx = createBubblegumTreeIx;
exports.configureBubblegumTreeIx = configureBubblegumTreeIx;
exports.compressedClaimNonce = compressedClaimNonce;
exports.openCompressedPackIx = openCompressedPackIx;
exports.fuseCompressedClaimsIx = fuseCompressedClaimsIx;
exports.fuseClaimsCommitIx = fuseClaimsCommitIx;
exports.fuseClaimsRevealIx = fuseClaimsRevealIx;
exports.cancelStaleClaimFusionIx = cancelStaleClaimFusionIx;
exports.closeExpiredClaimIx = closeExpiredClaimIx;
exports.stageCompressedChipIx = stageCompressedChipIx;
exports.mintCompressedChipIx = mintCompressedChipIx;
exports.registerCompressedChipIx = registerCompressedChipIx;
exports.cancelCompressedClaimIx = cancelCompressedClaimIx;
exports.finalizeCompressedPackIx = finalizeCompressedPackIx;
exports.payMintFor = payMintFor;
exports.buyPackIx = buyPackIx;
exports.openPackIx = openPackIx;
exports.cancelStalePackIx = cancelStalePackIx;
exports.fuseIx = fuseIx;
exports.fuseRevealIx = fuseRevealIx;
exports.cancelStaleFusionIx = cancelStaleFusionIx;
exports.thawChipIx = thawChipIx;
exports.payServiceIx = payServiceIx;
// Instruction builders for programs/chip_core. Account order MUST match the
// #[derive(Accounts)] structs (see programs/chip_core/src/instructions/*).
const web3_js_1 = require("@solana/web3.js");
const borsh_1 = require("../borsh");
const anchor_1 = require("../anchor");
const ids_1 = require("../ids");
const pdas_1 = require("../pdas");
const rng_1 = require("./rng");
function createBubblegumTreeIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [collection] = (0, pdas_1.collectionMetaPda)(a.collectionIdx);
    const [treeMeta] = (0, pdas_1.bubblegumTreeMetaPda)(a.collectionIdx);
    const data = new borsh_1.BorshWriter().u8(a.collectionIdx).u8(a.maxDepth).u8(a.canopy).u32(a.maxBufferSize).toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.admin), (0, anchor_1.ro)(config), (0, anchor_1.ro)(collection), (0, anchor_1.rw)(treeMeta), (0, anchor_1.rw)(a.merkleTree), (0, anchor_1.rw)(a.treeConfig),
            (0, anchor_1.ro)(ids_1.MPL_BUBBLEGUM_V2_ID), (0, anchor_1.ro)(ids_1.MPL_NOOP_ID), (0, anchor_1.ro)(ids_1.MPL_ACCOUNT_COMPRESSION_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('create_bubblegum_tree', data)),
    });
}
function configureBubblegumTreeIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [meta] = (0, pdas_1.collectionMetaPda)(a.collectionIdx);
    const [treeMeta] = (0, pdas_1.bubblegumTreeMetaPda)(a.collectionIdx);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.admin), (0, anchor_1.ro)(config), (0, anchor_1.ro)(meta), (0, anchor_1.rw)(treeMeta), (0, anchor_1.ro)(a.merkleTree), (0, anchor_1.ro)(a.treeConfig), (0, anchor_1.ro)(a.treeAuthority), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('configure_bubblegum_tree', new borsh_1.BorshWriter().u8(a.collectionIdx).u8(a.maxDepth).u8(a.canopy).toBytes())),
    });
}
exports.COMPRESSED_CLAIM_PACK_STRIDE = 128n;
function compressedClaimNonce(purchaseNonce, packNo, chipNo) {
    if (!Number.isInteger(packNo) || packNo < 0 || !Number.isInteger(chipNo) || chipNo < 0 || chipNo >= 5)
        throw new Error('Invalid compressed claim coordinates');
    return purchaseNonce * exports.COMPRESSED_CLAIM_PACK_STRIDE + BigInt(packNo * 5 + chipNo);
}
/** Permissionless roll-to-claim transition. Each collection/tree pair is
 * transport data only; the program re-derives and validates every account. */
function openCompressedPackIx(a) {
    if (!Number.isInteger(a.chips) || a.chips < 1 || a.chips > 5 || a.collectionIdx.length !== a.chips)
        throw new Error('Invalid compressed pack chip count');
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.pendingPackPda)(a.buyer, a.nonce);
    const [pity] = (0, pdas_1.pityPda)(a.buyer);
    const [settlement] = (0, pdas_1.compressedSettlementPda)(a.buyer, a.nonce);
    const keys = [(0, anchor_1.signer)(a.payer), (0, anchor_1.ro)(config), (0, anchor_1.rw)(pending), (0, anchor_1.ro)(a.randomness), (0, anchor_1.rw)(pity), (0, anchor_1.rw)(settlement), (0, anchor_1.ro)(a.buyer), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)];
    for (let i = 0; i < a.chips; i++) {
        keys.push((0, anchor_1.rw)((0, pdas_1.compressedMintClaimPda)(a.buyer, compressedClaimNonce(a.nonce, a.packNo, i))[0]));
        keys.push((0, anchor_1.rw)((0, pdas_1.collectionMetaPda)(a.collectionIdx[i])[0]));
        keys.push((0, anchor_1.ro)((0, pdas_1.bubblegumTreeMetaPda)(a.collectionIdx[i])[0]));
    }
    const data = new borsh_1.BorshWriter().u64(a.nonce).u8(a.packNo).toBytes();
    return new web3_js_1.TransactionInstruction({ programId: ids_1.CHIP_CORE_ID, keys, data: Buffer.from((0, anchor_1.ixData)('open_compressed_pack', data)) });
}
function fuseCompressedClaimsIx(a) {
    if (a.materialClaims.length !== 3)
        throw new Error('compressed fusion requires three claims');
    const [config] = (0, pdas_1.configPda)();
    const [resultClaim] = (0, pdas_1.compressedMintClaimPda)(a.owner, a.resultClaimNonce);
    const data = new borsh_1.BorshWriter().u64(a.resultClaimNonce).u8(a.resultCollectionIdx).toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.ro)(config), (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.owner)[0]), (0, anchor_1.rw)((0, pdas_1.collectionMetaPda)(a.resultCollectionIdx)[0]),
            (0, anchor_1.rw)(resultClaim), (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
            ...a.materialClaims.map(anchor_1.rw),
        ],
        data: Buffer.from((0, anchor_1.ixData)('fuse_compressed_claims', data)),
    });
}
/**
 * Randomized claim fusion (H3): commit three claims + escrow the fee, randomness kind 3.
 * Committer UIs must keep fusion nonces out of the pack-claim `purchase_nonce * 128 + …`
 * stride space (the reveal reuses the commit nonce as the result claim nonce).
 */
function fuseClaimsCommitIx(a) {
    if (a.materials.length !== 3)
        throw new Error('Claim fusion needs exactly 3 material claims');
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.claimFusionPda)(a.owner, a.nonce);
    const [items] = (0, pdas_1.playerItemsPda)(a.owner);
    const [resultMeta] = (0, pdas_1.collectionMetaPda)(a.resultCollectionIdx);
    const [vault] = (0, pdas_1.vaultPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.ro)(config), (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.owner)[0]), (0, anchor_1.rw)(pending), (0, anchor_1.rw)(a.randomness), (0, anchor_1.ro)((0, pdas_1.rngAuthPda)(pdas_1.RNG_KIND.CLAIM_FUSION)[0]),
            (0, anchor_1.ro)(ids_1.SWITCHBOARD_ON_DEMAND_ID), (0, anchor_1.ro)(a.queue), (0, anchor_1.rw)(a.oracle), (0, anchor_1.ro)(ids_1.SYSVAR_SLOT_HASHES_ID), (0, anchor_1.rw)(items), (0, anchor_1.rw)(resultMeta),
            (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.ro)(vault), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, vault)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
            ...a.materials.map(anchor_1.rw),
        ],
        data: Buffer.from((0, anchor_1.ixData)('fuse_claims_commit', new borsh_1.BorshWriter().u64(a.nonce).bool(a.useBooster).toBytes())),
    });
}
/** `fuse_claims_reveal(nonce, result_claim_nonce)` — permissionless; survivors refunded or the result claim is created. */
function fuseClaimsRevealIx(a) {
    if (a.materials.length !== 3)
        throw new Error('Claim fusion needs exactly 3 material claims');
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.claimFusionPda)(a.owner, a.nonce);
    const [resultMeta] = (0, pdas_1.collectionMetaPda)(a.resultCollectionIdx);
    const [resultClaim] = (0, pdas_1.compressedMintClaimPda)(a.owner, a.resultClaimNonce);
    const [vault] = (0, pdas_1.vaultPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.payer), (0, anchor_1.ro)(config), (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.owner)[0]), (0, anchor_1.rw)(pending), (0, anchor_1.ro)(a.randomness), (0, anchor_1.rw)(a.owner),
            (0, anchor_1.rw)(resultMeta), (0, anchor_1.rw)(resultClaim), (0, anchor_1.rw)(vault), (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, vault)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
            ...a.materials.map(anchor_1.rw),
        ],
        data: Buffer.from((0, anchor_1.ixData)('fuse_claims_reveal', new borsh_1.BorshWriter().u64(a.nonce).u64(a.resultClaimNonce).toBytes())),
    });
}
/** `cancel_stale_claim_fusion(nonce)` — oracle outage only; fee refunded, materials un-consumed. */
function cancelStaleClaimFusionIx(a) {
    if (a.materials.length !== 3)
        throw new Error('Claim fusion needs exactly 3 material claims');
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.claimFusionPda)(a.owner, a.nonce);
    const [vault] = (0, pdas_1.vaultPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.ro)(config), (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.owner)[0]), (0, anchor_1.rw)(pending), (0, anchor_1.ro)(a.randomness),
            (0, anchor_1.rw)(vault), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, vault)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
            ...a.materials.map(anchor_1.rw),
        ],
        data: Buffer.from((0, anchor_1.ixData)('cancel_stale_claim_fusion', new borsh_1.BorshWriter().u64(a.nonce).toBytes())),
    });
}
/** `close_expired_claim(claim_nonce)` — buyer reclaims the rent of an expired settlement-free claim shell. */
function closeExpiredClaimIx(a) {
    const [claim] = (0, pdas_1.compressedMintClaimPda)(a.buyer, a.claimNonce);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.buyer), (0, anchor_1.rw)(claim), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('close_expired_claim', new borsh_1.BorshWriter().u64(a.claimNonce).toBytes())),
    });
}
function stageCompressedChipIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [collection] = (0, pdas_1.collectionMetaPda)(a.collectionIdx);
    const [treeMeta] = (0, pdas_1.bubblegumTreeMetaPda)(a.collectionIdx);
    const [claim] = (0, pdas_1.compressedMintClaimPda)(a.buyer, a.claimNonce);
    const data = new borsh_1.BorshWriter()
        .pubkey(a.buyer).u8(a.collectionIdx).u64(a.claimNonce).u8(a.rarity).u8(a.level).u64(a.gameIndex).i64(a.expiresAt).toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.admin), (0, anchor_1.ro)(config), (0, anchor_1.ro)(collection), (0, anchor_1.ro)(treeMeta), (0, anchor_1.rw)(claim), (0, anchor_1.ro)(a.buyer), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('stage_compressed_chip', data)),
    });
}
/** Bubblegum V2 mint CPI for a previously staged claim. The collection PDA is
 * deliberately supplied as both collection authority and tree delegate; the
 * program derives the corresponding signer seeds on chain. */
function mintCompressedChipIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [collection] = (0, pdas_1.collectionMetaPda)(a.collectionIdx);
    const [treeMeta] = (0, pdas_1.bubblegumTreeMetaPda)(a.collectionIdx);
    const [claim] = (0, pdas_1.compressedMintClaimPda)(a.buyer, a.claimNonce);
    const data = new borsh_1.BorshWriter().pubkey(a.buyer).u8(a.collectionIdx).u64(a.claimNonce).toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.payer), (0, anchor_1.ro)(config), (0, anchor_1.ro)(collection), (0, anchor_1.ro)(treeMeta), (0, anchor_1.rw)(claim), (0, anchor_1.ro)(a.buyer),
            (0, anchor_1.rw)(a.treeConfig), (0, anchor_1.rw)(a.merkleTree), (0, anchor_1.ro)(collection), (0, anchor_1.rw)(a.coreCollection),
            (0, anchor_1.ro)(web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('collection_cpi')], ids_1.MPL_BUBBLEGUM_V2_ID)[0]),
            (0, anchor_1.ro)(ids_1.MPL_BUBBLEGUM_V2_ID), (0, anchor_1.ro)(ids_1.MPL_NOOP_ID), (0, anchor_1.ro)(ids_1.MPL_ACCOUNT_COMPRESSION_ID), (0, anchor_1.ro)(ids_1.MPL_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('mint_compressed_chip', data)),
    });
}
/** Proof-backed registration. DAS values are transport only; the program
 * verifies the reconstructed V2 leaf against Account Compression. */
function registerCompressedChipIx(a) {
    if (a.proof.root.length !== 32 || a.proof.dataHash.length !== 32 || a.proof.creatorHash.length !== 32 ||
        a.proof.collectionHash.length !== 32 || a.proof.assetDataHash.length !== 32) {
        throw new Error('Bubblegum V2 hashes and root must be exactly 32 bytes');
    }
    if (!Number.isInteger(a.proof.index) || a.proof.index < 0 || a.proof.index > 0xffff_ffff)
        throw new Error('Invalid Bubblegum leaf index');
    if (!Number.isInteger(a.proof.flags) || a.proof.flags < 0 || a.proof.flags > 255)
        throw new Error('Invalid Bubblegum flags');
    if (a.proof.nonce < 0n || a.gameIndex < 0n || a.claimNonce < 0n || a.proof.proofNodes.length > 30)
        throw new Error('Invalid Bubblegum proof coordinates');
    const [config] = (0, pdas_1.configPda)();
    const [collection] = (0, pdas_1.collectionMetaPda)(a.collectionIdx);
    const [treeMeta] = (0, pdas_1.bubblegumTreeMetaPda)(a.collectionIdx);
    const [chip] = (0, pdas_1.compressedChipStatePda)(a.asset);
    const data = new borsh_1.BorshWriter()
        .pubkey(a.asset)
        .u8(a.collectionIdx)
        .pubkey(a.owner)
        .pubkey(a.delegate)
        .pubkey(a.buyer)
        .u64(a.claimNonce)
        .bytes(a.proof.root)
        .bytes(a.proof.dataHash)
        .bytes(a.proof.creatorHash)
        .bytes(a.proof.collectionHash)
        .bytes(a.proof.assetDataHash)
        .u8(a.proof.flags)
        .u64(a.proof.nonce)
        .u32(a.proof.index)
        .u8(a.rarity)
        .u8(a.level)
        .u64(a.gameIndex)
        .toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.payer), (0, anchor_1.ro)(config), (0, anchor_1.rw)(collection), (0, anchor_1.ro)(treeMeta), (0, anchor_1.rw)((0, pdas_1.compressedMintClaimPda)(a.buyer, a.claimNonce)[0]), a.settlement ? (0, anchor_1.rw)(a.settlement) : (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID), (0, anchor_1.ro)(a.buyer), (0, anchor_1.rw)(chip), (0, anchor_1.ro)(a.asset),
            (0, anchor_1.ro)(a.owner), (0, anchor_1.ro)(a.delegate), (0, anchor_1.ro)(a.merkleTree), (0, anchor_1.ro)(a.treeConfig), (0, anchor_1.ro)(ids_1.MPL_BUBBLEGUM_V2_ID),
            (0, anchor_1.ro)(ids_1.MPL_ACCOUNT_COMPRESSION_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
            ...a.proof.proofNodes.map(anchor_1.ro),
        ],
        data: Buffer.from((0, anchor_1.ixData)('register_compressed_chip', data)),
    });
}
function cancelCompressedClaimIx(a) {
    const [settlement] = (0, pdas_1.compressedSettlementPda)(a.buyer, a.nonce);
    const [pending] = (0, pdas_1.pendingPackPda)(a.buyer, a.nonce);
    const [claim] = (0, pdas_1.compressedMintClaimPda)(a.buyer, a.claimNonce);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.buyer), (0, anchor_1.rw)(settlement), (0, anchor_1.ro)(pending), (0, anchor_1.rw)(claim), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('cancel_compressed_claim', new borsh_1.BorshWriter().u64(a.claimNonce).u64(a.nonce).toBytes())),
    });
}
function finalizeCompressedPackIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [settlement] = (0, pdas_1.compressedSettlementPda)(a.buyer, a.nonce);
    const [pending] = (0, pdas_1.pendingPackPda)(a.buyer, a.nonce);
    const [ledger] = (0, pdas_1.ledgerPdaOf)(a.buyer);
    const [vault] = (0, pdas_1.vaultPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.payer), (0, anchor_1.ro)(config), (0, anchor_1.rw)(settlement), (0, anchor_1.rw)(pending), (0, anchor_1.rw)(a.buyer), (0, anchor_1.rw)(ledger), (0, anchor_1.rw)(vault),
            (0, anchor_1.optional)(a.cg?.cgMint, ids_1.CHIP_CORE_ID), (0, anchor_1.optional)(a.cg?.vaultCg, ids_1.CHIP_CORE_ID), (0, anchor_1.optional)(a.cg?.treasuryCg, ids_1.CHIP_CORE_ID),
            (0, anchor_1.optional)(a.refundToken?.vault, ids_1.CHIP_CORE_ID), (0, anchor_1.optional)(a.refundToken?.buyer, ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('finalize_compressed_pack', new borsh_1.BorshWriter().u64(a.nonce).toBytes())),
    });
}
exports.Currency = { SOL: 0, USDC: 1, CG: 2, SKR: 3 };
/** 0.008 SOL per chip reserved in PendingPack so any cranker can open the pack (unspent part returned to the buyer at the last open — SEC-L3). */
exports.RENT_RESERVE_PER_CHIP = 8000000n;
/** Refund window (≈ 72 min at 400 ms slots) — mirrors chip_core::economy::STALE_PACK_SLOTS and @guttercaps/economy `STALE_PACK_SLOTS` (sync-check pins all three); refunds are only possible after the oracle's 1 h reveal window has expired (SEC-C3). */
exports.STALE_PACK_SLOTS = 10800n;
/** SPL mint that pays for `currency`, or undefined for SOL. */
function payMintFor(currency, mints) {
    if (currency === exports.Currency.USDC)
        return mints.usdcMint;
    if (currency === exports.Currency.CG)
        return mints.cgMint;
    if (currency === exports.Currency.SKR)
        return mints.skrMint;
    return undefined;
}
function buyPackIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [pity] = (0, pdas_1.pityPda)(a.buyer);
    const [pending] = (0, pdas_1.pendingPackPda)(a.buyer, a.nonce);
    const [vault] = (0, pdas_1.vaultPda)();
    const payMint = payMintFor(a.currency, a);
    const volatile = a.currency === exports.Currency.SOL || a.currency === exports.Currency.SKR;
    const data = (0, anchor_1.ixData)('buy_pack', new borsh_1.BorshWriter().u8(a.sku).u8(a.qty).u8(a.currency).u64(a.nonce).u64(a.maxLamports).toBytes());
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.buyer),
            (0, anchor_1.ro)(config), // #12: config is read-only in every player instruction
            (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.buyer)[0]), // buyer's liability shard
            (0, anchor_1.rw)(pity),
            (0, anchor_1.rw)(pending),
            (0, anchor_1.rw)(a.randomness),
            ...(0, rng_1.commitAccountMetas)({ kind: pdas_1.RNG_KIND.PACK, queue: a.queue, oracle: a.oracle }),
            a.currency === exports.Currency.SOL ? (0, anchor_1.rw)(vault) : (0, anchor_1.ro)(vault), // vault lamports change only on the SOL path
            (0, anchor_1.optional)(volatile ? a.priceUpdate : undefined, ids_1.CHIP_CORE_ID, false),
            (0, anchor_1.optional)(payMint ? (0, pdas_1.ata)(payMint, a.buyer) : undefined, ids_1.CHIP_CORE_ID),
            (0, anchor_1.optional)(payMint ? (0, pdas_1.ata)(payMint, vault) : undefined, ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from(data),
    });
}
/** Legacy MPL-Core path. The on-chain handler is fail-closed during the full
 * Bubblegum V2 migration; callers must use claim -> mint -> registration.
 * @deprecated Use {@link openCompressedPackIx} and the V2 settlement pipeline instead. */
function openPackIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.pendingPackPda)(a.buyer, a.nonce);
    const [pity] = (0, pdas_1.pityPda)(a.buyer);
    const [vault] = (0, pdas_1.vaultPda)();
    const settles = a.packNo === (a.qty ?? 1) - 1;
    const keys = [
        (0, anchor_1.signer)(a.payer),
        (0, anchor_1.ro)(config),
        settles ? (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.buyer)[0]) : (0, anchor_1.ro)((0, pdas_1.ledgerPdaOf)(a.buyer)[0]), // #12: shard writable only on the settling pack
        (0, anchor_1.rw)(pending),
        (0, anchor_1.ro)(a.randomness),
        (0, anchor_1.rw)(pity),
        (0, anchor_1.rw)(a.buyer),
        (0, anchor_1.ro)(vault), // signs the $CG split, never changes here
        (0, anchor_1.optional)(a.cg?.cgMint, ids_1.CHIP_CORE_ID),
        (0, anchor_1.optional)(a.cg ? (0, pdas_1.ata)(a.cg.cgMint, vault) : undefined, ids_1.CHIP_CORE_ID),
        (0, anchor_1.optional)(a.cg ? (0, pdas_1.ata)(a.cg.cgMint, a.cg.treasury) : undefined, ids_1.CHIP_CORE_ID),
        (0, anchor_1.ro)(ids_1.MPL_CORE_ID),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
    ];
    a.rolledCollections.forEach((col, i) => {
        const [asset] = (0, pdas_1.assetPda)(pending, a.packNo, i);
        const [state] = (0, pdas_1.chipStatePda)(asset);
        const [meta] = (0, pdas_1.collectionMetaPda)(col);
        keys.push((0, anchor_1.rw)(asset), (0, anchor_1.rw)(state), (0, anchor_1.rw)(meta), (0, anchor_1.rw)(a.coreCollectionOf(col)));
    });
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys,
        data: Buffer.from((0, anchor_1.ixData)('open_pack', new borsh_1.BorshWriter().u64(a.nonce).u8(a.packNo).toBytes())),
    });
}
function cancelStalePackIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.pendingPackPda)(a.buyer, a.nonce);
    const [vault] = (0, pdas_1.vaultPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.buyer),
            (0, anchor_1.ro)(config),
            (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.buyer)[0]), // #12
            (0, anchor_1.rw)(pending),
            (0, anchor_1.ro)(a.randomness),
            (0, anchor_1.rw)(vault),
            (0, anchor_1.optional)(a.paidMint ? (0, pdas_1.ata)(a.paidMint, vault) : undefined, ids_1.CHIP_CORE_ID),
            (0, anchor_1.optional)(a.paidMint ? (0, pdas_1.ata)(a.paidMint, a.buyer) : undefined, ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('cancel_stale_pack', new borsh_1.BorshWriter().u64(a.nonce).toBytes())),
    });
}
function fuseIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.pendingFusionPda)(a.owner, a.nonce);
    const [items] = (0, pdas_1.playerItemsPda)(a.owner);
    const [resultMeta] = (0, pdas_1.collectionMetaPda)(a.resultCollectionIdx);
    const [resultAsset] = (0, pdas_1.assetPda)(pending, 0, 0);
    const [resultState] = (0, pdas_1.chipStatePda)(resultAsset);
    const keys = [
        (0, anchor_1.signer)(a.owner),
        (0, anchor_1.ro)(config),
        (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.owner)[0]), // #12: fee burn / escrow accounting
        (0, anchor_1.rw)(pending),
        (0, anchor_1.optional)(a.rng?.randomness, ids_1.CHIP_CORE_ID),
        (0, anchor_1.ro)((0, pdas_1.rngAuthPda)(pdas_1.RNG_KIND.FUSION)[0]),
        (0, anchor_1.optional)(a.rng ? ids_1.SWITCHBOARD_ON_DEMAND_ID : undefined, ids_1.CHIP_CORE_ID, false),
        (0, anchor_1.optional)(a.rng?.queue, ids_1.CHIP_CORE_ID, false),
        (0, anchor_1.optional)(a.rng?.oracle, ids_1.CHIP_CORE_ID),
        (0, anchor_1.optional)(a.rng ? ids_1.SYSVAR_SLOT_HASHES_ID : undefined, ids_1.CHIP_CORE_ID, false),
        (0, anchor_1.rw)(items),
        (0, anchor_1.rw)(resultMeta),
        (0, anchor_1.rw)(a.coreCollectionOf(a.resultCollectionIdx)),
        (0, anchor_1.rw)(resultAsset),
        (0, anchor_1.rw)(resultState),
        (0, anchor_1.rw)(a.cgMint),
        (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)),
        (0, anchor_1.ro)((0, pdas_1.vaultPda)()[0]), // SEC-M3: fee escrow authority
        (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, (0, pdas_1.vaultPda)()[0])), // vault $CG ATA (randomized recipes park the fee here)
        (0, anchor_1.ro)(ids_1.MPL_CORE_ID),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
    ];
    // remaining: [asset, state] × 3, then [meta, core_collection] × 3
    for (const m of a.materials)
        keys.push((0, anchor_1.rw)(m.asset), (0, anchor_1.rw)((0, pdas_1.chipStatePda)(m.asset)[0]));
    for (const m of a.materials)
        keys.push((0, anchor_1.rw)((0, pdas_1.collectionMetaPda)(m.collectionIdx)[0]), (0, anchor_1.rw)(a.coreCollectionOf(m.collectionIdx)));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys,
        data: Buffer.from((0, anchor_1.ixData)('fuse', new borsh_1.BorshWriter().u64(a.nonce).bool(a.useBooster).toBytes())),
    });
}
function fuseRevealIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.pendingFusionPda)(a.owner, a.nonce);
    const [resultMeta] = (0, pdas_1.collectionMetaPda)(a.resultCollectionIdx);
    const [resultAsset] = (0, pdas_1.assetPda)(pending, 0, 0);
    const [resultState] = (0, pdas_1.chipStatePda)(resultAsset);
    const [vault] = (0, pdas_1.vaultPda)();
    const keys = [
        (0, anchor_1.signer)(a.payer),
        (0, anchor_1.ro)(config),
        (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.owner)[0]), // #12
        (0, anchor_1.rw)(pending),
        (0, anchor_1.ro)(a.randomness),
        (0, anchor_1.rw)(a.owner),
        (0, anchor_1.rw)(resultMeta),
        (0, anchor_1.rw)(a.coreCollectionOf(a.resultCollectionIdx)),
        (0, anchor_1.rw)(resultAsset),
        (0, anchor_1.rw)(resultState),
        (0, anchor_1.ro)(ids_1.MPL_CORE_ID),
        (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        (0, anchor_1.rw)(vault),
        (0, anchor_1.rw)(a.cgMint),
        (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, vault)),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
    ];
    for (const m of a.materials) {
        keys.push((0, anchor_1.rw)(m.asset), (0, anchor_1.rw)((0, pdas_1.chipStatePda)(m.asset)[0]), (0, anchor_1.rw)((0, pdas_1.collectionMetaPda)(m.collectionIdx)[0]), (0, anchor_1.rw)(a.coreCollectionOf(m.collectionIdx)));
    }
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys,
        data: Buffer.from((0, anchor_1.ixData)('fuse_reveal', new borsh_1.BorshWriter().u64(a.nonce).toBytes())),
    });
}
function cancelStaleFusionIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [pending] = (0, pdas_1.pendingFusionPda)(a.owner, a.nonce);
    const [vault] = (0, pdas_1.vaultPda)();
    const keys = [
        (0, anchor_1.signer)(a.owner), (0, anchor_1.ro)(config), (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.owner)[0]) /* #12 */, (0, anchor_1.rw)(pending), (0, anchor_1.ro)(a.randomness), (0, anchor_1.ro)(ids_1.MPL_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        (0, anchor_1.rw)(vault), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, vault)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), // SEC-M3 fee refund
    ];
    for (const m of a.materials) {
        keys.push((0, anchor_1.rw)(m.asset), (0, anchor_1.rw)((0, pdas_1.chipStatePda)(m.asset)[0]), (0, anchor_1.rw)((0, pdas_1.collectionMetaPda)(m.collectionIdx)[0]), (0, anchor_1.rw)(a.coreCollectionOf(m.collectionIdx)));
    }
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys,
        data: Buffer.from((0, anchor_1.ixData)('cancel_stale_fusion', new borsh_1.BorshWriter().u64(a.nonce).toBytes())),
    });
}
// ---------------------------------------------------------------- thaw (soulbound / result lock expired)
function thawChipIx(a) {
    const [config] = (0, pdas_1.configPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.ro)(config), (0, anchor_1.rw)(a.asset), (0, anchor_1.rw)((0, pdas_1.chipStatePda)(a.asset)[0]), (0, anchor_1.ro)((0, pdas_1.collectionMetaPda)(a.collectionIdx)[0]), (0, anchor_1.rw)(a.coreCollection),
            (0, anchor_1.ro)(ids_1.MPL_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('thaw_chip')),
    });
}
function payServiceIx(a) {
    const [config] = (0, pdas_1.configPda)();
    const [ledger] = (0, pdas_1.serviceLedgerPda)(a.buyer);
    const [items] = (0, pdas_1.playerItemsPda)(a.buyer);
    const payMint = payMintFor(a.currency, a);
    const volatile = a.currency === exports.Currency.SOL || a.currency === exports.Currency.SKR;
    const cg = a.currency === exports.Currency.CG;
    if (a.refHash.length !== 32)
        throw new Error('refHash must be 32 bytes');
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.buyer),
            (0, anchor_1.ro)(config),
            (0, anchor_1.rw)(ledger),
            (0, anchor_1.rw)((0, pdas_1.ledgerPdaOf)(a.buyer)[0]), // #12: vault_ledger (burn shard)
            (0, anchor_1.rw)(items),
            (0, anchor_1.rw)(a.treasury),
            (0, anchor_1.optional)(volatile ? a.priceUpdate : undefined, ids_1.CHIP_CORE_ID, false),
            (0, anchor_1.optional)(payMint ? (0, pdas_1.ata)(payMint, a.buyer) : undefined, ids_1.CHIP_CORE_ID),
            (0, anchor_1.optional)(payMint && !cg ? (0, pdas_1.ata)(payMint, a.treasury) : undefined, ids_1.CHIP_CORE_ID),
            (0, anchor_1.optional)(cg ? a.cgMint : undefined, ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('pay_service', new borsh_1.BorshWriter().u8(a.kind).u8(a.currency).u64(a.maxUnits).bytes(a.refHash).toBytes())),
    });
}

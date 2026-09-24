"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketMintFor = exports.minPriceFor = exports.MIN_PRICE_SKR = exports.MIN_PRICE_USDC = exports.MIN_PRICE_LAMPORTS = exports.ROYALTY_BPS = exports.FEE_BUYBACK_SHARE_BPS = exports.MARKET_FEE_BPS = exports.LISTING_FEE_CG = exports.MarketCurrency = void 0;
exports.marketCurrencyOfApi = marketCurrencyOfApi;
exports.listIx = listIx;
exports.updatePriceIx = updatePriceIx;
exports.cancelListingIx = cancelListingIx;
exports.buyIx = buyIx;
exports.makeOfferIx = makeOfferIx;
exports.cancelOfferIx = cancelOfferIx;
exports.acceptOfferIx = acceptOfferIx;
exports.saleSplit = saleSplit;
exports.listCompressedIx = listCompressedIx;
exports.cancelCompressedIx = cancelCompressedIx;
exports.buyCompressedSolIx = buyCompressedSolIx;
exports.listCompressedAssetIx = listCompressedAssetIx;
exports.cancelCompressedAssetIx = cancelCompressedAssetIx;
exports.buyCompressedAssetIx = buyCompressedAssetIx;
// Instruction builders for programs/market (freeze-in-place listings in SOL/USDC/SKR + USDC offers).
const web3_js_1 = require("@solana/web3.js");
const borsh_1 = require("../borsh");
const anchor_1 = require("../anchor");
const ids_1 = require("../ids");
const bubblegum_1 = require("../bubblegum");
const pdas_1 = require("../pdas");
// SKR is 2, not 3: market::Currency is a three-variant enum, and borsh puts the variant INDEX on the
// wire (see the comment on the Rust side); 3 was chip_core's four-variant code.
exports.MarketCurrency = { SOL: 0, USDC: 1, SKR: 2 };
/**
 * SEC-F11: translate the shared API currency code (packages/economy `CURRENCIES`: SOL 0 / USDC 1 /
 * $CG 2 / SKR 3) into the market wire enum above. Passing the API code straight into `listIx` sends
 * borsh variant index 3 to a three-variant enum and fails every SKR listing — this boundary is where
 * the translation must live. `$CG` (2) is not listable at all and throws.
 */
function marketCurrencyOfApi(apiCode) {
    switch (apiCode) {
        case 0: return exports.MarketCurrency.SOL;
        case 1: return exports.MarketCurrency.USDC;
        case 3: return exports.MarketCurrency.SKR;
        default: throw new Error(`currency code ${apiCode} is not listable on the market`);
    }
}
exports.LISTING_FEE_CG = 500000n; // 0.5 $CG burned on list
/** Default protocol fee; the live value is GameConfig.marketFeeBps (≤ 10 %). */
exports.MARKET_FEE_BPS = 750;
exports.FEE_BUYBACK_SHARE_BPS = 3_333;
exports.ROYALTY_BPS = 250;
exports.MIN_PRICE_LAMPORTS = 1000000n;
exports.MIN_PRICE_USDC = 100000n;
exports.MIN_PRICE_SKR = 5000000n;
const minPriceFor = (c) => (c === exports.MarketCurrency.SOL ? exports.MIN_PRICE_LAMPORTS : c === exports.MarketCurrency.USDC ? exports.MIN_PRICE_USDC : exports.MIN_PRICE_SKR);
exports.minPriceFor = minPriceFor;
const marketMintFor = (c, cfg) => (c === exports.MarketCurrency.USDC ? cfg.usdcMint : c === exports.MarketCurrency.SKR ? cfg.skrMint : undefined);
exports.marketMintFor = marketMintFor;
function listIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [
            (0, anchor_1.signer)(a.seller),
            (0, anchor_1.rw)((0, pdas_1.listingPda)(a.asset)[0]),
            (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]),
            (0, anchor_1.rw)(a.asset),
            (0, anchor_1.rw)((0, pdas_1.chipStatePda)(a.asset)[0]),
            (0, anchor_1.ro)((0, pdas_1.collectionMetaPda)(a.collectionIdx)[0]),
            (0, anchor_1.rw)(a.coreCollection),
            (0, anchor_1.ro)((0, pdas_1.configPda)()[0]),
            (0, anchor_1.rw)(a.cgMint),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.seller)),
            (0, anchor_1.ro)(ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.MPL_CORE_ID),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('list', new borsh_1.BorshWriter().u64(a.price).u8(a.currency).toBytes())),
    });
}
function updatePriceIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [(0, anchor_1.signer)(a.seller, false), (0, anchor_1.rw)((0, pdas_1.listingPda)(a.asset)[0])],
        data: Buffer.from((0, anchor_1.ixData)('update_price', new borsh_1.BorshWriter().u64(a.price).toBytes())),
    });
}
function cancelListingIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [
            (0, anchor_1.signer)(a.seller),
            (0, anchor_1.rw)((0, pdas_1.listingPda)(a.asset)[0]),
            (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]),
            (0, anchor_1.rw)(a.asset),
            (0, anchor_1.rw)((0, pdas_1.chipStatePda)(a.asset)[0]),
            (0, anchor_1.ro)((0, pdas_1.collectionMetaPda)(a.collectionIdx)[0]),
            (0, anchor_1.rw)(a.coreCollection),
            (0, anchor_1.ro)((0, pdas_1.configPda)()[0]),
            (0, anchor_1.ro)(ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.MPL_CORE_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('cancel')),
    });
}
function buyIx(a) {
    const mint = (0, exports.marketMintFor)(a.expectedCurrency, a);
    if (a.expectedCurrency !== exports.MarketCurrency.SOL && !mint)
        throw new Error('mint for this currency is not configured');
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [
            (0, anchor_1.signer)(a.buyer),
            (0, anchor_1.rw)(a.seller),
            (0, anchor_1.rw)((0, pdas_1.listingPda)(a.asset)[0]),
            (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]),
            (0, anchor_1.rw)(a.asset),
            (0, anchor_1.rw)((0, pdas_1.chipStatePda)(a.asset)[0]),
            (0, anchor_1.ro)((0, pdas_1.collectionMetaPda)(a.collectionIdx)[0]),
            (0, anchor_1.rw)(a.coreCollection),
            (0, anchor_1.ro)((0, pdas_1.configPda)()[0]),
            (0, anchor_1.rw)(a.treasury),
            (0, anchor_1.rw)(a.buybackWallet),
            (0, anchor_1.optional)(mint ? (0, pdas_1.ata)(mint, a.buyer) : undefined, ids_1.MARKET_ID),
            (0, anchor_1.optional)(mint ? (0, pdas_1.ata)(mint, a.seller) : undefined, ids_1.MARKET_ID),
            (0, anchor_1.optional)(mint ? (0, pdas_1.ata)(mint, a.treasury) : undefined, ids_1.MARKET_ID),
            (0, anchor_1.optional)(mint ? (0, pdas_1.ata)(mint, a.buybackWallet) : undefined, ids_1.MARKET_ID),
            (0, anchor_1.ro)(ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.MPL_CORE_ID),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('buy', new borsh_1.BorshWriter().u64(a.expectedPrice).u8(a.expectedCurrency).toBytes())),
    });
}
function makeOfferIx(a) {
    const [offer] = (0, pdas_1.offerPda)(a.asset, a.bidder);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [
            (0, anchor_1.signer)(a.bidder),
            (0, anchor_1.ro)(a.asset),
            (0, anchor_1.rw)(offer),
            (0, anchor_1.ro)((0, pdas_1.configPda)()[0]),
            (0, anchor_1.ro)(a.usdcMint),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.usdcMint, a.bidder)),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.usdcMint, offer)),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.ASSOCIATED_TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('make_offer', new borsh_1.BorshWriter().u64(a.amountUsdc).i64(a.ttlSecs).toBytes())),
    });
}
function cancelOfferIx(a) {
    const [offer] = (0, pdas_1.offerPda)(a.asset, a.bidder);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [(0, anchor_1.signer)(a.bidder), (0, anchor_1.rw)(offer), (0, anchor_1.rw)((0, pdas_1.ata)(a.usdcMint, offer)), (0, anchor_1.rw)((0, pdas_1.ata)(a.usdcMint, a.bidder)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('cancel_offer')),
    });
}
function acceptOfferIx(a) {
    const [offer] = (0, pdas_1.offerPda)(a.asset, a.bidder);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [
            (0, anchor_1.signer)(a.seller),
            (0, anchor_1.rw)(a.bidder),
            (0, anchor_1.rw)(offer),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.usdcMint, offer)),
            (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]),
            (0, anchor_1.rw)(a.asset),
            (0, anchor_1.rw)((0, pdas_1.chipStatePda)(a.asset)[0]),
            (0, anchor_1.ro)((0, pdas_1.collectionMetaPda)(a.collectionIdx)[0]),
            (0, anchor_1.rw)(a.coreCollection),
            (0, anchor_1.ro)((0, pdas_1.configPda)()[0]),
            (0, anchor_1.ro)(a.treasury),
            (0, anchor_1.ro)(a.buybackWallet),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.usdcMint, a.seller)),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.usdcMint, a.treasury)),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.usdcMint, a.buybackWallet)),
            (0, anchor_1.ro)(ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.MPL_CORE_ID),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('accept_offer')),
    });
}
/** Sale split shown before signing (matches market::split). */
/** Same integer math as market::split. `feeBps` = GameConfig.marketFeeBps (live), default 7.5 %. */
function saleSplit(price, feeBps = exports.MARKET_FEE_BPS) {
    const fee = (price * BigInt(Math.min(feeBps, 1_000))) / 10000n;
    const royalty = (price * BigInt(exports.ROYALTY_BPS)) / 10000n;
    const buyback = (fee * BigInt(exports.FEE_BUYBACK_SHARE_BPS)) / 10000n;
    const treasury = fee - buyback;
    return { fee, royalty, buyback, treasury, seller: price - fee - royalty, feeBps };
}
function listCompressedIx(a) {
    const [listing] = (0, pdas_1.compressedListingPda)(a.claim);
    const data = new borsh_1.BorshWriter().u64(a.price).u8(a.currency).toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [(0, anchor_1.signer)(a.seller), (0, anchor_1.rw)(listing), (0, anchor_1.rw)(a.claim), (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('list_compressed', data)),
    });
}
/** Cancel a custom compressed listing and clear the chip_core-owned claim flag. */
function cancelCompressedIx(a) {
    const [listing] = (0, pdas_1.compressedListingPda)(a.claim);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [(0, anchor_1.signer)(a.seller), (0, anchor_1.rw)(listing), (0, anchor_1.rw)(a.claim), (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('cancel_compressed')),
    });
}
/** Custom marketplace settlement for a claim-bound compressed chip. */
function buyCompressedSolIx(a) {
    const [listing] = (0, pdas_1.compressedListingPda)(a.claim);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [
            (0, anchor_1.signer)(a.buyer), (0, anchor_1.rw)(listing), (0, anchor_1.rw)(a.claim), (0, anchor_1.rw)(a.seller), (0, anchor_1.rw)(a.treasury), (0, anchor_1.rw)(a.buyback),
            (0, anchor_1.ro)((0, pdas_1.configPda)()[0]), (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('buy_compressed')),
    });
}
/** Create a custom listing for the actual registered Bubblegum V2 leaf. */
function listCompressedAssetIx(a) {
    const [listing] = (0, pdas_1.compressedAssetListingPda)(a.asset);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [
            (0, anchor_1.signer)(a.seller), (0, anchor_1.rw)(listing), (0, anchor_1.rw)(a.asset), (0, anchor_1.rw)((0, pdas_1.compressedChipStatePda)(a.asset)[0]),
            (0, anchor_1.ro)((0, pdas_1.collectionMetaPda)(a.collectionIdx)[0]), (0, anchor_1.rw)(a.claim), (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('list_compressed_asset', new borsh_1.BorshWriter().u64(a.price).u8(a.currency).toBytes())),
    });
}
function cancelCompressedAssetIx(a) {
    const [listing] = (0, pdas_1.compressedAssetListingPda)(a.asset);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [(0, anchor_1.signer)(a.seller), (0, anchor_1.rw)(listing), (0, anchor_1.rw)(a.claim), (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('cancel_compressed_asset')),
    });
}
/** Buy and atomically Bubblegum-transfer a registered V2 leaf. The DAS proof is
 * serialized into the market instruction and its nodes are passed in order. */
function buyCompressedAssetIx(a) {
    (0, bubblegum_1.assertFreshProof)(a.proof);
    if (!a.proof.assetId.equals(a.asset) || !a.proof.leafOwner.equals(a.seller) || !a.proof.leafDelegate.equals(a.delegate))
        throw new Error('Bubblegum proof does not match compressed listing');
    if (a.proof.leafIndex > 0xffffffffn)
        throw new Error('Bubblegum leaf index exceeds u32');
    if (!a.proof.merkleTree.equals(a.merkleTree))
        throw new Error('Bubblegum proof tree does not match listing');
    if (!(0, pdas_1.bubblegumTreeConfigPda)(a.merkleTree)[0].equals(a.treeConfig))
        throw new Error('Bubblegum tree config does not match merkle tree');
    const [listing] = (0, pdas_1.compressedAssetListingPda)(a.asset);
    const data = new borsh_1.BorshWriter()
        .pubkey(a.delegate)
        .bytes(a.proof.root)
        .bytes(a.proof.dataHash)
        .bytes(a.proof.creatorHash)
        .bytes(a.proof.collectionHash)
        .bytes(a.proof.assetDataHash)
        .u8(a.proof.flags)
        .u64(a.proof.leafNonce)
        .u32(Number(a.proof.leafIndex))
        .toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.MARKET_ID,
        keys: [
            (0, anchor_1.signer)(a.buyer), (0, anchor_1.rw)(listing), (0, anchor_1.rw)(a.claim), (0, anchor_1.rw)((0, pdas_1.compressedChipStatePda)(a.asset)[0]), (0, anchor_1.ro)((0, pdas_1.configPda)()[0]),
            (0, anchor_1.rw)(a.treasury), (0, anchor_1.rw)(a.buyback), (0, anchor_1.rw)(a.seller), (0, anchor_1.ro)(a.seller), (0, anchor_1.ro)(a.delegate),
            (0, anchor_1.rw)(a.treeConfig), (0, anchor_1.rw)(a.merkleTree), (0, anchor_1.ro)(a.coreCollection), (0, anchor_1.ro)((0, pdas_1.marketAuthPda)()[0]),
            (0, anchor_1.ro)(ids_1.MPL_BUBBLEGUM_V2_ID), (0, anchor_1.ro)(ids_1.MPL_NOOP_ID), (0, anchor_1.ro)(ids_1.MPL_ACCOUNT_COMPRESSION_ID), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
            ...(0, bubblegum_1.bubblegumProofMetas)(a.proof),
        ],
        data: Buffer.from((0, anchor_1.ixData)('buy_compressed_asset', data)),
    });
}

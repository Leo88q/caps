"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BATTLE_STATUS = exports.ACC_PRECISION = exports.claimIsListable = exports.compressedChipIsFree = exports.chipIsFree = exports.CHIP_FLAG = exports.SPLIT_COUNT = exports.SQUAD = exports.MATERIALS_PER_FUSION = exports.MAX_CHIPS_PER_PACK = exports.RARITY_COUNT = void 0;
exports.decodeVaultLedger = decodeVaultLedger;
exports.sumLedgers = sumLedgers;
exports.decodeGameConfig = decodeGameConfig;
exports.decodeCollectionMeta = decodeCollectionMeta;
exports.decodeBubblegumTreeMeta = decodeBubblegumTreeMeta;
exports.decodeChipState = decodeChipState;
exports.decodeCompressedChipState = decodeCompressedChipState;
exports.decodeCompressedMintClaim = decodeCompressedMintClaim;
exports.decodeCompressedAssetListing = decodeCompressedAssetListing;
exports.decodeCompressedPackSettlement = decodeCompressedPackSettlement;
exports.decodePlayerPity = decodePlayerPity;
exports.decodePendingPack = decodePendingPack;
exports.decodePendingFusion = decodePendingFusion;
exports.decodePendingClaimFusion = decodePendingClaimFusion;
exports.decodePlayerItems = decodePlayerItems;
exports.readPackOpened = readPackOpened;
exports.readCompressedClaimsCreated = readCompressedClaimsCreated;
exports.readCompressedPackSettled = readCompressedPackSettled;
exports.readClaimFusionCommitted = readClaimFusionCommitted;
exports.readClaimFusionRevealed = readClaimFusionRevealed;
exports.readChipFused = readChipFused;
exports.decodeListing = decodeListing;
exports.decodeOffer = decodeOffer;
exports.decodeEmissionState = decodeEmissionState;
exports.decodePool = decodePool;
exports.decodeTokenStake = decodeTokenStake;
exports.decodeChipStake = decodeChipStake;
exports.decodeCompressedChipStake = decodeCompressedChipStake;
exports.decodeSetBonus = decodeSetBonus;
exports.decodeRewardRoot = decodeRewardRoot;
exports.decodeSkrPool = decodeSkrPool;
exports.pendingReward = pendingReward;
exports.decodeArenaConfig = decodeArenaConfig;
exports.decodeWagerBattle = decodeWagerBattle;
exports.decodeCoreAssetHeader = decodeCoreAssetHeader;
exports.decodeCoreCollectionHeader = decodeCoreCollectionHeader;
exports.decodeTokenAmount = decodeTokenAmount;
const borsh_1 = require("./borsh");
const anchor_1 = require("./anchor");
exports.RARITY_COUNT = 9;
exports.MAX_CHIPS_PER_PACK = 5;
exports.MATERIALS_PER_FUSION = 3;
exports.SQUAD = 3;
exports.SPLIT_COUNT = 5;
function readPackDef(r) {
    return {
        chips: r.u8(),
        priceUsdCents: r.u32(),
        priceCgMicro: r.u64(),
        oddsBps: r.array(exports.RARITY_COUNT, () => r.u16()),
        floor: r.u8(),
        dailyCap: r.u8(),
        pityTier: r.u8(),
        pityHardAt: r.u16(),
        pitySoftStart: r.u16(),
        pitySoftStepBps: r.u16(),
        featuredOnly: r.bool(),
        enabled: r.bool(),
    };
}
function decodeVaultLedger(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'VaultLedger');
    return { shard: r.u8(), liabLamports: r.u64(), liabUsdc: r.u64(), liabCg: r.u64(), liabSkr: r.u64(), burnedTotal: r.u64(), bump: r.u8() };
}
/** Sum of all shards (missing shards count as zero — `init_ledger` not run yet). */
function sumLedgers(shards) {
    const t = { liabLamports: 0n, liabUsdc: 0n, liabCg: 0n, liabSkr: 0n, burnedTotal: 0n };
    for (const l of shards) {
        if (!l)
            continue;
        t.liabLamports += l.liabLamports;
        t.liabUsdc += l.liabUsdc;
        t.liabCg += l.liabCg;
        t.liabSkr += l.liabSkr;
        t.burnedTotal += l.burnedTotal;
    }
    return t;
}
function decodeGameConfig(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'GameConfig');
    return {
        admin: r.pubkey(), pendingAdmin: r.pubkey(), treasury: r.pubkey(), buybackWallet: r.pubkey(),
        cgMint: r.pubkey(), usdcMint: r.pubkey(), skrMint: r.pubkey(), stakingProgram: r.pubkey(), pythSolUsdFeed: r.pubkey(), pythSkrUsdFeed: r.pubkey(),
        featuredCollection: r.u8(), paused: r.bool(),
        packs: r.array(4, () => readPackDef(r)),
        marketFeeBps: r.u16(), skrDiscountBps: r.u16(), collectionsCreated: r.u8(),
        paramsVersion: r.u32(), vaultBump: r.u8(), bump: r.u8(), pauser: r.pubkey(),
    };
}
function decodeCollectionMeta(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'CollectionMeta');
    return {
        idx: r.u8(), coreCollection: r.pubkey(), symbol: r.string(), element: r.u8(),
        minted: r.u64(), mintedByRarity: r.array(exports.RARITY_COUNT, () => r.u64()), bump: r.u8(),
    };
}
function decodeBubblegumTreeMeta(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'BubblegumTreeMeta');
    return {
        collectionIdx: r.u8(), coreCollection: r.pubkey(), merkleTree: r.pubkey(), treeConfig: r.pubkey(),
        treeAuthority: r.pubkey(), maxDepth: r.u8(), canopy: r.u8(), active: r.bool(), bump: r.u8(),
    };
}
exports.CHIP_FLAG = { STAKED: 1, LISTED: 2, FUSING: 4, SOULBOUND: 8 };
function decodeChipState(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'ChipState');
    return {
        asset: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), index: r.u64(),
        flags: r.u8(), lockUntil: r.i64(), mintedAt: r.i64(), bump: r.u8(),
    };
}
const chipIsFree = (c, nowSec = Math.floor(Date.now() / 1000)) => (c.flags & (exports.CHIP_FLAG.STAKED | exports.CHIP_FLAG.LISTED | exports.CHIP_FLAG.FUSING)) === 0 && BigInt(nowSec) >= c.lockUntil;
exports.chipIsFree = chipIsFree;
function decodeCompressedChipState(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'CompressedChipState');
    return {
        asset: r.pubkey(), claim: r.pubkey(), collectionIdx: r.u8(), merkleTree: r.pubkey(), leafIndex: r.u32(), leafNonce: r.u64(),
        dataHash: r.bytes(32), creatorHash: r.bytes(32), collectionHash: r.bytes(32), assetDataHash: r.bytes(32),
        leafFlags: r.u8(), rarity: r.u8(), level: r.u8(), index: r.u64(), flags: r.u8(), lockUntil: r.i64(), mintedAt: r.i64(), bump: r.u8(),
    };
}
const compressedChipIsFree = (c, nowSec = Math.floor(Date.now() / 1000)) => (c.flags & (exports.CHIP_FLAG.STAKED | exports.CHIP_FLAG.LISTED | exports.CHIP_FLAG.FUSING)) === 0 && (c.leafFlags & 3) === 0 && BigInt(nowSec) >= c.lockUntil;
exports.compressedChipIsFree = compressedChipIsFree;
function decodeCompressedMintClaim(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'CompressedMintClaim');
    return {
        buyer: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), gameIndex: r.u64(), expiresAt: r.i64(),
        settlement: r.pubkey(), indexReserved: r.bool(), minted: r.bool(), registered: r.bool(), consumed: r.bool(), listed: r.bool(), bump: r.u8(), staked: r.bool(), origin: r.pubkey(), lockUntil: r.i64(),
    };
}
/** A claim is listable only when it is free AND its soulbound window has passed (H1). */
const claimIsListable = (c, nowSec = Math.floor(Date.now() / 1000)) => c.registered && !c.consumed && !c.listed && !c.staked && BigInt(nowSec) >= c.lockUntil;
exports.claimIsListable = claimIsListable;
function decodeCompressedAssetListing(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'CompressedAssetListing');
    return {
        asset: r.pubkey(), claim: r.pubkey(), seller: r.pubkey(), merkleTree: r.pubkey(), treeConfig: r.pubkey(), coreCollection: r.pubkey(),
        collectionIdx: r.u8(), price: r.u64(), currency: r.u8(), createdAt: r.i64(), bump: r.u8(),
    };
}
function decodeCompressedPackSettlement(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'CompressedPackSettlement');
    return { buyer: r.pubkey(), pending: r.pubkey(), nonce: r.u64(), totalClaims: r.u16(), registeredClaims: r.u16(), cancelledClaims: r.u16(), bump: r.u8() };
}
function decodePlayerPity(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'PlayerPity');
    return {
        owner: r.pubkey(), counters: r.array(4, () => r.u16()), dayStart: r.i64(),
        boughtToday: r.array(4, () => r.u8()), starterClaimed: r.bool(), bump: r.u8(),
    };
}
function decodePendingPack(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'PendingPack');
    const head = {
        buyer: r.pubkey(), sku: r.u8(), qty: r.u8(), opened: r.u8(), randomness: r.pubkey(), commitSlot: r.u64(),
        paidLamports: r.u64(), paidUsdc: r.u64(), paidCg: r.u64(), paidSkr: r.u64(), pitySnapshot: r.u16(), nonce: r.u64(), bump: r.u8(),
        revealed: r.bool(), value: r.bytes(32),
    };
    // pre-#28 accounts (159 bytes) decode as purchases
    const voucher = r.remaining >= 20 ? r.bool() : false;
    const voucherOdds = r.remaining >= 19 ? r.array(exports.RARITY_COUNT, () => r.u16()) : Array(exports.RARITY_COUNT).fill(0);
    const soulboundDays = r.remaining >= 1 ? r.u8() : 0;
    return { ...head, voucher, voucherOdds, soulboundDays };
}
function decodePendingFusion(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'PendingFusion');
    return {
        owner: r.pubkey(), recipe: r.u8(), materials: r.array(exports.MATERIALS_PER_FUSION, () => r.pubkey()),
        resultCollectionIdx: r.u8(), boosted: r.bool(), randomness: r.pubkey(), commitSlot: r.u64(), nonce: r.u64(), bump: r.u8(),
        feeEscrowed: r.u64(),
    };
}
function decodePendingClaimFusion(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'PendingClaimFusion');
    return {
        owner: r.pubkey(), recipe: r.u8(), materials: r.array(exports.MATERIALS_PER_FUSION, () => r.pubkey()),
        resultCollectionIdx: r.u8(), boosted: r.bool(), randomness: r.pubkey(), commitSlot: r.u64(), nonce: r.u64(), bump: r.u8(),
        feeEscrowed: r.u64(),
    };
}
function decodePlayerItems(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'PlayerItems');
    return { owner: r.pubkey(), boosters: r.u16(), bump: r.u8() };
}
function readPackOpened(r) {
    const e = {
        buyer: r.pubkey(), sku: r.u8(), nonce: r.u64(),
        assets: r.array(exports.MAX_CHIPS_PER_PACK, () => r.pubkey()),
        rarities: r.array(exports.MAX_CHIPS_PER_PACK, () => r.u8()),
        collections: r.array(exports.MAX_CHIPS_PER_PACK, () => r.u8()),
        count: r.u8(), roll: r.bytes(32), pityBefore: r.u16(), pityAfter: r.u16(),
    };
    return { ...e, assets: e.assets.slice(0, e.count), rarities: e.rarities.slice(0, e.count), collections: e.collections.slice(0, e.count) };
}
function readCompressedClaimsCreated(r) {
    const e = {
        buyer: r.pubkey(), nonce: r.u64(), packNo: r.u8(),
        claimNonces: r.array(exports.MAX_CHIPS_PER_PACK, () => r.u64()), count: r.u8(),
    };
    return { ...e, claimNonces: e.claimNonces.slice(0, e.count) };
}
function readCompressedPackSettled(r) {
    return { buyer: r.pubkey(), nonce: r.u64(), refunded: r.bool() };
}
function readClaimFusionCommitted(r) {
    return { owner: r.pubkey(), nonce: r.u64(), recipe: r.u8(), materials: r.array(exports.MATERIALS_PER_FUSION, () => r.pubkey()) };
}
function readClaimFusionRevealed(r) {
    return {
        owner: r.pubkey(), nonce: r.u64(), recipe: r.u8(), materials: r.array(exports.MATERIALS_PER_FUSION, () => r.pubkey()),
        resultClaim: r.pubkey(), success: r.bool(), rollBps: r.u16(), thresholdBps: r.u16(), feeBurned: r.u64(),
    };
}
function readChipFused(r) {
    return {
        owner: r.pubkey(), recipe: r.u8(), materials: r.array(exports.MATERIALS_PER_FUSION, () => r.pubkey()), result: r.pubkey(),
        success: r.bool(), rollBps: r.u16(), thresholdBps: r.u16(), feeBurned: r.u64(),
    };
}
function decodeListing(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'Listing');
    return { asset: r.pubkey(), seller: r.pubkey(), price: r.u64(), currency: r.u8(), createdAt: r.i64(), bump: r.u8() };
}
function decodeOffer(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'Offer');
    return { asset: r.pubkey(), bidder: r.pubkey(), amountUsdc: r.u64(), expiresAt: r.i64(), bump: r.u8() };
}
function decodeEmissionState(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'EmissionState');
    return {
        admin: r.pubkey(), cgMint: r.pubkey(), chipCoreProgram: r.pubkey(), marketProgram: r.pubkey(), arenaProgram: r.pubkey(),
        questOracle: r.pubkey(), seasonOracle: r.pubkey(), setOracle: r.pubkey(), genesisTs: r.i64(), dayIndex: r.u32(),
        mintedTotal: r.u64(), scheduleMinted: r.array(8, () => r.u64()), burnRing: r.array(7, () => r.u64()), burnToday: r.u64(),
        splitBps: r.array(exports.SPLIT_COUNT, () => r.u16()), splitChangedAt: r.i64(), sliceBudget: r.array(exports.SPLIT_COUNT, () => r.u64()),
        paused: r.bool(), bump: r.u8(), pauser: r.pubkey(), burnOracle: r.pubkey(), recycledTotal: r.u64(), recycledMinted: r.u64(),
    };
}
function decodePool(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'Pool');
    return { kind: r.u8(), totalWeight: r.u128(), accRewardPerWeight: r.u128(), budgetPerSec: r.u64(), budgetRemaining: r.u64(), lastUpdate: r.i64(), bump: r.u8() };
}
function decodeTokenStake(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'TokenStake');
    return { owner: r.pubkey(), tier: r.u8(), amount: r.u64(), weight: r.u128(), rewardDebt: r.u128(), unlockAt: r.i64(), bump: r.u8() };
}
function decodeChipStake(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'ChipStake');
    return { owner: r.pubkey(), asset: r.pubkey(), weight: r.u128(), rewardDebt: r.u128(), stakedAt: r.i64(), bump: r.u8() };
}
function decodeCompressedChipStake(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'CompressedChipStake');
    return { owner: r.pubkey(), claim: r.pubkey(), weight: r.u128(), rewardDebt: r.u128(), stakedAt: r.i64(), bump: r.u8() };
}
function decodeSetBonus(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'SetBonus');
    return { owner: r.pubkey(), completedSets: r.u8(), updatedAt: r.i64(), bump: r.u8() };
}
function decodeRewardRoot(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'RewardRoot');
    return { kind: r.u8(), epoch: r.u32(), root: r.bytes(32), budget: r.u64(), claimed: r.u64(), publishedAt: r.i64(), publisher: r.pubkey(), revoked: r.bool(), bump: r.u8() };
}
function decodeSkrPool(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'SkrPool');
    return { skrMint: r.pubkey(), vault: r.pubkey(), budget: r.u64(), reserved: r.u64(), fundedTotal: r.u64(), paidTotal: r.u64(), maxRootBudget: r.u64(), paused: r.bool(), bump: r.u8() };
}
/** MasterChef pending = weight × acc / 1e12 − debt */
exports.ACC_PRECISION = 1000000000000n;
function pendingReward(weight, acc, debt) {
    const v = (weight * acc) / exports.ACC_PRECISION - debt;
    return v > 0n ? v : 0n;
}
// ---------------------------------------------------------------- arena
exports.BATTLE_STATUS = ['open', 'accepted', 'resolved', 'cancelled'];
function decodeArenaConfig(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'ArenaConfig');
    return { admin: r.pubkey(), battleOracle: r.pubkey(), cgMint: r.pubkey(), seasonPool: r.pubkey(), treasuryCg: r.pubkey(), oracleDailyCap: r.u64(), oraclePaidToday: r.u64(), oracleDayStart: r.i64(), paused: r.bool(), bump: r.u8(), pauser: r.pubkey() };
}
function decodeWagerBattle(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'WagerBattle');
    return {
        challenger: r.pubkey(), opponent: r.pubkey(), wager: r.u64(), squadA: r.array(exports.SQUAD, () => r.pubkey()), squadB: r.array(exports.SQUAD, () => r.pubkey()),
        powerA: r.u32(), powerB: r.u32(), randomness: r.pubkey(), commitSlot: r.u64(), status: r.u8(), createdAt: r.i64(), acceptedAt: r.i64(),
        winner: r.pubkey(), resultHash: r.bytes(32), nonce: r.u64(), bump: r.u8(),
    };
}
// ---------------------------------------------------------------- Metaplex Core (BaseAssetV1 header)
/** Reads owner + update authority from a Core asset account (Key::AssetV1 = 1). */
function decodeCoreAssetHeader(data) {
    const r = new borsh_1.BorshReader(data);
    const key = r.u8();
    if (key !== 1)
        throw new Error('Not a Core AssetV1');
    const owner = r.pubkey();
    const kind = r.u8(); // 0 None, 1 Address, 2 Collection
    const updateAuthority = kind === 0 ? undefined : r.pubkey();
    const name = r.string();
    const uri = r.string();
    return { owner, updateAuthorityKind: kind, updateAuthority, name, uri };
}
/** Reads name + update authority from a Core collection account (Key::CollectionV1 = 5 in the crate-era
 * program — the enum is Uninitialized=0, AssetV1=1, HashedAssetV1=2, PluginHeaderV1=3, PluginRegistryV1=4,
 * CollectionV1=5, GroupV1=6) — the layout the admin spec checks after create_collection (name, update
 * authority = the collection meta PDA); decoding a collection with the asset decoder above answers
 * "Not a Core AssetV1" because the key byte differs. */
function decodeCoreCollectionHeader(data) {
    const r = new borsh_1.BorshReader(data);
    const key = r.u8();
    if (key !== 5)
        throw new Error('Not a Core CollectionV1');
    // unlike the asset header, a collection's update authority is a PLAIN Pubkey — no Option tag byte
    // (state/collection.rs in the crate-era program); reading the tag here shifts everything and the
    // trailing reads run past the end of the account
    const updateAuthority = r.pubkey();
    const name = r.string();
    const uri = r.string();
    const numMinted = r.u32();
    const currentSize = r.u32();
    return { updateAuthority, name, uri, numMinted, currentSize };
}
// ---------------------------------------------------------------- SPL token account (amount only)
function decodeTokenAmount(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return dv.getBigUint64(64, true);
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.burnReporterPda = exports.skrPoolPda = exports.claimReceiptPda = exports.rewardRootPda = exports.setBonusPda = exports.compressedChipStakePda = exports.chipStakePda = exports.tokenStakePda = exports.seasonPoolAuthPda = exports.rewarderPda = exports.stakeAuthPda = exports.chipPoolPda = exports.tokenPoolPda = exports.emissionPda = exports.offerPda = exports.listingPda = exports.marketAuthPda = exports.sbRewardEscrow = exports.sbOracleStatsPda = exports.sbLutPda = exports.sbLutSignerPda = exports.sbStatePda = exports.rngPda = exports.rngAuthPda = exports.RNG_KIND = exports.assetPda = exports.playerItemsPda = exports.serviceLedgerPda = exports.claimFusionPda = exports.pendingFusionPda = exports.pityPda = exports.pendingPackPda = exports.bubblegumTreeConfigPda = exports.bubblegumLeafAssetPda = exports.compressedAssetListingPda = exports.compressedListingPda = exports.compressedSettlementPda = exports.compressedMintClaimPdaForOrigin = exports.compressedMintClaimPda = exports.compressedChipStatePda = exports.chipStatePda = exports.bubblegumTreeMetaPda = exports.collectionMetaPda = exports.allLedgerPdas = exports.ledgerPdaOf = exports.ledgerPda = exports.ledgerShardOf = exports.LEDGER_SHARDS = exports.vaultPda = exports.configPda = void 0;
exports.battlePda = exports.arenaConfigPda = void 0;
exports.ata = ata;
exports.freshNonce = freshNonce;
// Every PDA of the four programs, mirroring the seeds in
// programs/*/src — see docs/03-architecture.md §2.3.
const web3_js_1 = require("@solana/web3.js");
const borsh_1 = require("./borsh");
const ids_1 = require("./ids");
const enc = (s) => new TextEncoder().encode(s);
const u8 = (n) => Uint8Array.of(n & 0xff);
const find = (seeds, program) => web3_js_1.PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), program);
// ---------------------------------------------------------------- chip_core
const configPda = () => find([enc('config')], ids_1.CHIP_CORE_ID);
exports.configPda = configPda;
const vaultPda = () => find([enc('vault')], ids_1.CHIP_CORE_ID);
exports.vaultPda = vaultPda;
/** Number of `VaultLedger` shards — mirrors chip_core `state::LEDGER_SHARDS` (#12, pinned by sync-check). */
exports.LEDGER_SHARDS = 4;
/** Liability / burn shard of a wallet: `["ledger", wallet[0] % LEDGER_SHARDS]` (same rule as `VaultLedger::shard_of`). */
const ledgerShardOf = (wallet) => wallet.toBytes()[0] % exports.LEDGER_SHARDS;
exports.ledgerShardOf = ledgerShardOf;
const ledgerPda = (shard) => find([enc('ledger'), u8(shard)], ids_1.CHIP_CORE_ID);
exports.ledgerPda = ledgerPda;
const ledgerPdaOf = (wallet) => (0, exports.ledgerPda)((0, exports.ledgerShardOf)(wallet));
exports.ledgerPdaOf = ledgerPdaOf;
/** All shard PDAs in order 0…N−1 — `sweep_vault` remaining_accounts / admin liability sums. */
const allLedgerPdas = () => Array.from({ length: exports.LEDGER_SHARDS }, (_, i) => (0, exports.ledgerPda)(i)[0]);
exports.allLedgerPdas = allLedgerPdas;
const collectionMetaPda = (idx) => find([enc('collection'), u8(idx)], ids_1.CHIP_CORE_ID);
exports.collectionMetaPda = collectionMetaPda;
/** Admin-owned binding between an MPL-Core collection and its Bubblegum V2 tree. */
const bubblegumTreeMetaPda = (idx) => find([enc('bubblegum_tree'), u8(idx)], ids_1.CHIP_CORE_ID);
exports.bubblegumTreeMetaPda = bubblegumTreeMetaPda;
const chipStatePda = (asset) => find([enc('chip'), asset.toBytes()], ids_1.CHIP_CORE_ID);
exports.chipStatePda = chipStatePda;
const compressedChipStatePda = (asset) => find([enc('compressed_chip'), asset.toBytes()], ids_1.CHIP_CORE_ID);
exports.compressedChipStatePda = compressedChipStatePda;
/** Stable claim PDA: `origin` is immutable and must not be replaced by the current buyer after a market transfer. */
const compressedMintClaimPda = (origin, claimNonce) => find([enc('compressed_claim'), origin.toBytes(), (0, borsh_1.u64le)(claimNonce)], ids_1.CHIP_CORE_ID);
exports.compressedMintClaimPda = compressedMintClaimPda;
exports.compressedMintClaimPdaForOrigin = exports.compressedMintClaimPda;
const compressedSettlementPda = (buyer, nonce) => find([enc('compressed_settlement'), buyer.toBytes(), (0, borsh_1.u64le)(nonce)], ids_1.CHIP_CORE_ID);
exports.compressedSettlementPda = compressedSettlementPda;
/** Custom marketplace listing PDA for a claim-bound compressed chip. */
const compressedListingPda = (claim) => find([enc('compressed_listing'), claim.toBytes()], ids_1.MARKET_ID);
exports.compressedListingPda = compressedListingPda;
/** Listing for an already-registered Bubblegum V2 asset. */
const compressedAssetListingPda = (asset) => find([enc('compressed_asset_listing'), asset.toBytes()], ids_1.MARKET_ID);
exports.compressedAssetListingPda = compressedAssetListingPda;
/** Bubblegum V2 leaf asset PDA `["asset", tree, leafIndex LE]`. */
const bubblegumLeafAssetPda = (merkleTree, leafIndex) => find([enc('asset'), merkleTree.toBytes(), (0, borsh_1.u32le)(leafIndex)], ids_1.MPL_BUBBLEGUM_V2_ID);
exports.bubblegumLeafAssetPda = bubblegumLeafAssetPda;
const bubblegumTreeConfigPda = (merkleTree) => find([merkleTree.toBytes()], ids_1.MPL_BUBBLEGUM_V2_ID);
exports.bubblegumTreeConfigPda = bubblegumTreeConfigPda;
const pendingPackPda = (buyer, nonce) => find([enc('pending'), buyer.toBytes(), (0, borsh_1.u64le)(nonce)], ids_1.CHIP_CORE_ID);
exports.pendingPackPda = pendingPackPda;
const pityPda = (wallet) => find([enc('pity'), wallet.toBytes()], ids_1.CHIP_CORE_ID);
exports.pityPda = pityPda;
const pendingFusionPda = (owner, nonce) => find([enc('fusion'), owner.toBytes(), (0, borsh_1.u64le)(nonce)], ids_1.CHIP_CORE_ID);
exports.pendingFusionPda = pendingFusionPda;
/** Randomized claim fusion (H3): `["claim_fusion", owner, nonce]` — same layout as PendingFusion, claim PDAs as materials. */
const claimFusionPda = (owner, nonce) => find([enc('claim_fusion'), owner.toBytes(), (0, borsh_1.u64le)(nonce)], ids_1.CHIP_CORE_ID);
exports.claimFusionPda = claimFusionPda;
const serviceLedgerPda = (wallet) => find([enc('services'), wallet.toBytes()], ids_1.CHIP_CORE_ID);
exports.serviceLedgerPda = serviceLedgerPda;
const playerItemsPda = (wallet) => find([enc('items'), wallet.toBytes()], ids_1.CHIP_CORE_ID);
exports.playerItemsPda = playerItemsPda;
/** Core asset address minted by open_pack (pack_no, slot i) or fuse (0, 0). */
const assetPda = (pending, packNo, i) => find([enc('asset'), pending.toBytes(), u8(packNo), u8(i)], ids_1.CHIP_CORE_ID);
exports.assetPda = assetPda;
// ------------------------------------------- program-owned Switchboard randomness (SEC-C3 part 2)
/** Randomness account kinds: 0 pack, 1 fusion, 3 claim fusion (chip_core), 2 battle (arena). */
exports.RNG_KIND = { PACK: 0, FUSION: 1, BATTLE: 2, CLAIM_FUSION: 3 };
const rngProgram = (kind) => (kind === exports.RNG_KIND.BATTLE ? ids_1.ARENA_ID : ids_1.CHIP_CORE_ID);
/** Switchboard `authority` of every randomness account of a program: `["rng_auth"]`. */
const rngAuthPda = (kind) => find([enc('rng_auth')], rngProgram(kind));
exports.rngAuthPda = rngAuthPda;
/** The randomness account itself: `["rng", kind, owner, nonce]` — one per purchase / fusion / battle. */
const rngPda = (kind, owner, nonce) => find([enc('rng'), u8(kind), owner.toBytes(), (0, borsh_1.u64le)(nonce)], rngProgram(kind));
exports.rngPda = rngPda;
// ---------------------------------------------------------------- Switchboard On-Demand PDAs
/** `["STATE"]` of the Switchboard program. */
const sbStatePda = () => find([enc('STATE')], ids_1.SWITCHBOARD_ON_DEMAND_ID);
exports.sbStatePda = sbStatePda;
/** `["LutSigner", randomness]` — authority of the lookup table created by `randomness_init`. */
const sbLutSignerPda = (randomness) => find([enc('LutSigner'), randomness.toBytes()], ids_1.SWITCHBOARD_ON_DEMAND_ID);
exports.sbLutSignerPda = sbLutSignerPda;
/** Address of the lookup table: `AddressLookupTableProgram.createLookupTable({ authority: lutSigner, recentSlot })`. */
const sbLutPda = (lutSigner, recentSlot) => find([lutSigner.toBytes(), (0, borsh_1.u64le)(recentSlot)], ids_1.ADDRESS_LOOKUP_TABLE_PROGRAM_ID);
exports.sbLutPda = sbLutPda;
/** `["OracleRandomnessStats", oracle]` — writable in `randomness_reveal`. */
const sbOracleStatsPda = (oracle) => find([enc('OracleRandomnessStats'), oracle.toBytes()], ids_1.SWITCHBOARD_ON_DEMAND_ID);
exports.sbOracleStatsPda = sbOracleStatsPda;
/** wSOL reward escrow of a randomness account = its ATA. */
const sbRewardEscrow = (randomness) => ata(ids_1.WSOL_MINT, randomness);
exports.sbRewardEscrow = sbRewardEscrow;
// ---------------------------------------------------------------- market
const marketAuthPda = () => find([enc('market_auth')], ids_1.MARKET_ID);
exports.marketAuthPda = marketAuthPda;
const listingPda = (asset) => find([enc('listing'), asset.toBytes()], ids_1.MARKET_ID);
exports.listingPda = listingPda;
const offerPda = (asset, bidder) => find([enc('offer'), asset.toBytes(), bidder.toBytes()], ids_1.MARKET_ID);
exports.offerPda = offerPda;
// ---------------------------------------------------------------- staking
const emissionPda = () => find([enc('emission')], ids_1.STAKING_ID);
exports.emissionPda = emissionPda;
const tokenPoolPda = () => find([enc('token_pool')], ids_1.STAKING_ID);
exports.tokenPoolPda = tokenPoolPda;
const chipPoolPda = () => find([enc('chip_pool')], ids_1.STAKING_ID);
exports.chipPoolPda = chipPoolPda;
const stakeAuthPda = () => find([enc('stake_auth')], ids_1.STAKING_ID);
exports.stakeAuthPda = stakeAuthPda;
/** `["rewarder"]` — staking's signer for chip_core `grant_booster` (kind-8 item claims, backlog #27). */
const rewarderPda = () => find([enc('rewarder')], ids_1.STAKING_ID);
exports.rewarderPda = rewarderPda;
/** SEC-L5: authority of the arena's season pool ($CG ATA of this PDA); spent only by `fund_slice`. */
const seasonPoolAuthPda = () => find([enc('season_pool')], ids_1.STAKING_ID);
exports.seasonPoolAuthPda = seasonPoolAuthPda;
const tokenStakePda = (owner, tier) => find([enc('tstake'), owner.toBytes(), u8(tier)], ids_1.STAKING_ID);
exports.tokenStakePda = tokenStakePda;
const chipStakePda = (asset) => find([enc('cstake'), asset.toBytes()], ids_1.STAKING_ID);
exports.chipStakePda = chipStakePda;
const compressedChipStakePda = (claim) => find([enc('compressed_cstake'), claim.toBytes()], ids_1.STAKING_ID);
exports.compressedChipStakePda = compressedChipStakePda;
const setBonusPda = (owner) => find([enc('setbonus'), owner.toBytes()], ids_1.STAKING_ID);
exports.setBonusPda = setBonusPda;
const rewardRootPda = (kind, epoch) => find([enc('root'), u8(kind), (0, borsh_1.u32le)(epoch)], ids_1.STAKING_ID);
exports.rewardRootPda = rewardRootPda;
const claimReceiptPda = (root, wallet) => find([enc('claim'), root.toBytes(), wallet.toBytes()], ids_1.STAKING_ID);
exports.claimReceiptPda = claimReceiptPda;
/** SKR prize pool (reward currency #2) — vault = ata(skrMint, skrPool). */
const skrPoolPda = () => find([enc('skr_pool')], ids_1.STAKING_ID);
exports.skrPoolPda = skrPoolPda;
const burnReporterPda = (program) => find([enc('burn_reporter')], program);
exports.burnReporterPda = burnReporterPda;
// ---------------------------------------------------------------- arena
const arenaConfigPda = () => find([enc('arena_config')], ids_1.ARENA_ID);
exports.arenaConfigPda = arenaConfigPda;
const battlePda = (challenger, nonce) => find([enc('battle'), challenger.toBytes(), (0, borsh_1.u64le)(nonce)], ids_1.ARENA_ID);
exports.battlePda = battlePda;
// ---------------------------------------------------------------- SPL
function ata(mint, owner) {
    return find([owner.toBytes(), ids_1.TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ids_1.ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
/** Fresh u64 nonce for pending packs / fusions / battles (time-ordered, collision-free per wallet). */
function freshNonce() {
    const rnd = new Uint32Array(1);
    crypto.getRandomValues(rnd);
    return (BigInt(Date.now()) << 20n) | BigInt(rnd[0] & 0xfffff);
}

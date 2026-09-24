"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SWITCHBOARD_ON_DEMAND_ID = exports.SWITCHBOARD_QUEUE = exports.SWITCHBOARD_PROGRAM_ID = exports.PYTH_SPONSORED_SOL_USD = exports.PYTH_PRICE_ACCOUNTS = exports.PYTH_SHARD_ID = exports.PYTH_SKR_USD_FEED_ID_HEX = exports.PYTH_SOL_USD_FEED_ID_HEX = exports.PYTH_PUSH_ORACLE_ID = exports.PYTH_RECEIVER_ID = exports.WSOL_MINT = exports.ADDRESS_LOOKUP_TABLE_PROGRAM_ID = exports.SYSVAR_SLOT_HASHES_ID = exports.SYSTEM_PROGRAM_ID = exports.ASSOCIATED_TOKEN_PROGRAM_ID = exports.TOKEN_PROGRAM_ID = exports.MPL_NOOP_ID = exports.MPL_ACCOUNT_COMPRESSION_ID = exports.MPL_BUBBLEGUM_V2_ID = exports.MPL_CORE_ID = exports.ARENA_ID = exports.STAKING_ID = exports.MARKET_ID = exports.CHIP_CORE_ID = void 0;
const web3_js_1 = require("@solana/web3.js");
const config_1 = require("@/app/config");
exports.CHIP_CORE_ID = config_1.PROGRAM_IDS.chipCore;
exports.MARKET_ID = config_1.PROGRAM_IDS.market;
exports.STAKING_ID = config_1.PROGRAM_IDS.staking;
exports.ARENA_ID = config_1.PROGRAM_IDS.arena;
exports.MPL_CORE_ID = new web3_js_1.PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
exports.MPL_BUBBLEGUM_V2_ID = new web3_js_1.PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
exports.MPL_ACCOUNT_COMPRESSION_ID = new web3_js_1.PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
exports.MPL_NOOP_ID = new web3_js_1.PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
exports.TOKEN_PROGRAM_ID = new web3_js_1.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
exports.ASSOCIATED_TOKEN_PROGRAM_ID = new web3_js_1.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
exports.SYSTEM_PROGRAM_ID = new web3_js_1.PublicKey('11111111111111111111111111111111');
exports.SYSVAR_SLOT_HASHES_ID = new web3_js_1.PublicKey('SysvarS1otHashes111111111111111111111111111');
exports.ADDRESS_LOOKUP_TABLE_PROGRAM_ID = new web3_js_1.PublicKey('AddressLookupTab1e1111111111111111111111111');
exports.WSOL_MINT = new web3_js_1.PublicKey('So11111111111111111111111111111111111111112');
/**
 * Pyth (owner decision Q7 — the studio posts SOL/USD and SKR/USD itself, ops/pyth-pusher/).
 * `/packs/quote` returns the exact PriceUpdateV2 account to pass as `price_update`; when the
 * API is unreachable the flow falls back to `GameConfig.pyth_*_feed`, which the admin points
 * at the same accounts (`npm run pyth-pusher -- set-params-args`). The program accepts ANY
 * account owned by the receiver that carries the right feed id, Full verification and a
 * publish_time ≤ 60 s old — the shard is a routing detail, not a trust boundary.
 */
exports.PYTH_RECEIVER_ID = new web3_js_1.PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
exports.PYTH_PUSH_ORACLE_ID = new web3_js_1.PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
exports.PYTH_SOL_USD_FEED_ID_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** Pyth `Crypto.SKR/USD` (Hermes id). The configured PriceUpdateV2 account carries this feed. */
exports.PYTH_SKR_USD_FEED_ID_HEX = '38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9';
/** Our push-oracle shard (0xCA75 = "CAPS") and its two PDAs: [shard u16 LE, feed_id] under the push-oracle program. */
exports.PYTH_SHARD_ID = 0xca75;
exports.PYTH_PRICE_ACCOUNTS = {
    SOL: new web3_js_1.PublicKey('ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB'),
    SKR: new web3_js_1.PublicKey('9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc'),
};
/** Pyth-sponsored shard-0 SOL/USD account (55 s heartbeat — too slow for a 60 s window; incident fallback only). */
exports.PYTH_SPONSORED_SOL_USD = new web3_js_1.PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
/**
 * Switchboard On-Demand is a DIFFERENT program per cluster (SEC-H1): mainnet `SBond…`, devnet
 * `Aio4…`, localnet our `sb_mock` (tests/localnet). The on-chain programs enforce
 * `randomness.owner == chip_core::randomness::SB_PROGRAM_ID` for the cluster they were built for,
 * so these three tables must stay in sync with `programs/chip_core/src/randomness.rs`.
 */
exports.SWITCHBOARD_PROGRAM_ID = {
    'mainnet-beta': new web3_js_1.PublicKey('SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv'),
    devnet: new web3_js_1.PublicKey('Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'),
    localnet: new web3_js_1.PublicKey('ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH'), // programs/sb_mock, keypair in tests/localnet/fixtures
};
exports.SWITCHBOARD_QUEUE = {
    'mainnet-beta': new web3_js_1.PublicKey('A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w'),
    devnet: new web3_js_1.PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7'),
    localnet: new web3_js_1.PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7'), // sb_mock ignores the queue; any key works
};
exports.SWITCHBOARD_ON_DEMAND_ID = exports.SWITCHBOARD_PROGRAM_ID[config_1.CLUSTER];

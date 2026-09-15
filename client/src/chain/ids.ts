import { PublicKey } from '@solana/web3.js';
import { CLUSTER, PROGRAM_IDS } from '@/app/config';

export const CHIP_CORE_ID = PROGRAM_IDS.chipCore;
export const MARKET_ID = PROGRAM_IDS.market;
export const STAKING_ID = PROGRAM_IDS.staking;
export const ARENA_ID = PROGRAM_IDS.arena;

export const MPL_CORE_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const SYSVAR_SLOT_HASHES_ID = new PublicKey('SysvarS1otHashes111111111111111111111111111');

/** Pyth price-update account (SOL/USD sponsored feed). The quote endpoint returns the exact account; this is the fallback. */
export const PYTH_RECEIVER_ID = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
export const PYTH_SOL_USD_FEED_ID_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** Pyth `Crypto.SKR/USD` (Hermes id). GameConfig.pyth_skr_usd_feed must post this feed id. */
export const PYTH_SKR_USD_FEED_ID_HEX = '38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9';

/**
 * Switchboard On-Demand is a DIFFERENT program per cluster (SEC-H1): mainnet `SBond…`, devnet
 * `Aio4…`, localnet our `sb_mock` (tests/localnet). The on-chain programs enforce
 * `randomness.owner == chip_core::randomness::SB_PROGRAM_ID` for the cluster they were built for,
 * so these three tables must stay in sync with `programs/chip_core/src/randomness.rs`.
 */
export const SWITCHBOARD_PROGRAM_ID = {
  'mainnet-beta': new PublicKey('SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv'),
  devnet: new PublicKey('Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'),
  localnet: new PublicKey('ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH'), // programs/sb_mock, keypair in tests/localnet/fixtures
} as const;
export const SWITCHBOARD_QUEUE = {
  'mainnet-beta': new PublicKey('A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w'),
  devnet: new PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7'),
  localnet: new PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7'), // sb_mock ignores the queue; any key works
} as const;
export const SWITCHBOARD_ON_DEMAND_ID = SWITCHBOARD_PROGRAM_ID[CLUSTER];

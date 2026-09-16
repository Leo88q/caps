// Every PDA of the four programs, mirroring the seeds in
// programs/*/src — see docs/03-architecture.md §2.3.
import { PublicKey } from '@solana/web3.js';
import { u32le, u64le } from './borsh';
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ID, ARENA_ID, ASSOCIATED_TOKEN_PROGRAM_ID, CHIP_CORE_ID, MARKET_ID, STAKING_ID, SWITCHBOARD_ON_DEMAND_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from './ids';

const enc = (s: string) => new TextEncoder().encode(s);
const u8 = (n: number) => Uint8Array.of(n & 0xff);

const find = (seeds: Uint8Array[], program: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), program);

// ---------------------------------------------------------------- chip_core
export const configPda = () => find([enc('config')], CHIP_CORE_ID);
export const vaultPda = () => find([enc('vault')], CHIP_CORE_ID);
export const collectionMetaPda = (idx: number) => find([enc('collection'), u8(idx)], CHIP_CORE_ID);
export const chipStatePda = (asset: PublicKey) => find([enc('chip'), asset.toBytes()], CHIP_CORE_ID);
export const pendingPackPda = (buyer: PublicKey, nonce: bigint) => find([enc('pending'), buyer.toBytes(), u64le(nonce)], CHIP_CORE_ID);
export const pityPda = (wallet: PublicKey) => find([enc('pity'), wallet.toBytes()], CHIP_CORE_ID);
export const pendingFusionPda = (owner: PublicKey, nonce: bigint) => find([enc('fusion'), owner.toBytes(), u64le(nonce)], CHIP_CORE_ID);
export const serviceLedgerPda = (wallet: PublicKey) => find([enc('services'), wallet.toBytes()], CHIP_CORE_ID);
export const playerItemsPda = (wallet: PublicKey) => find([enc('items'), wallet.toBytes()], CHIP_CORE_ID);
/** Core asset address minted by open_pack (pack_no, slot i) or fuse (0, 0). */
export const assetPda = (pending: PublicKey, packNo: number, i: number) =>
  find([enc('asset'), pending.toBytes(), u8(packNo), u8(i)], CHIP_CORE_ID);

// ------------------------------------------- program-owned Switchboard randomness (SEC-C3 part 2)
/** Randomness account kinds: 0 pack, 1 fusion (chip_core), 2 battle (arena). */
export const RNG_KIND = { PACK: 0, FUSION: 1, BATTLE: 2 } as const;
export type RngKind = (typeof RNG_KIND)[keyof typeof RNG_KIND];
const rngProgram = (kind: RngKind) => (kind === RNG_KIND.BATTLE ? ARENA_ID : CHIP_CORE_ID);
/** Switchboard `authority` of every randomness account of a program: `["rng_auth"]`. */
export const rngAuthPda = (kind: RngKind) => find([enc('rng_auth')], rngProgram(kind));
/** The randomness account itself: `["rng", kind, owner, nonce]` — one per purchase / fusion / battle. */
export const rngPda = (kind: RngKind, owner: PublicKey, nonce: bigint) => find([enc('rng'), u8(kind), owner.toBytes(), u64le(nonce)], rngProgram(kind));

// ---------------------------------------------------------------- Switchboard On-Demand PDAs
/** `["STATE"]` of the Switchboard program. */
export const sbStatePda = () => find([enc('STATE')], SWITCHBOARD_ON_DEMAND_ID);
/** `["LutSigner", randomness]` — authority of the lookup table created by `randomness_init`. */
export const sbLutSignerPda = (randomness: PublicKey) => find([enc('LutSigner'), randomness.toBytes()], SWITCHBOARD_ON_DEMAND_ID);
/** Address of the lookup table: `AddressLookupTableProgram.createLookupTable({ authority: lutSigner, recentSlot })`. */
export const sbLutPda = (lutSigner: PublicKey, recentSlot: bigint) => find([lutSigner.toBytes(), u64le(recentSlot)], ADDRESS_LOOKUP_TABLE_PROGRAM_ID);
/** `["OracleRandomnessStats", oracle]` — writable in `randomness_reveal`. */
export const sbOracleStatsPda = (oracle: PublicKey) => find([enc('OracleRandomnessStats'), oracle.toBytes()], SWITCHBOARD_ON_DEMAND_ID);
/** wSOL reward escrow of a randomness account = its ATA. */
export const sbRewardEscrow = (randomness: PublicKey) => ata(WSOL_MINT, randomness);

// ---------------------------------------------------------------- market
export const marketAuthPda = () => find([enc('market_auth')], MARKET_ID);
export const listingPda = (asset: PublicKey) => find([enc('listing'), asset.toBytes()], MARKET_ID);
export const offerPda = (asset: PublicKey, bidder: PublicKey) => find([enc('offer'), asset.toBytes(), bidder.toBytes()], MARKET_ID);

// ---------------------------------------------------------------- staking
export const emissionPda = () => find([enc('emission')], STAKING_ID);
export const tokenPoolPda = () => find([enc('token_pool')], STAKING_ID);
export const chipPoolPda = () => find([enc('chip_pool')], STAKING_ID);
export const stakeAuthPda = () => find([enc('stake_auth')], STAKING_ID);
/** SEC-L5: authority of the arena's season pool ($CG ATA of this PDA); spent only by `fund_slice`. */
export const seasonPoolAuthPda = () => find([enc('season_pool')], STAKING_ID);
export const tokenStakePda = (owner: PublicKey, tier: number) => find([enc('tstake'), owner.toBytes(), u8(tier)], STAKING_ID);
export const chipStakePda = (asset: PublicKey) => find([enc('cstake'), asset.toBytes()], STAKING_ID);
export const setBonusPda = (owner: PublicKey) => find([enc('setbonus'), owner.toBytes()], STAKING_ID);
export const rewardRootPda = (kind: number, epoch: number) => find([enc('root'), u8(kind), u32le(epoch)], STAKING_ID);
export const claimReceiptPda = (root: PublicKey, wallet: PublicKey) => find([enc('claim'), root.toBytes(), wallet.toBytes()], STAKING_ID);
/** SKR prize pool (reward currency #2) — vault = ata(skrMint, skrPool). */
export const skrPoolPda = () => find([enc('skr_pool')], STAKING_ID);
export const burnReporterPda = (program: PublicKey) => find([enc('burn_reporter')], program);

// ---------------------------------------------------------------- arena
export const arenaConfigPda = () => find([enc('arena_config')], ARENA_ID);
export const battlePda = (challenger: PublicKey, nonce: bigint) => find([enc('battle'), challenger.toBytes(), u64le(nonce)], ARENA_ID);

// ---------------------------------------------------------------- SPL
export function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return find([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Fresh u64 nonce for pending packs / fusions / battles (time-ordered, collision-free per wallet). */
export function freshNonce(): bigint {
  const rnd = new Uint32Array(1);
  crypto.getRandomValues(rnd);
  return (BigInt(Date.now()) << 20n) | BigInt(rnd[0] & 0xfffff);
}

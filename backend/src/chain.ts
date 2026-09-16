// On-chain glue for the crank: PDAs, account decoders and the instruction
// builders the worker needs (reveal_randomness / open_pack / fuse_reveal /
// close_randomness + the arena twins). Deliberately a mirror of
// client/src/chain/{pdas,ix/rng,ix/chipCore,accounts}.ts rather than a shared
// package: the client is bundled by Vite with `@/app/config` aliases, the
// backend runs on plain Node — and the *program* is the contract both sides
// follow (account order == the `#[derive(Accounts)]` structs in
// programs/chip_core/src/instructions/{rng,packs,fusion}.rs and
// programs/arena/src/lib.rs). backend/test/crank.test.ts pins the layouts.
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { BorshReader, BorshWriter } from './borsh.ts';
import { PROGRAMS, SWITCHBOARD_PROGRAM_ID } from './config.ts';

// ---------------------------------------------------------------- ids
export const CHIP_CORE_ID = PROGRAMS.chip_core;
export const ARENA_ID = PROGRAMS.arena;
export const MPL_CORE_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const SYSVAR_SLOT_HASHES_ID = new PublicKey('SysvarS1otHashes111111111111111111111111111');
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ---------------------------------------------------------------- anchor wire helpers
const enc = (s: string) => new TextEncoder().encode(s);
const u8 = (v: number) => Uint8Array.of(v & 0xff);
export const u64le = (v: bigint | number): Uint8Array => new BorshWriter().u64(v).toBytes();
const disc = (prefix: string, name: string) => sha256(enc(`${prefix}:${name}`)).slice(0, 8);
export const ixDiscriminator = (name: string) => disc('global', name);
export const accountDiscriminator = (name: string) => disc('account', name);
export function ixData(name: string, args: Uint8Array = new Uint8Array()): Buffer {
  return Buffer.concat([ixDiscriminator(name), args]);
}
export const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
export const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
export const signer = (pubkey: PublicKey, writable = true): AccountMeta => ({ pubkey, isSigner: true, isWritable: writable });
/** Anchor `Option<Account<…>>`: absent = the program id itself (readonly). */
export const optional = (pubkey: PublicKey | undefined, programId: PublicKey): AccountMeta => (pubkey ? rw(pubkey) : ro(programId));

export function expectDiscriminator(data: Uint8Array, name: string): BorshReader {
  const d = accountDiscriminator(name);
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) throw new Error(`Account discriminator mismatch: expected ${name}`);
  return new BorshReader(data, 8);
}
export function hasDiscriminator(data: Uint8Array, name: string): boolean {
  const d = accountDiscriminator(name);
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return false;
  return true;
}

// ---------------------------------------------------------------- PDAs
const find = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), program);

export const configPda = () => find([enc('config')], CHIP_CORE_ID);
export const vaultPda = () => find([enc('vault')], CHIP_CORE_ID);
export const collectionMetaPda = (idx: number) => find([enc('collection'), u8(idx)], CHIP_CORE_ID);
export const chipStatePda = (asset: PublicKey) => find([enc('chip'), asset.toBytes()], CHIP_CORE_ID);
export const pendingPackPda = (buyer: PublicKey, nonce: bigint) => find([enc('pending'), buyer.toBytes(), u64le(nonce)], CHIP_CORE_ID);
export const pityPda = (wallet: PublicKey) => find([enc('pity'), wallet.toBytes()], CHIP_CORE_ID);
export const pendingFusionPda = (owner: PublicKey, nonce: bigint) => find([enc('fusion'), owner.toBytes(), u64le(nonce)], CHIP_CORE_ID);
export const playerItemsPda = (wallet: PublicKey) => find([enc('items'), wallet.toBytes()], CHIP_CORE_ID);
export const assetPda = (pending: PublicKey, packNo: number, i: number) => find([enc('asset'), pending.toBytes(), u8(packNo), u8(i)], CHIP_CORE_ID);
export const battlePda = (challenger: PublicKey, nonce: bigint) => find([enc('battle'), challenger.toBytes(), u64le(nonce)], ARENA_ID);
export const emissionPda = () => find([enc('emission')], PROGRAMS.staking);
/** SEC-L5: staking's `["season_pool"]` PDA — authority of the arena's season pool ($CG ATA), spent only by `fund_slice`. */
export const seasonPoolAuthPda = () => find([enc('season_pool')], PROGRAMS.staking);
export const seasonPoolAta = (cgMint: PublicKey) => ata(cgMint, seasonPoolAuthPda()[0]);
/** staking `["skr_pool"]` — treasury-funded SKR prize pool (reward currency #2). */
export const skrPoolPda = () => find([enc('skr_pool')], PROGRAMS.staking);

/** Randomness account kinds: 0 pack, 1 fusion (chip_core), 2 battle (arena). */
export const RNG_KIND = { PACK: 0, FUSION: 1, BATTLE: 2 } as const;
export type RngKind = (typeof RNG_KIND)[keyof typeof RNG_KIND];
export const rngProgram = (kind: RngKind) => (kind === RNG_KIND.BATTLE ? ARENA_ID : CHIP_CORE_ID);
export const rngAuthPda = (kind: RngKind) => find([enc('rng_auth')], rngProgram(kind));
export const rngPda = (kind: RngKind, owner: PublicKey, nonce: bigint) => find([enc('rng'), u8(kind), owner.toBytes(), u64le(nonce)], rngProgram(kind));

export const sbStatePda = () => find([enc('STATE')], SWITCHBOARD_PROGRAM_ID);
export const sbLutSignerPda = (randomness: PublicKey) => find([enc('LutSigner'), randomness.toBytes()], SWITCHBOARD_PROGRAM_ID);
export const sbLutPda = (lutSigner: PublicKey, slot: bigint) => find([lutSigner.toBytes(), u64le(slot)], ADDRESS_LOOKUP_TABLE_PROGRAM_ID);
export const sbOracleStatsPda = (oracle: PublicKey) => find([enc('OracleRandomnessStats'), oracle.toBytes()], SWITCHBOARD_PROGRAM_ID);

export function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return find([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
export const sbRewardEscrow = (randomness: PublicKey) => ata(WSOL_MINT, randomness);

// ---------------------------------------------------------------- account decoders (programs/chip_core/src/state.rs)
export const RARITY_COUNT = 9;
export const MATERIALS_PER_FUSION = 3;
export const SQUAD = 3;

export interface PackDef {
  chips: number; priceUsdCents: number; priceCgMicro: bigint; oddsBps: number[]; floor: number; dailyCap: number;
  pityTier: number; pityHardAt: number; pitySoftStart: number; pitySoftStepBps: number; featuredOnly: boolean; enabled: boolean;
}
function readPackDef(r: BorshReader): PackDef {
  return {
    chips: r.u8(), priceUsdCents: r.u32(), priceCgMicro: r.u64(), oddsBps: r.array(RARITY_COUNT, () => r.u16()), floor: r.u8(), dailyCap: r.u8(),
    pityTier: r.u8(), pityHardAt: r.u16(), pitySoftStart: r.u16(), pitySoftStepBps: r.u16(), featuredOnly: r.bool(), enabled: r.bool(),
  };
}

export interface GameConfig {
  admin: PublicKey; pendingAdmin: PublicKey; treasury: PublicKey; buybackWallet: PublicKey; cgMint: PublicKey; usdcMint: PublicKey; skrMint: PublicKey;
  stakingProgram: PublicKey; pythSolUsdFeed: PublicKey; pythSkrUsdFeed: PublicKey; featuredCollection: number; paused: boolean; packs: PackDef[];
  marketFeeBps: number; skrDiscountBps: number; collectionsCreated: number;
  liabLamports: bigint; liabUsdc: bigint; liabCg: bigint; liabSkr: bigint; burnedTotal: bigint; paramsVersion: number; vaultBump: number; bump: number;
  /** SEC-H2 hot pauser; `PublicKey.default` = none */
  pauser: PublicKey;
}
export function decodeGameConfig(data: Uint8Array): GameConfig {
  const r = expectDiscriminator(data, 'GameConfig');
  return {
    admin: r.pubkey(), pendingAdmin: r.pubkey(), treasury: r.pubkey(), buybackWallet: r.pubkey(), cgMint: r.pubkey(), usdcMint: r.pubkey(), skrMint: r.pubkey(),
    stakingProgram: r.pubkey(), pythSolUsdFeed: r.pubkey(), pythSkrUsdFeed: r.pubkey(), featuredCollection: r.u8(), paused: r.bool(),
    packs: r.array(4, () => readPackDef(r)), marketFeeBps: r.u16(), skrDiscountBps: r.u16(), collectionsCreated: r.u8(),
    liabLamports: r.u64(), liabUsdc: r.u64(), liabCg: r.u64(), liabSkr: r.u64(), burnedTotal: r.u64(), paramsVersion: r.u32(), vaultBump: r.u8(), bump: r.u8(),
    pauser: r.remaining >= 32 ? r.pubkey() : PublicKey.default,
  };
}
/** 42-byte Borsh `PackDef` (programs/chip_core/src/economy.rs) — the `set_params` patch carries `Option<[PackDef; 4]>`. */
export function writePackDef(w: BorshWriter, p: PackDef): BorshWriter {
  w.u8(p.chips).u32(p.priceUsdCents).u64(p.priceCgMicro);
  for (const o of p.oddsBps) w.u16(o);
  return w.u8(p.floor).u8(p.dailyCap).u8(p.pityTier).u16(p.pityHardAt).u16(p.pitySoftStart).u16(p.pitySoftStepBps).bool(p.featuredOnly).bool(p.enabled);
}

export const SPLIT_COUNT = 5;
/** staking `EmissionState` (`["emission"]`, programs/staking/src/state.rs) — mirror of client/src/chain/accounts.ts. */
export interface EmissionState {
  admin: PublicKey; cgMint: PublicKey; chipCoreProgram: PublicKey; marketProgram: PublicKey; arenaProgram: PublicKey;
  questOracle: PublicKey; seasonOracle: PublicKey; setOracle: PublicKey; genesisTs: bigint; dayIndex: number;
  mintedTotal: bigint; scheduleMinted: bigint[]; burnRing: bigint[]; burnToday: bigint; splitBps: number[];
  splitChangedAt: bigint; sliceBudget: bigint[]; paused: boolean; bump: number; pauser: PublicKey; burnOracle: PublicKey;
  /** SEC-L5: $CG burned out of the season pool by `fund_slice` / re-minted at claim (supply-neutral recycling of the 20 % rake). */
  recycledTotal: bigint; recycledMinted: bigint;
}
export function decodeEmissionState(data: Uint8Array): EmissionState {
  const r = expectDiscriminator(data, 'EmissionState');
  return {
    admin: r.pubkey(), cgMint: r.pubkey(), chipCoreProgram: r.pubkey(), marketProgram: r.pubkey(), arenaProgram: r.pubkey(),
    questOracle: r.pubkey(), seasonOracle: r.pubkey(), setOracle: r.pubkey(), genesisTs: r.i64(), dayIndex: r.u32(),
    mintedTotal: r.u64(), scheduleMinted: r.array(8, () => r.u64()), burnRing: r.array(7, () => r.u64()), burnToday: r.u64(),
    splitBps: r.array(SPLIT_COUNT, () => r.u16()), splitChangedAt: r.i64(), sliceBudget: r.array(SPLIT_COUNT, () => r.u64()),
    paused: r.bool(), bump: r.u8(), pauser: r.remaining >= 32 ? r.pubkey() : PublicKey.default, burnOracle: r.remaining >= 32 ? r.pubkey() : PublicKey.default,
    recycledTotal: r.remaining >= 8 ? r.u64() : 0n, recycledMinted: r.remaining >= 8 ? r.u64() : 0n,
  };
}

/** staking `SkrPool` (programs/staking/src/state.rs) — invariant vault ≥ budget + reserved; mirror of client/src/chain/accounts.ts. */
export interface SkrPool { skrMint: PublicKey; vault: PublicKey; budget: bigint; reserved: bigint; fundedTotal: bigint; paidTotal: bigint; maxRootBudget: bigint; paused: boolean; bump: number }
export function decodeSkrPool(data: Uint8Array): SkrPool {
  const r = expectDiscriminator(data, 'SkrPool');
  return { skrMint: r.pubkey(), vault: r.pubkey(), budget: r.u64(), reserved: r.u64(), fundedTotal: r.u64(), paidTotal: r.u64(), maxRootBudget: r.u64(), paused: r.bool(), bump: r.u8() };
}

export interface CollectionMeta { idx: number; coreCollection: PublicKey; symbol: string; element: number; minted: bigint; mintedByRarity: bigint[]; bump: number }
export function decodeCollectionMeta(data: Uint8Array): CollectionMeta {
  const r = expectDiscriminator(data, 'CollectionMeta');
  const idx = r.u8(), coreCollection = r.pubkey();
  const len = r.u32(); const symbol = new TextDecoder().decode(r.bytes(len));
  return { idx, coreCollection, symbol, element: r.u8(), minted: r.u64(), mintedByRarity: r.array(RARITY_COUNT, () => r.u64()), bump: r.u8() };
}

export interface ChipState { asset: PublicKey; collectionIdx: number; rarity: number; level: number; index: bigint; flags: number; lockUntil: bigint; mintedAt: bigint; bump: number }
export function decodeChipState(data: Uint8Array): ChipState {
  const r = expectDiscriminator(data, 'ChipState');
  return { asset: r.pubkey(), collectionIdx: r.u8(), rarity: r.u8(), level: r.u8(), index: r.u64(), flags: r.u8(), lockUntil: r.i64(), mintedAt: r.i64(), bump: r.u8() };
}

export interface PlayerPity { owner: PublicKey; counters: number[]; dayStart: bigint; boughtToday: number[]; starterClaimed: boolean; bump: number }
export function decodePlayerPity(data: Uint8Array): PlayerPity {
  const r = expectDiscriminator(data, 'PlayerPity');
  return { owner: r.pubkey(), counters: r.array(4, () => r.u16()), dayStart: r.i64(), boughtToday: r.array(4, () => r.u8()), starterClaimed: r.bool(), bump: r.u8() };
}

export interface PendingPack {
  buyer: PublicKey; sku: number; qty: number; opened: number; randomness: PublicKey; commitSlot: bigint;
  paidLamports: bigint; paidUsdc: bigint; paidCg: bigint; paidSkr: bigint; pitySnapshot: number; nonce: bigint; bump: number;
  /** set by the first open_pack (SEC-C2): packs 2…N reuse `value`, the oracle account is never re-read */
  revealed: boolean; value: Uint8Array;
}
export const PENDING_PACK_SIZE = 159;
export function decodePendingPack(data: Uint8Array): PendingPack {
  const r = expectDiscriminator(data, 'PendingPack');
  return {
    buyer: r.pubkey(), sku: r.u8(), qty: r.u8(), opened: r.u8(), randomness: r.pubkey(), commitSlot: r.u64(),
    paidLamports: r.u64(), paidUsdc: r.u64(), paidCg: r.u64(), paidSkr: r.u64(), pitySnapshot: r.u16(), nonce: r.u64(), bump: r.u8(),
    revealed: r.bool(), value: r.bytes(32),
  };
}

export interface PendingFusion { owner: PublicKey; recipe: number; materials: PublicKey[]; resultCollectionIdx: number; boosted: boolean; randomness: PublicKey; commitSlot: bigint; nonce: bigint; bump: number; feeEscrowed: bigint }
export function decodePendingFusion(data: Uint8Array): PendingFusion {
  const r = expectDiscriminator(data, 'PendingFusion');
  return {
    owner: r.pubkey(), recipe: r.u8(), materials: r.array(MATERIALS_PER_FUSION, () => r.pubkey()), resultCollectionIdx: r.u8(), boosted: r.bool(),
    randomness: r.pubkey(), commitSlot: r.u64(), nonce: r.u64(), bump: r.u8(), feeEscrowed: r.u64(), // SEC-M3
  };
}

export const BATTLE_STATUS = { OPEN: 0, ACCEPTED: 1, RESOLVED: 2, CANCELLED: 3 } as const;
export interface WagerBattle {
  challenger: PublicKey; opponent: PublicKey; wager: bigint; squadA: PublicKey[]; squadB: PublicKey[]; powerA: number; powerB: number;
  randomness: PublicKey; commitSlot: bigint; status: number; createdAt: bigint; acceptedAt: bigint; winner: PublicKey; resultHash: Uint8Array; nonce: bigint; bump: number;
}
export function decodeWagerBattle(data: Uint8Array): WagerBattle {
  const r = expectDiscriminator(data, 'WagerBattle');
  return {
    challenger: r.pubkey(), opponent: r.pubkey(), wager: r.u64(), squadA: r.array(SQUAD, () => r.pubkey()), squadB: r.array(SQUAD, () => r.pubkey()),
    powerA: r.u32(), powerB: r.u32(), randomness: r.pubkey(), commitSlot: r.u64(), status: r.u8(), createdAt: r.i64(), acceptedAt: r.i64(),
    winner: r.pubkey(), resultHash: r.bytes(32), nonce: r.u64(), bump: r.u8(),
  };
}

// ---------------------------------------------------------------- Switchboard accounts (raw layouts, no SDK)
/**
 * `RandomnessAccountData` (sb_on_demand IDL, bytemuck, 480 bytes): authority @8, queue @40,
 * seed_slothash @72, seed_slot @104, oracle @112, reveal_slot @144, value @152, lut_slot @184.
 */
export const RANDOMNESS_ACCOUNT_SIZE = 480;
export interface RandomnessData {
  authority: PublicKey; queue: PublicKey; seedSlothash: Uint8Array; seedSlot: bigint; oracle: PublicKey; revealSlot: bigint; value: Uint8Array; lutSlot: bigint;
}
export function decodeRandomness(data: Uint8Array): RandomnessData {
  const r = expectDiscriminator(data, 'RandomnessAccountData');
  if (data.length < RANDOMNESS_ACCOUNT_SIZE) throw new Error(`RandomnessAccountData: ${data.length} bytes`);
  return { authority: r.pubkey(), queue: r.pubkey(), seedSlothash: r.bytes(32), seedSlot: r.u64(), oracle: r.pubkey(), revealSlot: r.u64(), value: r.bytes(32), lutSlot: r.u64() };
}

/** `OracleAccountData` (4816 bytes): gateway_uri[64] @3584 (NUL-padded), authority @3440, queue @3472. */
export const ORACLE_GATEWAY_URI_OFFSET = 3584;
export const ORACLE_ACCOUNT_SIZE = 4816;
export function decodeOracleGateway(data: Uint8Array): string {
  if (!hasDiscriminator(data, 'OracleAccountData')) throw new Error('Account discriminator mismatch: expected OracleAccountData');
  if (data.length < ORACLE_GATEWAY_URI_OFFSET + 64) throw new Error(`OracleAccountData: ${data.length} bytes`);
  const raw = data.subarray(ORACLE_GATEWAY_URI_OFFSET, ORACLE_GATEWAY_URI_OFFSET + 64);
  let end = raw.indexOf(0); if (end < 0) end = raw.length;
  return new TextDecoder().decode(raw.subarray(0, end)).trim();
}

// ---------------------------------------------------------------- economy mirrors
/** Sub-seed for pack `packNo` of a bundle (packs.rs `open_pack`: keccak(value ‖ pack_no) when qty > 1). */
export function packSeed(value: Uint8Array, qty: number, packNo: number): Uint8Array {
  if (qty === 1) return value;
  const buf = new Uint8Array(33); buf.set(value, 0); buf[32] = packNo;
  return keccak_256(buf);
}

// ---------------------------------------------------------------- instructions
export interface RevealArgs {
  kind: RngKind; payer: PublicKey; randomness: PublicKey; oracle: PublicKey; queue: PublicKey;
  /** oracle gateway response */
  signature: Uint8Array; recoveryId: number; value: Uint8Array;
}
/** `reveal_randomness(signature[64], recovery_id, value[32])` (chip_core) / `reveal_battle_randomness` (arena) — permissionless relay. */
export function revealRandomnessIx(a: RevealArgs): TransactionInstruction {
  if (a.signature.length !== 64) throw new Error('oracle signature must be 64 bytes');
  if (a.value.length !== 32) throw new Error('revealed value must be 32 bytes');
  const keys = [
    signer(a.payer), rw(a.randomness), ro(rngAuthPda(a.kind)[0]), ro(a.oracle), ro(a.queue), rw(sbOracleStatsPda(a.oracle)[0]), rw(sbRewardEscrow(a.randomness)),
    ro(sbStatePda()[0]), ro(SYSVAR_SLOT_HASHES_ID), ro(SWITCHBOARD_PROGRAM_ID), ro(WSOL_MINT), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  const name = a.kind === RNG_KIND.BATTLE ? 'reveal_battle_randomness' : 'reveal_randomness';
  return new TransactionInstruction({ programId: rngProgram(a.kind), keys, data: ixData(name, new BorshWriter().bytes(a.signature).u8(a.recoveryId).bytes(a.value).toBytes()) });
}

/** `close_randomness(kind, nonce)` / `close_battle_randomness(nonce)` — permissionless once the pinned account is gone (battle settled). Rent → owner. */
export function closeRandomnessIx(a: { kind: RngKind; payer: PublicKey; owner: PublicKey; nonce: bigint; lutSlot: bigint }): TransactionInstruction {
  const randomness = rngPda(a.kind, a.owner, a.nonce)[0];
  const lutSigner = sbLutSignerPda(randomness)[0];
  const pinned = a.kind === RNG_KIND.PACK ? pendingPackPda(a.owner, a.nonce)[0] : a.kind === RNG_KIND.FUSION ? pendingFusionPda(a.owner, a.nonce)[0] : battlePda(a.owner, a.nonce)[0];
  const keys = [
    signer(a.payer), rw(a.owner), rw(randomness), rw(rngAuthPda(a.kind)[0]), ro(pinned), rw(sbRewardEscrow(randomness)), ro(sbStatePda()[0]),
    rw(sbLutPda(lutSigner, a.lutSlot)[0]), ro(lutSigner), ro(SWITCHBOARD_PROGRAM_ID), ro(WSOL_MINT), ro(ADDRESS_LOOKUP_TABLE_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  const data = a.kind === RNG_KIND.BATTLE
    ? ixData('close_battle_randomness', new BorshWriter().u64(a.nonce).toBytes())
    : ixData('close_randomness', new BorshWriter().u8(a.kind).u64(a.nonce).toBytes());
  return new TransactionInstruction({ programId: rngProgram(a.kind), keys, data });
}

export interface OpenPackArgs {
  payer: PublicKey; buyer: PublicKey; nonce: bigint; packNo: number; randomness: PublicKey;
  /** collection index rolled for each chip slot (crank pre-simulates `expand`) */
  rolledCollections: number[];
  coreCollectionOf: (idx: number) => PublicKey;
  /** present when the purchase was paid in $CG (final pack burns 75 % / 25 % → treasury) */
  cg?: { cgMint: PublicKey; treasury: PublicKey };
}
/** `open_pack(nonce, pack_no)` — permissionless; rent for the new accounts is reimbursed from the PendingPack reserve. */
export function openPackIx(a: OpenPackArgs): TransactionInstruction {
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [vault] = vaultPda();
  const keys = [
    signer(a.payer), rw(configPda()[0]), rw(pending), ro(a.randomness), rw(pityPda(a.buyer)[0]), rw(a.buyer), rw(vault),
    optional(a.cg?.cgMint, CHIP_CORE_ID), optional(a.cg ? ata(a.cg.cgMint, vault) : undefined, CHIP_CORE_ID), optional(a.cg ? ata(a.cg.cgMint, a.cg.treasury) : undefined, CHIP_CORE_ID),
    ro(MPL_CORE_ID), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  a.rolledCollections.forEach((col, i) => {
    const [asset] = assetPda(pending, a.packNo, i);
    keys.push(rw(asset), rw(chipStatePda(asset)[0]), rw(collectionMetaPda(col)[0]), rw(a.coreCollectionOf(col)));
  });
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys, data: ixData('open_pack', new BorshWriter().u64(a.nonce).u8(a.packNo).toBytes()) });
}

export interface FuseRevealArgs {
  payer: PublicKey; owner: PublicKey; nonce: bigint; randomness: PublicKey; resultCollectionIdx: number;
  materials: { asset: PublicKey; collectionIdx: number }[];
  coreCollectionOf: (idx: number) => PublicKey;
  /** $CG mint (GameConfig.cg_mint) — the escrowed fee is burned from the vault ATA (SEC-M3) */
  cgMint: PublicKey;
}
/** `fuse_reveal(nonce)` — permissionless; PendingFusion rent → payer. */
export function fuseRevealIx(a: FuseRevealArgs): TransactionInstruction {
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [resultAsset] = assetPda(pending, 0, 0);
  const [vault] = vaultPda();
  const keys = [
    signer(a.payer), rw(configPda()[0]), rw(pending), ro(a.randomness), rw(a.owner), rw(collectionMetaPda(a.resultCollectionIdx)[0]), rw(a.coreCollectionOf(a.resultCollectionIdx)),
    rw(resultAsset), rw(chipStatePda(resultAsset)[0]), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    rw(vault), rw(a.cgMint), rw(ata(a.cgMint, vault)), ro(TOKEN_PROGRAM_ID),
  ];
  for (const m of a.materials) keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]), rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys, data: ixData('fuse_reveal', new BorshWriter().u64(a.nonce).toBytes()) });
}

/** SPL Associated Token `CreateIdempotent` (instruction 1). */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [signer(payer), rw(ata(mint, owner)), ro(owner), ro(mint), ro(SYSTEM_PROGRAM_ID), ro(TOKEN_PROGRAM_ID)],
    data: Buffer.from([1]),
  });
}

// ---------------------------------------------------------------- program errors the crank reacts to
/** chip_core error codes (programs/chip_core/src/errors.rs; Anchor custom errors start at 6000). */
export const CHIP_CORE_ERR = {
  InvalidQuantity: 6005, RandomnessExpired: 6014, RandomnessAlreadyRevealed: 6015, RandomnessNotResolved: 6016, RandomnessMismatch: 6017, NotStale: 6018,
  InvalidChipState: 6024, RandomnessAuthority: 6035, RandomnessUsed: 6036,
} as const;
/** Switchboard On-Demand errors we expect from the reveal CPI. */
export const SB_ERR = { InvalidAuthority: 6012, RandomnessTooOld: 6035, RandomnessNotRequested: 6038, InvalidSlotNumber: 6039, OracleKeyExpired: 6040 } as const;

/** Parse `custom program error: 0x…` (message or logs) → numeric code. */
export function customErrorCode(err: unknown): number | undefined {
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  const m = /custom program error: (0x[0-9a-fA-F]+|\d+)/.exec(msg);
  if (m) return m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
  const logs: string[] | undefined = (err as { logs?: string[] })?.logs;
  for (const l of logs ?? []) {
    const mm = /custom program error: (0x[0-9a-fA-F]+)/.exec(l);
    if (mm) return parseInt(mm[1], 16);
  }
  const j = /"Custom":(\d+)/.exec(msg);
  return j ? Number(j[1]) : undefined;
}

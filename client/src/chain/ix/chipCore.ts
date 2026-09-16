// Instruction builders for programs/chip_core. Account order MUST match the
// #[derive(Accounts)] structs (see programs/chip_core/src/instructions/*).
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, optional, ro, rw, signer } from '../anchor';
import { CHIP_CORE_ID, MPL_CORE_ID, SWITCHBOARD_ON_DEMAND_ID, SYSTEM_PROGRAM_ID, SYSVAR_SLOT_HASHES_ID, TOKEN_PROGRAM_ID } from '../ids';
import {
  RNG_KIND, assetPda, ata, chipStatePda, collectionMetaPda, configPda, pendingFusionPda, pendingPackPda, pityPda, playerItemsPda, rngAuthPda, serviceLedgerPda, vaultPda,
} from '../pdas';
import { commitAccountMetas } from './rng';

export const Currency = { SOL: 0, USDC: 1, CG: 2, SKR: 3 } as const;
export type CurrencyCode = (typeof Currency)[keyof typeof Currency];

/** 0.006 SOL per chip reserved in PendingPack so any cranker can open the pack (reimbursed). */
export const RENT_RESERVE_PER_CHIP = 6_000_000n;
/** Refund window (≈ 72 min at 400 ms slots) — mirrors chip_core::economy::STALE_PACK_SLOTS and @guttercaps/economy `STALE_PACK_SLOTS` (sync-check pins all three); refunds are only possible after the oracle's 1 h reveal window has expired (SEC-C3). */
export const STALE_PACK_SLOTS = 10_800n;

export interface BuyPackArgs {
  buyer: PublicKey;
  sku: number;
  qty: number;
  currency: CurrencyCode;
  nonce: bigint;
  /** slippage guard for volatile currencies: max lamports (SOL) or max micro-SKR (SKR); pass 0n otherwise */
  maxLamports: bigint;
  /** program-owned randomness PDA `["rng", 0, buyer, nonce]` created by `init_randomness` in the same tx */
  randomness: PublicKey;
  /** commit CPI accounts (SEC-C3 part 2): the pinned queue and the oracle chosen for this request */
  queue: PublicKey;
  oracle: PublicKey;
  /** SOL / SKR path: Pyth PriceUpdateV2 account for the matching feed */
  priceUpdate?: PublicKey;
  /** mints from GameConfig */
  usdcMint: PublicKey;
  cgMint: PublicKey;
  skrMint?: PublicKey;
}

/** SPL mint that pays for `currency`, or undefined for SOL. */
export function payMintFor(currency: CurrencyCode, mints: { usdcMint: PublicKey; cgMint: PublicKey; skrMint?: PublicKey }): PublicKey | undefined {
  if (currency === Currency.USDC) return mints.usdcMint;
  if (currency === Currency.CG) return mints.cgMint;
  if (currency === Currency.SKR) return mints.skrMint;
  return undefined;
}

export function buyPackIx(a: BuyPackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pity] = pityPda(a.buyer);
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [vault] = vaultPda();
  const payMint = payMintFor(a.currency, a);
  const volatile = a.currency === Currency.SOL || a.currency === Currency.SKR;
  const data = ixData(
    'buy_pack',
    new BorshWriter().u8(a.sku).u8(a.qty).u8(a.currency).u64(a.nonce).u64(a.maxLamports).toBytes(),
  );
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.buyer),
      rw(config),
      rw(pity),
      rw(pending),
      rw(a.randomness),
      ...commitAccountMetas({ kind: RNG_KIND.PACK, queue: a.queue, oracle: a.oracle }),
      rw(vault),
      optional(volatile ? a.priceUpdate : undefined, CHIP_CORE_ID, false),
      optional(payMint ? ata(payMint, a.buyer) : undefined, CHIP_CORE_ID),
      optional(payMint ? ata(payMint, vault) : undefined, CHIP_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(data),
  });
}

export interface OpenPackArgs {
  payer: PublicKey;
  buyer: PublicKey;
  nonce: bigint;
  packNo: number;
  randomness: PublicKey;
  /** rolled collection index per chip slot (from expandRandomness) */
  rolledCollections: number[];
  /** CollectionMeta.core_collection for each collection index */
  coreCollectionOf: (idx: number) => PublicKey;
  /** only for $CG-paid packs (settlement happens on the last open) */
  cg?: { cgMint: PublicKey; treasury: PublicKey };
}

export function openPackIx(a: OpenPackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [pity] = pityPda(a.buyer);
  const [vault] = vaultPda();
  const keys = [
    signer(a.payer),
    rw(config),
    rw(pending),
    ro(a.randomness),
    rw(pity),
    rw(a.buyer),
    rw(vault),
    optional(a.cg?.cgMint, CHIP_CORE_ID),
    optional(a.cg ? ata(a.cg.cgMint, vault) : undefined, CHIP_CORE_ID),
    optional(a.cg ? ata(a.cg.cgMint, a.cg.treasury) : undefined, CHIP_CORE_ID),
    ro(MPL_CORE_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];
  a.rolledCollections.forEach((col, i) => {
    const [asset] = assetPda(pending, a.packNo, i);
    const [state] = chipStatePda(asset);
    const [meta] = collectionMetaPda(col);
    keys.push(rw(asset), rw(state), rw(meta), rw(a.coreCollectionOf(col)));
  });
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: Buffer.from(ixData('open_pack', new BorshWriter().u64(a.nonce).u8(a.packNo).toBytes())),
  });
}

export interface CancelStalePackArgs {
  buyer: PublicKey;
  nonce: bigint;
  randomness: PublicKey;
  /** mint of the SPL currency that was paid (USDC, CG or SKR); undefined for SOL */
  paidMint?: PublicKey;
}

export function cancelStalePackIx(a: CancelStalePackArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingPackPda(a.buyer, a.nonce);
  const [vault] = vaultPda();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.buyer),
      rw(config),
      rw(pending),
      ro(a.randomness),
      rw(vault),
      optional(a.paidMint ? ata(a.paidMint, vault) : undefined, CHIP_CORE_ID),
      optional(a.paidMint ? ata(a.paidMint, a.buyer) : undefined, CHIP_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('cancel_stale_pack', new BorshWriter().u64(a.nonce).toBytes())),
  });
}

// ---------------------------------------------------------------- fusion
export interface FuseMaterial { asset: PublicKey; collectionIdx: number }

export interface FuseArgs {
  owner: PublicKey;
  nonce: bigint;
  useBooster: boolean;
  /**
   * Randomized recipes (< 100 %): the program-owned randomness PDA `["rng", 1, owner, nonce]` created
   * by `init_randomness` in the same tx + the commit CPI accounts. Omit for atomic recipes (the five
   * optional slots collapse to the program id).
   */
  rng?: { randomness: PublicKey; queue: PublicKey; oracle: PublicKey };
  materials: FuseMaterial[]; // exactly 3
  resultCollectionIdx: number;
  cgMint: PublicKey;
  coreCollectionOf: (idx: number) => PublicKey;
}

export function fuseIx(a: FuseArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [items] = playerItemsPda(a.owner);
  const [resultMeta] = collectionMetaPda(a.resultCollectionIdx);
  const [resultAsset] = assetPda(pending, 0, 0);
  const [resultState] = chipStatePda(resultAsset);
  const keys = [
    signer(a.owner),
    rw(config),
    rw(pending),
    optional(a.rng?.randomness, CHIP_CORE_ID),
    ro(rngAuthPda(RNG_KIND.FUSION)[0]),
    optional(a.rng ? SWITCHBOARD_ON_DEMAND_ID : undefined, CHIP_CORE_ID, false),
    optional(a.rng?.queue, CHIP_CORE_ID, false),
    optional(a.rng?.oracle, CHIP_CORE_ID),
    optional(a.rng ? SYSVAR_SLOT_HASHES_ID : undefined, CHIP_CORE_ID, false),
    rw(items),
    rw(resultMeta),
    rw(a.coreCollectionOf(a.resultCollectionIdx)),
    rw(resultAsset),
    rw(resultState),
    rw(a.cgMint),
    rw(ata(a.cgMint, a.owner)),
    ro(vaultPda()[0]),                 // SEC-M3: fee escrow authority
    rw(ata(a.cgMint, vaultPda()[0])),  // vault $CG ATA (randomized recipes park the fee here)
    ro(MPL_CORE_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
  ];
  // remaining: [asset, state] × 3, then [meta, core_collection] × 3
  for (const m of a.materials) keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]));
  for (const m of a.materials) keys.push(rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: Buffer.from(ixData('fuse', new BorshWriter().u64(a.nonce).bool(a.useBooster).toBytes())),
  });
}

export interface FuseRevealArgs {
  payer: PublicKey;
  owner: PublicKey;
  nonce: bigint;
  randomness: PublicKey;
  resultCollectionIdx: number;
  materials: FuseMaterial[];
  coreCollectionOf: (idx: number) => PublicKey;
  /** $CG mint — the escrowed fee (SEC-M3) is burned from the vault ATA at reveal / refunded at cancel */
  cgMint: PublicKey;
}

export function fuseRevealIx(a: FuseRevealArgs): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [resultMeta] = collectionMetaPda(a.resultCollectionIdx);
  const [resultAsset] = assetPda(pending, 0, 0);
  const [resultState] = chipStatePda(resultAsset);
  const [vault] = vaultPda();
  const keys = [
    signer(a.payer),
    rw(config),
    rw(pending),
    ro(a.randomness),
    rw(a.owner),
    rw(resultMeta),
    rw(a.coreCollectionOf(a.resultCollectionIdx)),
    rw(resultAsset),
    rw(resultState),
    ro(MPL_CORE_ID),
    ro(SYSTEM_PROGRAM_ID),
    rw(vault),
    rw(a.cgMint),
    rw(ata(a.cgMint, vault)),
    ro(TOKEN_PROGRAM_ID),
  ];
  for (const m of a.materials) {
    keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]), rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));
  }
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: Buffer.from(ixData('fuse_reveal', new BorshWriter().u64(a.nonce).toBytes())),
  });
}

export function cancelStaleFusionIx(a: Omit<FuseRevealArgs, 'payer' | 'resultCollectionIdx'>): TransactionInstruction {
  const [config] = configPda();
  const [pending] = pendingFusionPda(a.owner, a.nonce);
  const [vault] = vaultPda();
  const keys = [
    signer(a.owner), rw(config), rw(pending), ro(a.randomness), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    rw(vault), rw(ata(a.cgMint, vault)), rw(ata(a.cgMint, a.owner)), ro(TOKEN_PROGRAM_ID), // SEC-M3 fee refund
  ];
  for (const m of a.materials) {
    keys.push(rw(m.asset), rw(chipStatePda(m.asset)[0]), rw(collectionMetaPda(m.collectionIdx)[0]), rw(a.coreCollectionOf(m.collectionIdx)));
  }
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys,
    data: Buffer.from(ixData('cancel_stale_fusion', new BorshWriter().u64(a.nonce).toBytes())),
  });
}

// ---------------------------------------------------------------- thaw (soulbound / result lock expired)
export function thawChipIx(a: { owner: PublicKey; asset: PublicKey; collectionIdx: number; coreCollection: PublicKey }): TransactionInstruction {
  const [config] = configPda();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.owner), ro(config), rw(a.asset), rw(chipStatePda(a.asset)[0]), ro(collectionMetaPda(a.collectionIdx)[0]), rw(a.coreCollection),
      ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('thaw_chip')),
  });
}

// ---------------------------------------------------------------- paid services
export interface PayServiceArgs {
  buyer: PublicKey;
  kind: number;
  currency: CurrencyCode;
  /** max lamports / max micro-SKR for volatile currencies; 0n otherwise */
  maxUnits: bigint;
  /** keccak(kind ‖ wallet ‖ canonical payload) — binds the payment to e.g. a handle string */
  refHash: Uint8Array;
  treasury: PublicKey;
  priceUpdate?: PublicKey;
  usdcMint: PublicKey;
  cgMint: PublicKey;
  skrMint?: PublicKey;
}

export function payServiceIx(a: PayServiceArgs): TransactionInstruction {
  const [config] = configPda();
  const [ledger] = serviceLedgerPda(a.buyer);
  const [items] = playerItemsPda(a.buyer);
  const payMint = payMintFor(a.currency, a);
  const volatile = a.currency === Currency.SOL || a.currency === Currency.SKR;
  const cg = a.currency === Currency.CG;
  if (a.refHash.length !== 32) throw new Error('refHash must be 32 bytes');
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.buyer),
      rw(config),
      rw(ledger),
      rw(items),
      rw(a.treasury),
      optional(volatile ? a.priceUpdate : undefined, CHIP_CORE_ID, false),
      optional(payMint ? ata(payMint, a.buyer) : undefined, CHIP_CORE_ID),
      optional(payMint && !cg ? ata(payMint, a.treasury) : undefined, CHIP_CORE_ID),
      optional(cg ? a.cgMint : undefined, CHIP_CORE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('pay_service', new BorshWriter().u8(a.kind).u8(a.currency).u64(a.maxUnits).bytes(a.refHash).toBytes())),
  });
}

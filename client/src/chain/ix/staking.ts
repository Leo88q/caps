// Instruction builders for programs/staking ($CG tiers, chip staking, Merkle claims).
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, ro, rw, signer } from '../anchor';
import { CHIP_CORE_ID, MPL_CORE_ID, STAKING_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../ids';
import {
  ata, chipPoolPda, chipStakePda, chipStatePda, claimReceiptPda, collectionMetaPda, configPda, emissionPda, playerItemsPda, rewardRootPda,
  rewarderPda, seasonPoolAuthPda, setBonusPda, skrPoolPda, stakeAuthPda, tokenPoolPda, tokenStakePda,
} from '../pdas';
import { ITEM_REWARDS, isItemRootKind, isSkrRootKind } from '@guttercaps/economy';

export const TIER_LOCK_SECS = [0, 30 * 86_400, 90 * 86_400, 180 * 86_400] as const;
export const TIER_BOOST_BPS = [10_000, 15_000, 22_000, 30_000] as const;
export const TIER_PENALTY_BPS = [0, 500, 1_000, 1_500] as const;
export const MIN_STAKE_MICRO = 10_000_000n;
export const TIER_NAMES = ['Flex', '30 days', '90 days', '180 days'] as const;

export function stakeCgIx(a: { owner: PublicKey; tier: number; amount: bigint; cgMint: PublicKey }): TransactionInstruction {
  const [emission] = emissionPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emission), rw(tokenPoolPda()[0]), rw(tokenStakePda(a.owner, a.tier)[0]),
      rw(a.cgMint), rw(ata(a.cgMint, a.owner)), rw(ata(a.cgMint, emission)),
      ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('stake_cg', new BorshWriter().u8(a.tier).u64(a.amount).toBytes())),
  });
}

/** amount = 0n → claim only */
export function unstakeCgIx(a: { owner: PublicKey; tier: number; amount: bigint; cgMint: PublicKey }): TransactionInstruction {
  const [emission] = emissionPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emission), rw(tokenPoolPda()[0]), rw(tokenStakePda(a.owner, a.tier)[0]),
      rw(a.cgMint), rw(ata(a.cgMint, a.owner)), rw(ata(a.cgMint, emission)), ro(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('unstake_cg', new BorshWriter().u8(a.tier).u64(a.amount).toBytes())),
  });
}

interface ChipRef { asset: PublicKey; collectionIdx: number; coreCollection: PublicKey }

export function stakeChipIx(a: ChipRef & { owner: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emissionPda()[0]), rw(chipPoolPda()[0]), rw(chipStakePda(a.asset)[0]), rw(setBonusPda(a.owner)[0]),
      ro(stakeAuthPda()[0]), rw(a.asset), rw(chipStatePda(a.asset)[0]), ro(collectionMetaPda(a.collectionIdx)[0]), rw(a.coreCollection),
      ro(configPda()[0]), ro(CHIP_CORE_ID), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('stake_chip')),
  });
}

export function unstakeChipIx(a: ChipRef & { owner: PublicKey; cgMint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emissionPda()[0]), rw(chipPoolPda()[0]), rw(chipStakePda(a.asset)[0]), ro(stakeAuthPda()[0]),
      rw(a.asset), rw(chipStatePda(a.asset)[0]), ro(collectionMetaPda(a.collectionIdx)[0]), rw(a.coreCollection), ro(configPda()[0]),
      rw(a.cgMint), rw(ata(a.cgMint, a.owner)), ro(CHIP_CORE_ID), ro(MPL_CORE_ID), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('unstake_chip')),
  });
}

export function claimChipIx(a: { owner: PublicKey; asset: PublicKey; cgMint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.owner), rw(emissionPda()[0]), rw(chipPoolPda()[0]), rw(chipStakePda(a.asset)[0]), ro(setBonusPda(a.owner)[0]),
      ro(chipStatePda(a.asset)[0]), rw(a.cgMint), rw(ata(a.cgMint, a.owner)), ro(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_chip')),
  });
}

/** $CG Merkle claim (kinds 2..4) — mints from the emission slice. Rejects SKR / item kinds: use `claimSkrRootIx` / `claimItemRootIx`. */
export function claimRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[]; cgMint: PublicKey }): TransactionInstruction {
  if (isSkrRootKind(a.kind)) throw new Error(`kind ${a.kind} is an SKR root — use claimSkrRootIx`);
  if (isItemRootKind(a.kind)) throw new Error(`kind ${a.kind} is an item root — use claimItemRootIx`);
  const [root] = rewardRootPda(a.kind, a.epoch);
  const w = new BorshWriter().u64(a.amount);
  w.vec(a.proof, (p) => w.bytes(p));
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.wallet), rw(emissionPda()[0]), rw(root), rw(claimReceiptPda(root, a.wallet)[0]),
      rw(a.cgMint), rw(ata(a.cgMint, a.wallet)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_root', w.toBytes())),
  });
}

/** SKR Merkle claim (kinds 5..7) — transfers from the treasury-funded prize pool vault (never minted). */
export function claimSkrRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[]; skrMint: PublicKey }): TransactionInstruction {
  if (!isSkrRootKind(a.kind)) throw new Error(`kind ${a.kind} is a $CG root — use claimRootIx`);
  const [root] = rewardRootPda(a.kind, a.epoch);
  const [pool] = skrPoolPda();
  const w = new BorshWriter().u64(a.amount);
  w.vec(a.proof, (p) => w.bytes(p));
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.wallet), ro(emissionPda()[0]), rw(pool), rw(root), rw(claimReceiptPda(root, a.wallet)[0]),
      rw(ata(a.skrMint, pool)), rw(ata(a.skrMint, a.wallet)), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_skr_root', w.toBytes())),
  });
}

/**
 * Item Merkle claim (kind 8 = fusion boosters, backlog #27) — `amount` is the booster COUNT (≤ 10). The program
 * verifies the proof and CPIs chip_core `grant_booster` signed by its `["rewarder"]` PDA, so the boosters land in
 * `PlayerItems` (`["items", wallet]`, created on first claim with the wallet as payer) in this transaction.
 */
export function claimItemRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[] }): TransactionInstruction {
  if (!isItemRootKind(a.kind)) throw new Error(`kind ${a.kind} is not an item root — use claimRootIx / claimSkrRootIx`);
  if (a.amount <= 0n || a.amount > BigInt(ITEM_REWARDS.maxClaim)) throw new Error(`item claim must be 1..${ITEM_REWARDS.maxClaim} boosters`);
  const [root] = rewardRootPda(a.kind, a.epoch);
  const w = new BorshWriter().u64(a.amount);
  w.vec(a.proof, (p) => w.bytes(p));
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [
      signer(a.wallet), ro(emissionPda()[0]), rw(root), rw(claimReceiptPda(root, a.wallet)[0]),
      ro(rewarderPda()[0]), ro(configPda()[0]), rw(playerItemsPda(a.wallet)[0]), ro(CHIP_CORE_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_item_root', w.toBytes())),
  });
}

/** Route a claim leaf to the right instruction by its root kind (2..4 $CG, 5..7 SKR, 8 boosters). */
export function claimAnyRootIx(a: { wallet: PublicKey; kind: number; epoch: number; amount: bigint; proof: Uint8Array[]; cgMint?: PublicKey; skrMint?: PublicKey }): TransactionInstruction {
  if (isItemRootKind(a.kind)) return claimItemRootIx(a);
  if (isSkrRootKind(a.kind)) {
    if (!a.skrMint) throw new Error('SKR mint not configured');
    return claimSkrRootIx({ ...a, skrMint: a.skrMint });
  }
  if (!a.cgMint) throw new Error('$CG mint not configured');
  return claimRootIx({ ...a, cgMint: a.cgMint });
}

/** Treasury / anyone tops up the SKR prize pool (multisig runs this weekly from SKR revenue). */
export function fundSkrIx(a: { funder: PublicKey; amount: bigint; skrMint: PublicKey }): TransactionInstruction {
  const [pool] = skrPoolPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [signer(a.funder, false), rw(pool), rw(ata(a.skrMint, a.funder)), rw(ata(a.skrMint, pool)), ro(TOKEN_PROGRAM_ID)],
    data: Buffer.from(ixData('fund_skr', new BorshWriter().u64(a.amount).toBytes())),
  });
}

/** SEC-L5 `fund_slice(kind, amount)` — season oracle / admin burns the arena's 20 % wager rake (season pool ATA) into `slice_budget[kind]`; only kind 3 (PvpSeason) is accepted. */
export const SLICE_PVP_SEASON = 3;
export function fundSliceIx(a: { authority: PublicKey; amount: bigint; cgMint: PublicKey; kind?: number }): TransactionInstruction {
  const [auth] = seasonPoolAuthPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [signer(a.authority, false), rw(emissionPda()[0]), rw(a.cgMint), ro(auth), rw(ata(a.cgMint, auth)), ro(TOKEN_PROGRAM_ID)],
    data: Buffer.from(ixData('fund_slice', new BorshWriter().u8(a.kind ?? SLICE_PVP_SEASON).u64(a.amount).toBytes())),
  });
}

/** Early-exit penalty preview (bps of principal, burned). */
export function unstakePenalty(amount: bigint, tier: number, unlockAt: bigint, nowSec = Math.floor(Date.now() / 1000)): bigint {
  if (BigInt(nowSec) >= unlockAt) return 0n;
  return (amount * BigInt(TIER_PENALTY_BPS[tier] ?? 0)) / 10_000n;
}

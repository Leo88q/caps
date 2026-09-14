// Instruction builders for programs/arena (wagered 3v3 battles with $CG escrow).
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, optional, ro, rw, signer } from '../anchor';
import { ARENA_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../ids';
import { arenaConfigPda, ata, battlePda, chipStatePda } from '../pdas';

export const MIN_WAGER = 5_000_000n;
export const MAX_WAGER = 5_000_000_000n;
export const RAKE_BPS = 500;
export const RAKE_TREASURY_BPS = 4_000;
export const RAKE_POOL_BPS = 2_000;
export const MIN_SQUAD_POWER = 400;
export const LEAGUE_UPPER = [800, 1400, 2400, 4000, 7000, Infinity] as const;
export const LEAGUE_NAMES = ['Curb', 'Alley', 'Block', 'District', 'Skyline', 'Rooftop'] as const;
export const leagueOf = (power: number) => LEAGUE_UPPER.findIndex((u) => power < u);

export function createBattleIx(a: { challenger: PublicKey; nonce: bigint; wager: bigint; randomness: PublicKey; squad: PublicKey[]; cgMint: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  const keys = [
    signer(a.challenger), ro(arenaConfigPda()[0]), rw(battle), ro(a.randomness), ro(a.cgMint),
    rw(ata(a.cgMint, a.challenger)), rw(ata(a.cgMint, battle)),
    ro(TOKEN_PROGRAM_ID), ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
  ];
  for (const asset of a.squad) keys.push(ro(asset), ro(chipStatePda(asset)[0]));
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys,
    data: Buffer.from(ixData('create_battle', new BorshWriter().u64(a.nonce).u64(a.wager).toBytes())),
  });
}

export function acceptBattleIx(a: { opponent: PublicKey; challenger: PublicKey; nonce: bigint; squad: PublicKey[]; cgMint: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  const keys = [
    signer(a.opponent), ro(arenaConfigPda()[0]), rw(battle), rw(ata(a.cgMint, a.opponent)), rw(ata(a.cgMint, battle)), ro(TOKEN_PROGRAM_ID),
  ];
  for (const asset of a.squad) keys.push(ro(asset), ro(chipStatePda(asset)[0]));
  return new TransactionInstruction({ programId: ARENA_ID, keys, data: Buffer.from(ixData('accept_battle')) });
}

export function cancelStaleBattleIx(a: { caller: PublicKey; challenger: PublicKey; opponent?: PublicKey; nonce: bigint; cgMint: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys: [
      signer(a.caller), ro(arenaConfigPda()[0]), rw(battle), rw(ata(a.cgMint, battle)), rw(ata(a.cgMint, a.challenger)),
      optional(a.opponent ? ata(a.cgMint, a.opponent) : undefined, ARENA_ID), rw(a.challenger), ro(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('cancel_stale_battle')),
  });
}

/** Pot math shown before signing: winner gets 2×wager − 5 % rake; rake → 40 % treasury / 40 % burned / 20 % season pool. */
export function wagerSplit(wager: bigint) {
  const pot = wager * 2n;
  const rake = (pot * BigInt(RAKE_BPS)) / 10_000n;
  const treasury = (rake * BigInt(RAKE_TREASURY_BPS)) / 10_000n;
  const seasonPool = (rake * BigInt(RAKE_POOL_BPS)) / 10_000n;
  return { pot, rake, treasury, seasonPool, burn: rake - treasury - seasonPool, payout: pot - rake };
}

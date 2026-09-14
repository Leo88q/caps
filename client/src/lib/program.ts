import { AnchorProvider, Program, BN, type Idl } from '@coral-xyz/anchor';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { AnchorWallet } from '@solana/wallet-adapter-react';

// Copy the generated IDL here after `anchor build` — it lives at
// target/idl/chip_game.json in the Anchor workspace. Importing it typed
// gives you full autocomplete on ctx.accounts / ctx.args in every call below.
import idl from './chip_game.idl.json';

export const PROGRAM_ID = new PublicKey('ChpGame1111111111111111111111111111111111');

export const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export function metadataPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );
}

export function getProgram(connection: Connection, wallet: AnchorWallet) {
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  return new Program(idl as Idl, PROGRAM_ID, provider);
}

// --- PDA helpers, mirroring the seeds used in state.rs ---

export function configPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
}

export function collectionPda(symbol: string) {
  const symbolBuf = Buffer.alloc(16);
  symbolBuf.write(symbol.slice(0, 16));
  return PublicKey.findProgramAddressSync([Buffer.from('collection'), symbolBuf], PROGRAM_ID);
}

export function chipStatePda(chipMint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('chip'), chipMint.toBuffer()], PROGRAM_ID);
}

export function listingPda(chipMint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('listing'), chipMint.toBuffer()], PROGRAM_ID);
}

export function pendingPackPda(buyer: PublicKey, vrf: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pending_pack'), buyer.toBuffer(), vrf.toBuffer()],
    PROGRAM_ID,
  );
}

export function questProgressPda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('quest_progress'), owner.toBuffer()], PROGRAM_ID);
}

export const RARITY_LABELS = [
  'Common', 'Common+', 'Rare', 'Rare+', 'Epic', 'Epic+', 'Legend', 'Legend+', 'Diamond',
] as const;

export function rarityLabel(rarity: unknown): string {
  // Anchor deserializes the Rust enum as { common: {} } / { commonPlus: {} } / etc.
  const key = Object.keys(rarity as object)[0] ?? '';
  const index = ['common', 'commonPlus', 'rare', 'rarePlus', 'epic', 'epicPlus', 'legend', 'legendPlus', 'diamond']
    .indexOf(key);
  return RARITY_LABELS[index] ?? 'Unknown';
}

export function toLamports(sol: number) {
  return new BN(Math.round(sol * 1_000_000_000));
}

/**
 * open_pack, upgrade_chip, list_chip, and resolve_battle all require a
 * QuestProgress account to already exist for the acting wallet — the
 * program doesn't init-if-needed it inline (that would mean every one of
 * those instructions pays rent unpredictably). Call this once after wallet
 * connect; it's a no-op if the account is already there.
 */
export async function ensureQuestProgress(program: Program, connection: Connection, owner: PublicKey) {
  const [questProgress] = questProgressPda(owner);
  const info = await connection.getAccountInfo(questProgress);
  if (info) return questProgress;
  await program.methods
    .initQuestProgress()
    .accounts({ owner, questProgress })
    .rpc();
  return questProgress;
}

// One-time admin setup, run once per deployment (devnet or mainnet):
//   ANCHOR_WALLET=~/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npm run setup
//
// Order matters here: the $CG mint's authority has to be the config PDA
// *before* claim_rewards can ever mint into it, but the config PDA only
// gets created by initialize_config. Since PDAs are deterministic, we
// derive the address first, point the mint's authority at it, and only
// then run initialize_config — no chicken-and-egg problem.

import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair } from '@solana/web3.js';
import { createMint } from '@solana/spl-token';
import idl from '../client/src/lib/chip_game.idl.json';
import { COLLECTIONS as LORE_COLLECTIONS } from '../client/src/lib/lore';

const PROGRAM_ID = new PublicKey('ChpGame1111111111111111111111111111111111');
const PACK_PRICE_LAMPORTS = new anchor.BN(0.1 * anchor.web3.LAMPORTS_PER_SOL);
const MARKETPLACE_FEE_BPS = 250; // 2.5%
// The 10 real GUTTERCAPS districts (client/src/lib/lore.ts), not
// placeholders — this is the same catalog the marketing site's collection
// gallery renders, so on-chain collections and site lore never drift apart.
const COLLECTIONS = LORE_COLLECTIONS.map((c) => c.symbol);

function symbolBuffer(symbol: string): number[] {
  const buf = Buffer.alloc(16);
  buf.write(symbol.slice(0, 16));
  return Array.from(buf);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(idl as anchor.Idl, PROGRAM_ID, provider);
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
  console.log('Config PDA:', config.toBase58());

  console.log('Creating $CG mint with config PDA as mint authority…');
  const cgMint = await createMint(provider.connection, admin, config, null, 6);
  console.log('$CG mint:', cgMint.toBase58());

  // Treasury: use a dedicated Keypair (or your multisig) in production —
  // a plain wallet is fine for devnet testing.
  const treasury = Keypair.generate();
  console.log('Treasury (devnet placeholder):', treasury.publicKey.toBase58());

  // Battle oracle: your backend's keypair, used to sign resolve_battle
  // once it has computed a PvP fight's outcome off-chain. Keep this key
  // in your backend's secrets manager, never in client code.
  const battleOracle = Keypair.generate();
  console.log('Battle oracle (SAVE THIS SECRET KEY on your backend):', battleOracle.publicKey.toBase58());

  console.log('Calling initialize_config…');
  await program.methods
    .initializeConfig(PACK_PRICE_LAMPORTS, MARKETPLACE_FEE_BPS)
    .accounts({
      admin: admin.publicKey,
      config,
      treasury: treasury.publicKey,
      cgMint,
      battleOracle: battleOracle.publicKey,
    })
    .rpc();

  for (const symbol of COLLECTIONS) {
    const [collection] = PublicKey.findProgramAddressSync(
      [Buffer.from('collection'), Buffer.from(symbolBuffer(symbol))],
      PROGRAM_ID,
    );
    console.log(`Creating collection ${symbol} at ${collection.toBase58()}…`);
    await program.methods
      .createCollection(symbolBuffer(symbol))
      .accounts({
        config,
        admin: admin.publicKey,
        collection,
        payer: admin.publicKey,
      })
      .rpc();
  }

  console.log('\nSetup complete. Save these for the client .env:');
  console.log('  CG_MINT =', cgMint.toBase58());
  console.log('  TREASURY =', treasury.publicKey.toBase58());
  console.log('  BATTLE_ORACLE_SECRET =', JSON.stringify(Array.from(battleOracle.secretKey)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

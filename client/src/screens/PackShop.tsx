import { useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  getProgram, configPda, collectionPda, pendingPackPda, rarityLabel,
  questProgressPda, metadataPda, TOKEN_METADATA_PROGRAM_ID, chipStatePda,
} from '../lib/program';
import { createVrfAccount } from '../lib/vrf';
import { PackRevealAnimation } from './PackRevealAnimation';
import { COLLECTIONS, chipNameFor } from '../lib/lore';

export function PackShopScreen({ wallet }: { wallet: AnchorWallet }) {
  const { connection } = useConnection();
  const [status, setStatus] = useState<string>('');
  const [reveal, setReveal] = useState<{ rarity: string; name: string; image: string } | null>(null);

  async function buyAndOpen(symbol: string) {
    setStatus('Requesting randomness…');
    const program = getProgram(connection, wallet);
    const [config] = configPda();
    const [collection] = collectionPda(symbol);

    // See client/src/lib/vrf.ts — this needs a real Switchboard VRF account
    // created and funded before buy_pack can request randomness against it.
    const vrfAccounts = await createVrfAccount(connection, Keypair.generate());
    const [pendingPack] = pendingPackPda(wallet.publicKey, vrfAccounts.vrf);

    await program.methods
      .buyPack()
      .accounts({
        buyer: wallet.publicKey,
        config,
        collection,
        vrf: vrfAccounts.vrf,
        oracleQueue: vrfAccounts.oracleQueue,
        queueAuthority: vrfAccounts.queueAuthority,
        dataBuffer: vrfAccounts.dataBuffer,
        permission: vrfAccounts.permission,
        escrow: vrfAccounts.escrow,
        programState: vrfAccounts.programState,
        switchboardProgram: vrfAccounts.switchboardProgram,
        recentBlockhashes: SystemProgram.programId, // placeholder — use the real sysvar id
        pendingPack,
      })
      .rpc();

    setStatus('Waiting for the oracle…');
    // In production, poll the VRF account (or subscribe via websocket) until
    // Switchboard writes a result, then call open_pack. A few seconds' wait
    // is typical on devnet.

    const chipMint = Keypair.generate();
    const metadata = metadataPda(chipMint.publicKey)[0];

    // The real name ("Moth with a Briefcase", etc.) depends on which rarity
    // tier the VRF roll lands on INSIDE open_pack — we can't know it before
    // submitting this transaction, so it mints with a generic placeholder
    // and gets its real name pushed in a follow-up call once the
    // PackOpened event reveals the rarity. See reveal_chip_metadata's doc
    // comment in instructions/pack.rs for why that's a deliberate two-step
    // design, not a shortcut.
    let resolvedRarity = 'Common';
    const listenerId = program.addEventListener('PackOpened', (event) => {
      if (event.chipMint.equals(chipMint.publicKey)) {
        resolvedRarity = rarityLabel(event.rarity);
      }
    });

    setStatus('Opening pack…');
    await program.methods
      .openPack('Sealed Cap', 'https://your-cdn/metadata/placeholder.json')
      .accounts({
        payer: wallet.publicKey,
        pendingPack,
        vrf: vrfAccounts.vrf,
        collection,
        chipMint: chipMint.publicKey,
        buyerTokenAccountOwner: wallet.publicKey,
        metadata,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        questProgress: questProgressPda(wallet.publicKey)[0],
      })
      .signers([chipMint])
      .rpc();

    await program.removeEventListener(listenerId);

    const realName = chipNameFor(symbol, resolvedRarity);
    const chipUri = `https://your-cdn/metadata/${chipMint.publicKey.toBase58()}.json`;
    const ownerTokenAccount = getAssociatedTokenAddressSync(chipMint.publicKey, wallet.publicKey);

    setStatus('Revealing…');
    await program.methods
      .revealChipMetadata(realName, chipUri)
      .accounts({
        owner: wallet.publicKey,
        chipState: chipStatePda(chipMint.publicKey)[0],
        chipMint: chipMint.publicKey,
        ownerTokenAccount,
        collection,
        metadata,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      })
      .rpc();

    setStatus('');
    setReveal({
      rarity: resolvedRarity,
      name: realName,
      image: `https://your-cdn/art/${symbol.toLowerCase()}-${resolvedRarity.toLowerCase().replace('+', 'plus')}.png`,
    });
  }

  return (
    <div className="cg-brick-bg" style={{ padding: 16 }}>
      {COLLECTIONS.map((col) => (
        <button
          key={col.symbol}
          onClick={() => buyAndOpen(col.symbol)}
          style={{ width: '100%', padding: 14, marginBottom: 8, textAlign: 'left' }}
        >
          <strong>{col.name}</strong>
          <div style={{ fontSize: 11, color: '#888' }}>{col.district} · {col.theme}</div>
        </button>
      ))}
      {status && <p style={{ color: '#888', fontSize: 13 }}>{status}</p>}

      {reveal && (
        <PackRevealAnimation
          rarity={reveal.rarity}
          chipName={reveal.name}
          chipImageUrl={reveal.image}
          isOnChain
          onDone={() => setReveal(null)}
        />
      )}
    </div>
  );
}

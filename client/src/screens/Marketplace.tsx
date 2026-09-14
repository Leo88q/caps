import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getProgram, configPda, listingPda, toLamports } from '../lib/program';

interface ListingRow {
  publicKey: PublicKey;
  chipMint: PublicKey;
  seller: PublicKey;
  priceSol: number;
}

export function MarketplaceScreen({ wallet }: { wallet: AnchorWallet }) {
  const { connection } = useConnection();
  const [listings, setListings] = useState<ListingRow[]>([]);

  async function refresh() {
    const program = getProgram(connection, wallet);
    const all = await program.account.listing.all();
    setListings(
      all.map((a) => ({
        publicKey: a.publicKey,
        chipMint: a.account.chipMint,
        seller: a.account.seller,
        priceSol: a.account.priceLamports.toNumber() / 1_000_000_000,
      })),
    );
  }

  useEffect(() => { refresh(); }, [connection, wallet]);

  async function buy(row: ListingRow) {
    const program = getProgram(connection, wallet);
    const [config] = configPda();
    const configAccount = await program.account.gameConfig.fetch(config);
    const [listing] = listingPda(row.chipMint);

    await program.methods
      .buyChip()
      .accounts({
        buyer: wallet.publicKey,
        config,
        treasury: configAccount.treasury,
        listing,
        seller: row.seller,
        chipMint: row.chipMint,
      })
      .rpc();
    refresh();
  }

  async function listForSale(chipMint: PublicKey, priceSol: number) {
    const program = getProgram(connection, wallet);
    const [listing] = listingPda(chipMint);
    await program.methods
      .listChip(toLamports(priceSol))
      .accounts({
        seller: wallet.publicKey,
        chipMint,
        listing,
      })
      .rpc();
    refresh();
  }

  return (
    <div className="cg-brick-bg" style={{ padding: 16, minHeight: '100%' }}>
      <p style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>
        {listings.length} фишек на продаже
      </p>
      {listings.map((row) => (
        // Marketplace is the page most likely to need user trust — price
        // and the buy action live in a clean-zone block, per the design
        // doc's "clean zone" rule, even though the row itself sits on the
        // brick-textured background.
        <div
          key={row.publicKey.toBase58()}
          className="cg-clean-zone"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}
        >
          <span style={{ fontFamily: 'var(--cg-font-body)', fontSize: 13, color: '#aaa' }}>
            {row.chipMint.toBase58().slice(0, 8)}…
          </span>
          <span className="cg-accent">{row.priceSol} SOL</span>
          <button className="cg-spray-button" onClick={() => buy(row)}>Купить</button>
        </div>
      ))}
      {/* Listing your own chip for sale would normally live in the Chips
          screen next to the "Прокачать" button — listForSale is exposed
          here so the wiring is visible in one place. */}
    </div>
  );
}

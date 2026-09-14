import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { ProfileIcon } from '../lib/icons';

export function ProfileScreen({ wallet }: { wallet: AnchorWallet }) {
  const address = wallet.publicKey.toBase58();

  return (
    <div className="cg-brick-bg" style={{ padding: 16, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <ProfileIcon size={22} />
        <strong className="cg-heading" style={{ fontSize: 18 }}>Profile</strong>
      </div>

      {/* Wallet address is account identity, not a balance — but it's
          still the thing a player screenshots to prove ownership, so it
          gets the clean-zone treatment for legibility and trust. */}
      <div className="cg-clean-zone" style={{ padding: 14, marginBottom: 16, wordBreak: 'break-all' }}>
        <p style={{ fontSize: 11, color: '#888', margin: '0 0 4px' }}>Wallet address</p>
        <span>{address}</span>
      </div>

      <p style={{ fontSize: 12, color: '#666' }}>
        Collection stats, battle record, and staking history would live here
        once the indexer (mentioned throughout this project) aggregates
        on-chain events per wallet — right now those numbers aren't computed
        anywhere.
      </p>
    </div>
  );
}

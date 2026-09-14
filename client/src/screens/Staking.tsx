import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getProgram, configPda, chipStatePda, rarityLabel } from '../lib/program';

interface StakedChip {
  mint: PublicKey;
  rarity: string;
  level: number;
  staked: boolean;
}

export function StakingScreen({ wallet }: { wallet: AnchorWallet }) {
  const { connection } = useConnection();
  const [chips, setChips] = useState<StakedChip[]>([]);

  async function refresh() {
    const program = getProgram(connection, wallet);
    const all = await program.account.chipState.all();
    setChips(
      all.map((a) => ({
        mint: a.account.mint,
        rarity: rarityLabel(a.account.rarity),
        level: a.account.level,
        staked: a.account.staked,
      })),
    );
  }

  useEffect(() => { refresh(); }, [connection, wallet]);

  async function toggleStake(chip: StakedChip) {
    const program = getProgram(connection, wallet);
    const [chipState] = chipStatePda(chip.mint);
    const ownerTokenAccount = getAssociatedTokenAddressSync(chip.mint, wallet.publicKey);

    if (chip.staked) {
      await program.methods.unstakeChip().accounts({
        owner: wallet.publicKey, chipState, chipMint: chip.mint, ownerTokenAccount,
      }).rpc();
    } else {
      await program.methods.stakeChip().accounts({
        owner: wallet.publicKey, chipState, chipMint: chip.mint, ownerTokenAccount,
      }).rpc();
    }
    refresh();
  }

  async function claim(chip: StakedChip) {
    const program = getProgram(connection, wallet);
    const [config] = configPda();
    const configAccount = await program.account.gameConfig.fetch(config);
    const [chipState] = chipStatePda(chip.mint);
    const ownerCgAccount = getAssociatedTokenAddressSync(configAccount.cgMint, wallet.publicKey);

    await program.methods.claimRewards().accounts({
      owner: wallet.publicKey,
      config,
      chipState,
      chipMint: chip.mint,
      cgMint: configAccount.cgMint,
      ownerCgAccount,
    }).rpc();
  }

  return (
    <div className="cg-brick-bg" style={{ padding: 16, minHeight: '100%' }}>
      {chips.map((chip) => (
        <div key={chip.mint.toBase58()} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #333' }}>
          <span style={{ fontFamily: 'var(--cg-font-body)' }}>{chip.rarity} · ур. {chip.level}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button onClick={() => toggleStake(chip)}>{chip.staked ? 'Убрать' : 'Застейкать'}</button>
            {/* $CG payout is real value moving — clean-zone treatment even
                though it's a small inline element. */}
            {chip.staked && (
              <button className="cg-clean-zone cg-clean-pulse" onClick={() => claim(chip)} style={{ cursor: 'pointer' }}>
                Забрать <span className="cg-accent">$CG</span>
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

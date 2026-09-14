import { useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getProgram, configPda, chipStatePda, toLamports } from '../lib/program';

export function BattleScreen({ wallet }: { wallet: AnchorWallet }) {
  const { connection } = useConnection();
  const [chipMintInput, setChipMintInput] = useState('');
  const [wagerSol, setWagerSol] = useState(0.1);
  const [status, setStatus] = useState('');

  async function createBattle() {
    const program = getProgram(connection, wallet);
    const [config] = configPda();
    const chipMint = new PublicKey(chipMintInput);
    const [chipState] = chipStatePda(chipMint);
    const [battle] = PublicKey.findProgramAddressSync(
      [Buffer.from('battle'), wallet.publicKey.toBuffer(), chipMint.toBuffer()],
      program.programId,
    );

    await program.methods
      .createBattle(toLamports(wagerSol))
      .accounts({
        challenger: wallet.publicKey,
        config,
        challengerChipState: chipState,
        challengerChip: chipMint,
        battle,
      })
      .rpc();

    setStatus(`Вызов создан со ставкой ${wagerSol} SOL. Ждём соперника — battle: ${battle.toBase58().slice(0, 8)}…`);
    // In a full build this would also notify your backend matchmaker so it
    // knows to watch `battle` for an opponent joining and later call
    // resolve_battle once the off-chain fight sim has a winner.
  }

  return (
    <div style={{ padding: 16 }}>
      <p style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>
        Бой рассчитывается в бэкенде (статы фишек, RNG урона), контракт только
        держит эскроу ставок и платит победителю по подписи battle-оракула.
      </p>
      <input
        placeholder="Mint фишки для боя"
        value={chipMintInput}
        onChange={(e) => setChipMintInput(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 8 }}
      />
      <input
        type="number"
        step={0.05}
        value={wagerSol}
        onChange={(e) => setWagerSol(Number(e.target.value))}
        style={{ width: '100%', padding: 8, marginBottom: 8 }}
      />
      <button onClick={createBattle} style={{ width: '100%', padding: 12 }}>
        Создать вызов
      </button>
      {status && <p style={{ fontSize: 13, color: '#888', marginTop: 10 }}>{status}</p>}
    </div>
  );
}

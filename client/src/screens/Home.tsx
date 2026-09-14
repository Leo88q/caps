import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { getProgram } from '../lib/program';
import { QuestsIcon, LeaderboardIcon } from '../lib/icons';
// Codex uses a plain text link below, not a world-object icon of its own yet.

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL ?? 'http://localhost:8787';

interface Props {
  wallet: AnchorWallet;
  onNavigate: (tab: 'shop' | 'chips' | 'market' | 'stake' | 'quests' | 'leaderboard' | 'codex') => void;
}

interface GlobalStats {
  chipsMinted: number;
  activeWallets: number;
  chipsCurrentlyStaked: number;
}

export function HomeScreen({ wallet, onNavigate }: Props) {
  const { connection } = useConnection();
  const [chipCount, setChipCount] = useState<number | null>(null);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [statsError, setStatsError] = useState(false);

  useEffect(() => {
    const program = getProgram(connection, wallet);
    // A real implementation paginates via getProgramAccounts with a memcmp
    // filter on chip_state.mint's owning token account — left as a single
    // count query here to keep the example short. This is the wallet's own
    // count, unrelated to the game-wide stats below.
    program.account.chipState.all().then((accounts) => setChipCount(accounts.length));
  }, [connection, wallet]);

  useEffect(() => {
    fetch(`${INDEXER_URL}/stats`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setGlobalStats)
      .catch(() => setStatsError(true));
  }, []);

  return (
    <div className="cg-brick-bg" style={{ padding: 16, minHeight: '100%' }}>
      {/* Chip count isn't money, so it stays in the graffiti voice — only
          balances/prices/tx confirmations get the clean-zone treatment. */}
      <p style={{ color: '#888', fontSize: 13 }}>Фишек в коллекции</p>
      <p className="cg-heading" style={{ fontSize: 32, margin: '4px 0 20px' }}>
        {chipCount ?? '…'}
      </p>

      {/* Game-wide numbers, computed by the indexer from on-chain events —
          separate concept from the personal count above. */}
      {globalStats && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <div className="cg-clean-zone" style={{ flex: 1, padding: 10, textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{globalStats.chipsMinted}</div>
            <div style={{ fontSize: 10, color: '#888' }}>minted</div>
          </div>
          <div className="cg-clean-zone" style={{ flex: 1, padding: 10, textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{globalStats.activeWallets}</div>
            <div style={{ fontSize: 10, color: '#888' }}>wallets</div>
          </div>
          <div className="cg-clean-zone" style={{ flex: 1, padding: 10, textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{globalStats.chipsCurrentlyStaked}</div>
            <div style={{ fontSize: 10, color: '#888' }}>staked</div>
          </div>
        </div>
      )}
      {statsError && (
        <p style={{ fontSize: 11, color: '#555', marginBottom: 16 }}>
          Game-wide stats need the indexer running (see indexer/README.md).
        </p>
      )}

      <button
        className="cg-spray-button"
        onClick={() => onNavigate('shop')}
        style={{ width: '100%', fontSize: 15, marginBottom: 10 }}
      >
        Открыть пак
      </button>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button style={{ flex: 1, padding: 10 }} onClick={() => onNavigate('chips')}>Мои фишки</button>
        <button style={{ flex: 1, padding: 10 }} onClick={() => onNavigate('market')}>Маркет</button>
        <button style={{ flex: 1, padding: 10 }} onClick={() => onNavigate('stake')}>Стейкинг</button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={{ flex: 1, padding: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => onNavigate('quests')}>
          <QuestsIcon size={18} /> Квесты
        </button>
        <button style={{ flex: 1, padding: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => onNavigate('leaderboard')}>
          <LeaderboardIcon size={18} /> Топ игроков
        </button>
      </div>
      <button style={{ width: '100%', padding: 10, marginTop: 8 }} onClick={() => onNavigate('codex')}>
        The Ten Districts (lore)
      </button>
    </div>
  );
}

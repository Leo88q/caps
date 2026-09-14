import { useEffect, useState } from 'react';
import { LeaderboardIcon } from '../lib/icons';

// Real data now: fetches the indexer's /leaderboard endpoint (see
// indexer/README.md), which computes wins per wallet from stored
// BattleResolved events. Falls back to a visible "indexer unreachable"
// message rather than silently showing stale numbers if the fetch fails —
// no indexer running is a common dev-environment state, not an error to hide.

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL ?? 'http://localhost:8787';

interface Entry {
  rank: number;
  wallet: string;
  wins: number;
}

function shorten(wallet: string) {
  return wallet.length > 10 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet;
}

export function LeaderboardScreen() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${INDEXER_URL}/leaderboard?limit=20`)
      .then((r) => {
        if (!r.ok) throw new Error(`indexer responded ${r.status}`);
        return r.json();
      })
      .then((data) => setEntries(data.leaderboard))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="cg-brick-bg" style={{ padding: 16, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <LeaderboardIcon size={22} />
        <strong className="cg-heading" style={{ fontSize: 18 }}>Leaderboard</strong>
      </div>

      {error && (
        <p style={{ color: '#888', fontSize: 13 }}>
          Couldn't reach the indexer at {INDEXER_URL} ({error}). Run
          <code style={{ margin: '0 4px' }}>cd indexer && npm run dev</code>
          to see live standings.
        </p>
      )}

      {!error && entries === null && <p style={{ color: '#888' }}>Loading…</p>}

      {entries?.length === 0 && (
        <p style={{ color: '#888', fontSize: 13 }}>No battles resolved yet — standings appear once players fight.</p>
      )}

      {entries?.map((e) => (
        <div
          key={e.rank}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 12px', borderBottom: '1px solid #2a2a2a',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700,
              background: e.rank <= 3 ? 'var(--cg-acid-green)' : '#2a2a2a',
              color: e.rank <= 3 ? '#16151A' : '#888',
            }}>{e.rank}</span>
            <span style={{ fontFamily: 'var(--cg-font-mono)', fontSize: 13 }}>{shorten(e.wallet)}</span>
          </span>
          <span className="cg-clean-zone" style={{ padding: '4px 10px', fontSize: 12 }}>{e.wins} wins</span>
        </div>
      ))}
    </div>
  );
}

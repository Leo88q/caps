import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useMe, useGrid, useQuests, usePendingOps, useStreak, useSeason } from '@/api/hooks';
import { usePity } from '@/chain/hooks';
import { useActiveOps } from '@/app/store/txs';
import { PACKS } from '@guttercaps/economy';
import { fmtCg, countdown } from '@/shared/lib/format';
import { COLLECTIONS } from '@/shared/lib/lore';
import { collectionColor } from '@/shared/lib/rarity';
import { Progress, Skeleton, Stat } from '@/shared/ui/primitives';
import { SprayNozzleButton } from '@/shared/ui/buttons';
import { ShowcaseStrip } from '@/shared/ui/Showcase';
import { QuestsIcon, LeaderboardIcon, SignatureTag } from '@/shared/ui/icons';
import { useSessionStore } from '@/app/store/session';
import { useT } from '@/shared/i18n';

export default function Home() {
  const t = useT();
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const status = useSessionStore((s) => s.status);
  const me = useMe();
  const grid = useGrid();
  const quests = useQuests();
  const streak = useStreak();
  const pending = usePendingOps();
  const season = useSeason();
  const pity = usePity();
  const active = useActiveOps(publicKey?.toBase58());

  if (!connected) return <Landing onConnect={() => setVisible(true)} />;

  const owned = grid.data?.cells?.flat().filter((n) => n > 0).length ?? 0;
  const claimable = quests.data?.filter((q) => q.claimable).length ?? 0;
  const stdCounter = pity.data?.counters?.[1] ?? me.data?.pity?.counters?.[1] ?? 0;
  const stdPity = PACKS.standard.pity!;
  const localPending = active.packs.length + active.fusions.length;
  const apiPending = (pending.data?.packs?.length ?? 0) + (pending.data?.fusions?.length ?? 0);

  return (
    <div className="page page-bg page-bg-home stack">
      <div className="row between">
        <div>
          <h1 className="page-title">{t('home.greeting', { name: me.data?.handle ?? t('home.collector') })}</h1>
          <p className="page-sub">{status === 'authenticated' ? t('common.signedIn') : t('common.signingIn')} · {season.data ? t('home.inSeason', { id: season.data.id }) : t('home.loadingCity')}</p>
        </div>
        <SignatureTag size={44} />
      </div>

      {(localPending > 0 || apiPending > 0) && (
        <div className="warn row between">
          <span>You have {Math.max(localPending, apiPending)} unfinished operation(s).</span>
          {active.packs[0] ? <Link className="btn btn-sm" to={`/shop/opening/${active.packs[0].nonce}`}>Continue</Link> : <Link className="btn btn-sm" to="/fusion">Open bench</Link>}
        </div>
      )}

      <div className="grid-3">
        <div className="card"><Stat label="caps in the grid" value={grid.isLoading ? <Skeleton h={22} w={48} /> : `${owned}/72`} /></div>
        <div className="card"><Stat label="completed districts" value={grid.data?.completedSets ?? me.data?.completedSets ?? 0} /></div>
        <div className="card"><Stat label="quests to claim" value={claimable} /></div>
      </div>

      <div className="card stack-sm">
        <div className="row between">
          <span className="strong">Standard-pack pity</span>
          <span className="mono small">{stdCounter}/{stdPity.hardAt}</span>
        </div>
        <Progress value={stdCounter} max={stdPity.hardAt} tone={stdCounter >= stdPity.softStart ? 'orange' : undefined} />
        <div className="tiny muted">Legend guaranteed within {Math.max(0, stdPity.hardAt - stdCounter)} more Standard packs · soft pity from {stdPity.softStart}</div>
      </div>

      <Link to="/shop" style={{ textDecoration: 'none' }}>
        <SprayNozzleButton style={{ width: '100%', fontSize: 16 }}>Open a pack</SprayNozzleButton>
      </Link>

      <div className="grid-2">
        <Link to="/quests" className="card card-hover row" style={{ textDecoration: 'none' }}>
          <QuestsIcon size={28} />
          <div className="grow">
            <div className="strong">Daily quests</div>
            <div className="tiny muted">Streak {streak.data?.days ?? 0}/7 · resets in {streak.data ? countdown(streak.data.resetsAt!) : '—'}</div>
          </div>
          {claimable > 0 && <span className="pill pill-ok">{claimable}</span>}
        </Link>
        <Link to="/leaderboard" className="card card-hover row" style={{ textDecoration: 'none' }}>
          <LeaderboardIcon size={28} />
          <div className="grow">
            <div className="strong">Season {season.data?.id ?? '—'}</div>
            <div className="tiny muted">Pool {season.data ? fmtCg(season.data.poolCgMicro, 0) : '—'} · ends in {season.data ? countdown(season.data.endsAt!) : '—'}</div>
          </div>
        </Link>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 10 }}>
          <span className="strong">Districts</span>
          <Link to="/codex" className="small" style={{ color: 'var(--cg-neon-cyan)' }}>Read the lore →</Link>
        </div>
        <div className="tabs">
          {COLLECTIONS.map((c, i) => {
            const have = grid.data?.cells?.[i]?.filter((n) => n > 0).length ?? 0;
            return (
              <Link key={c.symbol} to={`/collection?c=${i}`} className="pill" style={{ borderColor: collectionColor(i), textDecoration: 'none' }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: collectionColor(i) }} />{c.name} <span className="mono muted">{have}/9</span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Landing({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="page page-bg page-bg-home stack" style={{ minHeight: '80vh', justifyContent: 'center', textAlign: 'center' }}>
      <SignatureTag size={72} opacity={0.8} />
      <h1 className="page-title" style={{ fontSize: 40, margin: 0 }}>GUTTERCAPS</h1>
      <ShowcaseStrip items={[[0, 8], [1, 6], [3, 7], [5, 8], [6, 6]]} size={76} />
      <p className="muted" style={{ maxWidth: 480, margin: '0 auto' }}>
        72 charged caps from the storm drains of Gutter City. 8 districts × 9 tiers. Every cap is a Metaplex Core NFT in <em>your</em> wallet;
        every pack is rolled from Switchboard randomness you can verify yourself.
      </p>
      <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
        <SprayNozzleButton onClick={onConnect}>Connect wallet</SprayNozzleButton>
        <Link to="/market" className="btn">Browse the market</Link>
      </div>
      <div className="grid-3" style={{ maxWidth: 720, margin: '24px auto 0', textAlign: 'left' }}>
        <div className="card"><div className="strong">Collect</div><div className="small muted">Fill the 8×9 grid. Complete a district for a permanent staking boost.</div></div>
        <div className="card"><div className="strong">Fuse</div><div className="small muted">3 → 1, up the ladder. Atomic burn+mint on-chain, fee burned forever.</div></div>
        <div className="card"><div className="strong">Slam</div><div className="small muted">3v3 Cap Slam. Ranked seasons, optional $CG wagers in escrow.</div></div>
      </div>
      <p className="tiny muted">Wallets: Phantom · Solflare · Backpack · Mobile Wallet Adapter</p>
    </div>
  );
}

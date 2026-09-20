// /arena/match/:id — round-by-round replay with the fairness data exposed.
import { Link, useParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMatch } from '@/api/hooks';
import { ChipArt } from '@/shared/ui/ChipArt';
import { Skeleton } from '@/shared/ui/primitives';
import { chipName, chipPower, ELEMENT_ICON, ELEMENT_OF_COLLECTION, rarityColor, chipImageOf } from '@/shared/lib/rarity';
import { fmtCg, shortKey } from '@/shared/lib/format';
import { EXPLORER } from '@/app/config';
import { useT } from '@/shared/i18n';

export default function MatchReplay() {
  const t = useT();
  const { id = '' } = useParams();
  const m = useMatch(id);
  const { publicKey } = useWallet();
  if (m.isLoading) return <div className="page page-bg page-bg-arena stack"><Skeleton h={200} /><Skeleton h={200} /></div>;
  const d = m.data;
  if (!d) return <div className="page page-bg page-bg-arena"><div className="empty">Match not found.</div></div>;
  const me = publicKey?.toBase58();
  const iAmA = me === d.a;
  const won = d.winner === me;

  return (
    <div className="page page-bg page-bg-arena stack">
      <div className="row between">
        <div>
          <h1 className="page-title">{t('arena.replay')}</h1>
          <p className="page-sub">Season {d.season} · {d.status === 'revealing' ? 'in progress' : d.status === 'cancelled' ? 'cancelled (nobody revealed)' : won ? 'you won' : me && (me === d.a || me === d.b) ? 'you lost' : `${shortKey(d.winner)} won`}{d.wagerCgMicro && d.wagerCgMicro !== '0' ? ` · wager ${fmtCg(d.wagerCgMicro)}` : ''}{me === d.a && d.rewardA && d.rewardA !== '0' ? ` · +${fmtCg(d.rewardA, 1)}` : me === d.b && d.rewardB && d.rewardB !== '0' ? ` · +${fmtCg(d.rewardB, 1)}` : ''}</p>
        </div>
        <Link to="/arena" className="btn btn-sm">Back</Link>
      </div>

      <div className="round" style={{ alignItems: 'start' }}>
        <div className="stack-sm">
          <div className="small strong">{iAmA ? 'You' : shortKey(d.a)}</div>
          <div className="squad">{d.squadA?.map((c) => <div key={c.asset}><ChipArt collection={c.collection!} rarity={c.rarity!} level={c.level} imageUrl={chipImageOf(c)} /></div>)}</div>
        </div>
        <div className="vs">VS</div>
        <div className="stack-sm">
          <div className="small strong">{!iAmA && me === d.b ? 'You' : d.b?.startsWith('bot:') ? 'Bot' : shortKey(d.b)}</div>
          <div className="squad">{d.squadB?.map((c) => <div key={c.asset}><ChipArt collection={c.collection!} rarity={c.rarity!} level={c.level} imageUrl={chipImageOf(c)} /></div>)}</div>
        </div>
      </div>

      <div className="card stack-sm">
        {(d.rounds ?? []).map((r, i) => {
          const a = d.squadA?.find((c) => c.asset === r.attacker) ?? d.squadA?.[i];
          const b = d.squadB?.find((c) => c.asset === r.defender) ?? d.squadB?.[i];
          if (!a || !b) return null;
          const pa = chipPower(a.rarity!, a.level!) * (1 + (r.elementEdge ?? 0)) * (r.luckA ?? 1);
          const pb = chipPower(b.rarity!, b.level!) * (r.luckB ?? 1);
          const aWins = r.winner === d.a;
          return (
            <div key={i} className="round small" style={{ padding: '8px 0', borderBottom: '1px solid var(--gc-line)' }}>
              <div className="row">
                <span style={{ width: 54 }}><ChipArt collection={a.collection!} rarity={a.rarity!} imageUrl={chipImageOf(a)} /></span>
                <div><div style={{ color: rarityColor(a.rarity!) }}>{chipName(a.collection!, a.rarity!)}</div><div className="tiny muted mono">{chipPower(a.rarity!, a.level!)} × edge {(1 + (r.elementEdge ?? 0)).toFixed(2)} × luck {(r.luckA ?? 1).toFixed(2)} = {pa.toFixed(0)}</div></div>
              </div>
              <div className="center"><div className="tiny muted">R{i + 1}</div><div style={{ color: aWins ? 'var(--cg-acid-green)' : 'var(--cg-neon-magenta)' }}>{aWins ? '◀' : '▶'}</div></div>
              <div className="row" style={{ justifyContent: 'flex-end', textAlign: 'right' }}>
                <div><div style={{ color: rarityColor(b.rarity!) }}>{chipName(b.collection!, b.rarity!)} {ELEMENT_ICON[ELEMENT_OF_COLLECTION[b.collection!]]}</div><div className="tiny muted mono">{chipPower(b.rarity!, b.level!)} × luck {(r.luckB ?? 1).toFixed(2)} = {pb.toFixed(0)}</div></div>
                <span style={{ width: 54 }}><ChipArt collection={b.collection!} rarity={b.rarity!} imageUrl={chipImageOf(b)} /></span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card stack-sm">
        <div className="strong">Fairness</div>
        <div className="tiny mono verify-hex muted">
          commitA {d.commitA}<br />commitB {d.commitB}<br />nonceA {d.nonceA} · nonceB {d.nonceB}<br />seed {d.seed}
        </div>
        <div className="tiny muted">{d.seedFormula ?? 'seed = sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret)'}. {d.serverSecret ? <>Season secret <span className="mono">{d.serverSecret.slice(0, 16)}…</span> is published — re-run the fight with @guttercaps/economy <code>resolveFight</code>.</> : <>Verify once the season secret is published (hash <span className="mono">{d.serverSecretHash?.slice(0, 16) ?? '—'}…</span>).</>} {d.resolveSignature && <a href={EXPLORER.tx(d.resolveSignature)} target="_blank" rel="noreferrer">on-chain settlement ↗</a>}</div>
        {d.status === 'revealing' && <div className="small" style={{ color: 'var(--cg-electric-orange)' }}>Waiting for both seeds to be revealed — rounds appear as soon as the match resolves.</div>}
        {d.forfeit && <div className="small muted">Decided by forfeit — the other side never revealed its seed. No rewards were paid.</div>}
        {d.bot && <div className="small muted">Bot fill after {45}s in queue — participation reward only.</div>}
      </div>
    </div>
  );
}

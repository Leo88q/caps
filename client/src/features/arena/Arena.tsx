// Cap Slam arena: squad builder (power, elements, synergy), ranked queue,
// optional wager with on-chain escrow, season + rating overview.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { MATCH_REWARDS, MATCHMAKING, SEASON } from '@guttercaps/economy';
import { useArenaMe, useMyChips, useSeason, useQueueArena, useLeaveQueue, useRevealNonce, type Chip } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { prepareRandomness } from '@/chain/switchboard';
import { createBattleIx, wagerSplit, MIN_WAGER, MAX_WAGER, MIN_SQUAD_POWER, leagueOf, LEAGUE_NAMES } from '@/chain/ix/arena';
import { RNG_KIND, freshNonce } from '@/chain/pdas';
import { ChipArt } from '@/shared/ui/ChipArt';
import { CleanZone, KV, Modal, Pill, Stat, Skeleton } from '@/shared/ui/primitives';
import { SprayNozzleButton, CleanConfirmButton } from '@/shared/ui/buttons';
import { chipPower, squadPower, squadSynergy, ELEMENT_OF_COLLECTION, ELEMENT_ICON, rarityColor, rarityName, chipName, chipImageOf } from '@/shared/lib/rarity';
import { fmtCg, countdown, parseUnits, shortKey } from '@/shared/lib/format';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { EXPLORER } from '@/app/config';
import { useT } from '@/shared/i18n';

export default function Arena() {
  const t = useT();
  const { connected } = useWallet();
  const me = useArenaMe();
  const season = useSeason();
  const chips = useMyChips({});
  const cfg = useGameConfig();
  const wallet = useWalletLike();
  const { connection } = useConnection();
  const toast = useUiStore((s) => s.toast);
  const queue = useQueueArena();
  const leave = useLeaveQueue();
  const revealNonce = useRevealNonce();
  const [squad, setSquad] = useState<Chip[]>([]);
  const [pick, setPick] = useState(false);
  const [wager, setWager] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ ticket: string; wait: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastMatch, setLastMatch] = useState<{ id: string; won: boolean | null } | null>(null);
  const revealing = useRef<string | null>(null);

  // commit–reveal, second half: as soon as the server paired us, reveal the nonce we committed to.
  // The nonce lives in sessionStorage so a page reload between queue and pairing still resolves.
  const cm = me.data?.currentMatch;
  const current = cm?.id ? { id: cm.id, opponent: cm.opponent ?? '', iRevealed: !!cm.iRevealed, revealDeadline: cm.revealDeadline ?? new Date().toISOString() } : null;
  const currentId = current?.id, currentRevealed = current?.iRevealed, currentOpponent = current?.opponent ?? '';
  useEffect(() => {
    if (!currentId || currentRevealed || revealing.current === currentId) return;
    const nonce = sessionStorage.getItem('gc.arena.nonce');
    if (!nonce) return;
    revealing.current = currentId;
    setQueued(null);
    revealNonce.mutateAsync({ id: currentId, nonce })
      .then((r) => {
        if (r?.resolved) { const won = r.winner === wallet?.publicKey.toBase58(); setLastMatch({ id: currentId, won }); toast({ kind: won ? 'money' : 'info', title: won ? t('arena.youWon') : t('arena.youLost'), body: `vs ${currentOpponent.startsWith('bot:') ? 'bot' : currentOpponent.slice(0, 6)}` }); }
        else toast({ kind: 'info', title: 'Seed revealed', body: 'Waiting for the opponent to reveal…' });
      })
      .catch((e) => { revealing.current = null; toast({ kind: 'error', title: 'Reveal failed', body: String((e as Error)?.message ?? e) }); });
  }, [currentId, currentRevealed, currentOpponent, revealNonce, toast, wallet, t]);
  // the opponent revealed after us → the match resolved server-side; surface the result once
  useEffect(() => {
    const r = me.data?.recent?.[0];
    if (!r || !revealing.current || r.id !== revealing.current || lastMatch?.id === r.id) return;
    setLastMatch({ id: r.id, won: r.won ?? null });
    revealing.current = null;
  }, [me.data, lastMatch]);
  // server-side state wins over local memory (reload, second tab, ticket expiry)
  useEffect(() => { if (me.data && !me.data.queue && !me.data.currentMatch && queued) setQueued(null); }, [me.data, queued]);

  const all = useMemo(() => (chips.data?.pages.flatMap((p) => p.items ?? []) ?? []).filter((c) => !c.flags?.listed && !c.flags?.fusing), [chips.data]);
  const power = squadPower(squad.map((c) => ({ rarity: c.rarity!, level: c.level! })));
  const synergy = squadSynergy(squad.map((c) => ({ collection: c.collection! })));
  const league = leagueOf(power);
  const ready = squad.length === 3 && power >= MIN_SQUAD_POWER;

  async function joinRanked() {
    if (!ready) return;
    setBusy(true);
    try {
      // commit-reveal for the server-authoritative match: commit = sha256(nonce)
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const nonceHex = Array.from(nonce, (b) => b.toString(16).padStart(2, '0')).join('');
      const commit = Array.from(sha256(nonce), (b) => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('gc.arena.nonce', nonceHex);
      const r = await queue.mutateAsync({ squad: squad.map((c) => c.asset!), commit });
      setLastMatch(null);
      revealing.current = null;
      setQueued({ ticket: r.ticket!, wait: r.estimatedWaitSec ?? 30 });
      toast({ kind: 'info', title: r.matchId ? 'Opponent found' : 'In queue', body: r.matchId ? 'Revealing your seed…' : `League ${LEAGUE_NAMES[r.league ?? league]} · ~${r.estimatedWaitSec ?? 30}s` });
    } catch (e) {
      toast({ kind: 'error', title: 'Queue failed', body: String((e as Error)?.message ?? e) });
    } finally { setBusy(false); }
  }

  async function createWager(amountMicro: bigint) {
    if (isMock()) { toast({ kind: 'money', title: 'Wager battle created (mock)', body: `${fmtCg(amountMicro)} escrowed` }); setWager(null); return; }
    if (!wallet || !cfg.data) return;
    setBusy(true);
    try {
      const nonce = freshNonce();
      // arena-owned randomness PDA ["rng", 2, challenger, nonce]: init here, commit inside create_battle (SEC-C3 part 2)
      const rnd = await prepareRandomness(connection, wallet.publicKey, RNG_KIND.BATTLE, nonce);
      const ix = createBattleIx({ challenger: wallet.publicKey, nonce, wager: amountMicro, randomness: rnd.randomness, queue: rnd.queue, oracle: rnd.oracle, squad: squad.map((c) => new PublicKey(c.asset!)), cgMint: cfg.data.cgMint });
      const { signature } = await sendTx(connection, wallet, [...rnd.ixs, ix], { cuLimit: 400_000 });
      toast({ kind: 'money', title: 'Wager battle open', body: `${fmtCg(amountMicro)} in escrow · waiting for an opponent in your league`, href: EXPLORER.tx(signature) });
      setWager(null);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not create battle', body: String((e as Error)?.message ?? e) });
    } finally { setBusy(false); }
  }

  return (
    <div
      className="page stack"
      style={{
        minHeight: '100%',
        // backdrop: magenta-vs-cyan arena floor (client/public/bg/), veiled for contrast.
        // `contain` shows the whole picture instead of cover-cropping it.
        backgroundImage:
          'linear-gradient(rgba(13,12,16,0.60), rgba(13,12,16,0.60)), url(/bg/game-arena.webp)',
        backgroundSize: 'contain',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'top center',
      }}
    >
      <div className="row between">
        <div>
          <h1 className="page-title">{t('arena.title')}</h1>
          <p className="page-sub">{t('arena.subtitle')}</p>
        </div>
        <Link to="/leaderboard/rating" className="btn btn-sm">Ranks</Link>
      </div>

      {connected && (
        <div className="grid-3">
          <div className="card"><Stat label={`rating · ${me.data ? LEAGUE_NAMES[me.data.league ?? 0] : ''}`} value={me.isLoading ? <Skeleton h={22} w={60} /> : Math.round(me.data?.rating ?? MATCHMAKING.startRating)} /></div>
          <div className="card"><Stat label="wins / games" value={`${me.data?.wins ?? 0} / ${me.data?.games ?? 0}`} /></div>
          <div className="card"><Stat label="rewarded left today" value={`${me.data?.rewardedMatchesLeft ?? MATCH_REWARDS.dailyRewardedMatches}/${MATCH_REWARDS.dailyRewardedMatches}`} /></div>
        </div>
      )}

      <div className="card stack">
        <div className="row between"><span className="strong">Your squad</span><span className="muted small">min power {MIN_SQUAD_POWER}</span></div>
        <div className="squad">
          {[0, 1, 2].map((i) => {
            const c = squad[i];
            return (
              <div key={i} className="stack-sm center" onClick={() => setPick(true)} style={{ cursor: 'pointer' }}>
                {c ? <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c)} /> : <div className="slot" style={{ aspectRatio: 1, borderRadius: '50%', border: '2px dashed var(--gc-line-strong)', display: 'grid', placeItems: 'center' }}>+</div>}
                <div className="tiny">{c ? <>{ELEMENT_ICON[ELEMENT_OF_COLLECTION[c.collection!]]} {chipPower(c.rarity!, c.level!)} pw</> : 'pick'}</div>
              </div>
            );
          })}
        </div>
        <div className="row-wrap between">
          <div className="row" style={{ gap: 14 }}>
            <Stat label="squad power" value={power} />
            <Stat label="synergy" value={`×${synergy.toFixed(2)}`} />
            <Stat label="league" value={LEAGUE_NAMES[league]} mono={false} />
          </div>
          {squad.length > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setSquad([])}>clear</button>}
        </div>
        <div className="tiny muted">{t('arena.ring')}</div>

        {current ? (
          <div className="warn row between">
            <span>{current.iRevealed ? `Seed revealed · waiting for ${current.opponent.startsWith('bot:') ? 'the bot' : shortKey(current.opponent)} to reveal (forfeit in ${countdown(current.revealDeadline)})` : 'Opponent found · revealing your seed…'}</span>
            <Link to={`/arena/match/${current.id}`} className="btn btn-sm">Open</Link>
          </div>
        ) : queued || me.data?.queue ? (
          <div className="warn row between">
            <span>Searching in {LEAGUE_NAMES[me.data?.queue?.league ?? league]}… ticket {(queued?.ticket ?? me.data?.queue?.ticket ?? '').slice(0, 6)} · bot fills after {MATCHMAKING.botFillAfterSec}s</span>
            <button className="btn btn-sm" onClick={async () => { await leave.mutateAsync(); setQueued(null); void me.refetch(); }}>Leave</button>
          </div>
        ) : (
          <div className="grid-2">
            <SprayNozzleButton disabled={!ready || busy || !connected} onClick={joinRanked}>Ranked match</SprayNozzleButton>
            <button className="btn" disabled={!ready || busy || !connected} onClick={() => setWager('')}>Wager battle ($CG)</button>
          </div>
        )}
        {!connected && <div className="muted small">Connect a wallet to play.</div>}
        {lastMatch && (
          <div className="row between small" style={{ color: lastMatch.won ? 'var(--cg-acid-green)' : 'var(--cg-neon-magenta)' }}>
            <span>{lastMatch.won === null ? 'Match finished' : lastMatch.won ? t('arena.youWon') : t('arena.youLost')}</span>
            <Link to={`/arena/match/${lastMatch.id}`} className="btn btn-sm">{t('arena.replay')}</Link>
          </div>
        )}
      </div>

      {(me.data?.recent?.length ?? 0) > 0 && (
        <div className="card stack-sm">
          <div className="strong">Recent matches</div>
          {me.data!.recent!.slice(0, 5).map((r) => (
            <Link key={r.id} to={`/arena/match/${r.id}`} className="row between small" style={{ textDecoration: 'none' }}>
              <span>{r.won ? '◀ win' : '▶ loss'}{r.forfeit ? ' (forfeit)' : ''} vs {r.opponent!.startsWith('bot:') ? 'bot' : shortKey(r.opponent)}</span>
              <span className="mono muted">{r.reward && r.reward !== '0' ? `+${fmtCg(r.reward, 1)}` : '—'}</span>
            </Link>
          ))}
          {me.data?.pendingRewardMicro && me.data.pendingRewardMicro !== '0' && <div className="tiny muted">{fmtCg(me.data.pendingRewardMicro, 1)} in match rewards waiting for the next reward root (claim on the Quests page).</div>}
        </div>
      )}

      <div className="card stack-sm">
        <div className="row between">
          <span className="strong">Season {season.data?.id ?? '—'}</span>
          <span className="muted small">ends in {season.data ? countdown(season.data.endsAt!) : '—'}</span>
        </div>
        <div className="small">Pool <b className="mono">{season.data ? fmtCg(season.data.poolCgMicro, 0) : '—'}</b> · {SEASON.weeks} weeks · reward caps by league: {SEASON.chipRewardByLeague.join(' / ')} (soulbound {SEASON.soulboundDays}d)</div>
        <div className="tag-list">{(season.data?.brackets ?? SEASON.payoutBrackets).map((b) => <span key={b.topPct} className="pill">top {b.topPct}% → {b.sharePct}%</span>)}</div>
        {me.data?.seasonRank && <div className="small">Your rank <b className="mono">#{me.data.seasonRank}</b> · projected {me.data.projectedBracket}</div>}
        <div className="tiny muted">Fairness: seed = sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret); the server secret hash is published at season start and the secret at season end.{season.data?.serverSecretHash ? <> Hash <span className="mono">{season.data.serverSecretHash.slice(0, 16)}…</span></> : null}</div>
      </div>

      <Modal open={pick} onClose={() => setPick(false)} title="Pick your squad (3)" wide>
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(144px, 47%), 1fr))' }}>
          {all.map((c) => {
            const sel = squad.some((s) => s.asset === c.asset);
            return (
              <div key={c.asset} className="chip-card" onClick={() => setSquad((s) => (sel ? s.filter((x) => x.asset !== c.asset) : s.length < 3 ? [...s, c] : s))}>
                <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c)} selected={sel} dim={!sel && squad.length >= 3} />
                <div className="chip-meta"><span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span> · {chipPower(c.rarity!, c.level!)} pw</div>
                <div className="tiny muted">{chipName(c.collection!, c.rarity!)}</div>
              </div>
            );
          })}
        </div>
        <button className="btn btn-block" style={{ marginTop: 12 }} onClick={() => setPick(false)}>Done ({squad.length}/3)</button>
      </Modal>

      <Modal open={wager !== null} onClose={() => setWager(null)} title="Wager battle">
        <div className="stack">
          <div className="small muted">{t('arena.escrowNote')}</div>
          <div className="small muted">{t('arena.squadLocked')}</div>
          <div className="tag-list">{[5, 25, 100, 500].map((v) => <Pill key={v} active={wager === String(v)} onClick={() => setWager(String(v))}>{v} $CG</Pill>)}</div>
          <CleanZone>
            <input className="input mono" inputMode="decimal" placeholder="5 – 5000" value={wager ?? ''} onChange={(e) => setWager(e.target.value)} />
            {(() => { const a = parseUnits(wager ?? '', 6); if (!a) return null; const s = wagerSplit(a); return <>
              <KV k="Your stake (escrowed)" v={fmtCg(a)} />
              <KV k="Pot" v={fmtCg(s.pot)} />
              <KV k={t('arena.rake')} v={`− ${fmtCg(s.rake)}`} />
              <KV k="Winner receives" v={fmtCg(s.payout)} total accent />
            </>; })()}
          </CleanZone>
          <CleanConfirmButton disabled={busy || !parseUnits(wager ?? '', 6) || parseUnits(wager ?? '', 6)! < MIN_WAGER || parseUnits(wager ?? '', 6)! > MAX_WAGER} onClick={() => createWager(parseUnits(wager ?? '', 6)!)}>Escrow & open battle</CleanConfirmButton>
          <div className="tiny muted">If nobody accepts within ~2 min the escrow can be cancelled and returned in full.</div>
        </div>
      </Modal>
    </div>
  );
}

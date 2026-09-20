// $CG staking (4 lock tiers) + chip staking + set bonus + claims. Money UI → clean zone.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { LOCK_TIERS, fullSetBonusMult, impliedApy } from '@guttercaps/economy';
import { useStakingOverview, useStakingMe, useMyChips, type Chip } from '@/api/hooks';
import { useGameConfig, useStakingChain, useWalletLike, useBalances } from '@/chain/hooks';
import { pendingReward } from '@/chain/accounts';
import { sendTx } from '@/chain/tx';
import { fetchCoreCollections } from '@/chain/flows/packFlow';
import { stakeCgIx, unstakeCgIx, stakeChipIx, unstakeChipIx, claimChipIx, unstakePenalty, TIER_NAMES, MIN_STAKE_MICRO } from '@/chain/ix/staking';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { CleanZone, KV, Modal, Pill, Stat, Skeleton, Empty } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { ChipArt } from '@/shared/ui/ChipArt';
import { fmtCg, fmtUnits, parseUnits, countdown } from '@/shared/lib/format';
import { chipName, rarityColor, rarityName, chipImageOf } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { EXPLORER, MINTS } from '@/app/config';
import { useT } from '@/shared/i18n';

const TIER_IDS = ['flex', 'd30', 'd90', 'd180'] as const;

export default function Staking() {
  const t = useT();
  const overview = useStakingOverview();
  const meApi = useStakingMe();
  const chips = useMyChips({});
  const cfg = useGameConfig();
  const [emission, pools, tstakes, setBonus] = useStakingChain();
  const wallet = useWalletLike();
  const { connection } = useConnection();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const cgMint = cfg.data?.cgMint ?? MINTS.cg;
  const bal = useBalances(cgMint, undefined);

  const [tier, setTier] = useState(1);
  const [amount, setAmount] = useState('');
  const [unstake, setUnstake] = useState<{ tier: number } | null>(null);
  const [unAmount, setUnAmount] = useState('');
  const [pickChip, setPickChip] = useState(false);
  const [busy, setBusy] = useState(false);

  const all = useMemo(() => chips.data?.pages.flatMap((p) => p.items ?? []) ?? [], [chips.data]);
  const staked = all.filter((c) => c.flags?.staked);
  const stakeable = all.filter((c) => !c.flags?.staked && !c.flags?.listed && !c.flags?.fusing && !c.lockUntil);
  const amt = parseUnits(amount, 6);
  const budgetToday = overview.data?.tokenPool?.budgetTodayMicro ? Number(overview.data.tokenPool.budgetTodayMicro) / 1e6 : 0;
  const totalWeight = overview.data?.tokenPool?.totalWeight ? Number(overview.data.tokenPool.totalWeight) / 1e6 : 1;
  const apy = amt && amt > 0n ? impliedApy(Number(amt) / 1e6, TIER_IDS[tier], totalWeight, budgetToday) : overview.data?.tokenPool?.apyByTier?.[tier] ?? 0;
  const sets = setBonus.data?.completedSets ?? meApi.data?.setBonus?.onChainSets ?? 0;
  const setMult = fullSetBonusMult(sets);

  async function run(kind: string, build: () => Promise<import('@solana/web3.js').TransactionInstruction[]>) {
    if (isMock()) { toast({ kind: 'money', title: `${kind} (mock)`, body: 'Transaction simulated' }); return; }
    if (!wallet || !cgMint) { toast({ kind: 'error', title: '$CG mint not configured' }); return; }
    setBusy(true);
    try {
      const { signature } = await sendTx(connection, wallet, await build(), { cuLimit: 250_000 });
      toast({ kind: 'money', title: `${kind} confirmed`, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['staking'] });
      void qc.invalidateQueries({ queryKey: ['chain'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast({ kind: 'error', title: `${kind} failed`, body: String((e as Error)?.message ?? e) });
    } finally { setBusy(false); }
  }
  const ata = () => createAtaIdempotentIx(wallet!.publicKey, wallet!.publicKey, cgMint!);

  // on-chain token stakes (preferred) with API fallback
  const positions = [0, 1, 2, 3].map((t) => {
    const s = tstakes.data?.[t];
    const pool = pools.data?.token;
    if (s && s.amount > 0n) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const acc = pool ? pool.accRewardPerWeight + (pool.lastUpdate < now && pool.totalWeight > 0n ? (BigInt(Math.min(Number(now - pool.lastUpdate), 86_400)) * pool.budgetPerSec * 1_000_000_000_000n) / pool.totalWeight : 0n) : 0n;
      return { tier: t, amount: s.amount, pending: pendingReward(s.weight, acc, s.rewardDebt), unlockAt: Number(s.unlockAt) * 1000 };
    }
    const a = meApi.data?.tokenStakes?.find((x) => x.tier === t);
    return a ? { tier: t, amount: BigInt(a.amount!), pending: BigInt(a.pending ?? '0'), unlockAt: new Date(a.unlockAt!).getTime() } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <div className="page page-bg page-bg-staking stack">
      <div>
        <h1 className="page-title">{t('staking.title')}</h1>
        <p className="page-sub">{t('staking.subtitle')}</p>
      </div>

      <div className="grid-3">
        <div className="card"><Stat label="day / year" value={overview.isLoading ? <Skeleton h={22} w={60} /> : `${emission.data?.dayIndex ?? overview.data?.emission?.dayIndex ?? 0} / Y${(overview.data?.emission?.year ?? 0) + 1}`} /></div>
        <div className="card"><Stat label="today's budget (guarded)" value={overview.data ? fmtCg(overview.data.emission?.guardedMicro, 0) : '—'} /></div>
        <div className="card"><Stat label="7d avg burn" value={overview.data ? fmtCg(overview.data.emission?.burn7dAvgMicro, 0) : '—'} /></div>
      </div>

      {/* ---------- $CG ---------- */}
      <div className="card stack">
        <div className="row between"><span className="strong">Stake $CG</span><span className="muted small">balance {fmtUnits(bal.data?.cg ?? 0n, 6, 0)} $CG</span></div>
        <div className="tag-list">
          {TIER_IDS.map((id, i) => <Pill key={id} active={tier === i} onClick={() => setTier(i)}>{TIER_NAMES[i]} · ×{LOCK_TIERS[id].boost}</Pill>)}
        </div>
        <CleanZone>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono" inputMode="decimal" placeholder="min 10" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="btn btn-sm" onClick={() => setAmount(fmtUnits(bal.data?.cg ?? 0n, 6, 6).replace(/,/g, ''))}>max</button>
          </div>
          <KV k="Weight boost" v={`×${LOCK_TIERS[TIER_IDS[tier]].boost}`} />
          <KV k="Lock" v={LOCK_TIERS[TIER_IDS[tier]].lockSeconds === 0 ? 'none (flex)' : `${LOCK_TIERS[TIER_IDS[tier]].lockSeconds / 86_400} days`} />
          <KV k="Early exit penalty (burned)" v={`${LOCK_TIERS[TIER_IDS[tier]].earlyExitPenaltyBps / 100}%`} />
          <KV k="Indicative APY at current pool" v={`${apy.toFixed(1)}%`} accent />
          {amt !== null && amt > 0n && <KV k="≈ per day" v={fmtCg(BigInt(Math.round((Number(amt) * apy) / 100 / 365)))} />}
        </CleanZone>
        {tier > 0 && positions.some((p) => p.tier === tier) && <div className="warn">Topping up a locked tier re-locks the whole position for the full period.</div>}
        <CleanConfirmButton disabled={busy || !amt || amt < MIN_STAKE_MICRO} onClick={() => run('Stake', async () => [ata(), stakeCgIx({ owner: wallet!.publicKey, tier, amount: amt!, cgMint: cgMint! })])}>Stake {TIER_NAMES[tier]}</CleanConfirmButton>

        {positions.length > 0 && (
          <div className="stack-sm">
            <span className="label">Your positions</span>
            {positions.map((p) => (
              <CleanZone key={p.tier} className="row between" style={{ padding: '8px 12px' }}>
                <div>
                  <div><b>{fmtCg(p.amount, 0)}</b> · {TIER_NAMES[p.tier]}</div>
                  <div className="tiny muted">pending {fmtCg(p.pending, 3)} · {p.unlockAt > Date.now() ? `unlocks in ${countdown(p.unlockAt)}` : 'unlocked'}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" disabled={busy} onClick={() => run('Claim', async () => [ata(), unstakeCgIx({ owner: wallet!.publicKey, tier: p.tier, amount: 0n, cgMint: cgMint! })])}>Claim</button>
                  <button className="btn btn-sm" onClick={() => { setUnstake({ tier: p.tier }); setUnAmount(''); }}>Unstake</button>
                </div>
              </CleanZone>
            ))}
          </div>
        )}
      </div>

      {/* ---------- chips ---------- */}
      <div className="card stack">
        <div className="row between">
          <div><div className="strong">Stake caps</div><div className="tiny muted">weight = rarity weight × level × set bonus · staked caps can still fight in the Arena</div></div>
          <button className="btn btn-sm" onClick={() => setPickChip(true)} disabled={stakeable.length === 0}>+ Stake a cap</button>
        </div>
        <CleanZone className="row between" style={{ padding: '8px 12px' }}>
          <span>Set bonus: <b className="cg-accent">×{setMult.toFixed(2)}</b> <span className="muted">({sets} complete district{sets === 1 ? '' : 's'})</span></span>
          <Link to="/collection" className="tiny">complete more →</Link>
        </CleanZone>
        {staked.length === 0 ? <Empty>No caps staked. Staked caps earn from the chip pool ({overview.data ? fmtCg(overview.data.chipPool?.budgetTodayMicro, 0) : '—'}/day shared by {overview.data?.chipPool?.stakedChips ?? '—'} caps).</Empty> : (
          <div className="stack-sm">
            {staked.map((c) => {
              const api = meApi.data?.chipStakes?.find((s) => s.chip?.asset === c.asset);
              return (
                <div key={c.asset} className="row between" style={{ flexWrap: 'wrap' }}>
                  <div className="row"><span style={{ width: 60 }}><ChipArt collection={c.collection!} rarity={c.rarity!} imageUrl={chipImageOf(c)} /></span><div><div className="small">{chipName(c.collection!, c.rarity!)} <span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span></div><div className="tiny muted mono">weight {c.stakeWeight} · pending {api ? fmtCg(api.pending, 3) : '…'}</div></div></div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-sm" disabled={busy} onClick={() => run('Claim', async () => [ata(), claimChipIx({ owner: wallet!.publicKey, asset: new PublicKey(c.asset!), cgMint: cgMint! })])}>Claim</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => run('Unstake', async () => { const cores = await fetchCoreCollections(connection, cfg.data!.collectionsCreated); return [ata(), unstakeChipIx({ owner: wallet!.publicKey, asset: new PublicKey(c.asset!), collectionIdx: c.collection!, coreCollection: cores.get(c.collection!)!, cgMint: cgMint! })]; })}>Unstake</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={!!unstake} onClose={() => setUnstake(null)} title={`Unstake · ${unstake ? TIER_NAMES[unstake.tier] : ''}`}>
        {unstake && (() => {
          const p = positions.find((x) => x.tier === unstake.tier)!;
          const a = parseUnits(unAmount, 6) ?? 0n;
          const pen = unstakePenalty(a, unstake.tier, BigInt(Math.floor(p.unlockAt / 1000)));
          return (
            <div className="stack">
              <CleanZone>
                <div className="row" style={{ gap: 8 }}><input className="input mono" inputMode="decimal" value={unAmount} onChange={(e) => setUnAmount(e.target.value)} placeholder="amount" /><button className="btn btn-sm" onClick={() => setUnAmount(fmtUnits(p.amount, 6, 6).replace(/,/g, ''))}>all</button></div>
                <KV k="Pending rewards (auto-claimed)" v={fmtCg(p.pending, 3)} />
                {pen > 0n && <KV k={`Early exit penalty ${unstakePenalty(10_000n, unstake.tier, 1n << 62n) / 100n}% (burned)`} v={`− ${fmtCg(pen)}`} />}
                <KV k="You receive" v={fmtCg(a - pen)} total accent />
              </CleanZone>
              {pen > 0n && <div className="danger">Position is still locked ({countdown(p.unlockAt)} left). Exiting now burns {fmtCg(pen)}.</div>}
              <CleanConfirmButton disabled={busy || a <= 0n || a > p.amount} onClick={async () => { setUnstake(null); await run('Unstake', async () => [ata(), unstakeCgIx({ owner: wallet!.publicKey, tier: unstake.tier, amount: a, cgMint: cgMint! })]); }}>Unstake</CleanConfirmButton>
            </div>
          );
        })()}
      </Modal>

      <Modal open={pickChip} onClose={() => setPickChip(false)} title="Stake a cap" wide>
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(144px, 47%), 1fr))' }}>
          {stakeable.map((c: Chip) => (
            <div key={c.asset} className="chip-card" onClick={async () => { setPickChip(false); await run('Stake', async () => { const cores = await fetchCoreCollections(connection, cfg.data!.collectionsCreated); return [stakeChipIx({ owner: wallet!.publicKey, asset: new PublicKey(c.asset!), collectionIdx: c.collection!, coreCollection: cores.get(c.collection!)! })]; }); }}>
              <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c)} />
              <div className="chip-meta"><span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span> · w {c.stakeWeight}</div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}


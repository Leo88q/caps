import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMe, useActivity, useMyServices, useReferrals, useGrid } from '@/api/hooks';
import { ChipArt } from '@/shared/ui/ChipArt';
import { chipArtUrl, rarityColor } from '@/shared/lib/rarity';
import { ANTI_FARM, SERVICE_BY_KIND } from '@guttercaps/economy';
import { HandleModal } from './HandleModal';
import { useT, useLocale, LOCALE_META, fmtLocale } from '@/shared/i18n';
import { useSignIn } from '@/app/session';
import { useUiStore } from '@/app/store/ui';
import { useTxStore, useActiveOps } from '@/app/store/txs';
import { CleanZone, KV, Stat, Skeleton, Empty } from '@/shared/ui/primitives';
import { SprayCapToggle } from '@/shared/ui/buttons';
import { HumanCheck } from '@/shared/ui/HumanCheck';
import { shortKey, timeAgo, fmtUnits, fmtCg } from '@/shared/lib/format';
import { CLUSTER, EXPLORER, FLAGS, RPC_URL, PROGRAM_IDS } from '@/app/config';
import { isMock, setMockMode } from '@/api/client';
import { REFERRAL } from '@guttercaps/economy';
import { Link } from 'react-router-dom';

export default function Profile() {
  const { publicKey, wallet } = useWallet();
  const { signOut } = useSignIn();
  const me = useMe();
  const referrals = useReferrals();
  const grid = useGrid();
  const activity = useActivity();
  const ui = useUiStore();
  const txs = useTxStore();
  const [rpc, setRpc] = useState(ui.rpcOverride ?? '');
  const addr = publicKey?.toBase58() ?? '';
  const refLink = `${window.location.origin}/?ref=${addr}`;
  const active = useActiveOps(addr);
  const t = useT();
  const { locale } = useLocale();
  const services = useMyServices();
  const [handleOpen, setHandleOpen] = useState(false);

  return (
    <div className="page page-bg page-bg-profile stack">
      <div className="row between">
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          {(() => {
            const cells = grid.data?.cells;
            let best: [number, number] | null = null;
            cells?.forEach((row, ci) => row.forEach((n, ri) => { if (n > 0 && (!best || ri > best[1])) best = [ci, ri]; }));
            return best ? (
              <span style={{ width: 64, flex: '0 0 auto', borderRadius: '50%', border: `2px solid ${rarityColor(best[1])}` }} title="Your rarest cap">
                <ChipArt collection={best[0]} rarity={best[1]} imageUrl={chipArtUrl(best[0], best[1])} />
              </span>
            ) : null;
          })()}
          <div>
            <h1 className="page-title">{me.data?.handle ? `@${me.data.handle}` : shortKey(addr, 6)}</h1>
            <p className="page-sub">{wallet?.adapter.name} · <a href={EXPLORER.account(addr)} target="_blank" rel="noreferrer">{shortKey(addr, 8)} ↗</a> · {t('profile.playingSince', { date: me.data?.firstSeen ? fmtLocale.date(me.data.firstSeen, locale) : '—' })}</p>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm" onClick={() => setHandleOpen(true)}>{me.data?.handle ? t('profile.handle.change') : t('profile.handle.get')}</button>
          <button className="btn btn-sm" onClick={() => void signOut()}>{t('common.signOut')}</button>
        </div>
      </div>
      {handleOpen && <HandleModal onClose={() => setHandleOpen(false)} />}

      <div className="grid-3">
        <div className="card"><Stat label={t('profile.districts')} value={me.data?.completedSets ?? 0} /></div>
        <div className="card"><Stat label={t('profile.boosters')} value={me.data?.boosters ?? 0} /></div>
        <div className="card"><Stat label={t('profile.accountAge')} value={me.data?.flags?.accountAgeH ? t('common.day', { n: Math.floor(me.data.flags.accountAgeH / 24) }) : '—'} /></div>
      </div>

      <CleanZone className="stack-sm">
        <div className="label">{t('profile.balances')}</div>
        <KV k="SOL" v={fmtUnits(me.data?.balances?.lamports, 9, 4)} />
        <KV k="USDC" v={fmtUnits(me.data?.balances?.usdc, 6, 2)} />
        <KV k="$CG" v={fmtUnits(me.data?.balances?.cg, 6, 2)} accent />
        {me.data?.balances?.skr !== undefined && <KV k="SKR" v={fmtUnits(me.data.balances.skr, 6, 2)} />}
        {me.data?.flags?.rewardsPaused && <div className="warn">{t('profile.rewardsPaused')}</div>}
        {me.data?.flags?.deviceLimited && <div className="warn">{t('human.deviceLimited', { n: ANTI_FARM.maxWalletsPerDevice })}</div>}
      </CleanZone>

      <HumanCheck always />

      <div className="card stack-sm">
        <div className="row between">
          <div className="strong">{t('profile.extras')}</div>
          <Link to="/shop?tab=services" className="tiny">{t('common.seeAll')} →</Link>
        </div>
        {services.isLoading && <Skeleton h={40} />}
        {services.data && services.data.entitlements?.length === 0 && <div className="small muted">{t('profile.noExtras')}</div>}
        {(services.data?.entitlements ?? []).map((e) => {
          const def = e.kind !== undefined ? SERVICE_BY_KIND[e.kind] : undefined;
          return (
            <div key={e.id} className="row between small">
              <span>{def ? t(`services.names.${def.id}`) : `#${e.kind}`}</span>
              <span className="muted">{e.expiresAt ? t('services.expires', { date: fmtLocale.date(e.expiresAt, locale) }) : t('services.owned')}</span>
            </div>
          );
        })}
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('profile.referrals')}</div>
        <div className="small muted">{t('profile.referralBody', { pct: REFERRAL.referrerRewardBps / 100, cap: REFERRAL.referrerCapCgPerRefereeMicro / 1e6, welcome: REFERRAL.refereeWelcomeCgMicro / 1e6 })}</div>
        <div className="row"><input className="input mono" readOnly value={refLink} onFocus={(e) => e.currentTarget.select()} /><button className="btn" onClick={() => { void navigator.clipboard.writeText(refLink); ui.toast({ kind: 'success', title: t('common.copied') }); }}>{t('common.copy')}</button></div>
        {referrals.data && (
          <CleanZone className="stack-sm">
            <div className="grid-3">
              <Stat label={t('profile.referralStats.referees')} value={`${referrals.data.totals?.referees ?? 0} · ${referrals.data.totals?.paying ?? 0} ${t('profile.referralStats.paying')}`} />
              <Stat label={t('profile.referralStats.earned')} value={fmtCg(referrals.data.totals?.earnedCgMicro)} />
              <Stat label={t('profile.referralStats.awaiting')} value={fmtCg(referrals.data.totals?.awaitingRootCgMicro)} />
            </div>
            {(referrals.data.totals?.unsettledPurchases ?? 0) > 0 && <div className="tiny muted">{t('profile.referralStats.unsettled', { n: referrals.data.totals?.unsettledPurchases ?? 0 })}</div>}
            {referrals.data.welcome && <KV k={t('profile.referralStats.welcome')} v={fmtCg(referrals.data.welcome.amountCgMicro)} accent />}
            {(referrals.data.referees ?? []).length === 0 && <div className="small muted">{t('profile.referralStats.none')}</div>}
            {(referrals.data.referees ?? []).map((r) => (
              <div key={r.wallet} className="row between small">
                <span className="mono">{r.handle ? `@${r.handle}` : shortKey(r.wallet, 5)} <span className="muted">· {r.paidPurchases} × · ${r.spendUsd?.toFixed(2)}</span></span>
                <span className="mono">{fmtCg(r.earnedCgMicro)} <span className="muted tiny">({t('profile.referralStats.capLeft')} {fmtCg(r.capLeftCgMicro, 0)})</span></span>
              </div>
            ))}
          </CleanZone>
        )}
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('profile.settings')}</div>
        <SprayCapToggle on={ui.sound} onChange={ui.setSound} label={t('profile.sound')} />
        <SprayCapToggle on={ui.reducedMotion} onChange={ui.setReducedMotion} label={t('profile.reducedMotion')} />
        <div className="row between small" style={{ marginTop: 4 }}>
          <span>{t('profile.language')}</span>
          <Link to="/language" className="btn btn-sm">{LOCALE_META[locale].flag} {LOCALE_META[locale].native}</Link>
        </div>
        {me.data?.isAdmin && (
          <div className="row between small" style={{ marginTop: 4 }}>
            <span>{t('profile.opsPanel')}</span>
            <Link to="/admin" className="btn btn-sm" data-testid="ops-link">{t('profile.openOps')}</Link>
          </div>
        )}
        <div className="stack-sm" style={{ marginTop: 8 }}>
          <span className="label">{t('profile.rpc', { cluster: CLUSTER, url: RPC_URL })}</span>
          <div className="row"><input className="input mono" placeholder="https://…" value={rpc} onChange={(e) => setRpc(e.target.value)} /><button className="btn" onClick={() => { ui.setRpcOverride(rpc || undefined); ui.toast({ kind: 'info', title: t('profile.rpcSaved'), body: t('profile.reload') }); }}>{t('common.save')}</button></div>
        </div>
        {FLAGS.debugPanel && (
          <div className="stack-sm" style={{ marginTop: 8 }}>
            <span className="label">Debug</span>
            <SprayCapToggle on={isMock()} onChange={(v) => { setMockMode(v); window.location.reload(); }} label={`Mock API (${isMock() ? 'on' : 'off'})`} />
            <div className="tiny mono muted">chip_core {PROGRAM_IDS.chipCore.toBase58()}<br />market {PROGRAM_IDS.market.toBase58()}<br />staking {PROGRAM_IDS.staking.toBase58()}<br />arena {PROGRAM_IDS.arena.toBase58()}</div>
            {(active.packs.length > 0 || active.fusions.length > 0) && <div className="tiny">Unfinished: {active.packs.map((p) => <Link key={p.id} to={`/shop/opening/${p.nonce}`}>pack {p.nonce.slice(-6)} ({p.phase}) </Link>)}{active.fusions.map((f) => <span key={f.id}>fusion {f.nonce.slice(-6)} ({f.phase}) </span>)}</div>}
            <button className="btn btn-sm" onClick={() => { Object.keys(txs.packs).forEach(txs.remove); Object.keys(txs.fusions).forEach(txs.remove); }}>Clear local tx history</button>
          </div>
        )}
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('profile.activity')}</div>
        {activity.isLoading && <Skeleton h={100} />}
        {(activity.data?.pages.flatMap((p) => p.items ?? []) ?? []).map((a, i) => (
          <div key={`${a.signature}-${i}`} className="row between small">
            <span>{a.kind?.replace(/_/g, ' ')}</span>
            <span className="muted">{a.blockTime ? timeAgo(a.blockTime) : ''} {a.signature && <a href={EXPLORER.tx(a.signature)} target="_blank" rel="noreferrer">↗</a>}</span>
          </div>
        ))}
        {activity.data && activity.data.pages[0]?.items?.length === 0 && <Empty>{t('profile.noActivity')}</Empty>}
      </div>
    </div>
  );
}

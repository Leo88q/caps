import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { PACKS, BUNDLES, FEES, bundlePriceCents, effectiveOdds, probabilityAtLeast, type PackId } from '@guttercaps/economy';
import { useMe, usePackCatalog, useQuote, type PackSku } from '@/api/hooks';
import { useGameConfig, usePity } from '@/chain/hooks';
import { toEconPack, rentReserve } from '@/chain/flows/packFlow';
import { Currency, type CurrencyCode } from '@/chain/ix/chipCore';
import { FLAGS, MINTS, ONRAMP_URL } from '@/app/config';
import { fmtAmount, fmtCents, fmtPct, fmtProb, fmtSol } from '@/shared/lib/format';
import { RARITIES, RARITY_SHORT, rarityColor } from '@/shared/lib/rarity';
import { CleanZone, KV, Modal, Pill, Progress } from '@/shared/ui/primitives';
import { SprayNozzleButton, CleanConfirmButton } from '@/shared/ui/buttons';
import { usePackFlow } from './usePackFlow';
import { PackStepper } from './PackStepper';
import { Services } from './Services';
import { useT } from '@/shared/i18n';

const SKU_IDS: PackId[] = ['starter', 'standard', 'premium', 'limited'];
const CUR_LABEL = ['SOL', 'USDC', 'CG', 'SKR'] as const;

export default function Shop() {
  const catalog = usePackCatalog();
  const cfg = useGameConfig();
  const me = useMe();
  const pity = usePity();
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const nav = useNavigate();
  const flow = usePackFlow();
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'services' ? 'services' : 'packs';

  const [sel, setSel] = useState<{ sku: number; qty: number; currency: CurrencyCode } | null>(null);

  // Merge sources: on-chain GameConfig (authoritative) → API catalog → economy defaults
  const packs = useMemo(() => {
    return SKU_IDS.map((id, sku) => {
      const econ = cfg.data ? toEconPack(sku, cfg.data.packs[sku]) : PACKS[id];
      const api = catalog.data?.packs?.find((p: PackSku) => p.sku === sku);
      const enabled = cfg.data ? cfg.data.packs[sku].enabled : api?.enabled ?? id !== 'limited';
      return { sku, id, econ, api, enabled: enabled || (id === 'limited' && FLAGS.limitedPackPreview) };
    });
  }, [cfg.data, catalog.data]);

  const counters = pity.data?.counters ?? me.data?.pity?.counters ?? [0, 0, 0, 0];
  const boughtToday = pity.data?.boughtToday ?? me.data?.pity?.boughtToday ?? [0, 0, 0, 0];
  const starterClaimed = pity.data?.starterClaimed ?? me.data?.pity?.starterClaimed ?? false;
  const geoBlocked = FLAGS.geoGate && !!me.data?.flags?.geoRestricted;

  return (
    <div className="page">
      <h1 className="page-title">{tab === 'services' ? t('services.title') : t('shop.title')}</h1>
      <p className="page-sub">{tab === 'services' ? t('services.subtitle') : t('shop.subtitle')}</p>

      <div className="tag-list" style={{ marginBottom: 16 }} role="tablist">
        <Pill active={tab === 'packs'} onClick={() => setParams({}, { replace: true })}>{t('shop.tabs.packs')}</Pill>
        <Pill active={tab === 'services'} onClick={() => setParams({ tab: 'services' }, { replace: true })}>{t('shop.tabs.services')}</Pill>
      </div>

      {tab === 'services' && <Services />}
      {tab === 'packs' && <>

      {geoBlocked && (
        <div className="warn" style={{ marginBottom: 16 }}>
          Randomised packs are not available in your region. You can still buy specific caps on the <a href="/market">Market</a>.
        </div>
      )}
      {cfg.data?.paused && <div className="danger" style={{ marginBottom: 16 }}>The game is paused by the operator. Purchases are disabled.</div>}

      <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {packs.map(({ sku, id, econ, api, enabled }) => {
          const counter = counters[sku] ?? 0;
          const odds = effectiveOdds(econ, counter);
          const pLegend = probabilityAtLeast(econ, 6);
          const capLeft = econ.dailyCap === null ? null : Math.max(0, econ.dailyCap - (boughtToday[sku] ?? 0));
          const starterGone = id === 'starter' && starterClaimed;
          const disabled = !enabled || geoBlocked || !!cfg.data?.paused || starterGone || capLeft === 0;
          const glow = ['rgba(216,216,220,0.12)', 'rgba(22,229,217,0.18)', 'rgba(255,46,138,0.18)', 'rgba(255,122,26,0.22)'][sku];
          return (
            <div key={sku} className="card pack-card stack" style={{ ['--pack-glow' as string]: glow, opacity: enabled ? 1 : 0.55 }}>
              <div className="row between">
                <div>
                  <div className="cg-heading" style={{ fontSize: 22 }}>{econ.name}</div>
                  <div className="muted small">{econ.chips} caps · floor {RARITIES[econ.floor]} · {econ.pool === 'featured' ? 'featured district only' : 'all 10 districts'}</div>
                </div>
                {!enabled && <Pill>coming soon</Pill>}
                {id === 'starter' && <Pill tone="ok">one per wallet</Pill>}
              </div>

              <div className="odds-bar" title="Per-slot odds">
                {odds.map((bps, r) => bps > 0 && <i key={r} style={{ width: `${bps / 100}%`, background: rarityColor(r) }} />)}
              </div>
              <div className="odds-legend">
                {odds.map((bps, r) => bps > 0 && <span key={r}><span style={{ color: rarityColor(r) }}>{RARITY_SHORT[r]}</span> {fmtPct(bps, bps < 100 ? 2 : 1)}</span>)}
              </div>
              <div className="row between small">
                <span className="muted">≥ Legend per pack</span><b className="mono">{fmtProb(pLegend, 2)}</b>
              </div>
              {econ.pity && (
                <div className="stack-sm">
                  <div className="row between small"><span className="muted">Pity (≥ Legend guaranteed at {econ.pity.hardAt})</span><b className="mono">{counter}/{econ.pity.hardAt}</b></div>
                  <Progress value={counter} max={econ.pity.hardAt} tone={counter >= econ.pity.softStart ? 'orange' : undefined} />
                  {counter >= econ.pity.softStart && <div className="tiny" style={{ color: 'var(--cg-electric-orange)' }}>Soft pity active: +{fmtPct(econ.pity.softStepBps * (counter - econ.pity.softStart + 1), 2)} to top tiers</div>}
                </div>
              )}
              {capLeft !== null && <div className="tiny muted">Daily cap: {capLeft} left today</div>}

              <CleanZone>
                <KV k="Price" v={fmtCents(econ.priceUsdCents)} />
                {econ.priceCgMicro && <KV k="or" v={fmtAmount(BigInt(econ.priceCgMicro), 'CG')} />}
                {api?.evPct !== undefined && <KV k="Modelled floor value" v={`${api.evPct.toFixed(0)}% of price`} />}
              </CleanZone>

              <SprayNozzleButton disabled={disabled} onClick={() => (connected ? setSel({ sku, qty: 1, currency: Currency.SOL }) : setVisible(true))}>
                {starterGone ? 'Starter claimed' : capLeft === 0 ? 'Cap reached' : connected ? 'Buy' : 'Connect to buy'}
              </SprayNozzleButton>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row between">
          <div>
            <div className="strong">Bundles</div>
            <div className="muted small">Standard & Premium only. Each pack in a bundle is opened one by one with its own sub-seed.</div>
          </div>
          <div className="tag-list">{BUNDLES.filter((b) => b.qty > 1).map((b) => <Pill key={b.qty}>×{b.qty} −{b.discountBps / 100}%</Pill>)}</div>
        </div>
      </div>

      <p className="tiny muted" style={{ marginTop: 12 }}>
        Crypto only. Need SOL? <a href={ONRAMP_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--cg-neon-cyan)' }}>Buy with card ↗</a> · Pack contents are digital collectibles with no guaranteed resale value.
      </p>

      {sel && (
        <BuyModal
          sel={sel}
          setSel={setSel}
          pack={packs[sel.sku]}
          counter={counters[sel.sku] ?? 0}
          onConfirm={async () => {
            const s = sel;
            setSel(null);
            const nonce = await flow.start({ sku: s.sku, qty: s.qty, currency: s.currency });
            if (nonce !== undefined) nav(`/shop/opening/${nonce.toString()}`);
          }}
        />
      )}
      </>}
      {flow.state && flow.state.phase !== 'done' && (
        <div style={{ position: 'fixed', left: 12, right: 12, bottom: 'calc(var(--gc-nav-h) + 12px)', zIndex: 40 }} className="card">
          <PackStepper state={flow.state} compact onRefund={flow.refund} />
        </div>
      )}
    </div>
  );
}

function BuyModal({ sel, setSel, pack, counter, onConfirm }: {
  sel: { sku: number; qty: number; currency: CurrencyCode };
  setSel: (s: { sku: number; qty: number; currency: CurrencyCode } | null) => void;
  pack: { econ: ReturnType<typeof toEconPack>; id: PackId };
  counter: number;
  onConfirm: () => void;
}) {
  const { econ, id } = pack;
  const t = useT();
  const bundlesAllowed = id === 'standard' || id === 'premium';
  const cfg = useGameConfig();
  const skrEnabled = !!MINTS.skr || (cfg.data ? !cfg.data.skrMint.equals(PublicKey.default) : false);
  const skrDiscountBps = cfg.data?.skrDiscountBps ?? FEES.skrPackDiscountBps;
  const currencies: CurrencyCode[] = [Currency.SOL, Currency.USDC, ...(econ.priceCgMicro ? [Currency.CG] : []), ...(skrEnabled ? [Currency.SKR] : [])];
  const quote = useQuote(sel.sku, sel.qty, CUR_LABEL[sel.currency]);
  const baseCents = bundlePriceCents(econ, sel.qty);
  // SKR promo stacks with the bundle discount (same integer math as buy_pack; total capped at 30 %)
  const bundleBps = bundlesAllowed ? (BUNDLES.find((b) => b.qty === sel.qty)?.discountBps ?? 0) : 0;
  const skrCents = Math.floor((econ.priceUsdCents * sel.qty * (10_000 - Math.min(bundleBps + skrDiscountBps, 3_000))) / 10_000);
  const cents = sel.currency === Currency.SKR ? skrCents : baseCents;
  const reserve = rentReserve(econ.chips, sel.qty);
  const odds = effectiveOdds(econ, counter);
  const amount = quote.data?.amount ? BigInt(quote.data.amount) : undefined;

  return (
    <Modal open onClose={() => setSel(null)} title={t('shop.buy', { name: econ.name })}>
      <div className="stack">
        {bundlesAllowed && (
          <div className="stack-sm">
            <span className="label">{t('shop.quantity')}</span>
            <div className="tag-list">{BUNDLES.map((b) => <Pill key={b.qty} active={sel.qty === b.qty} onClick={() => setSel({ ...sel, qty: b.qty })}>×{b.qty}{b.discountBps ? ` −${b.discountBps / 100}%` : ''}</Pill>)}</div>
          </div>
        )}
        <div className="stack-sm">
          <span className="label">{t('shop.payWith')}</span>
          <div className="tag-list">{currencies.map((c) => <Pill key={c} active={sel.currency === c} onClick={() => setSel({ ...sel, currency: c })}>{CUR_LABEL[c]}{c === Currency.CG ? ` · ${t('shop.burned75')}` : c === Currency.SKR ? ` · ${t('shop.seekerDiscount', { pct: skrDiscountBps / 100 })}` : ''}</Pill>)}</div>
        </div>

        <CleanZone className="cg-clean-pulse">
          <KV k={`${econ.name} × ${sel.qty}`} v={sel.currency === Currency.SKR && skrCents !== baseCents ? `${fmtCents(skrCents)} (${t('shop.was', { price: fmtCents(baseCents) })})` : fmtCents(cents)} />
          {sel.currency === Currency.SOL && <KV k={t('shop.solAtPyth')} v={quote.isLoading ? '…' : quote.data ? `${fmtSol(amount!)} (1 SOL = $${quote.data.solUsd?.toFixed(2)})` : t('shop.quoteUnavailable')} />}
          {sel.currency === Currency.SKR && <KV k={t('shop.skrAtPyth')} v={quote.isLoading ? '…' : quote.data?.amount ? `${fmtAmount(BigInt(quote.data.amount), 'SKR')} (1 SKR = $${quote.data.skrUsd?.toFixed(4) ?? '—'})` : t('shop.quoteUnavailable')} />}
          {sel.currency === Currency.USDC && <KV k="USDC" v={fmtAmount(BigInt(cents) * 10_000n, 'USDC')} />}
          {sel.currency === Currency.CG && econ.priceCgMicro && <KV k="$CG" v={fmtAmount(quote.data?.amount ?? BigInt(Math.round(econ.priceCgMicro * sel.qty)), 'CG')} />}
          <KV k={t('shop.rentReserve')} v={fmtSol(reserve)} />
          <KV k={t('shop.oracleFees')} v="≈ 0.003 SOL" />
          {(sel.currency === Currency.SOL || sel.currency === Currency.SKR) && quote.data?.maxLamports && <KV k={t('shop.maxSlippage')} v={fmtAmount(BigInt(quote.data.maxLamports), sel.currency === Currency.SOL ? 'SOL' : 'SKR')} />}
          <KV total k={t('common.youSign')} v={
            sel.currency === Currency.SOL ? (amount !== undefined ? fmtSol(amount + reserve) : '—')
            : sel.currency === Currency.SKR ? (amount !== undefined ? `${fmtAmount(amount, 'SKR')} + ${fmtSol(reserve)}` : '—')
            : `${fmtAmount(sel.currency === Currency.USDC ? BigInt(cents) * 10_000n : BigInt(quote.data?.amount ?? Math.round((econ.priceCgMicro ?? 0) * sel.qty)), sel.currency)} + ${fmtSol(reserve)}`
          } accent />
        </CleanZone>

        <div className="small">
          <div className="label" style={{ marginBottom: 4 }}>{t('shop.oddsNow', { n: counter })}</div>
          <div className="odds-legend">{odds.map((bps, r) => bps > 0 && <span key={r}><span style={{ color: rarityColor(r) }}>{RARITIES[r]}</span> {fmtPct(bps, 2)}</span>)}</div>
        </div>

        <div className="tiny muted">{t('shop.oneSignature')}</div>

        <CleanConfirmButton onClick={onConfirm} disabled={(sel.currency === Currency.SOL || sel.currency === Currency.SKR) && quote.isLoading}>
          {t('common.confirmSign')}
        </CleanConfirmButton>
      </div>
    </Modal>
  );
}

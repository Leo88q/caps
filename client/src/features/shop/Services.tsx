// "Extras" tab — the voluntary-spend catalogue (cosmetics, identity,
// convenience, boosters). Every card states what the money does (burn vs
// treasury) and that nothing here buys power; the money UI lives in a clean zone.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { SERVICES, type ServiceDef, type ServiceId } from '@guttercaps/economy';
import { claimWithRetry, api, isMock } from '@/api/client';
import { useFloor, useMyServices, useServices } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { Currency, type CurrencyCode } from '@/chain/ix/chipCore';
import { payForService, quoteService, serviceRefHash } from '@/chain/flows/serviceFlow';
import { useUiStore } from '@/app/store/ui';
import { EXPLORER, MINTS } from '@/app/config';
import { fmtAmount, fmtCents, CURRENCY_SYMBOLS } from '@/shared/lib/format';
import { CleanZone, KV, Modal, Pill } from '@/shared/ui/primitives';
import { CleanConfirmButton, SprayNozzleButton } from '@/shared/ui/buttons';
import { useT, useLocale, fmtLocale } from '@/shared/i18n';

const GLYPH: Record<ServiceId, string> = {
  handle: '@', handleChange: '↻', capSkin: '◐', profileTheme: '▦', arenaEmotePack: '✦', extraBenchSlots: '⊞', seasonPass: '★', booster: '⚡', packSkipAnim: '»', districtBanner: '⚑',
};

export function Services() {
  const t = useT();
  const { locale } = useLocale();
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const catalogue = useServices();
  const mine = useMyServices();
  const [sel, setSel] = useState<ServiceDef | null>(null);

  const owned = useMemo(() => new Set((mine.data?.entitlements ?? []).map((e) => e.kind)), [mine.data]);
  const dailyLeft = mine.data?.dailyLeft ?? {};

  return (
    <div className="stack">
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <div>
          <div className="strong">{t('services.title')}</div>
          <div className="small muted">{t('services.subtitle')}</div>
        </div>
        <Pill>{t('services.noPower')}</Pill>
      </div>

      <div className="grid-3">
        {SERVICES.filter((s) => s.id !== 'handleChange').map((s) => {
          const isOwned = owned.has(s.kind) && !s.recurring && s.fulfilment === 'entitlement' && s.id !== 'capSkin';
          const left = dailyLeft[String(s.kind)];
          const passActive = s.id === 'seasonPass' && (mine.data?.entitlements ?? []).some((e) => e.kind === 6 && e.expiresAt && new Date(e.expiresAt).getTime() > Date.now());
          return (
            <div key={s.id} className="card stack-sm" style={{ position: 'relative' }}>
              <div className="row between">
                <span className="mono" style={{ fontSize: 22, color: 'var(--cg-neon-cyan)' }} aria-hidden>{GLYPH[s.id]}</span>
                <span className="mono strong">{fmtCents(s.priceUsdCents)}</span>
              </div>
              <div className="strong">{t(`services.names.${s.id}`)}</div>
              <div className="tiny muted" style={{ minHeight: 44 }}>{t(`services.blurbs.${s.id}`)}</div>
              <div className="tag-list">
                {s.id === 'booster' && <Pill>{t('services.boosterCap')}</Pill>}
                {left !== undefined && <Pill>{t('services.dailyLeft', { n: left })}</Pill>}
                {passActive && <Pill active>{t('services.active')}</Pill>}
              </div>
              {s.id === 'handle' ? (
                <Link to="/profile" className="btn" style={{ textAlign: 'center' }}>{t('profile.handle.get')}</Link>
              ) : (
                <SprayNozzleButton disabled={isOwned || passActive || left === 0} onClick={() => (connected ? setSel(s) : setVisible(true))}>
                  {isOwned ? t('services.owned') : passActive ? t('services.active') : t('services.buy')}
                </SprayNozzleButton>
              )}
            </div>
          );
        })}
      </div>

      <div className="tiny muted">{t('services.howItWorks')}</div>
      {catalogue.data?.skrUsd !== undefined && <div className="tiny muted mono">1 SKR ≈ ${catalogue.data.skrUsd.toFixed(4)} · 1 SOL ≈ ${catalogue.data.solUsd?.toFixed(2)} · {fmtLocale.dateTime(Date.now(), locale)}</div>}
      {sel && <ServiceModal service={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function ServiceModal({ service, onClose }: { service: ServiceDef; onClose: () => void }) {
  const t = useT();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const cfg = useGameConfig();
  const floor = useFloor();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [currency, setCurrency] = useState<CurrencyCode>(Currency.CG);
  const [busy, setBusy] = useState(false);

  const skrEnabled = !!MINTS.skr || (cfg.data ? !cfg.data.skrMint.equals(PublicKey.default) : false);
  const currencies: CurrencyCode[] = [Currency.CG, Currency.SOL, Currency.USDC, ...(skrEnabled ? [Currency.SKR] : [])];
  const quote = useMemo(() => {
    try { return quoteService(service.id, currency, { solUsd: floor.data?.solUsd, skrUsd: floor.data?.skrUsd }); } catch { return null; }
  }, [service.id, currency, floor.data?.solUsd, floor.data?.skrUsd]);

  async function submit() {
    if (!quote) return;
    // payload the backend binds the payment to; cosmetics choose their variant later via /services/claim
    const payload = { id: service.id, v: 1 };
    if (isMock()) {
      await api.post('/services/claim', { signature: `mock-${Date.now()}`, kind: service.kind, payload });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast({ kind: 'money', title: t('services.bought'), body: t(`services.names.${service.id}`) });
      onClose();
      return;
    }
    if (!wallet || !cfg.data) return;
    setBusy(true);
    try {
      const refHash = serviceRefHash(service.kind, wallet.publicKey, payload);
      const { signature } = await payForService({ connection, wallet, id: service.id, currency, refHash, quote, cfg: cfg.data });
      // entitlements are granted only on a finalized payment (SEC-M5) — retry through indexer lag + finality (≈ 1–2 min)
      if (service.fulfilment === 'entitlement') await claimWithRetry(() => api.post('/services/claim', { signature, kind: service.kind, payload }));
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast({ kind: 'money', title: t('services.bought'), body: t(`services.names.${service.id}`), href: EXPLORER.tx(signature) });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: t('services.buyFailed'), body: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t(`services.names.${service.id}`)}>
      <div className="stack">
        <div className="small muted">{t(`services.blurbs.${service.id}`)}</div>
        <div className="stack-sm">
          <span className="label">{t('shop.payWith')}</span>
          <div className="tag-list">
            {currencies.map((c) => (
              <Pill key={c} active={currency === c} onClick={() => setCurrency(c)}>{CURRENCY_SYMBOLS[c]} · {c === Currency.CG ? t('services.burned') : t('services.toTreasury')}</Pill>
            ))}
          </div>
        </div>
        <CleanZone>
          <KV k={t(`services.names.${service.id}`)} v={fmtCents(service.priceUsdCents)} />
          {quote ? <KV total accent k={t('common.youSign')} v={fmtAmount(quote.amount, currency)} /> : <div className="tiny muted">{t('services.noQuote')}</div>}
          {(currency === Currency.SOL || currency === Currency.SKR) && quote && <KV k={t('shop.maxSlippage')} v={fmtAmount(quote.maxUnits, currency)} />}
        </CleanZone>
        <div className="tiny muted">{t('services.howItWorks')}</div>
        <CleanConfirmButton disabled={!quote || busy} onClick={submit}>{busy ? t('common.signing') : t('common.confirmSign')}</CleanConfirmButton>
      </div>
    </Modal>
  );
}

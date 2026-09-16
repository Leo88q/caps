// Buy / change the @handle: check availability → pay_service on-chain
// (any currency; $CG is burned) → PUT /me/handle with the signature so the
// indexer binds the ServicePaid event to this exact string via ref_hash.
import { useEffect, useMemo, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { SERVICE_BY_ID } from '@guttercaps/economy';
import { claimWithRetry, api, isMock } from '@/api/client';
import { useFloor, useHandleCheck, useMe } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { Currency, type CurrencyCode } from '@/chain/ix/chipCore';
import { handleRefHash, payForService, quoteService } from '@/chain/flows/serviceFlow';
import { useUiStore } from '@/app/store/ui';
import { EXPLORER, MINTS } from '@/app/config';
import { PublicKey } from '@solana/web3.js';
import { fmtAmount, fmtCents, CURRENCY_SYMBOLS } from '@/shared/lib/format';
import { CleanZone, KV, Modal, Pill } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { useT } from '@/shared/i18n';

const HANDLE_RE = /^[a-zA-Z0-9_]{3,16}$/;

export function HandleModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const cfg = useGameConfig();
  const me = useMe();
  const floor = useFloor();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>(Currency.CG);
  const [busy, setBusy] = useState<'idle' | 'signing' | 'claiming'>('idle');

  useEffect(() => { const id = setTimeout(() => setDebounced(input.trim()), 350); return () => clearTimeout(id); }, [input]);
  const check = useHandleCheck(debounced);
  const isChange = !!me.data?.handle;
  const service = SERVICE_BY_ID[isChange ? 'handleChange' : 'handle'];
  const valid = HANDLE_RE.test(input.trim());
  const available = valid && check.data?.available === true;
  const skrEnabled = !!MINTS.skr || (cfg.data ? !cfg.data.skrMint.equals(PublicKey.default) : false);
  const currencies: CurrencyCode[] = [Currency.CG, Currency.SOL, Currency.USDC, ...(skrEnabled ? [Currency.SKR] : [])];

  const quote = useMemo(() => {
    try { return quoteService(service.id, currency, { solUsd: floor.data?.solUsd, skrUsd: floor.data?.skrUsd }); } catch { return null; }
  }, [service.id, currency, floor.data?.solUsd, floor.data?.skrUsd]);

  async function submit() {
    const handle = input.trim();
    if (!available || !quote) return;
    if (isMock()) {
      await api.put('/me/handle', { handle, signature: 'mock' });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast({ kind: 'money', title: t('profile.handle.saved'), body: `@${handle}` });
      onClose();
      return;
    }
    if (!wallet || !cfg.data) return;
    try {
      setBusy('signing');
      const refHash = handleRefHash(isChange ? 1 : 0, wallet.publicKey, handle);
      const { signature } = await payForService({ connection, wallet, id: service.id, currency, refHash, quote, cfg: cfg.data });
      setBusy('claiming');
      // the backend grants the handle only once the payment is finalized (SEC-M5) — keep asking for ≈ 1–2 min
      await claimWithRetry(() => api.put('/me/handle', { handle, signature }));
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast({ kind: 'money', title: t('profile.handle.saved'), body: `@${handle}`, href: EXPLORER.tx(signature) });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: t('profile.handle.failed'), body: String((e as Error)?.message ?? e) });
    } finally {
      setBusy('idle');
    }
  }

  return (
    <Modal open onClose={onClose} title={isChange ? t('profile.handle.changeTitle') : t('profile.handle.title')}>
      <div className="stack">
        <div className="stack-sm">
          <label className="label">{t('profile.handle.label')}</label>
          <div className="row">
            <span className="mono muted">@</span>
            <input className="input mono" maxLength={16} autoFocus placeholder="rail_queen" value={input} onChange={(e) => setInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
          </div>
          <div className="tiny muted">{t('profile.handle.rules')}</div>
          {input && !valid && <div className="danger tiny">{t('profile.handle.invalid')}</div>}
          {valid && check.isFetching && <div className="tiny muted">{t('common.checking')}</div>}
          {valid && check.data && !check.data.available && <div className="danger tiny">{t(`profile.handle.reason.${check.data.reason ?? 'taken'}`)}</div>}
          {available && <div className="tiny" style={{ color: 'var(--acid)' }}>{t('profile.handle.available')}</div>}
        </div>

        <div className="stack-sm">
          <span className="label">{t('shop.payWith')}</span>
          <div className="tag-list">
            {currencies.map((c) => (
              <Pill key={c} active={currency === c} onClick={() => setCurrency(c)}>{CURRENCY_SYMBOLS[c]}{c === Currency.CG ? ` · ${t('services.burned')}` : ''}</Pill>
            ))}
          </div>
        </div>

        <CleanZone>
          <KV k={service.name} v={fmtCents(service.priceUsdCents)} />
          {quote && <KV total accent k={t('common.youSign')} v={fmtAmount(quote.amount, currency)} />}
          {!quote && <div className="tiny muted">{t('services.noQuote')}</div>}
          {isChange && <div className="tiny muted" style={{ marginTop: 6 }}>{t('profile.handle.changeNote')}</div>}
        </CleanZone>

        <div className="tiny muted">{t('services.howItWorks')}</div>
        <CleanConfirmButton disabled={!available || !quote || busy !== 'idle'} onClick={submit}>
          {busy === 'signing' ? t('common.signing') : busy === 'claiming' ? t('profile.handle.claiming') : t('profile.handle.cta')}
        </CleanConfirmButton>
      </div>
    </Modal>
  );
}

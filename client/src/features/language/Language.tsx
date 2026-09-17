// Language tab — a first-class screen (not buried in settings) because the
// user base is EN/PT/ES/VI/ID/FIL/RU and many Seeker devices ship with a
// system locale that is not the player's reading language. Each option is rendered in its own language
// so a player can always find their way home.
import { useState } from 'react';
import { LOCALES, LOCALE_META, useLocale, useT, type Locale } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { detectLocale } from '@/shared/i18n';

export default function Language() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const toast = useUiStore((s) => s.toast);
  const [busy, setBusy] = useState<Locale | null>(null);
  const detected = detectLocale();

  async function pick(l: Locale) {
    if (l === locale) return;
    setBusy(l);
    try {
      await setLocale(l);
      // toast in the *new* language — read straight from the loaded bundle
      toast({ kind: 'success', title: LOCALE_META[l].native, body: undefined });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('lang.title')}</h1>
        <p className="page-sub">{t('lang.subtitle')}</p>
      </div>

      <div className="lang-grid" role="radiogroup" aria-label={t('lang.title')}>
        {LOCALES.map((l) => {
          const m = LOCALE_META[l];
          const active = l === locale;
          return (
            <button
              key={l}
              role="radio"
              aria-checked={active}
              lang={m.tag}
              className={`lang-card${active ? ' active' : ''}`}
              disabled={busy !== null}
              onClick={() => void pick(l)}
            >
              <span className="lang-flag" aria-hidden>{m.flag}</span>
              <span className="lang-native">{m.native}</span>
              <span className="lang-english mono">{m.english}{l === detected ? ` · ${t('lang.auto', { name: '' }).replace(/\s*\(\)\s*$/, '')}` : ''}</span>
              {busy === l && <span className="lang-spinner" aria-hidden />}
            </button>
          );
        })}
      </div>

      <div className="tiny muted">{t('lang.current', { name: LOCALE_META[locale].native })}</div>
    </div>
  );
}

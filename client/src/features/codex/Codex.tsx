import { COLLECTIONS, RARITY_ORDER } from '@/shared/lib/lore';
import { ChipArt } from '@/shared/ui/ChipArt';
import { collectionColor } from '@/shared/lib/rarity';
import { useT } from '@/shared/i18n';

// Mirrors the marketing site's "The eight districts" gallery inside the app
// itself — same COLLECTIONS data (client/src/lib/lore.ts), same principle
// that rarity reads through color/glow/rim rather than circle size. This
// is a lore reference screen, not an ownership tracker: it doesn't check
// which of these 72 chips the connected wallet actually holds — that would
// mean cross-referencing every owned chip's ChipState against this catalog,
// which fits better as a filter on the Chips screen than duplicated here.

export default function Codex() {
  const t = useT();
  return (
    <div
      className="page"
      style={{
        minHeight: '100%',
        // backdrop: generated codex wall (client/public/bg/), veiled to keep text contrast.
        // `contain` shows the whole picture instead of cover-cropping it.
        backgroundImage:
          'linear-gradient(rgba(13,12,16,0.62), rgba(13,12,16,0.62)), url(/bg/game-codex.webp)',
        backgroundSize: 'contain',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'top center',
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <h1 className="page-title">{t('codex.title')}</h1>
        <p style={{ fontSize: 12, color: '#888', margin: '4px 0 0' }}>
          Every collection is a real district of Gutter City — its own scene, its own myth,
          nine chips running from a first throw-up to a one-of-one.
        </p>
      </div>

      {COLLECTIONS.map((col, ci) => (
        <div key={col.symbol} id={col.symbol} style={{ marginBottom: 28, borderTop: '1px solid #2a2a2a', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--cg-font-mono)', fontSize: 12, color: '#666' }}>{col.num}</span>
            <strong style={{ fontSize: 16, color: collectionColor(ci) }}>{col.name}</strong>
          </div>
          <p style={{ fontSize: 11, color: '#888', margin: '0 0 8px' }}>{col.district} · {col.theme}</p>
          <p style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5, margin: '0 0 12px' }}>{col.history}</p>

          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
            {col.caps.map((cap, i) => (
              <div key={cap.name} style={{ flex: '0 0 auto', width: 114, textAlign: 'center' }} title={`${RARITY_ORDER[i]}: ${cap.desc}`}>
                <div style={{ width: 96, margin: '0 auto 4px' }}><ChipArt collection={ci} rarity={i} imageUrl={`/art/${col.num}-${i}-256.webp`} /></div>
                <span style={{ fontSize: 10, color: '#888' }}>{RARITY_ORDER[i]}</span>
                <div style={{ fontSize: 10, color: '#666', lineHeight: 1.2, marginTop: 2 }}>{cap.name}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

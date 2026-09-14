import { COLLECTIONS, RARITY_ORDER } from '../lib/lore';

// Mirrors the marketing site's "The ten districts" gallery inside the app
// itself — same COLLECTIONS data (client/src/lib/lore.ts), same principle
// that rarity reads through color/glow/rim rather than circle size. This
// is a lore reference screen, not an ownership tracker: it doesn't check
// which of these 90 chips the connected wallet actually holds — that would
// mean cross-referencing every owned chip's ChipState against this catalog,
// which fits better as a filter on the Chips screen than duplicated here.

export function CodexScreen() {
  return (
    <div className="cg-brick-bg" style={{ padding: 16, minHeight: '100%' }}>
      <div style={{ marginBottom: 16 }}>
        <strong className="cg-heading" style={{ fontSize: 20 }}>The Ten Districts</strong>
        <p style={{ fontSize: 12, color: '#888', margin: '4px 0 0' }}>
          Every collection is a real district of Gutter City — its own scene, its own myth,
          nine chips running from a first throw-up to a one-of-one.
        </p>
      </div>

      {COLLECTIONS.map((col) => (
        <div key={col.symbol} style={{ marginBottom: 28, borderTop: '1px solid #2a2a2a', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--cg-font-mono)', fontSize: 12, color: '#666' }}>{col.num}</span>
            <strong style={{ fontSize: 16 }}>{col.name}</strong>
          </div>
          <p style={{ fontSize: 11, color: '#888', margin: '0 0 8px' }}>{col.district} · {col.theme}</p>
          <p style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5, margin: '0 0 12px' }}>{col.history}</p>

          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
            {col.caps.map((cap, i) => {
              const isDiamond = i === RARITY_ORDER.length - 1;
              const size = 44;
              return (
                <div key={cap.name} style={{ flex: '0 0 auto', width: size + 10, textAlign: 'center' }} title={`${RARITY_ORDER[i]}: ${cap.desc}`}>
                  <div
                    style={{
                      width: size, height: size, borderRadius: '50%', margin: '0 auto 4px',
                      background: col.color,
                      opacity: 0.15 + i * 0.09,
                      border: `${isDiamond ? 3 : 2}px solid ${col.color}`,
                      boxShadow: `0 0 ${6 + i * 3}px ${col.color}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, fontWeight: 700, color: '#fff',
                    }}
                  >
                    {col.name.charAt(0)}
                  </div>
                  <span style={{ fontSize: 9, color: '#666' }}>{RARITY_ORDER[i]}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

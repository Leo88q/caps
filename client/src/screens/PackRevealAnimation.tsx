import { useEffect, useState } from 'react';
import './reveal.css';

// Each tier gets its own effect vocabulary, not just a bigger version of
// the same one — see solana-chip-game-design-prompts-v2.md "TIER
// ESCALATION". `fx` picks which CSS effect class renders during the burst
// phase; holdMs/particles/shake still scale intensity within that language.
type FxKind = 'splash' | 'mural' | 'grind' | 'explosion' | 'diamond';

const TIER_CONFIG: Record<string, { holdMs: number; glow: string; particles: number; shake: boolean; fx: FxKind }> = {
  Common: { holdMs: 400, glow: '#8a8a8a', particles: 6, shake: false, fx: 'splash' },
  'Common+': { holdMs: 500, glow: '#16E5D9', particles: 8, shake: false, fx: 'splash' },
  Rare: { holdMs: 700, glow: '#16E5D9', particles: 14, shake: false, fx: 'mural' },
  'Rare+': { holdMs: 900, glow: '#2E8BFF', particles: 18, shake: false, fx: 'mural' },
  Epic: { holdMs: 1200, glow: '#FF2E8A', particles: 26, shake: false, fx: 'grind' },
  'Epic+': { holdMs: 1500, glow: '#FF7A1A', particles: 34, shake: true, fx: 'grind' },
  Legend: { holdMs: 1900, glow: '#FF7A1A', particles: 46, shake: true, fx: 'explosion' },
  'Legend+': { holdMs: 2300, glow: '#B6FF3C', particles: 58, shake: true, fx: 'explosion' },
  Diamond: { holdMs: 2800, glow: '#D8D8DC', particles: 72, shake: true, fx: 'diamond' },
};

type Phase = 'buildup' | 'burst' | 'reveal';

interface Props {
  rarity: string; // one of RARITY_LABELS from lib/program.ts
  chipName: string;
  chipImageUrl: string;
  isOnChain?: boolean; // shows the foil NFT badge on the revealed card
  onDone: () => void;
}

export function PackRevealAnimation({ rarity, chipName, chipImageUrl, isOnChain, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('buildup');
  const config = TIER_CONFIG[rarity] ?? TIER_CONFIG.Common;

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('burst'), config.holdMs);
    const t2 = setTimeout(() => setPhase('reveal'), config.holdMs + 550);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [config.holdMs]);

  const particles = Array.from({ length: config.particles }, (_, i) => i);
  const glowStyle = { '--glow-color': config.glow } as React.CSSProperties;

  return (
    <div className="reveal-backdrop" onClick={phase === 'reveal' ? onDone : undefined}>
      <div className={`reveal-stage ${config.shake && phase === 'burst' ? 'reveal-shake' : ''}`}>

        {phase !== 'reveal' && (
          <div className={`reveal-pack ${phase === 'burst' ? 'reveal-pack-burst' : 'reveal-pack-pulse'}`} style={glowStyle}>
            <div className="reveal-pack-shine" />
          </div>
        )}

        {phase === 'burst' && (
          <>
            {config.fx === 'splash' && <div className="reveal-fx-splash" style={glowStyle} />}
            {config.fx === 'mural' && <div className="reveal-fx-mural" style={glowStyle} />}
            {config.fx === 'grind' && <div className="reveal-fx-grind" style={glowStyle} />}
            {config.fx === 'explosion' && <div className="reveal-fx-explosion" style={glowStyle} />}
            {config.fx === 'diamond' && (
              <>
                <div className="reveal-fx-explosion" style={glowStyle} />
                <div className="reveal-fx-diamond-flash" />
              </>
            )}

            <div className="reveal-particles" style={glowStyle}>
              {particles.map((i) => (
                <span
                  key={i}
                  className="reveal-particle"
                  style={{ '--angle': `${(360 / particles.length) * i}deg`, '--delay': `${(i % 5) * 30}ms` } as React.CSSProperties}
                />
              ))}
            </div>
          </>
        )}

        {phase === 'reveal' && (
          <div className="reveal-chip-card" style={glowStyle}>
            {isOnChain && <div className="reveal-onchain-badge">NFT</div>}
            <div className="reveal-chip-glow" />
            <img src={chipImageUrl} alt={chipName} className="reveal-chip-image" />
            <p className="reveal-chip-rarity" style={{ color: config.glow }}>{rarity}</p>
            <p className="reveal-chip-name">{chipName}</p>
            <p className="reveal-tap-hint">Нажмите, чтобы продолжить</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Reward icons — the currency & prize set for the rewards panel (quests,
// pass, balances). Same construction rules as icons.tsx (design brief
// Block 6): 2-3 layered SVG shapes, one idle loop under 2.4s, one-shot
// activation on mount/tap. All colours come from the fixed palette tokens
// in theme.css — soft text variants where the icon sits next to copy.

import { useState } from 'react';
import './reward-icons.css';

function useActivation(durationMs: number) {
  const [active, setActive] = useState(false);
  const trigger = () => {
    setActive(true);
    setTimeout(() => setActive(false), durationMs);
  };
  return { active, trigger };
}

export type RewardKind = 'cg' | 'skr' | 'booster' | 'voucher' | 'streak' | 'stash';

interface IconProps {
  size?: number;
  onActivate?: () => void;
  className?: string;
}

/** $CG — a crimped bottle-cap coin: dashed crimp ring, dark face, paint drop. */
export function CgCoinIcon({ size = 20, onActivate, className }: IconProps) {
  const { active, trigger } = useActivation(700);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden
      className={`ric ric-cg ${active ? 'ric-active' : ''} ${className ?? ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <circle cx="16" cy="16" r="12" className="ric-cg-face" />
      <circle cx="16" cy="16" r="12" className="ric-cg-crimp" />
      <circle cx="16" cy="16" r="7.5" className="ric-cg-inner" />
      <path d="M16 10.5 C18.6 14.4 19.8 16.4 19.8 18.4 A3.8 3.8 0 0 1 12.2 18.4 C12.2 16.4 13.4 14.4 16 10.5 Z" className="ric-cg-drop" />
      <rect className="ric-cg-shine" x="4" y="4" width="5" height="24" rx="2.5" />
    </svg>
  );
}

/** $SKR — a skate wheel token: bearing core, speed lines trailing left. */
export function SkrTokenIcon({ size = 20, onActivate, className }: IconProps) {
  const { active, trigger } = useActivation(600);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden
      className={`ric ric-skr ${active ? 'ric-active' : ''} ${className ?? ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <g className="ric-skr-lines">
        <rect x="2" y="10" width="6" height="2" rx="1" />
        <rect x="1" y="15" width="7" height="2" rx="1" />
        <rect x="2" y="20" width="6" height="2" rx="1" />
      </g>
      <circle cx="20" cy="16" r="10.5" className="ric-skr-tire" />
      <circle cx="20" cy="16" r="5.5" className="ric-skr-bearing" />
      <circle cx="20" cy="16" r="1.8" className="ric-skr-core" />
    </svg>
  );
}

/** Booster — a pressurized spray can: gauge cap, rising pressure bubble. */
export function BoosterIcon({ size = 20, onActivate, className }: IconProps) {
  const { active, trigger } = useActivation(650);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden
      className={`ric ric-booster ${active ? 'ric-active' : ''} ${className ?? ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <g className="ric-booster-mist">
        <circle cx="24.5" cy="6" r="1.3" />
        <circle cx="28" cy="9.5" r="1" />
        <circle cx="26" cy="12.5" r="0.8" />
      </g>
      <rect x="9" y="10" width="12" height="18" rx="2.5" className="ric-booster-body" />
      <rect x="11" y="14" width="8" height="7" rx="1" className="ric-booster-label" />
      <rect x="12" y="6" width="6" height="4.5" rx="1" className="ric-booster-cap" />
      <rect x="14" y="3.5" width="2" height="3" rx="1" className="ric-booster-nozzle" />
      <circle className="ric-booster-bubble" cx="15" cy="25" r="1.6" />
    </svg>
  );
}

/** Cap voucher — a torn ticket with a punched cap hole and a dash perforation. */
export function VoucherIcon({ size = 20, onActivate, className }: IconProps) {
  const { active, trigger } = useActivation(700);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden
      className={`ric ric-voucher ${active ? 'ric-active' : ''} ${className ?? ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <path d="M5 8 L23 6 L27 9 L26 25 L8 27 L5 23 Z" className="ric-voucher-paper" />
      <path d="M18 6.5 L19.5 12 L17 11 L15.5 16 L14 11.5 L11.8 12.5 L13 7" className="ric-voucher-tear" />
      <circle cx="11" cy="20" r="4.2" className="ric-voucher-punch" />
      <circle cx="11" cy="20" r="2.4" className="ric-voucher-hole" />
      <g className="ric-voucher-perf">
        <rect x="18.5" y="17" width="5" height="1.6" rx="0.8" />
        <rect x="18.5" y="21" width="5" height="1.6" rx="0.8" />
      </g>
    </svg>
  );
}

/** Streak — a graffiti flame: outer orange burn, acid core, puddle base. */
export function StreakIcon({ size = 20, onActivate, className }: IconProps) {
  const { active, trigger } = useActivation(600);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden
      className={`ric ric-streak ${active ? 'ric-active' : ''} ${className ?? ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <ellipse cx="16" cy="27" rx="9" ry="2.2" className="ric-streak-puddle" />
      <path d="M16 3 C21 10 24 14 24 19 A8 8 0 0 1 8 19 C8 14 11 10 16 3 Z" className="ric-streak-flame" />
      <path d="M16 12 C18.4 15.4 19.6 17.2 19.6 19.6 A3.6 3.6 0 0 1 12.4 19.6 C12.4 17.2 13.6 15.4 16 12 Z" className="ric-streak-core" />
    </svg>
  );
}

/** Stash — the taped quest crate: plywood box, cap stencil on the lid. */
export function StashIcon({ size = 20, onActivate, className }: IconProps) {
  const { active, trigger } = useActivation(650);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden
      className={`ric ric-stash ${active ? 'ric-active' : ''} ${className ?? ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="5" y="12" width="22" height="15" rx="2" className="ric-stash-box" />
      <g className="ric-stash-lid">
        <rect x="4" y="8" width="24" height="5.5" rx="1.5" />
      </g>
      <rect x="14.5" y="8" width="3" height="5.5" className="ric-stash-tape" />
      <circle cx="16" cy="19.5" r="4" className="ric-stash-stencil-ring" />
      <circle cx="16" cy="19.5" r="1.6" className="ric-stash-stencil-dot" />
    </svg>
  );
}

/** Dispatcher so call sites can stay data-driven (quest leaves, pass track). */
export function RewardGlyph({ kind, size = 20, onActivate }: IconProps & { kind: RewardKind }) {
  switch (kind) {
    case 'cg': return <CgCoinIcon size={size} onActivate={onActivate} />;
    case 'skr': return <SkrTokenIcon size={size} onActivate={onActivate} />;
    case 'booster': return <BoosterIcon size={size} onActivate={onActivate} />;
    case 'voucher': return <VoucherIcon size={size} onActivate={onActivate} />;
    case 'streak': return <StreakIcon size={size} onActivate={onActivate} />;
    case 'stash': return <StashIcon size={size} onActivate={onActivate} />;
  }
}

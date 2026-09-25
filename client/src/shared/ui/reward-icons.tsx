// Reward icons — the currency & prize set for the rewards panel (quests,
// balances, pass). Faces are AI-generated spray-stencil badges
// (art_drafts/icons/gen → client/public/icons/gen/*.webp), processed to round
// 96px webp so they sit inline with text like the rest of the app's art.
// Stash has no generated face yet — it falls back to the vector crate until
// the next art batch lands.

interface IconProps {
  size?: number;
  onActivate?: () => void;
  className?: string;
}

export type RewardKind = 'cg' | 'skr' | 'booster' | 'voucher' | 'streak' | 'stash';

/** Generated faces that exist today (extend after the next art batch). */
export const REWARD_ICON_URL: Partial<Record<RewardKind, string>> = {
  cg: '/icons/gen/cg.webp',
  skr: '/icons/gen/skr.webp',
  booster: '/icons/gen/booster.webp',
  voucher: '/icons/gen/voucher.webp',
  streak: '/icons/gen/streak.webp',
};

function GenIcon({ url, size = 20, onActivate, className }: IconProps & { url: string }) {
  return (
    <img
      src={url}
      width={size}
      height={size}
      alt=""
      aria-hidden
      loading="eager"
      decoding="async"
      className={`gic ${className ?? ''}`}
      onClick={onActivate}
    />
  );
}

/** $CG — crimped cap coin with a paint droplet (acid green stencil). */
export function CgCoinIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/cg.webp" {...props} />;
}

/** $SKR — skate-wheel token (orange stencil). */
export function SkrTokenIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/skr.webp" {...props} />;
}

/** Booster — pressure can (magenta stencil). */
export function BoosterIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/booster.webp" {...props} />;
}

/** Cap voucher — torn ticket with a punched cap hole (cream stencil). */
export function VoucherIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/voucher.webp" {...props} />;
}

/** Streak — graffiti flame (orange + acid core). */
export function StreakIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/streak.webp" {...props} />;
}

// --- vector fallbacks (no generated face yet) -------------------------------

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

/** Stash — the taped quest crate (vector until its generated face lands). */
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
  const url = REWARD_ICON_URL[kind];
  if (url) return <GenIcon url={url} size={size} onActivate={onActivate} />;
  switch (kind) {
    case 'stash': return <StashIcon size={size} onActivate={onActivate} />;
    default: return null;
  }
}

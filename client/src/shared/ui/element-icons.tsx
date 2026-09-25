// Element glyphs — replace the old emoji map (🎨 ⚙️ 🛞 🔊 🌑) with hand-built
// street objects from the same family as icons.tsx. Static by design: these
// sit inside text lines (collection grid, arena squad, chip drawer) and must
// not flicker at the reader. Colours reuse the palette's soft text variants.
import type { Element } from '@/shared/lib/rarity';
import './reward-icons.css';

interface Props { element: Element; size?: number; className?: string; }

/** Paint — a loaded brush-nozzle mid-tag: blob, two drips, a splat dot. */
function PaintGlyph({ size = 14, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`ric ric-el ric-el-paint ${className ?? ''}`}>
      <path d="M8 6 C15 3 25 5 26 11 C27 16 22 17 17 16 C13 15.4 10 16 8.6 19 L6 15 C5 11 5 7.6 8 6 Z" className="rel-paint-blob" />
      <path d="M9.5 20.5 C10 23 9.6 25.4 8.6 27.4 C7.8 25.6 7.8 22.8 8.2 20.6 Z" className="rel-paint-drip" />
      <path d="M15 19 C15.4 21 15.2 22.8 14.6 24.4 C13.9 22.9 13.9 20.8 14.2 19.1 Z" className="rel-paint-drip" />
      <circle cx="27.5" cy="20" r="1.8" className="rel-paint-splat" />
      <circle cx="24" cy="24.5" r="1.1" className="rel-paint-splat" />
    </svg>
  );
}

/** Steel — a heavy hex nut with a washer and a bolt slit. */
function SteelGlyph({ size = 14, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`ric ric-el ric-el-steel ${className ?? ''}`}>
      <path d="M16 3.5 L26.5 9.5 L26.5 22 L16 28.5 L5.5 22 L5.5 9.5 Z" className="rel-steel-nut" />
      <circle cx="16" cy="16" r="6.4" className="rel-steel-hole" />
      <rect x="12.6" y="14.9" width="6.8" height="2.2" rx="1" className="rel-steel-slit" />
    </svg>
  );
}

/** Wheels — a skateboard wheel, quarter section, with a speed tick. */
function WheelsGlyph({ size = 14, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`ric ric-el ric-el-wheels ${className ?? ''}`}>
      <circle cx="17" cy="17" r="11" className="rel-wheels-tire" />
      <circle cx="17" cy="17" r="5" className="rel-wheels-bearing" />
      <circle cx="17" cy="17" r="1.6" className="rel-wheels-core" />
      <path d="M3.5 12.5 L9 10.5 M2.5 17.5 L8 17.5" className="rel-wheels-speed" />
    </svg>
  );
}

/** Noise — a megaphone horn with two pressure arcs. */
function NoiseGlyph({ size = 14, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`ric ric-el ric-el-noise ${className ?? ''}`}>
      <path d="M5 13 L13 13 L22 6.5 L22 25.5 L13 19 L5 19 Z" className="rel-noise-horn" />
      <rect x="7" y="19" width="5" height="8" rx="1.5" className="rel-noise-grip" />
      <path d="M25.5 11 C27.5 13.4 27.5 18.6 25.5 21" className="rel-noise-arc" />
      <path d="M28.4 8 C31.6 11.8 31.6 20.2 28.4 24" className="rel-noise-arc rel-noise-arc-b" />
    </svg>
  );
}

/** Shadow — a crescent cut from a chrome disc, three mist flecks. */
function ShadowGlyph({ size = 14, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`ric ric-el ric-el-shadow ${className ?? ''}`}>
      <path d="M20.5 3.5 A13 13 0 1 0 28.5 20.5 A11 11 0 0 1 20.5 3.5 Z" className="rel-shadow-moon" />
      <circle cx="25" cy="9" r="1.3" className="rel-shadow-fleck" />
      <circle cx="28" cy="14" r="0.9" className="rel-shadow-fleck" />
      <circle cx="24" cy="26" r="1.1" className="rel-shadow-fleck" />
    </svg>
  );
}

export function ElementGlyph({ element, size = 14, className }: Props) {
  switch (element) {
    case 'paint': return <PaintGlyph element={element} size={size} className={className} />;
    case 'steel': return <SteelGlyph element={element} size={size} className={className} />;
    case 'wheels': return <WheelsGlyph element={element} size={size} className={className} />;
    case 'noise': return <NoiseGlyph element={element} size={size} className={className} />;
    case 'shadow': return <ShadowGlyph element={element} size={size} className={className} />;
  }
}

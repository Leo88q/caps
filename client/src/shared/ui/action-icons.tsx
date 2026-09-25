// Small action icons — everything clickable that used to be a text dingbat
// (✕ ✓ ✗ ⚠ ↗ ↻ →) or a bare button. 20×20 grid, 2px rounded strokes,
// currentColor, no idle animation: these are controls, not décor.
interface Props { size?: number; className?: string; }

const base = (className?: string, extra = '') =>
  `aic ${extra} ${className ?? ''}`.trim();

/** Copy — two offset stencil sheets. */
export function CopyIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <rect x="11" y="11" width="16" height="16" rx="3" className="aic-stroke" />
      <path d="M21 7 L21 6 A3 3 0 0 0 18 3 L8 3 A3 3 0 0 0 5 6 L5 16 A3 3 0 0 0 8 19 L9 19" className="aic-stroke" />
    </svg>
  );
}

/** External link — arrow breaking out of a box (replaces ↗). */
export function ExternalIcon({ size = 14, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M14 8 L6 8 A2.5 2.5 0 0 0 3.5 10.5 L3.5 26 A2.5 2.5 0 0 0 6 28.5 L21.5 28.5 A2.5 2.5 0 0 0 24 26 L24 18" className="aic-stroke" />
      <path d="M19 4 L28 4 L28 13 M28 4 L15 17" className="aic-stroke" />
    </svg>
  );
}

/** Close — a sprayed X (replaces ✕). */
export function CloseIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M7 7 L25 25 M25 7 L7 25" className="aic-stroke" />
    </svg>
  );
}

/** Check — a fat marker tick (replaces ✓). */
export function CheckIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M5 17.5 L12.5 25 L27 7.5" className="aic-stroke" />
    </svg>
  );
}

/** Cross — a marker X for rejections (replaces ✗). */
export function CrossIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M7 7 L25 25 M25 7 L7 25" className="aic-stroke" />
      <circle cx="16" cy="16" r="12.5" className="aic-stroke aic-thin" />
    </svg>
  );
}

/** Alert — a leaning hazard triangle with a drip (replaces ⚠). */
export function AlertIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M16 4 L29.5 27 L2.5 27 Z" className="aic-stroke" strokeLinejoin="round" />
      <path d="M16 12 L16 19" className="aic-stroke" />
      <circle cx="16" cy="23" r="1.4" className="aic-fill" />
    </svg>
  );
}

/** Chevron — "see all / go" direction (replaces →). */
export function ChevronRightIcon({ size = 14, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M11 5 L22 16 L11 27" className="aic-stroke" />
    </svg>
  );
}

/** Server / RPC — two rack units with status lamps. */
export function ServerIcon({ size = 18, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <rect x="4" y="5" width="24" height="9" rx="2.5" className="aic-stroke" />
      <rect x="4" y="18" width="24" height="9" rx="2.5" className="aic-stroke" />
      <circle cx="9" cy="9.5" r="1.4" className="aic-fill" />
      <circle cx="9" cy="22.5" r="1.4" className="aic-fill" />
      <path d="M14 9.5 L24 9.5 M14 22.5 L24 22.5" className="aic-stroke aic-thin" />
    </svg>
  );
}

/** Shield — human check / verification. */
export function ShieldIcon({ size = 18, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M16 3 L27.5 7.5 C27.5 18 24 25.5 16 29 C8 25.5 4.5 18 4.5 7.5 Z" className="aic-stroke" strokeLinejoin="round" />
      <path d="M11 15.5 L14.5 19 L21.5 11.5" className="aic-stroke" />
    </svg>
  );
}

/** Sign out — a door swinging open with an arrow leaving. */
export function LogoutIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M13 4 L7 4 A2.5 2.5 0 0 0 4.5 6.5 L4.5 25.5 A2.5 2.5 0 0 0 7 28 L13 28" className="aic-stroke" />
      <path d="M20 10 L26 16 L20 22 M26 16 L12 16" className="aic-stroke" />
    </svg>
  );
}

/** Wrench — ops panel. */
export function WrenchIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M27.5 7 A7.5 7.5 0 0 1 17 16.8 L8 25.8 A3.2 3.2 0 0 1 3.5 21.3 L12.5 12.3 A7.5 7.5 0 0 1 22.3 1.8 L18 6.1 L23.2 11.3 Z" className="aic-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Reduced motion — a skate wheel with a slash through the spin arcs. */
export function MotionIcon({ size = 18, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <circle cx="13" cy="19" r="8" className="aic-stroke" />
      <circle cx="13" cy="19" r="2.2" className="aic-fill" />
      <path d="M24 8 C26.5 10.5 26.5 14.5 24.8 17" className="aic-stroke aic-thin" />
      <path d="M4 4 L28 28" className="aic-stroke" />
    </svg>
  );
}

/** Trash — clear local data. */
export function TrashIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M5 8 L27 8" className="aic-stroke" />
      <path d="M12 8 L12 5 A1.5 1.5 0 0 1 13.5 3.5 L18.5 3.5 A1.5 1.5 0 0 1 20 5 L20 8" className="aic-stroke" />
      <path d="M7.5 8 L9 27 A2 2 0 0 0 11 28.5 L21 28.5 A2 2 0 0 0 23 27 L24.5 8" className="aic-stroke" />
      <path d="M13.5 13 L13.5 23 M18.5 13 L18.5 23" className="aic-stroke aic-thin" />
    </svg>
  );
}

/** Spark — instant reveal / one-shot boost. */
export function SparkIcon({ size = 16, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M17 2 L19.6 10.8 L28.5 13.5 L19.6 16.2 L17 25 L14.4 16.2 L5.5 13.5 L14.4 10.8 Z" className="aic-fill" />
      <circle cx="26" cy="24" r="2" className="aic-fill aic-faded" />
      <circle cx="7" cy="25" r="1.4" className="aic-fill aic-faded" />
    </svg>
  );
}

/** Language tag — a speech bubble with crossing strokes (small size). */
export function LangIcon({ size = 18, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={base(className)}>
      <path d="M5 9 C5 6.8 6.6 5 8.5 5 L23.5 5 C25.4 5 27 6.8 27 9 L27 19 C27 21.2 25.4 23 23.5 23 L14 23 L8.5 28 L8.5 23 C6.6 23 5 21.2 5 19 Z" className="aic-stroke" strokeLinejoin="round" />
      <path d="M9.5 17.5 L13 10 L16.5 17.5 M10.8 15 L15.2 15" className="aic-stroke aic-thin" />
      <path d="M19 10.5 H23.5 M21.2 9 V10.5 C21.2 13.5 19.8 15.7 17.5 17 M19.6 13 C20.3 15.2 21.8 16.7 23.8 17.4" className="aic-stroke aic-thin" />
    </svg>
  );
}

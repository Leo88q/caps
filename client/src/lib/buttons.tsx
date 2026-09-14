import { useState, type ReactNode, type ButtonHTMLAttributes } from 'react';

// Every object-button fires a one-shot "activation" class for a moment,
// then removes it — see theme.css for what that class animates. Disabled
// buttons never fire (per Block 7: disabled = desaturated, no glow, no burst).
function useFire(durationMs: number, disabled?: boolean) {
  const [fired, setFired] = useState(false);
  const fire = () => {
    if (disabled) return;
    setFired(true);
    setTimeout(() => setFired(false), durationMs);
  };
  return { fired, fire };
}

interface ObjBtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

/** Primary action: buy pack, confirm, connect wallet. */
export function SprayNozzleButton({ children, onClick, disabled, ...rest }: ObjBtnProps) {
  const { fired, fire } = useFire(400, disabled);
  return (
    <button
      className={`cg-btn-primary ${fired ? 'cg-fired' : ''} ${disabled ? 'cg-btn-disabled' : ''}`}
      onClick={(e) => { fire(); onClick?.(e); }}
      disabled={disabled}
      {...rest}
    >
      <span className="cg-mist-puff" />
      <span className="cg-btn-label">{children}</span>
    </button>
  );
}

/** Secondary action: cancel, back, filters. */
export function DuctTapeButton({ children, onClick, disabled, ...rest }: ObjBtnProps) {
  const { fired, fire } = useFire(300, disabled);
  return (
    <button
      className={`cg-btn-tape ${fired ? 'cg-fired' : ''} ${disabled ? 'cg-btn-disabled' : ''}`}
      onClick={(e) => { fire(); onClick?.(e); }}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Destructive action: sell, discard, unstake. */
export function SpillCanButton({ children, onClick, disabled, ...rest }: ObjBtnProps) {
  const { fired, fire } = useFire(500, disabled);
  return (
    <button
      className={`cg-btn-spill ${fired ? 'cg-fired' : ''} ${disabled ? 'cg-btn-disabled' : ''}`}
      onClick={(e) => { fire(); onClick?.(e); }}
      disabled={disabled}
      {...rest}
    >
      {children}
      <span className="cg-drip-trail" />
    </button>
  );
}

/** Chip-specific action: open pack, list on marketplace, keep — the
 *  button IS a miniature chip. */
export function ChipButton({ children, onClick, disabled, ...rest }: ObjBtnProps) {
  const { fired, fire } = useFire(500, disabled);
  return (
    <button
      className={`cg-btn-chip ${fired ? 'cg-fired' : ''} ${disabled ? 'cg-btn-disabled' : ''}`}
      onClick={(e) => { fire(); onClick?.(e); }}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Clean-zone variant: wallet confirm, staking confirm, real-money purchase.
 *  Same silhouette family as SprayNozzleButton but chrome, with a checkmark
 *  stamp instead of mist — signals "this one spends real money." */
export function CleanConfirmButton({ children, onClick, disabled, ...rest }: ObjBtnProps) {
  const { fired, fire } = useFire(400, disabled);
  return (
    <button
      className={`cg-btn-clean ${fired ? 'cg-fired' : ''} ${disabled ? 'cg-btn-disabled' : ''}`}
      onClick={(e) => { fire(); onClick?.(e); }}
      disabled={disabled}
      {...rest}
    >
      {children}
      <span className="cg-check-stamp">✓</span>
    </button>
  );
}

/** Toggle: capped (grey) = off, uncapped+glow = on. */
export function SprayCapToggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <div className={`cg-toggle ${on ? 'cg-on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="cg-toggle-cap" />
      {label && <span style={{ fontSize: 13, color: '#aaa' }}>{label}</span>}
    </div>
  );
}

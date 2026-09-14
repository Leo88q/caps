import type { PackFlowState, PackPhase } from '@/chain/flows/packFlow';
import { EXPLORER } from '@/app/config';
import { shortKey } from '@/shared/lib/format';

const STEPS: { key: PackPhase[]; label: string; hint: string }[] = [
  { key: ['signing'], label: '1 · Pay & commit', hint: 'sign once' },
  { key: ['committed', 'revealing'], label: '2 · Oracle', hint: 'Switchboard reveals' },
  { key: ['opening'], label: '3 · Mint', hint: 'sign to open' },
  { key: ['done'], label: '4 · Caps', hint: 'in your wallet' },
];

export function PackStepper({ state, compact, onRefund }: { state: PackFlowState; compact?: boolean; onRefund?: () => void }) {
  const idx = STEPS.findIndex((s) => s.key.includes(state.phase));
  const errored = state.phase === 'error';
  const stale = state.phase === 'stale';
  return (
    <div className="stack-sm">
      <div className="stepper">
        {STEPS.map((s, i) => {
          const cls = errored && i === Math.max(0, idx) ? 'error' : i < idx || state.phase === 'done' ? 'done' : i === idx ? 'active' : '';
          return (
            <div key={s.label} className={`step ${cls}`}>
              <div className="strong">{s.label}</div>
              {!compact && <div className="tiny">{s.hint}</div>}
            </div>
          );
        })}
      </div>
      {state.phase === 'revealing' && (
        <div className="small muted">Waiting for the oracle{state.revealAttempt ? ` · attempt ${state.revealAttempt}` : ''}… this usually takes 2–6 s.</div>
      )}
      {state.phase === 'opening' && (
        <div className="small muted">Minting pack {state.opened.length + 1} of {state.qty}. Each pack needs one signature.</div>
      )}
      {errored && <div className="danger">{state.error}</div>}
      {stale && (
        <div className="warn row between">
          <span>The oracle did not answer in time. Your payment is safe in the vault.</span>
          {onRefund && <button className="btn btn-sm" onClick={onRefund}>Refund 100%</button>}
        </div>
      )}
      {!compact && (
        <div className="tiny muted row-wrap">
          {state.buySignature && <a href={EXPLORER.tx(state.buySignature)} target="_blank" rel="noreferrer">commit {shortKey(state.buySignature)} ↗</a>}
          {state.randomness && <a href={EXPLORER.account(state.randomness.toBase58())} target="_blank" rel="noreferrer">randomness {shortKey(state.randomness.toBase58())} ↗</a>}
          {state.openSignatures.map((s, i) => <a key={s} href={EXPLORER.tx(s)} target="_blank" rel="noreferrer">open #{i + 1} ↗</a>)}
        </div>
      )}
    </div>
  );
}

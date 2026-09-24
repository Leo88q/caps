// CU census for the localnet suite (G-6 table fuel).
//
// Every successful `Chain.send()` appends one JSON line to `target/cu-log.jsonl` via `recordCu()`.
// Append-only (not aggregate-in-memory) because vitest isolates modules PER SPEC FILE even with
// `singleFork` — a module-level Map would hold only the last file's transactions, each file
// overwriting the previous summary (proven by the first census run: 30 txs / 16 shapes, all setup
// plus the last file's prologue). The log is aggregated after the run by
// `scripts/ci-surface-cu.ts` (max CU + sample count per tx SHAPE).
//
// Labels are free-form (`buy_pack sku=standard qty=1 cur=SOL`, `open_pack #0`, `chip_core: pause`),
// so they are NORMALIZED to tx shapes before writing; anything unrecognized collapses to the
// raw label rather than to garbage. The census must never fail the suite: the append is sync,
// best-effort, and swallows all errors.
//
// NOTE: lines accumulate across LOCAL runs (target/ persists); CI starts each run with a fresh
// target dir, so the aggregation always covers exactly one run there. `rm target/cu-log.jsonl`
// for a clean local census.
import { appendFileSync, mkdirSync } from 'node:fs';

export const CU_LOG_PATH = 'target/cu-log.jsonl';

/** `buy_pack sku=standard qty=1 cur=SOL` → `buy_pack`; `open_pack #0` → `open_pack`; … */
export function normalizeCuLabel(label: string | undefined): string {
  let s = (label ?? '').trim();
  if (!s) return 'unlabeled';
  for (const cut of [' #', ' sku=', ' nonce=', ' qty=', ' cur=']) {
    const i = s.indexOf(cut);
    if (i > 0) s = s.slice(0, i);
  }
  s = s.replace(/\s*\([^)]*\)$/, ''); // `init_emission (future genesis)` → `init_emission`
  s = s.replace(/\s+\d+$/, ''); // `cancel compressed claim 3` → `cancel compressed claim`
  s = s.replace(/^[a-z_]+:\s+/, ''); // `chip_core: pauser pauses` → `pauser pauses`
  s = s.trim().slice(0, 64);
  return s || 'unlabeled';
}

export function recordCu(label: string | undefined, cu: bigint, signature: string, be: string): void {
  try {
    mkdirSync('target', { recursive: true });
    appendFileSync(
      CU_LOG_PATH,
      JSON.stringify({ key: normalizeCuLabel(label), cu: Number(cu), sig: signature, be }) + '\n',
    );
  } catch {
    // census must never fail the suite
  }
}

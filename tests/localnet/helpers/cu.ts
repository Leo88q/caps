// CU census for the localnet suite (G-6 table fuel).
//
// Every successful `Chain.send()` reports (label, CU) here via `recordCu()`, which FLUSHES
// `target/cu-summary.json` on every call — max CU + sample count per tx SHAPE. Flush-on-record
// (not on exit) because vitest terminates fork workers instead of letting them exit, so `exit`
// hooks never fire; the file is small (<10 KB) and txs number in the hundreds, so the cost is
// noise next to a transaction. Aggregation in module state is sound because the runner is
// single-fork (`vitest.config.mts`: pool `forks`, `singleFork`).
//
// Labels are free-form (`buy_pack sku=standard qty=1 cur=SOL`, `open_pack #0`, `chip_core: pause`),
// so they are NORMALIZED to tx shapes before aggregation; anything unrecognized collapses to the
// raw label rather than to garbage. The census must never fail the suite: the flush is sync,
// best-effort, and swallows all errors.
import { mkdirSync, writeFileSync } from 'node:fs';

export const CU_SUMMARY_PATH = 'target/cu-summary.json';

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

export interface CuRow {
  key: string;
  max: number;
  n: number;
  sample: string;
}

const census = new Map<string, CuRow>();
let backend = 'unknown';

export function recordCu(label: string | undefined, cu: bigint, signature: string, be: string): void {
  if (backend === 'unknown') backend = be;
  const key = normalizeCuLabel(label);
  const units = Number(cu);
  const row = census.get(key);
  if (!row) census.set(key, { key, max: units, n: 1, sample: signature });
  else {
    row.n += 1;
    if (units > row.max) {
      row.max = units;
      row.sample = signature;
    }
  }
  flushCuSummary();
}

/** Rows sorted by max CU descending — the hot paths first. */
export function cuSummary(): CuRow[] {
  return [...census.values()].sort((a, b) => b.max - a.max || (a.key < b.key ? -1 : 1));
}

function flushCuSummary(): void {
  try {
    mkdirSync('target', { recursive: true });
    const txs = [...census.values()].reduce((acc, r) => acc + r.n, 0);
    writeFileSync(
      CU_SUMMARY_PATH,
      JSON.stringify({ backend, generatedAt: new Date().toISOString(), txs, rows: cuSummary() }, null, 1) + '\n',
    );
  } catch {
    // census must never fail the suite
  }
}


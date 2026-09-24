// ci-surface-cu.ts <cu-log.jsonl> — aggregate the localnet CU census and publish it as ONE
// annotation, for readers who cannot open the log (same reason as ci-surface-junit.sh).
//
// Input: JSON lines from `recordCu()` (tests/localnet/helpers/cu.ts), one per successful tx.
// Output: the compact table on stdout, one capped `::notice`, and the aggregated
// `target/cu-summary.json` (uploaded as the `cu-summary` artifact — the surface step runs
// BEFORE the upload for exactly this reason).
//
// Budget: a check run keeps ~10 annotations total and truncates messages past ~3200 chars,
// so the table is compact (`max  count  key`), capped at ~40 rows / ~2900 chars, with an
// accounting line that keeps "cut off" distinguishable from "that was all of them".
// This script must never fail: missing/malformed input becomes a notice, exit is always 0.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const logFile = process.argv[2] ?? 'target/cu-log.jsonl';
const jsonOut = 'target/cu-summary.json';

interface CuLine {
  key?: string;
  cu?: number;
  sig?: string;
  be?: string;
}

interface CuRow {
  key: string;
  max: number;
  n: number;
  sample: string;
}

function notice(msg: string): void {
  const esc = msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::notice file=tests/localnet/helpers/cu.ts::${esc}\n`);
}

function main(): void {
  let text: string;
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    notice(`CU census: ${logFile} missing or unreadable (suite recorded no transactions)`);
    return;
  }
  const byKey = new Map<string, CuRow>();
  let backend = 'unknown';
  let txs = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let r: CuLine;
    try {
      r = JSON.parse(t) as CuLine;
    } catch {
      continue; // tolerate corrupt lines (a killed worker mid-append)
    }
    if (typeof r.key !== 'string' || typeof r.cu !== 'number') continue;
    txs += 1;
    if (backend === 'unknown' && typeof r.be === 'string') backend = r.be;
    const row = byKey.get(r.key);
    if (!row) byKey.set(r.key, { key: r.key, max: r.cu, n: 1, sample: r.sig ?? '' });
    else {
      row.n += 1;
      if (r.cu > row.max) {
        row.max = r.cu;
        row.sample = r.sig ?? '';
      }
    }
  }
  const rows = [...byKey.values()].sort((a, b) => b.max - a.max || (a.key < b.key ? -1 : 1));
  try {
    mkdirSync('target', { recursive: true });
    writeFileSync(
      jsonOut,
      JSON.stringify({ backend, generatedAt: new Date().toISOString(), txs, rows }, null, 1) + '\n',
    );
  } catch {
    // artifact write is best-effort; the annotation below still carries the table
  }
  if (rows.length === 0) {
    notice(`CU census (${backend}): no transactions recorded`);
    return;
  }
  const MAX_ROWS = 40;
  const shown = rows.slice(0, MAX_ROWS);
  const head = `CU census max-per-tx-shape (${backend}, ${txs} txs, ${rows.length} shapes):`;
  const lines = shown.map((r) => `${String(r.max).padStart(7)}  x${String(r.n).padStart(3)}  ${r.key}`);
  // human-readable copy for the log, then the annotation
  process.stdout.write([head, ...lines].join('\n') + '\n');
  let body = [head, ...lines].join('\n');
  const cut = rows.length - shown.length;
  if (cut > 0) body += `\n... ${cut} more shapes in the cu-summary artifact`;
  if (body.length > 2900) body = body.slice(0, 2900) + '...(cut)';
  notice(body);
}

main();

// ci-surface-cu.ts <cu-summary.json> — publish the localnet CU census as ONE annotation,
// for readers who cannot open the log (same reason as ci-surface-junit.sh).
//
// Budget: a check run keeps ~10 annotations total and truncates messages past ~3200 chars,
// so the table is compact (`max  count  key`), capped at ~40 rows / ~2900 chars, with an
// accounting line that keeps "cut off" distinguishable from "that was all of them".
// This script must never fail: missing/malformed input becomes a notice, exit is always 0.
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'target/cu-summary.json';

interface CuFile {
  backend?: string;
  txs?: number;
  rows?: { key: string; max: number; n: number }[];
}

function notice(msg: string): void {
  const esc = msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::notice file=tests/localnet/helpers/cu.ts::${esc}\n`);
}

function main(): void {
  let json: CuFile;
  try {
    json = JSON.parse(readFileSync(file, 'utf8')) as CuFile;
  } catch {
    notice(`CU census: ${file} missing or unreadable (suite did not reach the census flush)`);
    return;
  }
  const rows = Array.isArray(json.rows) ? json.rows : [];
  if (rows.length === 0) {
    notice(`CU census (${json.backend ?? 'unknown'}): no transactions recorded`);
    return;
  }
  const MAX_ROWS = 40;
  const shown = rows.slice(0, MAX_ROWS);
  const head = `CU census max-per-tx-shape (${json.backend ?? 'unknown'}, ${json.txs ?? '?'} txs, ${rows.length} shapes):`;
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

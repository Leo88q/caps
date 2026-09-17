// LT-3 (docs/06 §7): measure what a full re-index of the chain log actually costs, on a deterministic
// synthetic history. `backend/test/replay.test.ts` proves the *correctness* of a rebuild (live index and
// replay-from-raw land on the same state); this answers the other half of the question — how long the
// recovery takes, because that number is the RPO of the read model. If a rebuild of the whole history takes
// 40 minutes, an operator cannot "just rebuild" during an incident, and the honest fix is a replica instead.
//
//   npm run load:lt3                      # 1M events, file-backed, prints ingest + rebuild throughput
//   LT3_EVENTS=200000 npm run load:lt3    # a tier that fits a CI job's patience
//
// Nothing here talks to an RPC: the fixture stream is the same `walkHistory` the unit tests assert on, so
// the measurement and the correctness proof describe one corpus, not two.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, PROJECTION_TABLES } from '../../backend/src/db.ts';
import { ingestTx, replayStored } from '../../backend/src/ingest.ts';
import { walkHistory } from '../../backend/test/chainHistory.ts';

const EVENTS = Math.max(1_000, Number(process.env.LT3_EVENTS ?? 1_000_000));
/** txs to walk before the event budget runs out (the walk stops at `maxEvents` itself) */
const TXS = Math.ceil(EVENTS / 0.8);
const FLOOR = Number(process.env.LT3_MIN_EVENTS_PER_S ?? 4_000);
const keep = process.env.LT3_KEEP === '1';

const dir = mkdtempSync(join(tmpdir(), 'gc-lt3-bench-'));
const path = join(dir, keep ? 'keep.sqlite' : 'lt3.sqlite');
const started = Date.now();
let txs = 0, eventsSeen = 0, inserted = 0, failed = 0;
const db = new Db(path);

const t0 = performance.now();
for (const t of walkHistory({ txs: TXS, maxEvents: EVENTS })) {
  txs++;
  if (t.err) { failed++; continue; }
  const r = ingestTx(t, db);
  eventsSeen += r.events;
  inserted += r.inserted;
  if (txs % 25_000 === 0) console.log(`[lt3] ${txs} tx, ${inserted} events indexed… ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
const ingestMs = performance.now() - t0;
const rows = db.scalar(`SELECT COUNT(*) FROM events_raw`);

const t1 = performance.now();
const rebuilt = replayStored(db);
const rebuildMs = performance.now() - t1;
const sizeMb = (db.scalar(`SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()`) as number) / 1024 / 1024;
const counts = PROJECTION_TABLES.map((t) => `${t}=${db.scalar(`SELECT COUNT(*) FROM ${t}`)}`);

const rate = (n: number, ms: number) => Math.floor((n / Math.max(1, ms)) * 1000);
const ingestRate = rate(rows, ingestMs);
const rebuildRate = rate(rebuilt, rebuildMs);
const fmt = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

console.log(`
[lt3] corpus            ${txs} txs · ${rows} events stored (${eventsSeen} decoded, ${eventsSeen - rows} deduped, ${failed} failed txs ignored)
[lt3] database          ${path} · ${sizeMb.toFixed(1)} MB
[lt3] live ingest       ${fmt(ingestMs)} → ${ingestRate} events/s
[lt3] rebuild           ${fmt(rebuildMs)} → ${rebuildRate} events/s   (replayed ${rebuilt} events into ${PROJECTION_TABLES.length} tables)
[lt3] 1M events at this rate: rebuild ≈ ${fmt((1_000_000 / Math.max(1, rebuildRate)) * 1000)}
[lt3] projections       ${counts.join(' ')}
`);
db.close();
if (!keep) rmSync(dir, { recursive: true, force: true });
else console.log(`[lt3] kept at ${path}`);

// The floor is a regression gate, not a benchmark record: it is set ~5× under what the box measures, so a
// shared CI runner still passes it while an accidental O(n²) in a projection does not.
if (rebuildRate < FLOOR) {
  console.error(`[lt3] FAIL: rebuild ${rebuildRate} events/s < floor ${FLOOR} events/s — replay cost regressed (docs/09 §4.4)`);
  process.exit(1);
}
if (rows < EVENTS * 0.5) {
  console.error(`[lt3] FAIL: only ${rows} of ~${EVENTS} events were indexed — the fixture stream stopped early`);
  process.exit(1);
}
console.log(`[lt3] ok — ${rows} events, rebuild ${rebuildRate} events/s ≥ floor ${FLOOR} (${Date.now() - started} ms wall)`);

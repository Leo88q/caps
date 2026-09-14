// Drop every projection table and replay events_raw. Use after changing
// projections.ts or when a projection looks wrong — raw events are the truth.
import { db, PROJECTION_TABLES } from './db.ts';
import { replayStored } from './ingest.ts';

export function rebuild(log: (s: string) => void = console.log) {
  const d = db();
  d.tx(() => { for (const t of PROJECTION_TABLES) d.run(`DELETE FROM ${t}`); });
  // wallets are kept: handles / referrers / risk scores are not derivable from chain events
  const n = replayStored(d, (k) => log(`[rebuild] ${k} events…`));
  log(`[rebuild] replayed ${n} events into ${PROJECTION_TABLES.length} tables`);
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) rebuild();

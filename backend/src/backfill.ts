// Historical half of the indexer. For each program: walk
// getSignaturesForAddress backwards from the tip until we reach the signature
// recorded in indexer_cursor (or the start of history). Pages are ingested
// oldest-first inside each page; the cursor is only advanced once the whole
// walk finished, so a crash mid-way simply re-scans (inserts are idempotent).
//
//   npm run backfill                # all four programs
//   npm run backfill -- market      # one program
import { BACKFILL_CONCURRENCY, BACKFILL_PAGE, PROGRAMS, PROGRAM_NAMES, RPC_URL, type ProgramName } from './config.ts';
import { getConnection, getCursor, ingestSignatures, setCursor } from './ingest.ts';

export async function backfillProgram(program: ProgramName, log: (s: string) => void = console.log) {
  const connection = getConnection();
  const address = PROGRAMS[program];
  const cursor = getCursor(program);
  const stopAt = cursor?.newest_signature ?? null;

  let before: string | undefined;
  let newest: { signature: string; slot: number } | null = null;
  let scanned = 0, events = 0, inserted = 0, reachedCursor = false;

  log(`[backfill:${program}] ${address.toBase58()} on ${RPC_URL} ${stopAt ? `→ back to ${stopAt.slice(0, 8)}…` : '(full history)'}`);

  while (true) {
    const page = await connection.getSignaturesForAddress(address, { before, limit: BACKFILL_PAGE }, 'confirmed');
    if (page.length === 0) break;
    if (!newest) newest = { signature: page[0].signature, slot: page[0].slot };

    const stopIdx = stopAt ? page.findIndex((s) => s.signature === stopAt) : -1;
    const slice = stopIdx >= 0 ? page.slice(0, stopIdx) : page;
    const r = await ingestSignatures(connection, slice, BACKFILL_CONCURRENCY);
    scanned += slice.length; events += r.events; inserted += r.inserted;
    log(`[backfill:${program}] page … ${slice.length} tx, ${r.inserted} new events (total ${inserted})`);

    if (stopIdx >= 0) { reachedCursor = true; break; }
    before = page[page.length - 1].signature;
    if (page.length < BACKFILL_PAGE) break;
  }

  if (newest) setCursor(program, { newest_signature: newest.signature, newest_slot: newest.slot, history_complete: 1 });
  else if (!cursor) setCursor(program, { history_complete: 1 });
  log(`[backfill:${program}] done: ${scanned} tx scanned, ${events} events seen, ${inserted} new${reachedCursor ? ' (caught up to cursor)' : ''}`);
  return { scanned, events, inserted };
}

export async function backfillAll(only?: ProgramName[]) {
  for (const p of only ?? PROGRAM_NAMES) await backfillProgram(p);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.slice(2).filter((a): a is ProgramName => (PROGRAM_NAMES as string[]).includes(a));
  backfillAll(only.length ? only : undefined).catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}

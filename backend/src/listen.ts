// Real-time half of the indexer: one `onLogs` websocket subscription per
// program. Because a websocket only shows what happens while it is up, the
// listener also (a) runs a backfill on start and (b) every LISTEN_HEAL_EVERY_MS
// re-scans the newest LISTEN_HEAL_DEPTH signatures per program, which closes
// any gap from a dropped connection without operator intervention.
//
// Production note (docs/03-architecture.md §3.1): the same `ingestTx` is the
// handler for Helius enhanced webhooks — WS is the fallback path there.
import { COMMITMENT, LISTEN_HEAL_DEPTH, LISTEN_HEAL_EVERY_MS, LISTEN_RECONNECT_MS, PROGRAMS, PROGRAM_NAMES, RPC_URL, type ProgramName } from './config.ts';
import { backfillProgram } from './backfill.ts';
import { getConnection, ingestSignatures, ingestTx, sleep } from './ingest.ts';

export async function listen(log: (s: string) => void = console.log) {
  const connection = getConnection();
  log(`[listen] ${RPC_URL} — subscribing to ${PROGRAM_NAMES.join(', ')}`);

  // 1. catch up first, so projections are consistent before live events arrive
  for (const p of PROGRAM_NAMES) {
    try { await backfillProgram(p, log); } catch (e) { log(`[listen] initial backfill for ${p} failed: ${(e as Error).message}`); }
  }

  // 2. live subscriptions
  const subs = new Map<ProgramName, number>();
  const subscribe = (p: ProgramName) => {
    const id = connection.onLogs(
      PROGRAMS[p],
      (info, ctx) => {
        if (info.err) return;
        try {
          const r = ingestTx({ signature: info.signature, slot: ctx.slot, blockTime: null, logs: info.logs, err: null });
          if (r.inserted > 0) log(`[live:${p}] ${info.signature.slice(0, 8)}… +${r.inserted} events`);
        } catch (e) {
          log(`[live:${p}] ingest error ${info.signature}: ${(e as Error).message}`);
        }
      },
      COMMITMENT,
    );
    subs.set(p, id);
  };
  for (const p of PROGRAM_NAMES) subscribe(p);

  // 3. gap healer — cheap, idempotent, also fills block_time for rows first seen over WS
  const heal = async () => {
    for (const p of PROGRAM_NAMES) {
      try {
        const page = await connection.getSignaturesForAddress(PROGRAMS[p], { limit: LISTEN_HEAL_DEPTH }, 'confirmed');
        const r = await ingestSignatures(connection, page, 2);
        if (r.inserted > 0) log(`[heal:${p}] recovered ${r.inserted} missed events`);
      } catch (e) {
        log(`[heal:${p}] ${(e as Error).message}`);
      }
    }
  };
  const timer = setInterval(() => void heal(), LISTEN_HEAL_EVERY_MS);

  const stop = async () => {
    clearInterval(timer);
    for (const [, id] of subs) { try { await connection.removeOnLogsListener(id); } catch { /* closing */ } }
  };
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });

  // web3.js reconnects the socket itself; if the process-level socket dies we simply restart the loop
  while (true) await sleep(LISTEN_RECONNECT_MS);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listen().catch((err) => {
    console.error('Listener crashed:', err);
    process.exit(1);
  });
}

// Liveness vs readiness, plus the payload /metrics scrapes (docs/09 §4.1).
//
//   /healthz — the process is up and can answer. Never touches the DB or the RPC, so it cannot be the
//              reason a load balancer removes a pod that is merely lagging (that is readiness' job).
//   /readyz  — safe to route traffic to: DB readable, projections present, indexer not further behind
//              than the configured ceiling, Pyth cache fresh enough to price a pack. A 503 here is what
//              makes a rolling deploy lossless and what gives `depends_on: condition: service_healthy`
//              in compose any meaning.
//
// Slot lag, not wall-clock freshness, is the ingest signal: `block_time` is only known once the block
// has been fetched, so a healthy devnet with one player would look stale. When the RPC is unreachable
// the lag is reported as `unknown` and skipped — an RPC outage must not turn every replica unready.
import type { Connection } from '@solana/web3.js';
import { type Db } from './db.ts';
import { crankStatus, priceStatus } from './queries.ts';

/** Readiness gives the RPC this much time before the slot is treated as unknown. */
export const HEALTH_RPC_TIMEOUT_MS = Number(process.env.HEALTH_RPC_TIMEOUT_MS ?? 1_500);
/** A Pyth cache older than this cannot price a pack honestly (quote would be stale for the program). */
export const READY_MAX_PRICE_AGE_MS = Number(process.env.READY_MAX_PRICE_AGE_MS ?? 120_000);
/** Slots behind which trips readiness. 0 disables. ~600 = 4 minutes of mainnet slots. */
export const READY_MAX_INGEST_LAG_SLOTS = Number(process.env.READY_MAX_INGEST_LAG_SLOTS ?? 600);

export interface Readiness {
  ready: boolean;
  db: boolean;
  lastSlot: number;
  rpcSlot: number | null;
  ingestLagSlots: number | null;
  prices: { feeds: string[]; worstAgeS: number | null };
  crank: ReturnType<typeof crankStatus>;
  wsClients: number;
  problems: string[];
}

export interface ReadinessDeps {
  /** Omitted in tests / `--no-rpc`: rpcSlot is null and the slot-lag problem is skipped. */
  connection?: () => Connection;
  wsClients?: () => number;
  nowMs?: number;
}

export async function readiness(db: Db, deps: ReadinessDeps = {}): Promise<Readiness> {
  const nowMs = deps.nowMs ?? Date.now();
  const problems: string[] = [];

  let lastSlot = 0;
  let dbOk = false;
  try {
    db.scalar(`SELECT 1`);
    lastSlot = db.scalar(`SELECT COALESCE(MAX(slot), 0) FROM events_raw`);
    dbOk = true;
  } catch (e) {
    problems.push(`db not readable: ${(e as Error).message}`);
  }

  let rpcSlot: number | null = null;
  if (dbOk && deps.connection) {
    try { rpcSlot = await withTimeout(Promise.resolve(deps.connection().getSlot('confirmed')), HEALTH_RPC_TIMEOUT_MS); }
    catch (e) { problems.push(`rpc slot read failed: ${(e as Error).message}`); }
  }
  const ingestLagSlots = rpcSlot === null ? null : Math.max(0, rpcSlot - lastSlot);

  let crank = { pending: 0, stale: 0, settled: 0, closed: 0, abandoned: 0, headAgeS: null as number | null, lastActivity: null as string | null, healthy: true };
  let prices: Readiness['prices'] = { feeds: [], worstAgeS: null };
  if (dbOk) {
    try {
      crank = crankStatus(db, nowMs);
      if (crank.abandoned > 0) problems.push(`${crank.abandoned} abandoned crank job(s) — manual reveal needed (docs/06 §3.3)`);
      if (!crank.healthy) problems.push(`crank unhealthy (pending ${crank.pending}, head ${crank.headAgeS ?? 'n/a'} s old)`);
    } catch { /* crank_jobs absent in a minimal fixture db */ }
    try {
      const p = priceStatus(db);
      const ages = Object.values(p.feeds as Record<string, { ageS: number | null }>).map((f) => f.ageS).filter((a): a is number => a !== null);
      prices = { feeds: Object.keys(p.feeds), worstAgeS: ages.length ? Math.max(...ages) : null };
      if (READY_MAX_PRICE_AGE_MS > 0 && (ages.length === 0 || Math.max(...ages) * 1000 > READY_MAX_PRICE_AGE_MS)) {
        problems.push(ages.length === 0 ? 'no cached Pyth price (quote path cannot serve)' : `Pyth cache ${Math.max(...ages)} s old (>${READY_MAX_PRICE_AGE_MS / 1000} s)`);
      }
    } catch { /* oracle_prices absent */ }
  }

  if (!dbOk) problems.push('db not readable');
  else if (lastSlot === 0) problems.push('no events ingested yet (backfill not complete)');
  if (ingestLagSlots !== null && READY_MAX_INGEST_LAG_SLOTS > 0 && ingestLagSlots > READY_MAX_INGEST_LAG_SLOTS) {
    problems.push(`indexer ${ingestLagSlots} slots behind (>${READY_MAX_INGEST_LAG_SLOTS})`);
  }

  return { ready: problems.length === 0, db: dbOk, lastSlot, rpcSlot, ingestLagSlots, prices, crank, wsClients: deps.wsClients?.() ?? 0, problems };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`rpc call timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e as Error); });
  });
}

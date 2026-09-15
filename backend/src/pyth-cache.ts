// pyth-cache worker — mirrors our two Pyth price accounts into `oracle_prices`
// every PYTH_CACHE_EVERY_MS (10 s) so the read models (/services quotes,
// /market/floor USD, /stats) and /packs/quote never use a price the chain would
// reject. It is a READER: the prices are posted by the price pusher in
// ops/pyth-pusher/ (owner decision Q7). When a feed is stale/missing the row is
// left untouched and `prices()` falls back to the last good value for display
// only — quotes for on-chain amounts refuse instead (services/quote.ts).
//
//   npm run pyth-cache            # standalone
//   npm run dev                   # runs listen + api + pyth-cache together
import { PYTH_CACHE_EVERY_MS, RPC_URL } from './config.ts';
import { db as sharedDb, type Db } from './db.ts';
import { getConnection, sleep } from './ingest.ts';
import { cachePrice, fetchFeeds, priceAccountFor, PythError } from './pyth.ts';

export async function refreshOnce(db: Db, log: (s: string) => void = () => {}): Promise<{ ok: number; failed: number }> {
  const feeds = await fetchFeeds(getConnection());
  let ok = 0, failed = 0;
  for (const symbol of ['SOL', 'SKR'] as const) {
    const f = feeds[symbol];
    if (f instanceof PythError) { failed++; log(`[pyth-cache] ${symbol}: ${f.code} — ${f.message}`); continue; }
    cachePrice(db, symbol, f);
    ok++;
  }
  return { ok, failed };
}

export async function pythCache(log: (s: string) => void = console.log) {
  const db = sharedDb();
  log(`[pyth-cache] ${RPC_URL} — SOL ${priceAccountFor('SOL').toBase58()} · SKR ${priceAccountFor('SKR').toBase58()} every ${PYTH_CACHE_EVERY_MS} ms`);
  let lastState = '';
  while (true) {
    try {
      const r = await refreshOnce(db, log);
      const state = `${r.ok}/${r.ok + r.failed}`;
      if (state !== lastState) { log(`[pyth-cache] feeds healthy: ${state}`); lastState = state; }
    } catch (e) {
      log(`[pyth-cache] rpc error: ${(e as Error).message}`);
    }
    await sleep(PYTH_CACHE_EVERY_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  pythCache().catch((err) => {
    console.error('pyth-cache crashed:', err);
    process.exit(1);
  });
}

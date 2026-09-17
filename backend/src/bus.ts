// Event fan-out: indexer ingest → WebSocket clients (docs/09 §4.1).
//
// Why this exists at all: `listen.ts` (writes the projections) and `serve.ts` (owns the sockets) are
// separate processes, so an in-process emitter would look correct in `npm run dev`'s single-process
// tests and silently deliver nothing in production. Hence two transports:
//   inproc — the default. Publisher and subscriber share the module singleton; used by tests and by
//            any deployment where one process both indexes and serves (`API_INGEST=1`, docker-compose
//            `api` with LISTEN_INPROC).
//   redis  — `EVENT_BUS=redis` + REDIS_URL: PUBLISH on a channel, SUBSCRIBE in the API process. One
//            hop through Redis, ~sub-millisecond, and it survives multiple API replicas.
// A no-transport (`off`) sink is what every call site sees before `installBus` runs, so ingest never
// depends on the socket layer and a bus failure can never fail an ingest.
export interface BusMessage {
  /** Wallets that should refetch. Empty = broadcast to every socket (market-wide events). */
  wallets: string[];
  type: string;
  payload: Record<string, unknown>;
  slot?: number;
}
export interface EventBus {
  readonly kind: 'off' | 'inproc' | 'redis';
  publish(m: BusMessage): void;
  subscribe(onMessage: (m: BusMessage) => void): () => void;
  close(): Promise<void>;
}

const CHANNEL = process.env.EVENT_BUS_CHANNEL || 'chip:events';

/** Wallet-ish fields an on-chain event may name. Over-notifying is harmless (a socket only ever
 *  receives frames for the wallet it subscribed with); under-notifying would mean a stale UI. */
const WALLET_KEYS = ['owner', 'buyer', 'seller', 'bidder', 'opponent', 'challenger', 'winner', 'claimer', 'staker', 'wallet', 'funder', 'by', 'to', 'admin'] as const;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Which wallets care about this event, derived from its decoded payload. */
export function walletsOf(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const out = new Set<string>();
  for (const k of WALLET_KEYS) {
    const v = data[k];
    if (typeof v === 'string' && B58.test(v)) out.add(v); // a program-authority field is not a wallet, and `admin` is: the pauser wants to see its own change
  }
  // arrays of {wallet|owner} (e.g. rewards settled for many stakers in one tx)
  for (const v of Object.values(data)) {
    if (!Array.isArray(v)) continue;
    for (const item of v.slice(0, 64)) {
      const w = (item as Record<string, unknown> | undefined)?.wallet ?? (item as Record<string, unknown> | undefined)?.owner;
      if (typeof w === 'string' && B58.test(w)) out.add(w);
    }
  }
  return [...out];
}

function createInproc(): EventBus {
  const subs = new Set<(m: BusMessage) => void>();
  return {
    kind: 'inproc',
    publish(m) { for (const fn of subs) { try { fn(m); } catch { /* a bad socket must not break ingest */ } } },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async close() { subs.clear(); },
  };
}

async function createRedis(url: string): Promise<EventBus> {
  const { Redis } = await import('ioredis');
  const pub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  const sub = new Redis(url, { maxRetriesPerRequest: null });
  const subs = new Set<(m: BusMessage) => void>();
  await sub.subscribe(CHANNEL);
  sub.on('message', (_ch: string, raw: string) => {
    let m: BusMessage;
    try { m = JSON.parse(raw) as BusMessage; } catch { return; }
    for (const fn of subs) { try { fn(m); } catch { /* ignore */ } }
  });
  pub.on('error', () => { /* ioredis retries; publish between failures is dropped, and polling covers it */ });
  return {
    kind: 'redis',
    publish(m) { try { void pub.publish(CHANNEL, JSON.stringify(m)).catch(() => undefined); } catch { /* ignore */ } },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async close() { subs.clear(); try { await sub.quit(); } catch { /* ignore */ } try { await pub.quit(); } catch { /* ignore */ } },
  };
}

const NOOP: EventBus = { kind: 'off', publish() { /* no bus installed yet */ }, subscribe: () => () => undefined, async close() { /* nothing */ } };

let installed: EventBus = NOOP;

/** Install the process-wide bus. Idempotent; a second call replaces the first (tests). */
export async function installBus(kind: 'off' | 'inproc' | 'redis' = (process.env.EVENT_BUS as 'off' | 'inproc' | 'redis') ?? 'inproc', url = process.env.REDIS_URL): Promise<EventBus> {
  if (installed !== NOOP) await installed.close().catch(() => undefined);
  if (kind === 'redis') {
    if (!url) { logBusWarn('EVENT_BUS=redis without REDIS_URL — falling back to the in-process bus'); installed = createInproc(); return installed; }
    try { installed = await createRedis(url); return installed; } catch (e) {
      logBusWarn(`redis bus unavailable (${(e as Error).message}) — falling back to the in-process bus`);
    }
  }
  installed = kind === 'inproc' ? createInproc() : NOOP;
  return installed;
}
const logBusWarn = (msg: string) => { if (process.env.NODE_ENV !== 'test') process.stderr.write(`[bus] ${msg}\n`); };

export function bus(): EventBus { return installed; }
export function publish(m: BusMessage): void { installed.publish(m); }
export const BUS_CHANNEL = CHANNEL;

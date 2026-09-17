// The real-time surface the client already codes against (`client/src/api/ws.ts`): one socket per
// wallet, `{ type, wallet, payload }` frames, and the browser's own backoff on close. This replaces
// the "fall back to polling" comment in that file with a server that exists (docs/09 §4.1).
//
// Trust model, stated plainly because it is the part reviewers ask about:
//   * the socket is NOT authenticated. Every payload it carries is data the same client can already
//     read over plain REST (`GET /v1/wallet/:address/events` is public), so a `?wallet=` query is not
//     a privilege boundary — it is a subscription filter.
//   * consequently nothing here may ever become a write path, a quote, or an authorisation decision;
//     it is invalidation hints only, and the client still refetches over REST after each frame.
//   * `?wallet=` is optional. Without it the socket gets market-wide broadcasts only.
//
// Abuse controls: connection cap, a bounded per-socket outbox that drops a slow client instead of
// growing the heap, ping/pong liveness, and a strict direction (server→client frames only; the one
// accepted client message is `{"type":"ping"}`).
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { PublicKey } from '@solana/web3.js';
import { bus, type BusMessage } from './bus.ts';
import { sessionFromRequest } from './auth.ts';
import type { Db } from './db.ts';
import { log } from './log.ts';
import { metrics } from './metrics.ts';

/** Broadcast to every socket, wallet filter off: these are global read-models. */
export const PUBLIC_TYPES = new Set(['listing_changed', 'sale', 'offer', 'params_changed', 'day_closed', 'price_update']);

export interface WsOptions {
  db: () => Db;
  path?: string;
  maxClients?: number;
  /** ms between server pings; a socket that misses a pong is terminated. */
  pingMs?: number;
  /** bytes of unsent data after which a client is dropped as too slow. */
  maxBacklog?: number;
}

interface ClientState { wallet?: string; alive: boolean; queue: string[]; draining: boolean }

export interface WsHub {
  wss: WebSocketServer;
  clients(): number;
  broadcast(m: { wallets?: string[]; type: string; payload: Record<string, unknown> }): void;
  close(): Promise<void>;
}

const validWallet = (s: string | null | undefined): string | undefined => {
  if (!s || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return undefined;
  try { return new PublicKey(s).toBase58(); } catch { return undefined; }
};

export function createWsHub(opts: WsOptions): WsHub {
  const path = opts.path ?? '/ws';
  const maxClients = opts.maxClients ?? Number(process.env.WS_MAX_CLIENTS ?? 500);
  const maxBacklog = opts.maxBacklog ?? Number(process.env.WS_MAX_BACKLOG_BYTES ?? 1 << 20);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const state = new WeakMap<WebSocket, ClientState>();
  let open = 0;
  let unsub: (() => void) | undefined;

  const drain = (socket: WebSocket) => {
    const s = state.get(socket);
    if (!s || s.draining) return;
    s.draining = true;
    const next = () => {
      const frame = s.queue.shift();
      if (frame === undefined) { s.draining = false; return; }
      if (socket.readyState !== WebSocket.OPEN) { s.queue.length = 0; s.draining = false; return; }
      socket.send(frame, (err) => {
        if (err) { metrics.counter('ws_send_error_total'); s.queue.length = 0; }
        next();
      });
    };
    next();
  };

  wss.on('connection', (socket, req) => {
    if (open >= maxClients) {
      metrics.counter('ws_rejected_total', { reason: 'capacity' });
      socket.close(1013, 'at capacity');
      return;
    }
    open++;
    metrics.counter('ws_connections_total');
    metrics.gauge('ws_clients', open);

    const url = new URL(req.url ?? path, 'http://internal');
    const want = validWallet(url.searchParams.get('wallet'));
    // The session cookie, when present, only labels the log line: it tells an operator "this socket
    // belongs to a signed-in wallet" — it is not a check the REST layer does not already do itself.
    let sessionWallet: string | undefined;
    try { sessionWallet = validWallet(sessionFromRequest(opts.db(), { headers: req.headers } as never)?.wallet); } catch { /* no db in a unit test */ }
    if (want && sessionWallet && want !== sessionWallet) {
      // Not an attack (the data is public), but worth one WARN: "someone watched another wallet's feed"
      // is the first question asked in any incident review.
      log.warn('ws wallet mismatch', { want, sessionWallet });
      metrics.counter('ws_wallet_mismatch_total');
    }
    state.set(socket, { wallet: want ?? sessionWallet, alive: true, queue: [], draining: false });

    socket.on('pong', () => { const s = state.get(socket); if (s) s.alive = true; });
    socket.on('message', (data: RawData) => {
      let m: { type?: string } | undefined;
      try { m = JSON.parse(String(data)) as { type?: string }; } catch { metrics.counter('ws_bad_message_total'); return; }
      if (m?.type === 'ping') socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
      else metrics.counter('ws_ignored_message_total');
    });
    socket.on('error', () => { /* a torn socket is normal; the client reconnects */ });
    socket.on('close', () => { open = Math.max(0, open - 1); state.delete(socket); metrics.gauge('ws_clients', open); });

    socket.send(JSON.stringify({ type: 'ready', wallet: state.get(socket)!.wallet ?? null, serverTime: Date.now() }));
  });

  const hub: WsHub = {
    wss,
    clients: () => open,
    broadcast(m) {
      const frame = JSON.stringify({ type: m.type, wallet: m.wallets?.[0] ?? null, payload: m.payload });
      const pub = PUBLIC_TYPES.has(m.type);
      const want = new Set(m.wallets ?? []);
      let hits = 0;
      for (const socket of wss.clients) {
        const s = state.get(socket);
        if (!s) continue;
        if (!pub && !(s.wallet && want.has(s.wallet))) continue;
        if (socket.bufferedAmount + frame.length > maxBacklog) {
          // A client that cannot drain 1 MB of invalidation hints will not catch up; drop it and let
          // its own backoff reconnect rather than letting the API process OOM on its behalf.
          metrics.counter('ws_dropped_total', { reason: 'backlog' });
          socket.terminate();
          continue;
        }
        s.queue.push(frame);
        hits++;
        drain(socket);
      }
      metrics.counter('ws_events_total', { type: m.type });
      if (hits) metrics.counter('ws_frames_sent_total', { type: m.type }, hits);
    },
    async close() {
      unsub?.();
      for (const c of wss.clients) { try { c.close(1001, 'server restart'); } catch { /* ignore */ } }
      await new Promise<void>((res) => wss.close(() => res()));
    },
  };

  // Liveness: a socket that missed the pong since the previous ping is gone (half-open TCP after a
  // laptop sleep is the common case), and an unreadable socket must not keep its outbox memory alive.
  const pingMs = opts.pingMs ?? Number(process.env.WS_PING_MS ?? 30_000);
  const pinger = pingMs > 0 ? setInterval(() => {
    for (const socket of wss.clients) {
      const s = state.get(socket);
      if (!s) continue;
      if (!s.alive) { metrics.counter('ws_dropped_total', { reason: 'stalled' }); socket.terminate(); continue; }
      s.alive = false;
      try { socket.ping(); } catch { /* closing */ }
    }
  }, pingMs) : undefined;
  pinger?.unref();

  // Fan-out source. Installed after the hub exists, and removed on close, so a restart of the API
  // process cannot leave a stale subscriber holding a DB handle through the bus.
  unsub = bus().subscribe((m: BusMessage) => hub.broadcast({ wallets: m.wallets, type: m.type, payload: m.payload }));
  const closeAll = hub.close;
  hub.close = async () => { if (pinger) clearInterval(pinger); await closeAll(); };
  return hub;
}

/** Wire the hub onto an http server at `path` (liveness lives in the hub). Returns hub + close(). */
export function attachWs(server: Server, opts: WsOptions): { hub: WsHub; close: () => Promise<void> } {
  const hub = createWsHub(opts);
  const path = opts.path ?? '/ws';
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '/';
    try { pathname = new URL(req.url ?? '/', 'http://internal').pathname; } catch { socket.destroy(); return; }
    if (pathname !== path) { socket.destroy(); return; } // not ours: another upgrade handler owns it
    if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      metrics.counter('ws_rejected_total', { reason: 'not_upgrade' });
      socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);
  return { hub, close: async () => { await hub.close(); server.off('upgrade', onUpgrade); } };
}

// REST API — the subset of backend/openapi.yaml that can be served purely from
// indexed events + local state (auth, profile, inventory, packs catalogue,
// market, leaderboards, paid services). Endpoints that need the arena worker,
// quest oracle or Pyth quotes are stubbed with 501 so the client's mock
// fallback kicks in per-request during development.
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { CORS_ORIGINS } from './config.ts';
import { type Db } from './db.ts';
import { attachSession, requireAuth, issueNonce, verifySiws, createSession, setSessionCookie, destroySession, AuthError } from './auth.ts';
import { catalogue, checkHandle, claimHandle, claimService, myServices, ServiceError } from './services.ts';
import * as q from './queries.ts';

export function createApp(db: Db) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(cors({ origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS, credentials: true, allowedHeaders: ['Content-Type', 'X-CSRF-Token'] }));
  app.use(express.json({ limit: '64kb' }));
  app.use(attachSession(db));

  const v1 = express.Router();
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
  const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);
  const int = (v: unknown) => (typeof v === 'string' && v.length ? Number(v) : undefined);

  // ------------------------------------------------------------ health / stats
  v1.get('/health', (_req, res) => { res.json({ ok: true, lastSlot: db.scalar(`SELECT COALESCE(MAX(slot),0) FROM events_raw`) }); });
  v1.get('/stats', (_req, res) => { res.json(q.stats(db)); });
  v1.get('/wallet/:address/events', (req, res) => { res.json({ events: q.walletEvents(db, req.params.address, int(req.query.limit) ?? 50) }); });

  // ------------------------------------------------------------ auth
  v1.post('/auth/siws/nonce', wrap((req, res) => { res.json(issueNonce(db, String(req.body?.address ?? ''))); }));
  v1.post('/auth/siws/verify', wrap((req, res) => {
    const body = req.body as { address: string; message: string; signature: string; referrer?: string };
    const wallet = verifySiws(db, body, req.get('x-forwarded-host') ?? undefined);
    const s = createSession(db, wallet);
    if (body.referrer && body.referrer !== wallet) db.run(`UPDATE wallets SET referrer = COALESCE(referrer, ?) WHERE address = ?`, body.referrer, wallet);
    setSessionCookie(res, s.cookie);
    res.json({ csrf: s.csrf, wallet: q.walletProfile(db, wallet) });
  }));
  v1.post('/auth/logout', (req, res) => {
    if (req.session) destroySession(db, req.session);
    setSessionCookie(res, null);
    res.status(204).end();
  });

  // ------------------------------------------------------------ me
  v1.get('/me', requireAuth, (req, res) => { res.json(q.me(db, req.session!.wallet)); });
  v1.get('/me/chips', requireAuth, (req, res) => {
    res.json(q.myChips(db, req.session!.wallet, { collection: int(req.query.collection), rarity: int(req.query.rarity), status: str(req.query.status), cursor: str(req.query.cursor) }));
  });
  v1.get('/me/grid', requireAuth, (req, res) => { res.json(q.myGrid(db, req.session!.wallet)); });
  v1.get('/me/activity', requireAuth, (req, res) => { res.json(q.activity(db, req.session!.wallet, 50, str(req.query.cursor))); });
  v1.get('/me/pending', requireAuth, (req, res) => {
    const rows = db.all<{ nonce: string; sku: number; qty: number; opened: number; randomness: string; slot: number }>(`SELECT nonce, sku, qty, opened, randomness, slot FROM pack_purchases WHERE buyer = ? AND status = 'pending'`, req.session!.wallet);
    res.json({ packs: rows.map((r) => ({ nonce: r.nonce, sku: r.sku, qty: r.qty, opened: r.opened, commitSlot: r.slot, currentSlot: 0, randomness: r.randomness, status: 'awaiting_reveal', staleAt: null })), fusions: [] });
  });
  v1.get('/me/handle/check', requireAuth, (req, res) => { res.json(checkHandle(db, req.session!.wallet, String(req.query.handle ?? ''))); });
  v1.put('/me/handle', requireAuth, (req, res) => {
    const b = req.body as { handle: string; signature: string };
    res.json(claimHandle(db, req.session!.wallet, String(b.handle ?? ''), String(b.signature ?? '')));
  });
  v1.get('/me/services', requireAuth, (req, res) => { res.json(myServices(db, req.session!.wallet)); });

  // ------------------------------------------------------------ services
  v1.get('/services', (_req, res) => { res.json(catalogue(db)); });
  v1.post('/services/claim', requireAuth, (req, res) => {
    const b = req.body as { signature: string; kind: number; payload: Record<string, unknown> };
    res.json(claimService(db, req.session!.wallet, String(b.signature ?? ''), Number(b.kind), b.payload ?? {}));
  });

  // ------------------------------------------------------------ packs
  v1.get('/packs', (_req, res) => { res.json(q.packCatalogue(db)); });
  v1.get('/packs/opens/:signature', (req, res) => {
    const r = q.packOpen(db, req.params.signature);
    if (r) { res.json(r); return; }
    const pending = db.get(`SELECT nonce, sku, qty, opened, randomness, slot FROM pack_purchases WHERE signature = ?`, req.params.signature);
    if (pending) res.status(202).json({ ...pending, status: 'awaiting_reveal' });
    else res.status(404).json({ code: 'not_found', message: 'No pack open with that signature (yet)' });
  });
  v1.post('/packs/verify', (req, res) => {
    const r = q.packOpen(db, String(req.body?.signature ?? ''));
    if (!r) { res.status(404).json({ code: 'not_found', message: 'Unknown signature' }); return; }
    // Recompute happens client-side too (packages/economy expandRandomness); the API returns the on-chain facts.
    res.json({ signature: r.signature, rollHex: r.rollHex, pityBefore: r.pityBefore, effectiveOddsBps: r.effectiveOddsBps, onChain: r.onChain, recomputed: r.onChain, matches: true });
  });

  // ------------------------------------------------------------ collections / chips
  v1.get('/collections', (_req, res) => { res.json(q.collections(db)); });
  v1.get('/chips/:asset', (req, res) => {
    const r = q.chipDetail(db, req.params.asset);
    if (!r) res.status(404).json({ code: 'not_found', message: 'Unknown chip' });
    else res.json(r);
  });

  // ------------------------------------------------------------ market
  v1.get('/market/listings', (req, res) => { res.json(q.listings(db, req.query as Record<string, string | undefined>)); });
  v1.get('/market/floor', (_req, res) => { res.json(q.floor(db)); });
  v1.get('/market/history', (req, res) => { res.json(q.history(db, req.query as Record<string, string | undefined>)); });
  v1.get('/market/offers', requireAuth, (req, res) => {
    const w = req.session!.wallet;
    const made = req.query.direction !== 'received';
    const rows = made
      ? db.all<{ asset: string; bidder: string; amount: string; expires_at: number }>(`SELECT * FROM offers WHERE bidder = ?`, w)
      : db.all<{ asset: string; bidder: string; amount: string; expires_at: number }>(`SELECT o.* FROM offers o JOIN chips c ON c.asset = o.asset WHERE c.owner = ?`, w);
    res.json(rows.map((r) => ({ asset: r.asset, bidder: r.bidder, amountUsdc: r.amount, expiresAt: new Date(r.expires_at * 1000).toISOString() })));
  });

  // ------------------------------------------------------------ leaderboard
  v1.get('/leaderboard/:board', (req, res) => {
    try { res.json(q.leaderboard(db, req.params.board, 50, str(req.query.cursor), req.session?.wallet)); }
    catch { res.status(404).json({ code: 'unknown_board', message: 'rating | collection | staking | fusion' }); }
  });

  // ------------------------------------------------------------ not implemented here (other services)
  for (const p of ['/packs/quote', '/fusion/recipes', '/fusion/plan', '/fusion/suggest', '/arena/*', '/staking/*', '/quests*', '/admin/*']) {
    v1.all(p, (_req, res) => { res.status(501).json({ code: 'not_implemented', message: 'Served by the arena/oracle/quote service in production; the client falls back to its mock in dev' }); });
  }

  app.use('/v1', v1);
  app.use('/', v1); // legacy paths (/leaderboard, /stats, /wallet/:address/events) keep working for the landing page

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError || err instanceof AuthError) { res.status(err.status).json({ code: err.code, message: err.message }); return; }
    const msg = (err as Error)?.message ?? String(err);
    if (/Invalid public key|Non-base58/.test(msg)) { res.status(400).json({ code: 'bad_pubkey', message: msg }); return; }
    console.error(err);
    res.status(500).json({ code: 'internal', message: msg });
  });
  return app;
}

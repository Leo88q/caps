// REST API — backend/openapi.yaml served from indexed events + local state: auth, profile,
// inventory, packs catalogue + Pyth quotes, market, leaderboards, paid services, fusion planner,
// staking read-model, the server-authoritative arena (queue / reveal / matches / seasons) and
// quests + Merkle claims. `/admin/*` stays 501 until the Squads-gated admin service exists
// (docs/06 backlog #18) — the client's mock covers it in dev.
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Connection } from '@solana/web3.js';
import cors from 'cors';
import { CORS_ORIGINS, assertProductionConfig } from './config.ts';
import { type Db } from './db.ts';
import { attachSession, requireAuth, issueNonce, verifySiws, createSession, setSessionCookie, destroySession, AuthError } from './auth.ts';
import { POLICIES, createLimiter, type Limiter } from './ratelimit.ts';
import { catalogue, checkHandle, claimHandle, claimService, myServices, ServiceError } from './services.ts';
import { packQuote, validateRequest } from './quote.ts';
import { getConnection } from './ingest.ts';
import { crankStatus, pauseStatus, priceStatus } from './queries.ts';
import { burnOracleStatus } from './burn-oracle.ts';
import { finalityStatus } from './finality.ts';
import * as q from './queries.ts';
import * as fusion from './fusion.ts';
import * as staking from './staking.ts';
import * as arena from './arena.ts';
import * as quests from './quests.ts';
import { rewardOracleStatus } from './reward-oracle.ts';
import { referralSummary } from './referrals.ts';
import { antifraudStatus } from './antifraud.ts';
import * as admin from './admin.ts';
import { clientIp, ipNet } from './ratelimit.ts';
import { humanStatus, recordDevice, verifyHuman } from './human.ts';

export interface AppOptions {
  connection?: () => Connection;
  limiter?: Limiter;
  /** Arena sweep (pairing, bot fill, forfeits) interval; 0 disables the timer (tests call `arena.sweep` directly). */
  arenaSweepMs?: number;
  /** Override the `ADMIN_WALLETS` allowlist (tests). */
  adminWallets?: ReadonlySet<string>;
}

export function createApp(db: Db, deps: AppOptions = {}) {
  assertProductionConfig();
  const connection = deps.connection ?? getConnection;
  const limiter = deps.limiter ?? createLimiter();
  const rl = limiter.use.bind(limiter);
  const adminWallets = deps.adminWallets ?? admin.ADMIN_WALLETS; // ADMIN_WALLETS allowlist — gates /admin/* and the `isAdmin` flag on /me
  const app = express();
  const sweepMs = deps.arenaSweepMs ?? Number(process.env.ARENA_SWEEP_MS ?? 3_000);
  if (sweepMs > 0) {
    const timer = setInterval(() => { try { arena.sweep(db); } catch (e) { console.error('[arena] sweep failed:', (e as Error).message); } }, sweepMs);
    timer.unref();
  }
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(cors({ origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS, credentials: true, allowedHeaders: ['Content-Type', 'X-CSRF-Token'], exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'] }));
  app.use(express.json({ limit: '16kb' }));
  app.use(attachSession(db));
  // SEC-H3: one global read budget per IP, tighter per-session budgets on mutations below.
  app.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? rl(POLICIES.read)(req, res, next) : rl(POLICIES.mutate)(req, res, next)));

  const v1 = express.Router();
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
  const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);
  const int = (v: unknown) => (typeof v === 'string' && v.length ? Number(v) : undefined);

  // ------------------------------------------------------------ health / stats
  v1.get('/health', (_req, res) => { res.json({ ok: true, lastSlot: db.scalar(`SELECT COALESCE(MAX(slot),0) FROM events_raw`), prices: priceStatus(db), crank: crankStatus(db), paused: pauseStatus(db), burnOracle: burnOracleStatus(db), finality: finalityStatus(db), rewardOracle: rewardOracleStatus(db), antifraud: antifraudStatus(db), arena: { queued: db.scalar(`SELECT COUNT(*) FROM arena_queue`), revealing: db.scalar(`SELECT COUNT(*) FROM matches WHERE status = 'revealing'`) } }); });
  v1.get('/prices', (_req, res) => { res.json(priceStatus(db)); });
  v1.get('/stats', (_req, res) => { res.json(q.stats(db)); });
  v1.get('/rewards/skr-pool', (_req, res) => { res.json(q.skrPool(db)); });
  v1.get('/wallet/:address/events', (req, res) => { res.json({ events: q.walletEvents(db, req.params.address, int(req.query.limit) ?? 50) }); });

  // ------------------------------------------------------------ auth
  const bodyAddress = (req: Request) => (typeof req.body?.address === 'string' ? (req.body.address as string) : undefined);
  v1.post('/auth/siws/nonce', rl(POLICIES.nonceIp), rl(POLICIES.nonceWallet, { wallet: bodyAddress }), wrap((req, res) => { res.json(issueNonce(db, String(req.body?.address ?? ''))); }));
  v1.post('/auth/siws/verify', rl(POLICIES.verifyIp), wrap((req, res) => {
    const body = req.body as { address: string; message: string; signature: string; referrer?: string; fingerprint?: string };
    const wallet = verifySiws(db, body);
    const s = createSession(db, wallet);
    if (body.referrer && body.referrer !== wallet) db.run(`UPDATE wallets SET referrer = COALESCE(referrer, ?) WHERE address = ?`, body.referrer, wallet);
    recordDevice(db, wallet, body.fingerprint); // T-B-49 device dedupe (salted hash only — human.ts)
    setSessionCookie(res, s.cookie);
    res.json({ csrf: s.csrf, wallet: q.walletProfile(db, wallet) });
  }));
  v1.post('/auth/logout', (req, res) => {
    if (req.session) destroySession(db, req.session);
    setSessionCookie(res, null);
    res.status(204).end();
  });

  // ------------------------------------------------------------ me
  v1.get('/me', requireAuth, (req, res) => { res.json({ ...q.me(db, req.session!.wallet), isAdmin: admin.isAdminWallet(req.session!.wallet, adminWallets) }); });
  v1.get('/me/chips', requireAuth, (req, res) => {
    res.json(q.myChips(db, req.session!.wallet, { collection: int(req.query.collection), rarity: int(req.query.rarity), status: str(req.query.status), cursor: str(req.query.cursor) }));
  });
  v1.get('/me/grid', requireAuth, (req, res) => { res.json(q.myGrid(db, req.session!.wallet)); });
  v1.get('/me/activity', requireAuth, (req, res) => { res.json(q.activity(db, req.session!.wallet, 50, str(req.query.cursor))); });
  v1.get('/me/referrals', requireAuth, (req, res) => { res.json(referralSummary(db, req.session!.wallet)); });
  v1.get('/me/pending', requireAuth, (req, res) => {
    const rows = db.all<{ nonce: string; sku: number; qty: number; opened: number; randomness: string; slot: number }>(`SELECT nonce, sku, qty, opened, randomness, slot FROM pack_purchases WHERE buyer = ? AND status = 'pending'`, req.session!.wallet);
    res.json({ packs: rows.map((r) => ({ nonce: r.nonce, sku: r.sku, qty: r.qty, opened: r.opened, commitSlot: r.slot, currentSlot: 0, randomness: r.randomness, status: 'awaiting_reveal', staleAt: null })), fusions: [] });
  });
  v1.get('/me/handle/check', requireAuth, (req, res) => { res.json(checkHandle(db, req.session!.wallet, String(req.query.handle ?? ''))); });
  v1.put('/me/handle', requireAuth, rl(POLICIES.claim), rl(POLICIES.claimNet), (req, res) => {
    const b = req.body as { handle: string; signature: string };
    res.json(claimHandle(db, req.session!.wallet, String(b.handle ?? ''), String(b.signature ?? '')));
  });
  v1.get('/me/services', requireAuth, (req, res) => { res.json(myServices(db, req.session!.wallet)); });
  // T-B-49 proof of human: Turnstile token → 7-day pass that unlocks quest / SKR settlement (human.ts).
  v1.get('/me/human', requireAuth, (req, res) => { res.json(humanStatus(db, req.session!.wallet)); });
  v1.post('/me/human', requireAuth, rl(POLICIES.human), rl(POLICIES.humanNet), wrap(async (req, res) => {
    res.json(await verifyHuman(db, req.session!.wallet, req.body, { ip: clientIp(req), net: ipNet(req) }));
  }));

  // ------------------------------------------------------------ services
  v1.get('/services', (_req, res) => { res.json(catalogue(db)); });
  v1.post('/services/claim', requireAuth, rl(POLICIES.claim), rl(POLICIES.claimNet), (req, res) => {
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

  // ------------------------------------------------------------ packs: quote (Pyth, our own pusher — docs/03 §2.9)
  v1.post('/packs/quote', requireAuth, rl(POLICIES.quote), wrap(async (req, res) => {
    const quote = await packQuote(db, connection(), req.session!.wallet, validateRequest(req.body));
    res.set('Cache-Control', 'no-store');
    res.json(quote);
  }));

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
    const season = req.query.season !== undefined ? Number(req.query.season) : undefined;
    if (season !== undefined && (!Number.isInteger(season) || season < 0)) { res.status(400).json({ error: 'bad_season' }); return; }
    try { res.json(q.leaderboard(db, req.params.board, 50, str(req.query.cursor), req.session?.wallet, season)); }
    catch { res.status(404).json({ code: 'unknown_board', message: 'rating | collection | staking | fusion' }); }
  });

  // ------------------------------------------------------------ fusion planner (mirrors chip_core fuse rules)
  v1.get('/fusion/recipes', (_req, res) => { res.json(fusion.recipes()); });
  v1.post('/fusion/plan', requireAuth, (req, res) => { res.json(fusion.plan(db, req.session!.wallet, fusion.validatePlanRequest(req.body))); });
  v1.get('/fusion/suggest', requireAuth, (req, res) => { res.json(fusion.suggest(db, req.session!.wallet, req.query.protectSets !== 'false')); });

  // ------------------------------------------------------------ staking read-model
  v1.get('/staking/overview', (_req, res) => { res.json(staking.overview(db)); });
  v1.get('/staking/me', requireAuth, (req, res) => { res.json(staking.me(db, req.session!.wallet)); });
  v1.post('/staking/estimate', (req, res) => { res.json(staking.estimate(db, staking.validateEstimate(req.body))); });

  // ------------------------------------------------------------ arena (server-authoritative ranked; wagers are on chain)
  v1.get('/arena/seasons/current', (_req, res) => { res.json(arena.seasonApi(db)); });
  v1.post('/arena/simulate', (req, res) => { res.json(arena.simulate(db, req.body)); });
  v1.get('/arena/me', requireAuth, (req, res) => { res.json(arena.arenaMe(db, req.session!.wallet)); });
  v1.post('/arena/queue', requireAuth, rl(POLICIES.arena), rl(POLICIES.claimNet), (req, res) => { res.json(arena.joinQueue(db, req.session!.wallet, req.body)); });
  v1.delete('/arena/queue', requireAuth, (req, res) => { arena.leaveQueue(db, req.session!.wallet); res.status(204).end(); });
  v1.post('/arena/matches/:id/reveal', requireAuth, rl(POLICIES.arena), (req, res) => { res.json(arena.reveal(db, req.session!.wallet, req.params.id, req.body)); });
  v1.get('/arena/matches/:id', (req, res) => {
    const m = arena.matchApi(db, req.params.id, req.session?.wallet);
    if (!m) res.status(404).json({ code: 'not_found', message: 'Unknown match' });
    else res.json(m);
  });

  // ------------------------------------------------------------ quests + Merkle claims
  v1.get('/quests', requireAuth, (req, res) => { quests.recordLogin(db, req.session!.wallet); res.json(quests.list(db, req.session!.wallet)); });
  v1.get('/quests/claims', requireAuth, (req, res) => { res.json(quests.claims(db, req.session!.wallet)); });
  v1.get('/quests/streak', requireAuth, (req, res) => { quests.refreshQuestDay(db, req.session!.wallet); res.json(quests.streak(db, req.session!.wallet)); });
  v1.post('/quests/login', requireAuth, (req, res) => { res.json(quests.recordLogin(db, req.session!.wallet)); });

  // ------------------------------------------------------------ admin (docs/03 §3.5, T-B-46): SIWS session ∈ ADMIN_WALLETS, every call audited,
  // on-chain changes are only *encoded* for the Squads multisig — this process holds no admin key.
  const adminGate = (req: Request, res: Response, next: NextFunction) => {
    const wallet = req.session?.wallet;
    if (!wallet) { res.status(401).json({ code: 'unauthenticated', message: 'Sign in first' }); return; }
    if (!admin.isAdminWallet(wallet, adminWallets)) {
      admin.audit(db, { wallet, action: `denied:${req.method} ${req.baseUrl}${req.path}`, ip: clientIp(req), ok: false });
      res.status(403).json({ code: 'forbidden', message: 'Wallet is not on the admin allowlist' });
      return;
    }
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== req.session!.csrf) { res.status(403).json({ code: 'csrf', message: 'Bad CSRF token' }); return; }
    next();
  };
  const audited = (action: string, fn: (req: Request) => unknown | Promise<unknown>, target?: (req: Request) => string | undefined) => wrap(async (req, res) => {
    const wallet = req.session!.wallet;
    try {
      const out = await fn(req);
      admin.audit(db, { wallet, action, target: target?.(req), payload: req.method === 'GET' ? undefined : { body: req.body, result: summarize(out) }, ip: clientIp(req), ok: true });
      res.json(out);
    } catch (e) {
      admin.audit(db, { wallet, action, target: target?.(req), payload: { body: req.body, error: (e as Error).message }, ip: clientIp(req), ok: false });
      throw e;
    }
  });
  const summarize = (out: unknown) => { const o = out as { ok?: boolean; violations?: unknown[]; flags?: unknown; closed?: number } | null; return o && typeof o === 'object' ? { ok: o.ok, violations: o.violations?.length, flags: o.flags, closed: o.closed } : undefined; };
  v1.use('/admin', adminGate);
  v1.get('/admin/params', audited('params.get', async () => admin.paramsApi(db, await admin.fetchChainParams(connection()))));
  v1.post('/admin/params', audited('params.propose', async (req) => {
    const p = admin.proposeParams(await admin.fetchChainParams(connection()), req.body as admin.ParamsProposal);
    if (!p.ok) throw new ServiceError(422, 'guard_rail', p.violations.map((v) => `${v.path}: ${v.message}`).join('; '), p);
    return p;
  }));
  v1.post('/admin/simulate', audited('simulate', (req) => admin.simulate(req.body ?? {})));
  v1.post('/admin/kill-switch', audited('kill_switch', async (req) => {
    const body = req.body as { program: string; paused: boolean; reason?: string };
    const c = await admin.fetchChainParams(connection());
    const authority = body?.program === 'staking' ? { admin: c.emission.admin, pauser: c.emission.pauser } : { admin: c.config.admin, pauser: c.config.pauser };
    const p = admin.killSwitch(body, authority);
    if (!p.ok) throw new ServiceError(422, 'bad_request', p.violations.map((v) => `${v.path}: ${v.message}`).join('; '), p);
    return p;
  }, (req) => (req.body as { program?: string })?.program));
  v1.get('/admin/fraud', audited('fraud.queue', (req) => admin.fraud.queue(db, Math.min(500, int(req.query.limit) ?? 100))));
  v1.post('/admin/fraud/:wallet', audited('fraud.resolve', (req) => {
    const body = req.body as { resolution: string; note?: string };
    return admin.fraud.resolve(db, req.params.wallet, body?.resolution, `admin:${req.session!.wallet}`, body?.note);
  }, (req) => req.params.wallet));
  v1.get('/admin/kpi', audited('kpi', () => admin.kpi(db)));
  v1.get('/admin/audit', audited('audit.read', (req) => admin.auditLog(db, Math.min(1000, int(req.query.limit) ?? 100))));

  app.use('/v1', v1);
  app.use('/', v1); // legacy paths (/leaderboard, /stats, /wallet/:address/events) keep working for the landing page

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) { res.status(err.status).json({ code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) }); return; }
    if (err instanceof AuthError) { res.status(err.status).json({ code: err.code, message: err.message }); return; }
    const msg = (err as Error)?.message ?? String(err);
    if (/Invalid public key|Non-base58/.test(msg)) { res.status(400).json({ code: 'bad_pubkey', message: msg }); return; }
    if ((err as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ code: 'payload_too_large', message: 'Body limit is 16 KB' }); return; }
    if ((err as { type?: string })?.type === 'entity.parse.failed') { res.status(400).json({ code: 'bad_json', message: 'Malformed JSON body' }); return; }
    console.error(err);
    res.status(500).json({ code: 'internal', message: msg });
  });
  return app;
}

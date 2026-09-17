// Legal gating of paid randomised packs (docs/09 §5.2). Two things are pinned here that are easy to
// get wrong and impossible to see in a UI review: where the country comes from (and what happens when
// it cannot be trusted), and that the block covers the purchase only.
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { Db } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { base58Encode } from '../src/base58.ts';
import { geoOf, geoOptions, geoMisconfiguration, GEO_DEFAULT_COUNTRIES, type GeoOptions } from '../src/geo.ts';

const OPTS = (over: Partial<GeoOptions> = {}): GeoOptions => ({
  mode: 'shop',
  restricted: new Set(['BE', 'NL']),
  header: 'x-geo-country',
  trusted: true,
  unknown: 'allow',
  ...over,
});

describe('geoOf — the decision', () => {
  it('is inert when the gate is off, and never reads the header', () => {
    const g = geoOf({ 'x-geo-country': 'BE' }, { ...OPTS(), mode: 'off' });
    expect(g).toEqual({ mode: 'off', country: null, restricted: false, source: 'gate-off' });
  });

  it('blocks a restricted country and allows an unlisted one', () => {
    expect(geoOf({ 'x-geo-country': 'be' }, OPTS()).restricted).toBe(true);
    expect(geoOf({ 'x-geo-country': 'NL' }, OPTS()).restricted).toBe(true);
    expect(geoOf({ 'x-geo-country': 'US' }, OPTS()).restricted).toBe(false);
  });

  it('ignores a client-set header unless the edge is declared trusted', () => {
    // The point of GEO_TRUST_HEADER: `npm run backend:start` with 8787 exposed directly answers to
    // whatever the buyer put in the request. Untrusted must mean "no gate", never "gate by suggestion".
    const g = geoOf({ 'x-geo-country': 'BE' }, OPTS({ trusted: false }));
    expect(g).toMatchObject({ country: null, restricted: false, source: 'untrusted' });
  });

  it('treats a malformed value as unknown, never as a guess', () => {
    for (const bad of ['BE, NL', 'unknown', 'BEL', 'B', '??']) {
      const g = geoOf({ 'x-geo-country': bad }, OPTS());
      expect(g.source, bad).toBe('invalid');
      expect(g.country, bad).toBe(null);
      expect(g.restricted, bad).toBe(false);
    }
    // …and `unknown` is exactly where the strict policy is allowed to say "then nobody buys".
    expect(geoOf({ 'x-geo-country': 'nonsense' }, OPTS({ unknown: 'block' })).restricted).toBe(true);
    expect(geoOf({}, OPTS({ unknown: 'block' })).restricted).toBe(true);
    expect(geoOf({}, OPTS({ unknown: 'allow' })).restricted).toBe(false);
  });

  it('takes the first value when a proxy chain repeats the header', () => {
    expect(geoOf({ 'x-geo-country': ['BE', 'US'] }, OPTS()).restricted).toBe(true);
  });

  it('reads the header name from config', () => {
    const o = OPTS({ header: 'cf-ipcountry' });
    expect(geoOf({ 'x-geo-country': 'BE', 'cf-ipcountry': 'US' }, o).country).toBe('US');
  });
});

describe('geoOptions / geoMisconfiguration — the env contract', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of ['GEO_GATE', 'GEO_RESTRICT_COUNTRIES', 'GEO_COUNTRY_HEADER', 'GEO_TRUST_HEADER', 'GEO_UNKNOWN']) delete process.env[k];
  });

  it('defaults to off with zero restrictions', () => {
    const o = geoOptions();
    expect(o).toMatchObject({ mode: 'off', trusted: false, unknown: 'allow', header: 'x-geo-country' });
    expect(o.restricted.size).toBe(0);
    expect(geoMisconfiguration()).toBe(null);
  });

  it('turning the gate on brings the documented default list', () => {
    process.env.GEO_GATE = 'shop';
    expect([...geoOptions().restricted]).toEqual(GEO_DEFAULT_COUNTRIES.split(','));
    expect(geoOptions().header).toBe('x-geo-country');
  });

  it('refuses the two configurations that look compliant and are not', () => {
    process.env.GEO_GATE = 'shop';
    expect(geoMisconfiguration()).toMatch(/GEO_TRUST_HEADER/);
    process.env.GEO_TRUST_HEADER = '1';
    // The default list is non-empty, so "empty" only happens when an operator writes it explicitly —
    // which is exactly the shape of a config that passes review and enforces nothing.
    process.env.GEO_RESTRICT_COUNTRIES = '';
    expect(geoMisconfiguration()).toMatch(/empty GEO_RESTRICT_COUNTRIES/);
    process.env.GEO_RESTRICT_COUNTRIES = 'be, nl , XX';
    expect(geoMisconfiguration()).toBe(null);
    expect([...geoOptions().restricted]).toEqual(['BE', 'NL', 'XX']);
  });

  it('does not let a typo in the list silently disable a country', () => {
    process.env.GEO_GATE = 'shop';
    process.env.GEO_TRUST_HEADER = '1';
    process.env.GEO_RESTRICT_COUNTRIES = 'BELGIUM,NL';
    // `BELGIUM` is dropped by the 2-letter shape check rather than becoming a never-matching entry that
    // makes the operator believe Belgium is covered.
    expect([...geoOptions().restricted]).toEqual(['NL']);
  });

  it('restores env after the file', () => {
    process.env.GEO_GATE = 'shop';
    expect(geoOptions().mode).toBe('shop');
    Object.assign(process.env, saved);
    for (const k of ['GEO_GATE', 'GEO_RESTRICT_COUNTRIES', 'GEO_TRUST_HEADER']) if (!(k in saved)) delete process.env[k];
  });
});

// ------------------------------------------------------------------ HTTP surface
let db: Db;
let server: http.Server;
let base: string;
const wallet = Keypair.generate();

async function signIn(c: Client) {
  const address = wallet.publicKey.toBase58();
  const { json: n } = await c.req('POST', '/v1/auth/siws/nonce', { address });
  const message = `localhost wants you to sign in with your Solana account:\n${address}\n\n${n.statement}\n\nURI: http://localhost\nVersion: 1\nNonce: ${n.nonce}\nIssued At: ${new Date().toISOString()}`;
  const sig = ed25519.sign(new TextEncoder().encode(message), wallet.secretKey.slice(0, 32));
  const r = await c.req('POST', '/v1/auth/siws/verify', { address, message, signature: base58Encode(sig) });
  if (r.status === 200) c.csrf = r.json.csrf;
  return r;
}

class Client {
  cookie = '';
  csrf = '';
  constructor(private base: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }
}

const QUOTE = { sku: 1, qty: 1, currency: 'USDC' };

beforeAll(async () => {
  db = new Db(':memory:');
  server = http.createServer(createApp(db, { arenaSweepMs: 0 }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { server.close(); db.close(); });

describe('the gate on the wire', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of ['GEO_GATE', 'GEO_TRUST_HEADER', 'GEO_RESTRICT_COUNTRIES', 'GEO_UNKNOWN']) delete process.env[k];
  });

  it('POST /packs/quote answers 403 geo_blocked for a restricted country, and it does so before touching prices', () => {
    process.env.GEO_GATE = 'shop';
    process.env.GEO_TRUST_HEADER = '1';
    return (async () => {
      const c = new Client(base);
      await signIn(c);
      const blocked = await c.req('POST', '/v1/packs/quote', QUOTE, { 'x-geo-country': 'BE' });
      expect(blocked.status).toBe(403);
      expect(blocked.json).toMatchObject({ code: 'geo_blocked' });
      // The ordering is the assertion: with no RPC reachable here, anything that ran the price lookup
      // first would answer 503. 403 proves the legal check is not a post-hoc filter on a priced quote.
      expect(blocked.json.message).toMatch(/not available in your region/i);
      const unlisted = await c.req('POST', '/v1/packs/quote', QUOTE, { 'x-geo-country': 'US' });
      expect(unlisted.status).not.toBe(403);
    })();
  });

  it('GET /me reports the flag only when the gate is armed, and the flag never blocks by itself', async () => {
    process.env.GEO_GATE = 'shop';
    process.env.GEO_TRUST_HEADER = '1';
    const c = new Client(base);
    await signIn(c);
    const be = await c.req('GET', '/v1/me', undefined, { 'x-geo-country': 'NL' });
    expect(be.status).toBe(200);
    expect(be.json.flags.geoRestricted).toBe(true);
    const us = await c.req('GET', '/v1/me', undefined, { 'x-geo-country': 'DE' });
    expect(us.json.flags.geoRestricted).toBe(false);
    // Gate off → the flag is false even for a header that would otherwise block, so the client's copy
    // and the server's 403 cannot disagree about whether a purchase is possible.
    delete process.env.GEO_GATE;
    const off = await c.req('GET', '/v1/me', undefined, { 'x-geo-country': 'NL' });
    expect(off.json.flags.geoRestricted).toBe(false);
  });

  it('leaves every non-purchase endpoint alone (block the shop, not the game)', async () => {
    process.env.GEO_GATE = 'shop';
    process.env.GEO_TRUST_HEADER = '1';
    process.env.GEO_UNKNOWN = 'allow';
    const c = new Client(base);
    await signIn(c);
    const h = { 'x-geo-country': 'BE' };
    // /me/pending is the one that would be a real product bug if it were blocked: a buyer in a
    // restricted region must still be able to see and settle a pack bought before the gate existed.
    for (const p of ['/v1/packs', '/v1/stats', '/v1/market/floor', '/v1/leaderboard/collection', '/v1/me/chips', '/v1/me/pending']) {
      const res = await c.req('GET', p, undefined, h);
      expect(res.status, p).toBe(200);
    }
  });

  it('is completely inert by default (this is the state the product launches in)', async () => {
    const c = new Client(base);
    await signIn(c);
    const res = await c.req('POST', '/v1/packs/quote', QUOTE, { 'x-geo-country': 'BE' });
    expect(res.status).not.toBe(403);
  });
});

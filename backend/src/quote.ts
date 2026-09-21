// POST /packs/quote — the price + everything the client needs to build buy_pack.
//
// Volatile rails (SOL, SKR) are priced from OUR Pyth accounts (pyth.ts) with the
// exact integer formula of chip_core::units_for_cents, and the response carries
// the account the client must pass as `price_update`. If the on-chain price is
// stale / missing the endpoint answers 503 price_unavailable rather than
// inventing a number: the program would reject the transaction anyway
// (StalePrice), and the client then hides SOL/SKR and keeps USDC/$CG live.
//
// Pity and daily caps come from the indexer (pack_opens / pack_purchases), the
// pack table from the economy package (== GameConfig defaults; a live
// GameConfig read replaces it once the admin panel lands — TODO(G-1)).
import type { Connection } from '@solana/web3.js';
import { PACKS, BUNDLES, FEES, bundlePriceCents, effectiveOdds, type PackId } from '@guttercaps/economy';
import { QUOTE_CACHE_MS, SWITCHBOARD_QUEUE } from './config.ts';
import { randomBytes } from 'node:crypto';
import { type Db, now } from './db.ts';
import { configuredPriceAccounts, fetchFeeds, quoteIsUsable, quoteUnits, quoteValidForS, PythError, type FeedSnapshot, type PythAccounts } from './pyth.ts';
import { ServiceError } from './services.ts';

export const SKUS: PackId[] = ['starter', 'standard', 'premium', 'limited'];
export type QuoteCurrency = 'SOL' | 'USDC' | 'CG' | 'SKR';
const CURRENCY_CODE: Record<QuoteCurrency, number> = { SOL: 0, USDC: 1, CG: 2, SKR: 3 };
const RENT_RESERVE_PER_CHIP = 8_000_000n; // chip_core::instructions::packs::RENT_RESERVE_PER_CHIP (SEC-L3: 0.008 SOL, unspent part returned)
const MAX_TOTAL_DISCOUNT_BPS = 3_000;      // buy_pack: bundle + SKR promo capped at 30 %

export interface QuoteRequest { sku: number; qty: number; currency: QuoteCurrency }

/** Same integer maths as buy_pack (packs.rs): bundle discount, SKR promo stacked additively, capped at 30 %. */
export function priceCents(sku: number, qty: number, currency: QuoteCurrency, skrDiscountBps: number = FEES.skrPackDiscountBps): { cents: number; discountBps: number } {
  const p = PACKS[SKUS[sku]];
  const bundlesAllowed = sku === 1 || sku === 2; // Starter/Limited never get bundle discounts
  const bundleBps = bundlesAllowed ? ([...BUNDLES].reverse().find((b) => qty >= b.qty)?.discountBps ?? 0) : 0;
  const discountBps = currency === 'SKR' ? Math.min(bundleBps + skrDiscountBps, MAX_TOTAL_DISCOUNT_BPS) : bundleBps;
  const cents = Math.floor((p.priceUsdCents * qty * (10_000 - discountBps)) / 10_000);
  return { cents, discountBps };
}

export function validateRequest(body: unknown): QuoteRequest {
  const b = (body ?? {}) as Partial<Record<keyof QuoteRequest, unknown>>;
  const sku = Number(b.sku), qty = Number(b.qty);
  const currency = String(b.currency ?? '') as QuoteCurrency;
  if (!Number.isInteger(sku) || sku < 0 || sku > 3) throw new ServiceError(400, 'bad_sku', 'sku must be 0..3');
  if (!Number.isInteger(qty) || qty < 1 || qty > 25) throw new ServiceError(400, 'bad_qty', 'qty must be 1..25');
  if (!(currency in CURRENCY_CODE)) throw new ServiceError(400, 'bad_currency', 'currency must be SOL | USDC | CG | SKR');
  const p = PACKS[SKUS[sku]];
  if (currency === 'CG' && !p.priceCgMicro) throw new ServiceError(400, 'currency_not_accepted', `${p.name} cannot be bought with $CG`);
  if (sku === 0 && qty !== 1) throw new ServiceError(400, 'bad_qty', 'Starter is one per wallet');
  if (sku === 3 && qty > (p.dailyCap ?? 25)) throw new ServiceError(400, 'bad_qty', `Limited: at most ${p.dailyCap} per day`);
  return { sku, qty, currency };
}

/** Per-wallet state the program will check: pity counter, bought today, starter claimed. */
export function walletPackState(db: Db, wallet: string, sku: number) {
  const boughtToday = db.scalar(`SELECT COALESCE(SUM(qty),0) FROM pack_purchases WHERE buyer = ? AND sku = ? AND COALESCE(block_time, ?) >= ?`, wallet, sku, now(), now() - 86_400);
  const pity = db.get<{ pity_after: number }>(`SELECT pity_after FROM pack_opens WHERE buyer = ? AND sku = ? ORDER BY slot DESC LIMIT 1`, wallet, sku)?.pity_after ?? 0;
  const starterClaimed = sku === 0 && db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND sku = 0`, wallet) > 0;
  return { boughtToday, pity, starterClaimed };
}

// small in-process cache so a burst of quotes does not hammer the RPC
let cached: { at: number; key: string; feeds: Awaited<ReturnType<typeof fetchFeeds>> } | undefined;
export async function currentFeeds(connection: Connection, maxAgeMs = QUOTE_CACHE_MS, accounts?: PythAccounts) {
  const key = accounts ? `${accounts.SOL.toBase58()}:${accounts.SKR.toBase58()}` : 'env';
  if (cached && cached.key === key && Date.now() - cached.at < maxAgeMs) return cached.feeds;
  const feeds = await fetchFeeds(connection, { accounts });
  cached = { at: Date.now(), key, feeds };
  return feeds;
}
export function _resetQuoteCache() { cached = undefined; }

export async function packQuote(db: Db, connection: Connection, wallet: string, req: QuoteRequest) {
  const p = PACKS[SKUS[req.sku]];
  const state = walletPackState(db, wallet, req.sku);
  if (req.sku === 0 && state.starterClaimed) throw new ServiceError(409, 'starter_claimed', 'Starter pack already claimed by this wallet');
  if (p.dailyCap && state.boughtToday + req.qty > p.dailyCap) throw new ServiceError(429, 'daily_cap', `Daily cap ${p.dailyCap} for ${p.name} reached (${state.boughtToday} bought today)`);

  const { cents, discountBps } = priceCents(req.sku, req.qty, req.currency);
  const base = {
    sku: req.sku, qty: req.qty, currency: req.currency, discountBps,
    priceUsdCents: cents,
    rentReserveLamports: String(RENT_RESERVE_PER_CHIP * BigInt(p.chips) * BigInt(req.qty)),
    effectiveOddsBps: effectiveOdds(p, state.pity),
    pityCounter: state.pity,
    hardPityIn: p.pity ? Math.max(0, p.pity.hardAt - state.pity) : 0,
    nonce: String(BigInt(`0x${randomBytes(8).toString('hex')}`)),
    accounts: {} as Record<string, string>,
    switchboardQueue: SWITCHBOARD_QUEUE,
    pythUpdateData: [] as string[], // push model: nothing to post in the buyer's tx — our pusher already did
  };

  if (req.currency === 'USDC') return { ...base, amount: String(cents * 10_000), maxLamports: '0', expiresAt: new Date(Date.now() + 300_000).toISOString() };
  if (req.currency === 'CG') {
    const amount = Math.floor((p.priceCgMicro! * req.qty * (10_000 - discountBps)) / 10_000);
    return { ...base, amount: String(amount), maxLamports: '0', expiresAt: new Date(Date.now() + 300_000).toISOString() };
  }

  // volatile rails — read our Pyth accounts
  let feeds: Awaited<ReturnType<typeof fetchFeeds>>;
  try {
    const accounts = await configuredPriceAccounts(connection);
    feeds = await currentFeeds(connection, QUOTE_CACHE_MS, accounts);
  } catch (e) { throw new ServiceError(503, 'price_unavailable', `RPC error reading configured Pyth feeds: ${(e as Error).message}`); }
  const snap = feeds[req.currency];
  if (snap instanceof PythError) throw new ServiceError(503, 'price_unavailable', snap.message);
  if (!quoteIsUsable(snap)) throw new ServiceError(503, 'price_unavailable', `${snap.feed.pair} update is ${snap.ageS} s old — waiting for the next push`);
  const { amount, maxUnits } = quoteUnits(snap, cents);
  const other = feeds[req.currency === 'SOL' ? 'SKR' : 'SOL'];
  return {
    ...base,
    amount: String(amount),
    maxLamports: String(maxUnits),
    priceUpdateAccount: snap.account.toBase58(),
    solUsd: req.currency === 'SOL' ? snap.usd : (other instanceof PythError ? undefined : other.usd),
    skrUsd: req.currency === 'SKR' ? snap.usd : (other instanceof PythError ? undefined : other.usd),
    priceAgeS: snap.ageS,
    expiresAt: new Date((now() + quoteValidForS(snap)) * 1000).toISOString(),
  };
}

export type PackQuote = Awaited<ReturnType<typeof packQuote>>;
export type { FeedSnapshot };

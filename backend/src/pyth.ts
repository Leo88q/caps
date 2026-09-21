// Pyth PriceUpdateV2 reader for the backend (owner decision Q7: we post the
// prices ourselves into push-oracle shard PYTH_SHARD_ID; the program accepts
// any shard as long as owner / feed id / age check out, so the API quotes
// from the SAME accounts the client will pass to buy_pack / pay_service).
//
// Layout (pyth-solana-receiver-sdk 1.x, mirrored in client/src/chain/pyth.ts):
//   8 disc ‖ write_authority[32] ‖ VerificationLevel (0 Partial{u8} | 1 Full)
//   ‖ PriceFeedMessage { feed_id[32], price i64, conf u64, exponent i32,
//     publish_time i64, prev_publish_time i64, ema_price i64, ema_conf u64 }
//   ‖ posted_slot u64
import { Connection, PublicKey } from '@solana/web3.js';
import {
  PYTH_FEEDS, PYTH_PROGRAMS, PYTH_MAX_AGE_SECS, PYTH_MAX_CONF_BPS, PYTH_PUSHER, unitsForCents, maxUnitsWithSlippage, pythPriceToUsd, effectivePythPrice, confBps,
  type PythFeed,
} from '@guttercaps/economy';
import { BorshReader } from './borsh.ts';
import { PYTH_ACCOUNTS, PYTH_SHARD_ID } from './config.ts';
import { type Db, now } from './db.ts';
import { configPda, decodeGameConfig } from './chain.ts';

export const PYTH_RECEIVER = new PublicKey(PYTH_PROGRAMS.receiver);
export const PYTH_PUSH_ORACLE = new PublicKey(PYTH_PROGRAMS.pushOracle);

export interface PythPrice {
  feedIdHex: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: number;
  emaPrice: bigint;
  postedSlot: bigint;
  verification: 'full' | 'partial';
}

export function pushOracleAccount(shard: number, feedIdHex: string): PublicKey {
  const s = new Uint8Array(2); s[0] = shard & 0xff; s[1] = (shard >> 8) & 0xff;
  return PublicKey.findProgramAddressSync([Buffer.from(s), Buffer.from(feedIdHex, 'hex')], PYTH_PUSH_ORACLE)[0];
}

export function decodePriceUpdateV2(data: Uint8Array): PythPrice {
  const r = new BorshReader(data, 8);
  r.bytes(32); // write_authority
  const vl = r.u8();
  if (vl === 0) r.u8(); // Partial { num_signatures }
  const feedIdHex = Buffer.from(r.bytes(32)).toString('hex');
  const price = r.i64();
  const conf = r.u64();
  const exponent = new DataView(r.buf.buffer, r.buf.byteOffset + r.offset, 4).getInt32(0, true); r.bytes(4);
  const publishTime = Number(r.i64());
  r.i64(); // prev_publish_time
  const emaPrice = r.i64();
  r.u64(); // ema_conf
  const postedSlot = r.u64();
  return { feedIdHex, price, conf, exponent, publishTime, emaPrice, postedSlot, verification: vl === 0 ? 'partial' : 'full' };
}

/** The price-update account the API quotes from (and hands to the client) per symbol. */
export function priceAccountFor(symbol: 'SOL' | 'SKR'): PublicKey {
  return PYTH_ACCOUNTS[symbol] ?? pushOracleAccount(PYTH_SHARD_ID, PYTH_FEEDS[symbol].feedIdHex);
}

export interface PythAccounts { SOL: PublicKey; SKR: PublicKey }

/**
 * The on-chain GameConfig is authoritative. Environment values are useful for
 * local tooling, but using them for a quote while the program expects another
 * account makes every volatile purchase fail (or, worse, prices a different
 * feed). Read the config before quoting and pass these exact accounts through
 * to the reader.
 */
export async function configuredPriceAccounts(connection: Connection): Promise<PythAccounts> {
  const info = await connection.getAccountInfo(configPda()[0], 'confirmed');
  if (!info) throw new Error(`GameConfig ${configPda()[0].toBase58()} is missing`);
  const cfg = decodeGameConfig(new Uint8Array(info.data));
  if (cfg.pythSolUsdFeed.equals(PublicKey.default) || cfg.pythSkrUsdFeed.equals(PublicKey.default)) {
    throw new Error('GameConfig Pyth feed account is not configured');
  }
  return { SOL: cfg.pythSolUsdFeed, SKR: cfg.pythSkrUsdFeed };
}

export interface FeedSnapshot { feed: PythFeed; account: PublicKey; price: PythPrice; usd: number; ageS: number; fetchedAt: number }

export class PythError extends Error {
  constructor(public code: 'price_missing' | 'price_owner' | 'price_feed' | 'price_stale' | 'price_unverified' | 'price_uncertain', message: string) { super(message); }
}

/**
 * Validate exactly what chip_core validates (owner, feed id, verification, age, SEC-M2 confidence)
 * — plus our stricter age margin. A snapshot that passes here is one the program will accept.
 */
export function validateSnapshot(feed: PythFeed, account: PublicKey, owner: PublicKey | null, data: Uint8Array | null, maxAgeS = PYTH_MAX_AGE_SECS): PythPrice {
  if (!data || !owner) throw new PythError('price_missing', `${feed.pair} price account ${account.toBase58()} does not exist (pusher never posted?)`);
  if (!owner.equals(PYTH_RECEIVER)) throw new PythError('price_owner', `${feed.pair} account is not owned by the Pyth receiver`);
  const p = decodePriceUpdateV2(data);
  if (p.feedIdHex !== feed.feedIdHex) throw new PythError('price_feed', `${feed.pair} account carries feed ${p.feedIdHex.slice(0, 8)}…`);
  if (p.verification !== 'full') throw new PythError('price_unverified', `${feed.pair} update is only partially verified`);
  if (p.price <= 0n) throw new PythError('price_stale', `${feed.pair} price is not positive`);
  const age = now() - p.publishTime;
  if (age > maxAgeS) throw new PythError('price_stale', `${feed.pair} price is ${age} s old (max ${maxAgeS} s)`);
  const cb = confBps(p.price, p.conf);
  if (cb > PYTH_MAX_CONF_BPS || p.conf >= BigInt(p.price)) throw new PythError('price_uncertain', `${feed.pair} confidence ±${(cb / 100).toFixed(2)} % exceeds ${PYTH_MAX_CONF_BPS / 100} % — publishers disagree; retry after the next update`);
  return p;
}

/** Read both feeds in one RPC round-trip. Throws PythError for the first invalid feed unless `lenient`. */
export async function fetchFeeds(connection: Connection, opts: { maxAgeS?: number; accounts?: PythAccounts } = {}): Promise<Record<'SOL' | 'SKR', FeedSnapshot | PythError>> {
  const symbols = ['SOL', 'SKR'] as const;
  const accounts = symbols.map((s) => opts.accounts?.[s] ?? priceAccountFor(s));
  const infos = await connection.getMultipleAccountsInfo(accounts, 'confirmed');
  const t = now();
  const out = {} as Record<'SOL' | 'SKR', FeedSnapshot | PythError>;
  symbols.forEach((s, i) => {
    const feed = PYTH_FEEDS[s];
    try {
      const price = validateSnapshot(feed, accounts[i], infos[i]?.owner ?? null, infos[i] ? new Uint8Array(infos[i]!.data) : null, opts.maxAgeS);
      out[s] = { feed, account: accounts[i], price, usd: pythPriceToUsd(price.price, price.exponent), ageS: t - price.publishTime, fetchedAt: t };
    } catch (e) {
      out[s] = e instanceof PythError ? e : new PythError('price_missing', String((e as Error).message ?? e));
    }
  });
  return out;
}

/**
 * Amount + slippage guard for `usdCents` in the feed's currency — identical integers to the program:
 * `units_for_cents(cents, price − conf, expo)` (SEC-M2: the protocol-favouring edge of the interval).
 */
export function quoteUnits(snapshot: FeedSnapshot, usdCents: number): { amount: bigint; maxUnits: bigint } {
  const amount = unitsForCents(usdCents, effectivePythPrice(snapshot.price.price, snapshot.price.conf), snapshot.price.exponent, snapshot.feed.decimals);
  return { amount, maxUnits: maxUnitsWithSlippage(amount) };
}

/**
 * Seconds the quote stays usable: the on-chain check is `publish_time + 60 ≥ now`,
 * so a buyer must land the transaction before the CURRENT update expires — unless
 * the pusher posts a newer one first (it does, every ≈ 30 s). We advertise the
 * conservative bound and refuse to quote when less than quoteMinRemainingS is left.
 */
export function quoteValidForS(snapshot: FeedSnapshot): number {
  return Math.max(0, PYTH_MAX_AGE_SECS - snapshot.ageS);
}
export const quoteIsUsable = (snapshot: FeedSnapshot) => quoteValidForS(snapshot) >= PYTH_PUSHER.quoteMinRemainingS;

/** Write the cache row the read-models use for USD normalisation (services.ts::prices). */
export function cachePrice(db: Db, symbol: 'SOL' | 'SKR', snapshot: FeedSnapshot) {
  db.run(`INSERT INTO oracle_prices (symbol, usd, updated_at, publish_time, account, conf_bps) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol) DO UPDATE SET usd = excluded.usd, updated_at = excluded.updated_at, publish_time = excluded.publish_time, account = excluded.account, conf_bps = excluded.conf_bps`,
    symbol, snapshot.usd, snapshot.fetchedAt, snapshot.price.publishTime, snapshot.account.toBase58(), Number((snapshot.price.conf * 10_000n) / snapshot.price.price));
}

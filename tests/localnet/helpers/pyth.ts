// Pyth `PriceUpdateV2` fixtures for the suite (docs/06 §3.5 "Pyth-фикстура").
//
// chip_core reads SOL/USD (currency 0) and SKR/USD (currency 3) through
// `pyth_solana_receiver_sdk::PriceUpdateV2::get_price_no_older_than(60 s)`, which checks
// (a) the account is owned by the receiver program `rec5…`, (b) the Anchor discriminator,
// (c) `verification_level == Full`, (d) `feed_id`, (e) `publish_time` age. It never checks a
// signature — the receiver program did that when the update was posted — so on localnet we can
// simply *write* a well-formed account under the receiver's owner:
//
//   * LiteSVM: `chain.setAccount(...)` (owner is arbitrary) — refreshed before every SOL/SKR buy
//     so `publish_time` stays within the 60 s window after clock warps (`refreshPyth`).
//   * RPC (`npm run test:validator` / `anchor test`): fixtures/pyth_{sol,skr}_usd.json are loaded at
//     genesis (`--account`, also declared in Anchor.toml) at the deterministic addresses below,
//     with `publish_time` = 2100-01-01 — the SDK only checks `publish_time + max_age ≥ now`, so
//     they never go stale. Age-sensitive scenarios (`StalePrice`, forged owner) are LiteSVM-only.
//
// Layout mirrors backend/src/pyth.ts / client/src/chain/pyth.ts (SDK 1.0.1, LEN 134):
//   8 disc ‖ write_authority[32] ‖ VerificationLevel (1 = Full) ‖ feed_id[32] ‖ price i64 ‖ conf u64
//   ‖ exponent i32 ‖ publish_time i64 ‖ prev_publish_time i64 ‖ ema_price i64 ‖ ema_conf u64 ‖ posted_slot u64
import { Keypair, PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { BorshWriter } from '@/chain/borsh';
import { PYTH_RECEIVER_ID, PYTH_SKR_USD_FEED_ID_HEX, PYTH_SOL_USD_FEED_ID_HEX } from '@/chain/ids';
import type { Chain } from './chain';

/** `conf` = the confidence interval the fixture is posted with (default price / 1000 = 0.1 %, like encodePriceUpdateV2). */
export interface PythFixture { account: PublicKey; feedIdHex: string; price: bigint; exponent: number; decimals: number; conf: bigint }
export interface PythPrices { sol: PythFixture; skr: PythFixture }

/** $150.00 / SOL and $0.0174 / SKR with Pyth's usual expo −8 */
export const SOL_USD_PRICE = 15_000_000_000n;
export const SKR_USD_PRICE = 1_740_000n;
export const PYTH_EXPO = -8;

const DISC = sha256(new TextEncoder().encode('account:PriceUpdateV2')).slice(0, 8);

export function encodePriceUpdateV2(o: { feedIdHex: string; price: bigint; exponent?: number; conf?: bigint; publishTime: bigint; partial?: boolean; postedSlot?: bigint }): Uint8Array {
  const w = new BorshWriter().bytes(DISC).pubkey(PublicKey.default);
  if (o.partial) w.u8(0).u8(5); else w.u8(1);
  w.bytes(Buffer.from(o.feedIdHex, 'hex')).i64(o.price).u64(o.conf ?? o.price / 1000n);
  const e = new Uint8Array(4); new DataView(e.buffer).setInt32(0, o.exponent ?? PYTH_EXPO, true); w.bytes(e);
  w.i64(o.publishTime).i64(o.publishTime - 1n).i64(o.price).u64(o.conf ?? o.price / 1000n).u64(o.postedSlot ?? 1n);
  return w.toBytes();
}

/**
 * units (lamports / micro-SKR) for `cents` at a fixture price — same integer math as `units_for_cents`
 * in packs.rs applied to `oracle_price` = price − conf (SEC-M2: the protocol-favouring edge).
 */
export function unitsForCents(cents: bigint, f: PythFixture): bigint {
  const scale = 10n ** BigInt(Math.abs(f.exponent));
  return (cents * 10n ** BigInt(f.decimals) * scale) / 100n / (f.price - f.conf);
}

/** Fixture addresses: fresh per LiteSVM run, deterministic on RPC (must match run-validator.ts `fixtureKey`). */
const fixtureKey = (name: string) => Keypair.fromSeed(sha256(new TextEncoder().encode(`guttercaps/localnet/pyth/${name}`))).publicKey;
const solAccount = Keypair.generate().publicKey;
const skrAccount = Keypair.generate().publicKey;

/** Create both fixtures with `publish_time = now` (LiteSVM) or resolve the pre-posted accounts (RPC). */
export async function postPythPrices(chain: Chain): Promise<PythPrices> {
  const prices: PythPrices = {
    sol: { account: chain.kind === 'litesvm' ? solAccount : new PublicKey(process.env.PYTH_SOL_ACCOUNT ?? fixtureKey('SOL')), feedIdHex: PYTH_SOL_USD_FEED_ID_HEX, price: SOL_USD_PRICE, exponent: PYTH_EXPO, decimals: 9, conf: SOL_USD_PRICE / 1000n },
    skr: { account: chain.kind === 'litesvm' ? skrAccount : new PublicKey(process.env.PYTH_SKR_ACCOUNT ?? fixtureKey('SKR')), feedIdHex: PYTH_SKR_USD_FEED_ID_HEX, price: SKR_USD_PRICE, exponent: PYTH_EXPO, decimals: 6, conf: SKR_USD_PRICE / 1000n },
  };
  if (chain.kind === 'litesvm') await refreshPyth(chain, prices);
  else {
    for (const f of [prices.sol, prices.skr]) {
      const acc = await chain.getAccount(f.account);
      if (!acc || !acc.owner.equals(PYTH_RECEIVER_ID)) throw new Error(`Pyth fixture ${f.account.toBase58()} missing on the validator — start it with tests/localnet/run-validator.ts (npm run test:validator)`);
    }
  }
  return prices;
}

/** Re-post both fixtures with `publish_time = chain.now() − ageS` (default fresh). `conf` overrides the interval (SEC-M2 scenarios). LiteSVM only. */
export async function refreshPyth(chain: Chain, prices: PythPrices, opts: { ageS?: bigint; price?: Partial<Record<'sol' | 'skr', bigint>>; conf?: Partial<Record<'sol' | 'skr', bigint>>; partial?: boolean } = {}) {
  if (chain.kind !== 'litesvm') return;
  const now = await chain.now();
  const slot = await chain.slot();
  for (const k of ['sol', 'skr'] as const) {
    const f = prices[k];
    const data = encodePriceUpdateV2({ feedIdHex: f.feedIdHex, price: opts.price?.[k] ?? f.price, conf: opts.conf?.[k] ?? f.conf, exponent: f.exponent, publishTime: now - (opts.ageS ?? 0n), partial: opts.partial, postedSlot: slot });
    await chain.setAccount(f.account, { owner: PYTH_RECEIVER_ID, data });
  }
}

/** A look-alike price account under a foreign owner (SEC: owner check on price_update). LiteSVM only. */
export async function forgePriceAccount(chain: Chain, f: PythFixture, owner: PublicKey): Promise<PublicKey> {
  const key = Keypair.generate().publicKey;
  const data = encodePriceUpdateV2({ feedIdHex: f.feedIdHex, price: f.price, conf: f.conf, exponent: f.exponent, publishTime: await chain.now() });
  await chain.setAccount(key, { owner, data });
  return key;
}

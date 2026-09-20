// Deterministic synthetic chain history — the fixture tier of LT-3 (docs/06 §7).
//
// Why it exists: every projection test in this repo feeds one hand-written scenario (`fixtures.ts` →
// `world()`), which proves the reducers on a happy path of ~15 events. LT-3 asks a different question: does
// a *replay of the whole log* land on exactly the same state as a live index, on a corpus large enough that
// ordering, dedup and cross-table counters can actually disagree? That needs tens of thousands of
// interdependent events, which nobody hand-writes.
//
// So this is a tiny chain simulator, not a random event sprinkler: it tracks ownership of every chip it
// mints and only emits what the on-chain program could have emitted (you cannot list a chip you do not own,
// sell an unlisted one, or unstake what was never staked). A sprinkler would produce projections that are
// byte-identical *because they are all no-ops* — a green test that tests nothing.
//
// Determinism: every byte comes out of `seed` (no Math.random, no wall clock, no Keypair.generate()). Same
// seed ⇒ same events in the same order on any machine; without that, a "projections match" assertion is a
// flake generator rather than a proof. The same `walkHistory` feeds both the in-memory test corpus and the
// streamed 10⁶-event bench, so the bench measures the same shape the unit tests assert on.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { fakeLogs, MAX_CHIPS_PER_PACK, type EventData } from '../src/events.ts';
import type { ProgramName } from '../src/config.ts';
import type { TxLike } from '../src/ingest.ts';

export interface HistoryOpts {
  /** transactions to emit; events land at 1.5–3 per tx */
  txs?: number;
  players?: number;
  seed?: number;
  startSlot?: number;
  startBlockTime?: number;
  /** inject the messiness a real indexer sees: duplicates, ws-before-backfill, failed txs, junk log lines */
  noise?: boolean;
  /**
   * withhold some transactions and deliver them late (a backfill page filling an RPC gap). Off for the
   * "projections are identical" assertions on arrival order, on for the "rebuild is the fixpoint" ones.
   */
  gapFill?: boolean;
  /** stop once this many events have been produced (the bench sizes a corpus in events, not txs) */
  maxEvents?: number;
}

export interface HistoryStats {
  txs: number;
  /**
   * events the world produced — and the number of rows `events_raw` must end up with. The noise copies
   * (re-scan, ws-first, failed tx) deliberately do not raise it: they are what dedup must swallow.
   */
  events: number;
  byName: Record<string, number>;
  chipsMinted: number;
  chipsBurned: number;
  dupes: number;
  lateBlockTimes: number;
  failedTxs: number;
  junkTxs: number;
  /** events whose rows arrive *after* newer ones — the case a (slot, id)-ordered replay must reproduce */
  deferred: number;
}

export interface History {
  txs: TxLike[];
  stats: HistoryStats;
}

export const DEFAULT_SEED = 0x6c730003; // "lt3"

/** mulberry32 — a 32-bit seeded PRNG: dependency-free and identical on every V8. */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An address derived only from (seed, kind, index) — sha256, because a 32-bit hash would collide across
 * 10⁵ ids often enough to break the fixture's uniqueness assumptions (birthday bound, not malice). Not a
 * curve point on purpose: the indexer treats addresses as opaque strings.
 */
export function fixtureAddr(seed: number, kind: string, i: number): string {
  return new PublicKey(createHash('sha256').update(`gc-lt3|${seed}|${kind}|${i}`).digest()).toBase58();
}

const NULL_ADDR = '11111111111111111111111111111111';
const hex32 = (x: number) => (x >>> 0).toString(16).padStart(8, '0').repeat(8);
const sol = (r: () => number, min: number, max: number) => String(BigInt(min + Math.floor(r() * (max - min))) * 1_000_000_000n);
const usd = (r: () => number, min: number, max: number) => String(BigInt(min + Math.floor(r() * (max - min))) * 1_000_000n);

/** byte order of base58 addresses — the same comparison `fusion.rs` (and projections.ts) sorts on */
function cmpBase58(a: string, b: string): number {
  const A = new PublicKey(a).toBytes();
  const B = new PublicKey(b).toBytes();
  for (let i = 0; i < 32; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

interface Chip { owner: string; collection: number; rarity: number; listed: boolean; staked: boolean; burned: boolean; price: string; soulbound: boolean }

/** recent transactions, kept so the noise pass can re-visit them the way a rescan of the last slots does */
const RING = 4096;
/** every Nth iteration the indexer sees the transaction "live" first (no block time), then via backfill */
const WS_FIRST_EVERY = 40;
/** every Nth iteration a slot rescan re-visits a recent transaction */
const RESCAN_EVERY = 25;
/** every Nth iteration a failed transaction with our logs in it shows up */
const FAILED_EVERY = 50;
/**
 * every Nth transaction is withheld and delivered at the end: what an RPC gap looks like when the live
 * listener missed a tx and a later backfill page fills it in. The indexer must not care about the order
 * (replay re-sorts by slot), and this is the only noise case that can prove it.
 */
const DEFER_EVERY = 60;

/**
 * Walk the simulated world, yielding transactions in the order an indexer would receive them. Lazy on
 * purpose: 10⁶ events must not mean 10⁶ `TxLike` objects held in memory.
 */
export function* walkHistory(opts: HistoryOpts = {}): Generator<TxLike, HistoryStats, void> {
  const txsWanted = Math.max(1, Math.floor(opts.txs ?? 400));
  const players = opts.players ?? 12;
  const seed = opts.seed ?? DEFAULT_SEED;
  const noise = opts.noise !== false;
  const gapFill = opts.gapFill !== false;
  const startSlot = opts.startSlot ?? 100_000;
  const bt0 = opts.startBlockTime ?? 1_700_000_000;
  const rnd = rngOf(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

  const stats: HistoryStats = { txs: 0, events: 0, byName: {}, chipsMinted: 0, chipsBurned: 0, dupes: 0, lateBlockTimes: 0, failedTxs: 0, junkTxs: 0, deferred: 0 };
  const wallets = Array.from({ length: players }, (_, i) => fixtureAddr(seed, 'w', i));
  const chips = new Map<string, Chip>();
  const nonces = new Map<string, number>();
  const stakeKeys = new Map<string, { owner: string; amount: bigint }>();
  const stakedChips = new Map<string, string>(); // asset → owner, for the kind-1 unstake path
  const openBattles: string[] = [];
  const epochs = new Map<number, number>();
  const ring: TxLike[] = [];
  const deferred: TxLike[] = [];
  let slot = startSlot;
  let chipN = 0, battleN = 0, sigN = 0, dayIndex = 0, paramVersion = 0, iCur = -1;
  let firstCompressedEvent: { program: ProgramName; name: string; data: EventData } | undefined;
  let lastRoot: { kind: number; epoch: number } | undefined;
  const dayEvery = Math.max(25, Math.min(RESCAN_EVERY * 16, Math.floor(txsWanted / 8)));
  const blockTime = () => bt0 + (slot - startSlot);

  /** build the transaction for `events`, then yield it — with its websocket twin first when the schedule says so */
  function* emit(events: { program: ProgramName; name: string; data: EventData }[], o: { cpiFrom?: ProgramName; junk?: boolean } = {}): Generator<TxLike, void, void> {
    if (firstCompressedEvent) {
      events = [firstCompressedEvent, ...events];
      firstCompressedEvent = undefined;
    }
    slot += 1 + Math.floor(rnd() * 4);
    for (const e of events) stats.byName[e.name] = (stats.byName[e.name] ?? 0) + 1;
    stats.events += events.length;
    const logs = fakeLogs(events, { cpiFrom: o.cpiFrom });
    if (o.junk && noise) {
      // two undecodable frames + an unrelated program: a decoder that is not strict about its log grammar
      // turns these into phantom events
      logs.push('Program data: not-base64!!', 'Program data: AAAAAAAAAA', `Program ${NULL_ADDR} invoke [1]`, `Program ${NULL_ADDR} success`);
      stats.junkTxs++;
    }
    const t: TxLike = { signature: fixtureAddr(seed, 'sig', ++sigN), slot, blockTime: blockTime(), logs, err: null };
    // (1) the messy part of reality: confirmed-but-not-yet-timed, seen live before the backfill finds it.
    // Yielded *before* the canonical copy on purpose — arriving the other way round would hide the bug.
    if (noise && iCur % WS_FIRST_EVERY === 7 && ring.length > 0) {
      stats.lateBlockTimes++;
      yield { ...t, blockTime: null };
    }
    if (gapFill && iCur % DEFER_EVERY === 17) {
      // a tx the live listener "missed": it lands after much newer ones, so ingest order ≠ (slot, id) order
      deferred.push(t);
      stats.deferred++;
    } else {
      yield t;
    }
    ring.push(t);
    if (ring.length > RING) ring.shift();
    stats.txs++;
  }
  const nonceFor = (w: string) => { const n = (nonces.get(w) ?? 0) + 1; nonces.set(w, n); return n; };
  const mintChip = (owner: string, collection: number, rarity: number, soulbound: boolean): string => {
    const asset = fixtureAddr(seed, 'chip', ++chipN);
    chips.set(asset, { owner, collection, rarity, listed: false, staked: false, burned: false, price: '0', soulbound });
    stats.chipsMinted++;
    return asset;
  };
  const chipsOf = (owner: string, f: (c: Chip) => boolean) => [...chips.entries()].filter(([, c]) => c.owner === owner && f(c));
  const pad5 = <T,>(xs: readonly T[], fill: T): T[] => [...xs, ...Array<T>(Math.max(0, MAX_CHIPS_PER_PACK - xs.length)).fill(fill)];

  const maxEvents = opts.maxEvents && opts.maxEvents > 0 ? opts.maxEvents : Number.POSITIVE_INFINITY;
  for (iCur = 0; iCur < txsWanted && stats.events < maxEvents; iCur++) {
    const i = iCur;
    const actor = pick(wallets);
    const roll = rnd();

    // The migration event is included in the corpus even before the live
    // compressed pack path is enabled, so replay tests exercise its decoder
    // and projection handler rather than leaving it untested. It is attached
    // to the first real transaction, not emitted as a new transaction, so
    // cursor/restart fixtures retain their original slot topology.
    if (i === 0) {
      firstCompressedEvent = {
        program: 'chip_core', name: 'CompressedChipRegistered', data: {
          asset: fixtureAddr(seed, 'compressed-asset', 0), collectionIdx: 1,
          merkleTree: fixtureAddr(seed, 'compressed-tree', 0), leafIndex: 0, leafNonce: '0',
          owner: actor, delegate: actor, rarity: 2, level: 1, gameIndex: '1', flags: 0,
        },
      };
    }

    // the emission day closes every `dayEvery` txs (sized off the corpus so even a 400-tx fixture covers the
    // ledger): `emission_days` + roots are the tables a rebuild cannot afford to reorder, because
    // `sliceBudget` and `burn7dAvg` feed the emission guard
    if (i > 0 && i % dayEvery === 0) {
      dayIndex++;
      yield* emit([{
        program: 'staking', name: 'DayClosed', data: {
          dayIndex, year: 1 + (dayIndex % 3), scheduleCap: sol(rnd, 1, 40), guarded: sol(rnd, 1, 30),
          burn7dAvg: usd(rnd, 0, 9), sliceBudget: Array.from({ length: 5 }, () => usd(rnd, 1, 8)),
        },
      }]);
      const kind = Math.floor(rnd() * 10);
      const epoch = (epochs.get(kind) ?? 0) + 1;
      epochs.set(kind, epoch);
      lastRoot = { kind, epoch };
      yield* emit([{ program: 'staking', name: 'RootPublished', data: { kind, epoch, root: hex32(epoch * 7 + kind), budget: usd(rnd, 10, 900) } }]);
      if (rnd() < 0.3) yield* emit([{ program: 'staking', name: 'RootRevoked', data: { kind, epoch } }]);
      continue;
    }
    if (roll < 0.17) {
      // a pack: bought, then opened tx by tx (as on chain); each open mints 1..5 chips
      const sku = 1 + Math.floor(rnd() * 3);
      const qty = 1 + Math.floor(rnd() * 2);
      const nonce = nonceFor(actor);
      yield* emit([{ program: 'chip_core', name: 'PackBought', data: { buyer: actor, sku, qty, currency: Math.floor(rnd() * 3), amount: usd(rnd, 33, 330), nonce: String(nonce), randomness: fixtureAddr(seed, 'rng', i) } }]);
      for (let n = 0; n < qty; n++) {
        const count = 1 + Math.floor(rnd() * MAX_CHIPS_PER_PACK);
        const assets = Array.from({ length: count }, () => mintChip(actor, Math.floor(rnd() * 8) /* 0..7: the 8-collection universe */, Math.floor(rnd() * 5), false));
        yield* emit([{
          program: 'chip_core', name: 'PackOpened', data: {
            buyer: actor, sku, nonce: String(nonce),
            assets: pad5(assets, NULL_ADDR),
            rarities: pad5(assets.map((a) => chips.get(a)!.rarity), 0),
            collections: pad5(assets.map((a) => chips.get(a)!.collection), 0),
            count, roll: hex32(i * 31 + n), pityBefore: Math.floor(rnd() * 30), pityAfter: Math.floor(rnd() * 30),
          },
        }]);
      }
      if (rnd() < 0.08) yield* emit([{ program: 'chip_core', name: 'PackCancelled', data: { buyer: actor, nonce: String(nonceFor(actor)), refunded: usd(rnd, 33, 200) } }]);
      continue;
    }
    if (roll < 0.22) {
      // quest voucher: free issue, then an open with sku 0 — the soulbound branch of PackOpened
      const nonce = nonceFor(actor);
      const template = Math.floor(rnd() * 4);
      yield* emit([{ program: 'chip_core', name: 'VoucherIssued', data: { wallet: actor, nonce: String(nonce), template, randomness: fixtureAddr(seed, 'rng', i) } }]);
      const asset = mintChip(actor, Math.floor(rnd() * 8), Math.floor(rnd() * 3), true);
      yield* emit([{
        program: 'chip_core', name: 'PackOpened', data: {
          buyer: actor, sku: 0, nonce: String(nonce),
          assets: pad5([asset], NULL_ADDR),
          rarities: pad5([chips.get(asset)!.rarity], 0),
          collections: pad5([chips.get(asset)!.collection], 0),
          count: 1, roll: hex32(i), pityBefore: 0, pityAfter: 0,
        },
      }]);
      continue;
    }
    if (roll < 0.42) {
      const mine = chipsOf(actor, (c) => !c.listed && !c.staked && !c.burned && !c.soulbound);
      if (mine.length === 0) {
        yield* emit([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: actor, kind: Math.floor(rnd() * 5), currency: Math.floor(rnd() * 3), amount: usd(rnd, 1, 200), burned: usd(rnd, 0, 200), refHash: hex32(i) } }]);
        continue;
      }
      const [asset, chip] = pick(mine);
      const price = usd(rnd, 5, 500);
      yield* emit([{ program: 'market', name: 'ChipListed', data: { asset, seller: actor, price, currency: Math.floor(rnd() * 3) } }]);
      chip.listed = true;
      chip.price = price;
      if (rnd() < 0.3) yield* emit([{ program: 'market', name: 'ListingUpdated', data: { asset, price: usd(rnd, 5, 500) } }]);
      if (rnd() < 0.2) { yield* emit([{ program: 'market', name: 'ListingCancelled', data: { asset } }]); chip.listed = false; }
      continue;
    }
    if (roll < 0.58) {
      // a listing changes hands, sometimes through an offer the buyer had placed (so the offer row gets deleted)
      const listed = [...chips.entries()].filter(([, c]) => c.listed && !c.burned);
      if (listed.length === 0) continue;
      const [asset, chip] = pick(listed);
      const buyers = wallets.filter((w) => w !== chip.owner);
      if (buyers.length === 0) continue;
      const buyer = pick(buyers);
      const viaOffer = rnd() < 0.35;
      if (viaOffer) yield* emit([{ program: 'market', name: 'OfferMade', data: { asset, bidder: buyer, amount: chip.price, expiresAt: String(blockTime() + 3600) } }], { junk: rnd() < 0.35 });
      yield* emit([
        { program: 'chip_core', name: 'ChipFlagsChanged', data: { asset, flags: 0, lockUntil: '0' } },
        { program: 'market', name: 'ChipSold', data: { asset, seller: chip.owner, buyer, price: chip.price, currency: 0, fee: usd(rnd, 1, 40), royalty: usd(rnd, 0, 20), viaOffer } },
      ], { cpiFrom: 'market' });
      if (viaOffer && rnd() < 0.4) yield* emit([{ program: 'market', name: 'OfferCancelled', data: { asset, bidder: pick(wallets.filter((w) => w !== buyer)) ?? buyer } }]);
      // a bid that just sits there: `offers` is state a rebuild must reproduce, not only a transient
      if (rnd() < 0.35) {
        const other = pick(listed.filter(([a]) => a !== asset));
        if (other) yield* emit([{ program: 'market', name: 'OfferMade', data: { asset: other[0], bidder: pick(buyers), amount: usd(rnd, 3, 400), expiresAt: String(blockTime() + 86_400) } }]);
      }
      chip.owner = buyer;
      chip.listed = false;
      continue;
    }
    if (roll < 0.68) {
      // fusion: 3 owned chips in, 1 out. Failures mirror fusion.rs refunding the lowest material key, so the
      // simulator's `burned` set stays equal to the projections' `burned_at` set.
      const mine = chipsOf(actor, (c) => !c.listed && !c.staked && !c.burned && !c.soulbound);
      if (mine.length < 3) continue;
      const mats = mine.slice(0, 3).map(([a]) => a);
      const recipe = Math.floor(rnd() * 8);
      const success = rnd() < 0.6;
      const first = chips.get(mats[0]!)!;
      const result = success ? mintChip(actor, first.collection, Math.min(4, first.rarity + 1), false) : NULL_ADDR;
      yield* emit([
        { program: 'chip_core', name: 'BurnReported', data: { source: 1, amount: usd(rnd, 1, 10) } },
        { program: 'chip_core', name: 'ChipFused', data: { owner: actor, recipe, materials: mats, result, success, rollBps: Math.floor(rnd() * 10_000), thresholdBps: 1000, feeBurned: usd(rnd, 1, 5) } },
      ]);
      const refund = recipe >= 4 ? new Set([...mats].sort(cmpBase58).slice(0, 1)) : new Set<string>();
      for (const m of mats) {
        if (!success && refund.has(m)) continue; // refunded → survives
        chips.get(m)!.burned = true;
        stats.chipsBurned++;
      }
      continue;
    }
    if (roll < 0.8) {
      // staking: a chip (kind 1, one position per chip) or a token stake (kind 0, partial unstakes)
      const mine = chipsOf(actor, (c) => !c.listed && !c.staked && !c.burned && c.rarity >= 1);
      if (stakedChips.size > 0 && rnd() < 0.3) {
        // unstaking a chip is a different branch than a token stake: it flips active=0 and clears the flag
        const [asset, owner] = pick([...stakedChips.entries()]);
        yield* emit([{ program: 'staking', name: 'Unstaked', data: { owner, kind: 1, key: asset, amount: '1', penaltyBurned: usd(rnd, 0, 5) } }]);
        stakedChips.delete(asset);
        const c = chips.get(asset);
        if (c) c.staked = false;
        continue;
      }
      if (rnd() < 0.5 && mine.length > 0) {
        const [asset, chip] = pick(mine);
        yield* emit([{ program: 'staking', name: 'Staked', data: { owner: actor, kind: 1, key: asset, amount: '1', weight: String(1000 + 500 * chip.rarity), unlockAt: '0' } }]);
        chip.staked = true;
        stakedChips.set(asset, actor);
        continue;
      }
      const key = fixtureAddr(seed, 'stake', i % Math.max(1, players * 2));
      const prev = stakeKeys.get(key);
      if (prev && rnd() < 0.5) {
        const partial = rnd() < 0.7;
        const amount = partial ? prev.amount / 2n : prev.amount;
        yield* emit([{ program: 'staking', name: 'Unstaked', data: { owner: prev.owner, kind: 0, key, amount: amount.toString(), penaltyBurned: partial ? '0' : usd(rnd, 0, 5) } }]);
        if (partial) stakeKeys.set(key, { ...prev, amount: prev.amount - amount });
        else stakeKeys.delete(key);
        continue;
      }
      const add = BigInt(usd(rnd, 1, 400)) + (prev?.amount ?? 0n);
      stakeKeys.set(key, { owner: actor, amount: add });
      yield* emit([{ program: 'staking', name: 'Staked', data: { owner: actor, kind: 0, key, amount: add.toString(), weight: String(add / 1_000_000n), unlockAt: String(blockTime() + 86_400 * (1 + Math.floor(rnd() * 30))) } }]);
      continue;
    }
    if (roll < 0.86) {
      // arena: created → accepted → resolved, plus cancels and *orphan* resolves (the backfill-gap branch)
      if (openBattles.length > 0 && rnd() < 0.6) {
        const battle = pick(openBattles);
        const drop = () => openBattles.splice(openBattles.indexOf(battle), 1);
        if (rnd() < 0.12) { yield* emit([{ program: 'arena', name: 'BattleCancelled', data: { battle, refundedA: usd(rnd, 1, 50), refundedB: '0' } }]); drop(); continue; }
        yield* emit([{ program: 'arena', name: 'BattleAccepted', data: { battle, opponent: pick(wallets), powerB: 100 + Math.floor(rnd() * 900) } }]);
        const rake = BigInt(Math.floor(rnd() * 19 + 1)) * 1_000_000n;
        yield* emit([{ program: 'arena', name: 'BattleResolved', data: { battle, winner: pick(wallets), pot: usd(rnd, 2, 100), rakeBurn: (rake * 2n / 5n).toString(), rakePool: rake.toString(), rakeTreasury: rake.toString(), resultHash: hex32(i), roll: hex32(i ^ 0x5bf0) } }]);
        drop();
      } else {
        const battle = fixtureAddr(seed, 'battle', ++battleN);
        yield* emit([{ program: 'arena', name: 'BattleCreated', data: { battle, challenger: actor, wager: usd(rnd, 10, 100), powerA: 100 + Math.floor(rnd() * 900), randomness: fixtureAddr(seed, 'rng', i) } }]);
        openBattles.push(battle);
      }
      // a resolve with no create: what a gap in the backfill looks like, and why the handler inserts the battle too
      if (rnd() < 0.06) yield* emit([{ program: 'arena', name: 'BattleResolved', data: { battle: fixtureAddr(seed, 'battle', 1_000_000 + i), winner: actor, pot: usd(rnd, 1, 2), rakeBurn: usd(rnd, 0, 1), rakePool: usd(rnd, 1, 2), rakeTreasury: usd(rnd, 1, 2), resultHash: hex32(i), roll: hex32(i) } }]);
      continue;
    }
    if (roll < 0.92) {
      const kind = Math.floor(rnd() * 10);
      const epoch = epochs.get(kind);
      if (!epoch) continue;
      yield* emit([{ program: 'staking', name: 'RootClaimed', data: { kind, epoch, wallet: actor, amount: usd(rnd, 1, 500) } }]);
      yield* emit([{ program: 'staking', name: 'Claimed', data: { owner: actor, kind, amount: usd(rnd, 1, 500) } }]);
      if (rnd() < 0.25) yield* emit([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: actor, kind: 0, currency: 2, amount: '199000000', burned: '199000000', refHash: hex32(i) } }]);
      continue;
    }
    // admin + treasury bookkeeping
    yield* emit([{ program: pick<ProgramName>(['chip_core', 'staking', 'arena']), name: 'PauseChanged', data: { by: actor, paused: rnd() < 0.5 } }]);
    if (rnd() < 0.5) {
      const funded = rnd() < 0.5;
      yield* emit([{ program: 'staking', name: funded ? 'SkrFunded' : 'SkrWithdrawn', data: funded ? { funder: actor, amount: usd(rnd, 1, 90), budget: usd(rnd, 1, 200), reserved: usd(rnd, 0, 50) } : { to: actor, amount: usd(rnd, 1, 90), budget: usd(rnd, 1, 200) } }]);
    }
    if (rnd() < 0.3) yield* emit([{ program: 'staking', name: 'SkrPoolChanged', data: { maxRootBudget: usd(rnd, 100, 5000), paused: rnd() < 0.1 } }]);
    if (lastRoot) yield* emit([{ program: 'staking', name: 'SliceFunded', data: { by: actor, kind: lastRoot.kind, amount: usd(rnd, 1, 60), sliceBudget: Array.from({ length: 5 }, () => usd(rnd, 0, 40)), recycledTotal: usd(rnd, 0, 100) } }]);
    if (rnd() < 0.4) yield* emit([{ program: 'staking', name: 'SetBonusSynced', data: { owner: actor, sets: Math.floor(rnd() * 8) } }]);
    // `source` is a pubkey per the event spec (which burn account fed the vault), so it takes an address
    if (rnd() < 0.4) yield* emit([{ program: 'staking', name: 'BurnRecorded', data: { source: fixtureAddr(seed, 'burnsrc', Math.floor(rnd() * 4)), amount: usd(rnd, 1, 20), burnToday: usd(rnd, 1, 400) } }]);
    if (rnd() < 0.3) { paramVersion++; yield* emit([{ program: 'chip_core', name: 'ParamsChanged', data: { admin: wallets[0]!, version: paramVersion } }]); }

    if (!noise) continue;
    // every 60th iteration also releases one withheld tx mid-walk, so they interleave with fresh traffic
    // instead of arriving as one clean tail block
    if (i % DEFER_EVERY === 41 && deferred.length > 0) yield deferred.shift()!;
    // (2) a slot rescan re-visiting a recent transaction — dedup has to swallow it
    if (i % RESCAN_EVERY === 3 && ring.length > 0) {
      stats.dupes++;
      yield { ...pick(ring), slot: slot + 1_000 };
    }
    // (3) failed transactions carry logs nobody may trust
    if (i % FAILED_EVERY === 11 && ring.length > 0) {
      const src = pick(ring);
      stats.failedTxs++;
      // '!' is not a base58 character, so a test can identify these without colliding with a real key
      yield { signature: `${src.signature}!fail`, slot: src.slot, blockTime: src.blockTime, logs: src.logs, err: { InstructionError: [0, { Custom: 6000 }] } };
    }
  }
  // the rest of the missed transactions: out of slot order by construction
  if (gapFill) for (const t of deferred) yield t;
  return stats;
}

/** Drain the walk into an array — what the unit tests index into SQLite. */
export function generateHistory(opts: HistoryOpts = {}): History {
  const it = walkHistory(opts);
  const txs: TxLike[] = [];
  for (;;) {
    const r = it.next();
    if (r.done) return { txs, stats: r.value };
    txs.push(r.value);
  }
}

/** Stream the walk into a sink without holding the corpus — what the LT-3 bench uses for 10⁶ events. */
export async function streamHistory(sink: (t: TxLike) => unknown, opts: HistoryOpts = {}): Promise<HistoryStats> {
  const it = walkHistory(opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await sink(r.value);
  }
}

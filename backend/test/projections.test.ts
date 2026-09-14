import { describe, it, expect, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Db, PROJECTION_TABLES } from '../src/db.ts';
import { ingestTx, replayStored } from '../src/ingest.ts';
import * as q from '../src/queries.ts';
import { world, tx, kp, DEFAULT, hex32 } from './fixtures.ts';

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('ingest + projections', () => {
  it('stores every event once and applies projections in order', () => {
    const w = world();
    let inserted = 0;
    for (const t of w.txs) inserted += ingestTx(t, db).inserted;
    expect(inserted).toBe(15);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw`)).toBe(15);

    // inventory: alice opened 6 chips, sold 1, burned 3 in a fusion, gained 1 → 3 alive
    const alice = q.myChips(db, w.alice, {});
    expect(alice.total).toBe(3);
    expect(alice.items.map((c) => c.asset)).toContain(w.chips[4]);
    expect(alice.items.find((c) => c.asset === w.chips[4])!.rarity).toBe(1);   // Common+ from recipe 0
    expect(alice.items.find((c) => c.asset === w.chips[4])!.flags.staked).toBe(true);
    const bob = q.myChips(db, w.bob, {});
    expect(bob.items.map((c) => c.asset)).toEqual([w.chips[2]]);
    expect(bob.items[0].flags.listed).toBe(false);

    // market
    expect(db.scalar(`SELECT COUNT(*) FROM listings`)).toBe(0);
    const sales = q.history(db, {});
    expect(sales.items).toHaveLength(1);
    expect(sales.items[0]).toMatchObject({ seller: w.alice, buyer: w.bob, currency: 'SOL', fee: '7500000', royalty: '2500000', rarity: 2 });

    // arena leaderboard
    const lb = q.leaderboard(db, 'rating', 10, undefined, w.alice);
    expect(lb.items[0]).toMatchObject({ wallet: w.alice, value: 1 });
    expect(lb.me).toEqual({ rank: 1, value: 1 });

    // staking
    expect(db.scalar(`SELECT COUNT(*) FROM stakes WHERE active = 1`)).toBe(2);
    const st = q.stats(db);
    expect(st).toMatchObject({ chipsMinted: 7, chipsAlive: 4, packsOpened: 2, totalBattlesResolved: 1, fusions: 1, sales: 1, chipsCurrentlyStaked: 1, tokenStakedMicro: '500000000', servicesSold: 1 });
    expect(st.burnedCgMicro).toBe(String(2_500_000 + 199_000_000));

    // pack open result + pity
    const open = q.packOpen(db, w.packSig)!;
    expect(open.chips).toHaveLength(3);
    expect(open.highlights.bestRarity).toBe(2);
    expect(q.me(db, w.alice).pity.counters[1]).toBe(6);
  });

  it('is idempotent: re-ingesting the same transactions changes nothing', () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const before = q.stats(db);
    let inserted = 0;
    for (const t of w.txs) inserted += ingestTx(t, db).inserted;
    expect(inserted).toBe(0);
    expect(q.stats(db)).toEqual(before);
  });

  it('fills block_time later when a websocket-first event is backfilled', () => {
    const w = world();
    const live = { ...w.txs[0], blockTime: null };
    ingestTx(live, db);
    expect(db.get<{ block_time: number | null }>(`SELECT block_time FROM events_raw`)!.block_time).toBeNull();
    ingestTx(w.txs[0], db);
    expect(db.get<{ block_time: number | null }>(`SELECT block_time FROM events_raw`)!.block_time).toBe(w.txs[0].blockTime);
  });

  it('rebuild: projections are a pure function of events_raw', () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const before = { stats: q.stats(db), alice: q.myChips(db, w.alice, {}), lb: q.leaderboard(db, 'collection', 10) };
    db.tx(() => { for (const t of PROJECTION_TABLES) db.run(`DELETE FROM ${t}`); });
    expect(q.stats(db).chipsMinted).toBe(0);
    expect(replayStored(db)).toBe(15);
    expect(q.stats(db)).toEqual(before.stats);
    expect(q.myChips(db, w.alice, {})).toEqual(before.alice);
    expect(q.leaderboard(db, 'collection', 10)).toEqual(before.lb);
  });

  it('failed fusion refunds the lowest-key material for recipes ≥ 4 and burns the rest', () => {
    const owner = kp();
    const mats = [kp(), kp(), kp()];
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: owner, sku: 2, nonce: '1', assets: [...mats, DEFAULT, DEFAULT], rarities: [4, 4, 4, 0, 0], collections: [1, 1, 1, 0, 0], count: 3, roll: hex32(1), pityBefore: 0, pityAfter: 1 } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFused', data: { owner, recipe: 4, materials: mats, result: DEFAULT, success: false, rollBps: 9100, thresholdBps: 8500, feeBurned: '0' } }]), db);
    const alive = q.myChips(db, owner, {}).items.map((c) => c.asset);
    expect(alive).toHaveLength(1);
    const sortedByBytes = [...mats].sort((a, b) => Buffer.compare(Buffer.from(new PublicKey(a).toBytes()), Buffer.from(new PublicKey(b).toBytes())));
    expect(alive[0]).toBe(sortedByBytes[0]);
    expect(db.scalar(`SELECT COUNT(*) FROM fusions WHERE success = 0`)).toBe(1);
  });

  it('starter packs mint soulbound chips with a 7-day lock', () => {
    const owner = kp(); const a = kp();
    const t0 = Math.floor(Date.now() / 1000) - 60;
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: owner, sku: 0, nonce: '1', assets: [a, kp(), kp(), DEFAULT, DEFAULT], rarities: [0, 0, 2, 0, 0], collections: [0, 1, 2, 0, 0], count: 3, roll: hex32(1), pityBefore: 0, pityAfter: 0 } }], { blockTime: t0 }), db);
    const c = q.myChips(db, owner, {}).items.find((x) => x.asset === a)!;
    expect(c.flags.soulbound).toBe(true);
    expect(c.lockUntil).toBe(new Date((t0 + 7 * 86_400) * 1000).toISOString());
    expect(q.myChips(db, owner, { status: 'free' }).total).toBe(0);
    expect(q.myChips(db, owner, { status: 'locked' }).total).toBe(3);
    expect(q.me(db, owner).pity.starterClaimed).toBe(false); // starter purchases go through PackBought; none recorded here
  });

  it('floor matrix picks the cheapest USD-normalised listing per archetype', () => {
    const s = kp(); const a1 = kp(), a2 = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: s, sku: 1, nonce: '1', assets: [a1, a2, kp(), DEFAULT, DEFAULT], rarities: [2, 2, 0, 0, 0], collections: [4, 4, 4, 0, 0], count: 3, roll: hex32(1), pityBefore: 0, pityAfter: 0 } }]), db);
    ingestTx(tx([{ program: 'market', name: 'ChipListed', data: { asset: a1, seller: s, price: '200000000', currency: 0 } }]), db);   // 0.2 SOL ≈ $30 @150
    ingestTx(tx([{ program: 'market', name: 'ChipListed', data: { asset: a2, seller: s, price: '12000000', currency: 1 } }]), db);    // 12 USDC
    const f = q.floor(db);
    expect(f.floors[4][2]).toBe(12);
    expect(f.listedCount[4][2]).toBe(2);
    const l = q.listings(db, { sort: 'price_asc' });
    expect(l.items.map((i) => i.asset)).toEqual([a2, a1]);
    expect(q.listings(db, { currency: 'USDC' }).total).toBe(1);
  });
});

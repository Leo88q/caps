// Fusion planner, staking read-model, arena (queue → reveal → resolve → rewards → forfeits → seasons),
// quests (progress from events, eligibility, caps, streak) and the reward oracle (batches → publish_root).
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ANTI_FARM, DAILY_QUESTS, FUSION_RECIPES, MATCH_REWARDS, MATCHMAKING, WEEKLY_QUESTS, resolveFight, onChainSquadPower, type FighterChip } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { ServiceError } from '../src/services.ts';
import { PROGRAMS } from '../src/config.ts';
import { ixDiscriminator } from '../src/chain.ts';
import * as fusion from '../src/fusion.ts';
import * as staking from '../src/staking.ts';
import * as arena from '../src/arena.ts';
import * as quests from '../src/quests.ts';
import * as oracle from '../src/reward-oracle.ts';
import { buildRewardTree, rewardLeaf, toHex, verifyRewardProof, fromHex } from '../src/merkle.ts';
import { resolveBattleIx, resultHash, rollFromValue, squadFromDb } from '../src/battle-resolver.ts';
import { FakeConnection } from './chainFixtures.ts';
import { DEFAULT, hex32, kp, tx, world } from './fixtures.ts';

const sha256hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const asConn = (c: FakeConnection) => c as unknown as Connection;
const err = (fn: () => unknown): ServiceError => { try { fn(); } catch (e) { if (e instanceof ServiceError) return e; throw e; } throw new Error('expected a ServiceError'); };

/** Mint `n` chips for `owner` via a PackOpened event (rarity/collection per index). */
function mint(db: Db, owner: string, specs: { rarity: number; collection: number }[], opts: { nonce?: string; sku?: number; blockTime?: number } = {}): string[] {
  const assets = specs.map(() => kp());
  const nonce = opts.nonce ?? String(Math.floor(Math.random() * 1e9));
  ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: owner, sku: opts.sku ?? 1, qty: 1, currency: 0, amount: '33000000', nonce, randomness: kp() } }], { blockTime: opts.blockTime }), db);
  for (let i = 0; i < assets.length; i += 5) {
    const slice = assets.slice(i, i + 5);
    const pad = <T,>(arr: T[], v: T) => [...arr, ...Array(5 - arr.length).fill(v)] as T[];
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: {
      buyer: owner, sku: opts.sku ?? 1, nonce, assets: pad(slice, DEFAULT), rarities: pad(specs.slice(i, i + 5).map((s) => s.rarity), 0), collections: pad(specs.slice(i, i + 5).map((s) => s.collection), 0),
      count: slice.length, roll: hex32(0x9f), pityBefore: 0, pityAfter: 1,
    } }], { blockTime: opts.blockTime }), db);
  }
  return assets;
}
const squadOf = (assets: string[]) => assets.slice(0, 3);
const commitFor = (nonce: Buffer) => sha256hex(nonce);

/** Queue two players and return the match (pairing is attempted on join). */
function pair(db: Db, a: { wallet: string; squad: string[] }, b: { wallet: string; squad: string[] }, t = Math.floor(Date.now() / 1000)) {
  const na = randomBytes(16), nb = randomBytes(16);
  arena.joinQueue(db, a.wallet, { squad: a.squad, commit: commitFor(na) }, t, t * 1000);
  const r = arena.joinQueue(db, b.wallet, { squad: b.squad, commit: commitFor(nb) }, t, t * 1000 + 10);
  // ratings may have drifted apart / the pair fought ≥ 3× today: let the queue widen past the bot-fill threshold
  const matchId = r.matchId ?? (arena.sweep(db, t + 46), arena.currentMatchFor(db, a.wallet)?.id ?? null);
  return { matchId: matchId!, na, nb };
}

describe('fusion planner', () => {
  let db: Db; let w: ReturnType<typeof world>;
  beforeEach(() => { db = new Db(':memory:'); w = world(); for (const t of w.txs) ingestTx(t, db); });

  it('recipes mirror packages/economy (8 steps, strings for u64)', () => {
    const r = fusion.recipes();
    expect(r).toHaveLength(8);
    expect(r[0]).toMatchObject({ from: 'Common', to: 'Common+', rule: 'any', successBps: 10_000, feeCgMicro: '2500000', boosterBonusBps: 1500, boosterCapBps: 9500 });
    expect(r[7]).toMatchObject({ from: 'Legend+', to: 'Diamond', rule: 'same-collection', successBps: 5_000, refundOnFail: 1, feeCgMicro: '6000000000' });
  });

  it('plan: 3 owned free commons → Common+ (atomic, no randomness, fee 2.5 $CG, PDAs derived)', () => {
    const assets = mint(db, w.bob, [{ rarity: 0, collection: 1 }, { rarity: 0, collection: 4 }, { rarity: 0, collection: 1 }]);
    const p = fusion.plan(db, w.bob, fusion.validatePlanRequest({ materials: assets, resultCollection: 4 }));
    expect(p).toMatchObject({ resultRarity: 'Common+', resultCollection: 4, successBps: 10_000, feeCgMicro: '2500000', needsRandomness: false, breaksSet: false });
    expect(p.materials.map((m) => m.asset)).toEqual(assets);
    expect(p.accounts.randomness).toBeUndefined();
    expect(Object.keys(p.accounts)).toEqual(expect.arrayContaining(['config', 'vault', 'items', 'pending', 'resultMeta', 'material0', 'chipState2', 'collectionMeta1', 'collectionMeta4']));
    expect(BigInt(p.nonce)).toBeGreaterThan(0n);
  });

  it('plan: same-collection step rejects mixed districts; any step rejects a result district not among the inputs', () => {
    const mixed = mint(db, w.bob, [{ rarity: 1, collection: 2 }, { rarity: 1, collection: 2 }, { rarity: 1, collection: 3 }]);
    expect(err(() => fusion.plan(db, w.bob, { materials: mixed })).code).toBe('collection_mismatch');
    const same = mint(db, w.bob, [{ rarity: 1, collection: 2 }, { rarity: 1, collection: 2 }, { rarity: 1, collection: 2 }]);
    expect(fusion.plan(db, w.bob, { materials: same, resultCollection: 9 })).toMatchObject({ resultCollection: 2, resultRarity: 'Rare' }); // forced to the shared district
    const anyStep = mint(db, w.bob, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 2, collection: 2 }]);
    expect(err(() => fusion.plan(db, w.bob, { materials: anyStep, resultCollection: 7 })).code).toBe('collection_mismatch');
  });

  it('plan: rarity mismatch, not owner, staked / listed / fusing / locked / duplicate / Diamond → 422 with the chain\'s reason', () => {
    const [a, b, c] = mint(db, w.bob, [{ rarity: 0, collection: 0 }, { rarity: 1, collection: 0 }, { rarity: 0, collection: 0 }]);
    expect(err(() => fusion.plan(db, w.bob, { materials: [a, b, c] })).code).toBe('rarity_mismatch');
    expect(err(() => fusion.plan(db, w.bob, { materials: [a, a, c] })).code).toBe('duplicate_material');
    expect(err(() => fusion.plan(db, w.alice, { materials: [a, b, c] })).message).toContain('not_owner');
    const [d] = mint(db, w.bob, [{ rarity: 0, collection: 0 }]);
    ingestTx(tx([{ program: 'staking', name: 'Staked', data: { owner: w.bob, kind: 1, key: d, amount: '1', weight: '1000000', unlockAt: '0' } }]), db);
    expect(err(() => fusion.plan(db, w.bob, { materials: [a, c, d] })).message).toContain('staked');
    const [e] = mint(db, w.bob, [{ rarity: 0, collection: 0 }]);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFlagsChanged', data: { asset: e, flags: 8, lockUntil: String(Math.floor(Date.now() / 1000) + 86_400) } }]), db);
    expect(err(() => fusion.plan(db, w.bob, { materials: [a, c, e] })).message).toContain('locked');
    const diamonds = mint(db, w.bob, [{ rarity: 8, collection: 0 }, { rarity: 8, collection: 0 }, { rarity: 8, collection: 0 }]);
    expect(err(() => fusion.plan(db, w.bob, { materials: diamonds })).code).toBe('no_recipe');
    expect(err(() => fusion.validatePlanRequest({ materials: [a, b] })).code).toBe('bad_materials');
  });

  it('plan: randomized recipe → randomness PDA + booster maths (+15 pp, cap 95 %) + escrow warning; breaksSet flags a completed set', () => {
    const epics = mint(db, w.bob, [{ rarity: 4, collection: 5 }, { rarity: 4, collection: 6 }, { rarity: 4, collection: 5 }]);
    const p = fusion.plan(db, w.bob, { materials: epics, useBooster: true });
    expect(p).toMatchObject({ successBps: 9_500, needsRandomness: true, resultRarity: 'Epic+' });
    expect(p.accounts.randomness).toBeDefined();
    expect(p.warnings).toContain('result_locked_21600s');
    // 85 % + 15 pp = 100 % → capped at 95 %
    expect(fusion.successBps(FUSION_RECIPES[4], true)).toBe(9_500);
    expect(fusion.successBps(FUSION_RECIPES[7], true)).toBe(6_500);
    expect(fusion.successBps(FUSION_RECIPES[0], true)).toBe(10_000);
    // a complete district set: fusing 3 of its commons (only copies) breaks it
    const full = mint(db, w.bob, Array.from({ length: 9 }, (_, r) => ({ rarity: r, collection: 8 })));
    const extra = mint(db, w.bob, [{ rarity: 0, collection: 8 }, { rarity: 0, collection: 8 }]);
    const p2 = fusion.plan(db, w.bob, { materials: [full[0], ...extra] });
    expect(p2.breaksSet).toBe(true);
    expect(p2.warnings).toContain('breaks_set');
  });

  it('suggest: groups free chips per recipe rule, keeps sets intact when protectSets, ignores busy chips', () => {
    // 3 commons of districts 0/1/2 + 3 Common+ of one district + 3 Common+ of mixed districts (not fusable together)
    mint(db, w.bob, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 1 }, { rarity: 0, collection: 2 }]);
    mint(db, w.bob, [{ rarity: 1, collection: 4 }, { rarity: 1, collection: 4 }, { rarity: 1, collection: 4 }]);
    mint(db, w.bob, [{ rarity: 1, collection: 5 }, { rarity: 1, collection: 6 }, { rarity: 1, collection: 7 }]);
    // district 0 is two tiers away from a full set → its only Common is set-critical
    mint(db, w.bob, Array.from({ length: 6 }, (_, i) => ({ rarity: i + 3, collection: 0 })));
    const s = fusion.suggest(db, w.bob, false);
    expect(s.map((x) => x.resultRarity).sort()).toEqual(['Common+', 'Rare']);
    // with set protection the district-0 Common is kept → only two spare commons → only the Common+ triple remains
    const guarded = fusion.suggest(db, w.bob, true);
    expect(guarded.map((x) => x.resultRarity)).toEqual(['Rare']);
    // staked chips never appear
    const staked = mint(db, w.bob, [{ rarity: 3, collection: 9 }, { rarity: 3, collection: 9 }, { rarity: 3, collection: 9 }]);
    ingestTx(tx([{ program: 'staking', name: 'Staked', data: { owner: w.bob, kind: 1, key: staked[0], amount: '1', weight: '1', unlockAt: '0' } }]), db);
    expect(fusion.suggest(db, w.bob, false).some((x) => x.resultRarity === 'Epic')).toBe(false);
  });
});

describe('staking read-model', () => {
  let db: Db; let w: ReturnType<typeof world>;
  beforeEach(() => { db = new Db(':memory:'); w = world(); for (const t of w.txs) ingestTx(t, db); });

  it('overview before the first tick_day: schedule floor (30 %), pool totals from Staked events, split 30/15/17/23/15', () => {
    const o = staking.overview(db);
    expect(o.emission.source).toBe('schedule');
    expect(BigInt(o.emission.scheduleCapMicro) * 3n - BigInt(o.emission.guardedMicro) * 10n).toBeLessThan(10n); // floor(cap × 0.30)
    expect(o.emission.splitBps).toEqual([3000, 1500, 1700, 2300, 1500]);
    expect(o.tokenPool).toMatchObject({ tvlMicro: '500000000', totalWeight: '750000000' });
    expect(o.chipPool).toMatchObject({ stakedChips: 1, totalWeight: '2000' });
    expect(BigInt(o.tokenPool.budgetTodayMicro)).toBe((BigInt(o.emission.guardedMicro) * 15n) / 100n);
    expect(o.tokenPool.apyByTier).toHaveLength(4);
    expect(o.tokenPool.apyByTier[3]).toBeGreaterThan(o.tokenPool.apyByTier[0]);
  });

  it('overview after DayClosed uses the chain numbers', () => {
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 12, year: 0, scheduleCap: '271232876712', guarded: '150000000000', burn7dAvg: '40000000000', sliceBudget: ['0', '0', '1', '2', '3'] } }]), db);
    const o = staking.overview(db);
    expect(o.emission).toMatchObject({ dayIndex: 12, guardedMicro: '150000000000', burn7dAvgMicro: '40000000000', source: 'chain' });
    expect(o.chipPool.budgetTodayMicro).toBe('45000000000');
  });

  it('me: token stake tier from the PDA, penalty while locked, pending = share of the emitted budget since the stake opened (0 before any DayClosed)', () => {
    const owner = Keypair.generate().publicKey;
    const t = Math.floor(Date.now() / 1000);
    const key = staking.tokenStakePda(owner, 2).toBase58();
    ingestTx(tx([{ program: 'staking', name: 'Staked', data: { owner: owner.toBase58(), kind: 0, key, amount: '1000000000', weight: '2200000000', unlockAt: String(t + 80 * 86_400) } }], { blockTime: t - 3 * 86_400 }), db);
    let m = staking.me(db, owner.toBase58());
    expect(m.tokenStakes[0]).toMatchObject({ tier: 2, amount: '1000000000', weight: '2200000000', earlyExitPenalty: '100000000', pending: '0' });
    expect(m.pendingEstimated).toBe(true);
    // a day closed 2 days ago with a 100 $CG guarded budget → token pool got 15 $CG over 24 h; this stake holds 2.2e9 of 2.95e9 weight
    ingestTx(tx([{ program: 'staking', name: 'DayClosed', data: { dayIndex: 1, year: 0, scheduleCap: '271232876712', guarded: '100000000', burn7dAvg: '0', sliceBudget: ['0', '0', '0', '0', '0'] } }], { blockTime: t - 2 * 86_400 }), db);
    m = staking.me(db, owner.toBase58());
    const expected = (2_200_000_000n * 15_000_000n) / 2_950_000_000n;
    expect(BigInt(m.tokenStakes[0].pending)).toBe(expected);
    expect(m.totalPendingMicro).toBe(expected.toString());
    // set bonus: on-chain 0 sets vs computed 0 → no sync pending; after a full set arrives it flips
    expect(m.setBonus).toMatchObject({ onChainSets: 0, computedSets: 0, multBps: 10_000, syncPending: false });
    mint(db, owner.toBase58(), Array.from({ length: 9 }, (_, r) => ({ rarity: r, collection: 2 })));
    expect(staking.me(db, owner.toBase58()).setBonus).toMatchObject({ computedSets: 1, syncPending: true });
    ingestTx(tx([{ program: 'staking', name: 'SetBonusSynced', data: { owner: owner.toBase58(), sets: 1 } }]), db);
    expect(staking.me(db, owner.toBase58()).setBonus).toMatchObject({ onChainSets: 1, multBps: 11_200, syncPending: false });
  });

  it('estimate: validates tier/amount; APY falls as the amount grows (pro-rata pool); chip weight mirrors staking::chip_weight', () => {
    expect(err(() => staking.validateEstimate({ amountCgMicro: '1000000', tier: 4 })).code).toBe('bad_tier');
    expect(err(() => staking.validateEstimate({ amountCgMicro: 'abc', tier: 1 })).code).toBe('bad_amount');
    const small = staking.estimate(db, staking.validateEstimate({ amountCgMicro: '1000000000', tier: 3 }));
    const big = staking.estimate(db, staking.validateEstimate({ amountCgMicro: '100000000000000', tier: 3 }));
    expect(small.apyPct).toBeGreaterThan(big.apyPct);
    expect(small).toMatchObject({ earlyExitPenaltyBps: 1500, boostBps: 30_000, indicativeApyRange: [36, 90] });
    // Common lvl 1, 0 sets → 1e6; Rare lvl 5, 2 sets → 5e6 × 1.1 × 1.24
    expect(staking.chipWeightRaw(0, 1, 0)).toBe(1_000_000n);
    expect(staking.chipWeightRaw(2, 5, 2)).toBe((5_000_000n * 11_000n) / 10_000n * 12_400n / 10_000n);
    expect(staking.setBonusMultBps(10)).toBe(17_000);
  });
});

describe('arena — ranked commit/reveal', () => {
  let db: Db; let alice: string; let bob: string; let sa: string[]; let sb: string[];
  const T = 1_800_000_000; // fixed "now" (s) so days/seasons are deterministic
  beforeEach(() => {
    db = new Db(':memory:');
    alice = kp(); bob = kp();
    sa = squadOf(mint(db, alice, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 1, collection: 2 }], { blockTime: T - 3 * 86_400 }));
    sb = squadOf(mint(db, bob, [{ rarity: 2, collection: 3 }, { rarity: 1, collection: 4 }, { rarity: 2, collection: 5 }], { blockTime: T - 3 * 86_400 }));
  });

  it('season: created on first touch with a public hash and a private secret; previous season secret revealed after it ends', () => {
    const s = arena.seasonApi(db, T);
    expect(s.serverSecret).toBeNull();
    expect(s.serverSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(s.endsAt) - Date.parse(s.startsAt)).toBe(arena.SEASON_SECONDS * 1000);
    const row = arena.currentSeason(db, T);
    expect(sha256hex(Buffer.from(row.server_secret, 'hex'))).toBe(row.server_secret_hash);
    const next = arena.seasonApi(db, T + arena.SEASON_SECONDS + 5);
    expect(next.id).toBe(s.id + 1);
    expect(next.previous).toMatchObject({ id: s.id, serverSecretHash: s.serverSecretHash, serverSecret: row.server_secret });
  });

  it('queue validation mirrors validate_squad: 3 distinct owned chips, not listed/fusing, power ≥ 400, commit = 32-byte hex', () => {
    const c = commitFor(randomBytes(16));
    expect(err(() => arena.joinQueue(db, alice, { squad: sa.slice(0, 2), commit: c }, T)).code).toBe('bad_squad');
    expect(err(() => arena.joinQueue(db, alice, { squad: [sa[0], sa[0], sa[1]], commit: c }, T)).code).toBe('duplicate_chip');
    expect(err(() => arena.joinQueue(db, alice, { squad: sb, commit: c }, T)).code).toBe('not_owner');
    expect(err(() => arena.joinQueue(db, alice, { squad: sa, commit: 'zz' }, T)).code).toBe('bad_commit');
    expect(err(() => arena.joinQueue(db, alice, { squad: sa, commit: c, wagerCgMicro: '5000000' }, T)).code).toBe('wager_is_on_chain');
    const weak = mint(db, alice, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }]);
    expect(err(() => arena.joinQueue(db, alice, { squad: weak, commit: c }, T)).code).toBe('squad_too_weak');
    ingestTx(tx([{ program: 'market', name: 'ChipListed', data: { asset: sa[0], seller: alice, price: '1', currency: 0 } }]), db);
    expect(err(() => arena.joinQueue(db, alice, { squad: sa, commit: c }, T)).code).toBe('chip_busy');
  });

  it('join → pair in the same league → both reveal → deterministic resolution, ratings, rewards; the record is auditable', () => {
    const r1 = arena.joinQueue(db, alice, { squad: sa, commit: commitFor(Buffer.from('aa'.repeat(16), 'hex')) }, T, T * 1000);
    expect(r1.matchId).toBeNull();
    expect(r1.league).toBe(0); // 210+210+145 = 565 < 800
    expect(arena.arenaMe(db, alice, T).queue?.ticket).toBe(r1.ticket);
    const nb = randomBytes(16);
    const r2 = arena.joinQueue(db, bob, { square: 1, squad: sb, commit: commitFor(nb) } as never, T, T * 1000 + 500);
    expect(r2.matchId).toBeTruthy();
    expect(r2.estimatedWaitSec).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM arena_queue`)).toBe(0);
    const id = r2.matchId!;
    // nobody can see the other side's nonce before both revealed; the seed is hidden
    const pre = arena.matchApi(db, id, bob)!;
    expect(pre.status).toBe('revealing');
    expect(pre.seed).toBeNull();
    // wrong nonce → commit mismatch; alice reveals, bob must reveal too
    expect(err(() => arena.reveal(db, alice, id, { nonce: 'bb'.repeat(16) }, T)).code).toBe('commit_mismatch');
    expect(err(() => arena.reveal(db, kp(), id, { nonce: 'aa'.repeat(16) }, T)).code).toBe('not_a_player');
    expect(arena.reveal(db, alice, id, { nonce: 'aa'.repeat(16) }, T)).toMatchObject({ resolved: false, waitingFor: 'b' });
    expect(arena.arenaMe(db, alice, T).currentMatch).toMatchObject({ id, iRevealed: true, opponent: bob });
    const done = arena.reveal(db, bob, id, { nonce: nb.toString('hex') }, T);
    expect(done.resolved).toBe(true);
    const m = arena.matchApi(db, id)!;
    expect(m.status).toBe('resolved');
    expect([alice, bob]).toContain(m.winner);
    expect(m.rounds.length).toBeGreaterThanOrEqual(2);
    // re-derive the seed and the fight from the public record + the season secret
    const season = arena.currentSeason(db, T);
    const seed = arena.matchSeed(id, m.nonceA!, m.nonceB!, season.server_secret);
    expect(seed.toString('hex')).toBe(m.seed);
    const replay = resolveFight(m.squadA.map((c) => ({ asset: c.asset, collection: c.collection, rarity: c.rarity, level: c.level })), m.squadB.map((c) => ({ asset: c.asset, collection: c.collection, rarity: c.rarity, level: c.level })), arena.rollFromSeed(seed));
    expect(replay.rounds.map((r) => r.winner)).toEqual(m.rounds.map((r) => (r.winner === alice ? 'A' : 'B')));
    expect(replay.winner === 'A' ? alice : bob).toBe(m.winner);
    // ratings moved symmetrically (K = 40, both at 1000 → ±20), rewards 2 / 0.5 $CG
    const ra = arena.rating(db, alice, season.id), rb = arena.rating(db, bob, season.id);
    expect(ra.games).toBe(1); expect(rb.games).toBe(1);
    expect(Math.round(Math.abs(ra.rating - 1000))).toBe(20);
    expect(ra.rating + rb.rating).toBeCloseTo(2000, 6);
    const winnerReward = m.winner === alice ? m.rewardA : m.rewardB, loserReward = m.winner === alice ? m.rewardB : m.rewardA;
    expect(winnerReward).toBe(String(MATCH_REWARDS.winCgMicro));
    expect(loserReward).toBe(String(MATCH_REWARDS.lossCgMicro));
    expect(arena.arenaMe(db, alice, T)).toMatchObject({ games: 1, rewardedMatchesLeft: 7, currentMatch: null });
    expect(arena.arenaMe(db, m.winner!, T).wins).toBe(1);
    // idempotent reveal after resolution
    expect(arena.reveal(db, alice, id, { nonce: 'aa'.repeat(16) }, T)).toMatchObject({ resolved: true });
  });

  it('pairing respects league bands and the rating spread widening over time', () => {
    const carol = kp();
    const strong = squadOf(mint(db, carol, [{ rarity: 6, collection: 0 }, { rarity: 6, collection: 1 }, { rarity: 6, collection: 2 }])); // 2790 → league 3
    arena.joinQueue(db, alice, { squad: sa, commit: commitFor(randomBytes(16)) }, T, T * 1000);
    expect(arena.joinQueue(db, carol, { squad: strong, commit: commitFor(randomBytes(16)) }, T, T * 1000).matchId).toBeNull();
    // same league but 200 rating apart: not paired at t=0 (spread 25), paired once the queue widened (5/s → 35 s)
    db.run(`INSERT INTO ratings (wallet, season, rating, games) VALUES (?, ?, 1200, 40)`, bob, arena.currentSeason(db, T).id);
    expect(arena.joinQueue(db, bob, { squad: sb, commit: commitFor(randomBytes(16)) }, T, T * 1000 + 1_000).matchId).toBeNull();
    expect(arena.sweep(db, T + 10, T * 1000 + 10_000).paired).toBe(0);
    expect(arena.sweep(db, T + 40, T * 1000 + 40_000).paired).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM matches`)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM arena_queue`)).toBe(1); // carol still waiting in league 3
  });

  it('bot fill after 45 s: bot squad in the same power band, bot reveals instantly, participation reward only, rating still moves', () => {
    arena.joinQueue(db, alice, { squad: sa, commit: commitFor(Buffer.from('cc'.repeat(16), 'hex')) }, T, T * 1000);
    expect(arena.sweep(db, T + 30, T * 1000 + 30_000).bots).toBe(0);
    expect(arena.sweep(db, T + 46, T * 1000 + 46_000).bots).toBe(1);
    const me = arena.arenaMe(db, alice, T + 46);
    expect(me.currentMatch?.opponent).toMatch(/^bot:/);
    const id = me.currentMatch!.id;
    const pre = arena.matchApi(db, id)!;
    const botPower = onChainSquadPower(pre.squadB.map((c) => ({ asset: c.asset, collection: c.collection, rarity: c.rarity, level: c.level })));
    expect(Math.abs(botPower - pre.powerA) / pre.powerA).toBeLessThan(0.25);
    const r = arena.reveal(db, alice, id, { nonce: 'cc'.repeat(16) }, T + 50);
    expect(r.resolved).toBe(true);
    const m = arena.matchApi(db, id)!;
    expect(m.bot).toBe(true);
    expect(m.rewardA).toBe(String(MATCH_REWARDS.lossCgMicro)); // vs bot: participation only, win or lose
    expect(m.rewardB).toBe('0');
    expect(arena.rating(db, alice, m.season).games).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM ratings WHERE wallet LIKE 'bot:%'`)).toBe(0);
  });

  it('forfeit: the side that revealed wins after REVEAL_TIMEOUT (no rewards); nobody revealed → cancelled', () => {
    const { matchId, na } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T);
    arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, T + 5);
    expect(arena.sweep(db, T + 60, (T + 60) * 1000).forfeits).toBe(0);
    expect(arena.sweep(db, T + arena.REVEAL_TIMEOUT_S + 1, (T + arena.REVEAL_TIMEOUT_S + 1) * 1000).forfeits).toBe(1);
    const m = arena.matchApi(db, matchId)!;
    expect(m).toMatchObject({ status: 'resolved', forfeit: true, winner: alice, rewardA: '0', rewardB: '0' });
    expect(arena.rating(db, bob, m.season).rating).toBeLessThan(1000);
    // second match, nobody reveals
    const second = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T + 300);
    arena.sweep(db, T + 300 + arena.REVEAL_TIMEOUT_S + 1, (T + 300 + arena.REVEAL_TIMEOUT_S + 1) * 1000);
    expect(arena.matchApi(db, second.matchId)!.status).toBe('cancelled');
    // a player with a match still in 'revealing' cannot queue again
    const third = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T + 900);
    expect(third.matchId).toBeTruthy();
    expect(err(() => arena.joinQueue(db, alice, { squad: sa, commit: commitFor(randomBytes(16)) }, T + 901)).code).toBe('match_pending');
  });

  it('anti-farm: 8 rewarded matches per day, ≤ 3 rewarded vs the same wallet, squad < 400 power earns nothing', () => {
    let t = T;
    const play = () => { const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, t); arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, t); arena.reveal(db, bob, matchId, { nonce: nb.toString('hex') }, t); t += 60; return arena.matchApi(db, matchId)!; };
    const results = Array.from({ length: 4 }, play);
    expect(results.slice(0, 3).every((m) => m.rewardA !== '0' && m.rewardB !== '0')).toBe(true);
    expect(results[3]).toMatchObject({ rewardA: '0', rewardB: '0' }); // 4th vs the same opponent today
    // 5 more vs distinct opponents → alice hits the daily cap of 8 rewarded matches
    for (let i = 0; i < 6; i++) {
      const o = kp();
      const so = squadOf(mint(db, o, [{ rarity: 2, collection: 1 }, { rarity: 2, collection: 2 }, { rarity: 1, collection: 3 }]));
      const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: o, squad: so }, t);
      arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, t); arena.reveal(db, o, matchId, { nonce: nb.toString('hex') }, t); t += 60;
      const m = arena.matchApi(db, matchId)!;
      expect(m.rewardA !== '0').toBe(i < 5); // rewarded matches 4..8, then capped
      expect(m.rewardB).not.toBe('0');
    }
    expect(arena.arenaMe(db, alice, t).rewardedMatchesLeft).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM pvp_rewards WHERE wallet = ?`, alice)).toBe(MATCH_REWARDS.dailyRewardedMatches);
    // next day the counter resets
    expect(arena.arenaMe(db, alice, t + 86_400).rewardedMatchesLeft).toBe(MATCH_REWARDS.dailyRewardedMatches);
  });

  it('simulate: probabilities from the shared engine, spec squads allowed, league per side', () => {
    const s = arena.simulate(db, { squadA: sa, squadB: [{ collection: 0, rarity: 8, level: 1 }, { collection: 1, rarity: 8, level: 1 }, { collection: 2, rarity: 8, level: 1 }] });
    expect(s.pWinA).toBeLessThan(0.05);
    expect(s).toMatchObject({ powerA: 565, powerB: 6000, leagueA: 0, leagueB: 4 });
    expect(s.sampleRounds.length).toBeGreaterThanOrEqual(2);
    expect(err(() => arena.simulate(db, { squadA: sa, squadB: [{ collection: 11, rarity: 0, level: 1 }, {}, {}] })).code).toBe('bad_chip');
    // identical squads → 50 %
    expect(arena.simulate(db, { squadA: sa, squadB: sa }).pWinA).toBeCloseTo(0.5, 2);
    expect(MATCHMAKING.startRating).toBe(1000);
  });
});

describe('quests', () => {
  let db: Db; let alice: string; let bob: string; let sa: string[]; let sb: string[];
  const T = 1_800_000_000 + 12 * 3600; // noon so the day does not roll during the test
  beforeEach(() => {
    db = new Db(':memory:');
    alice = kp(); bob = kp();
    sa = squadOf(mint(db, alice, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 1, collection: 2 }], { blockTime: T - 3 * 86_400 }));
    sb = squadOf(mint(db, bob, [{ rarity: 2, collection: 3 }, { rarity: 1, collection: 4 }, { rarity: 2, collection: 5 }], { blockTime: T - 3 * 86_400 }));
  });
  const playMatch = (t: number) => { const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, t); arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, t); arena.reveal(db, bob, matchId, { nonce: nb.toString('hex') }, t); return arena.matchApi(db, matchId)!; };

  it('progress comes from events: login, matches, wins, fusions, trades; periods reset; permanent milestones accumulate', () => {
    const list0 = quests.list(db, alice, T);
    expect(list0).toHaveLength(DAILY_QUESTS.length + WEEKLY_QUESTS.length + 6);
    expect(list0.find((q) => q.id === 'd_login')).toMatchObject({ value: 0, claimable: false, ineligibleReason: null }); // paid pack (sku 1) → eligible
    quests.recordLogin(db, alice, T);
    expect(quests.list(db, alice, T).find((q) => q.id === 'd_login')).toMatchObject({ value: 1, claimable: true });
    let wins = 0;
    for (let i = 0; i < 3; i++) { const m = playMatch(T + i * 60); if (m.winner === alice) wins++; }
    const l = quests.list(db, alice, T + 200);
    expect(l.find((q) => q.id === 'd_pvp3')).toMatchObject({ value: 3, claimable: true });
    expect(l.find((q) => q.id === 'd_win1')!.value).toBe(Math.min(1, wins));
    expect(l.find((q) => q.id === 'w_pvp20')!.value).toBe(3);
    expect(l.find((q) => q.id === 'p_win50')!.value).toBe(wins);
    // yesterday's matches do not count for today's daily but do for the week (same week only if the day is not Monday)
    expect(quests.metricValue(db, alice, 'pvp_played', quests.periodStart(DAILY_QUESTS[1], T + 86_400), quests.periodEnd(DAILY_QUESTS[1], T + 86_400), T + 86_400)).toBe(0);
    // fusion + trade
    const mats = mint(db, alice, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }]);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFused', data: { owner: alice, recipe: 0, materials: mats, result: kp(), success: true, rollBps: 0, thresholdBps: 10000, feeBurned: '2500000' } }], { blockTime: T + 300 }), db);
    ingestTx(tx([{ program: 'market', name: 'ChipSold', data: { asset: sb[0], seller: bob, buyer: alice, price: '1', currency: 0, fee: '0', royalty: '0', viaOffer: false } }], { blockTime: T + 301 }), db);
    const l2 = quests.list(db, alice, T + 400);
    expect(l2.find((q) => q.id === 'd_fuse1')).toMatchObject({ value: 1, claimable: true });
    expect(l2.find((q) => q.id === 'p_first_fusion')).toMatchObject({ value: 1, claimable: true });
    expect(l2.find((q) => q.id === 'w_trade')).toMatchObject({ value: 1, claimable: true });
    expect(l2.find((q) => q.id === 'p_set1')!.value).toBe(0);
  });

  it('eligibility: new wallet without a paid pack is ineligible until 24 h + 10 matches; rewards_paused flag blocks; caps apply on settlement', () => {
    const newbie = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, newbie, T - 3600);
    expect(quests.eligibility(db, newbie, T)).toMatchObject({ eligible: false, reason: 'account_too_new', hasPaidPack: false });
    db.run(`UPDATE wallets SET first_seen = ? WHERE address = ?`, T - 2 * 86_400, newbie);
    expect(quests.eligibility(db, newbie, T)).toMatchObject({ eligible: false, reason: 'play_10_matches_or_buy_a_pack' });
    db.run(`UPDATE wallets SET flags = '{"rewardsPaused":true}' WHERE address = ?`, alice);
    expect(quests.eligibility(db, alice, T)).toMatchObject({ eligible: false, reason: 'rewards_paused' });
    db.run(`UPDATE wallets SET flags = '{}' WHERE address = ?`, alice);
    expect(quests.eligibility(db, alice, T).eligible).toBe(true);
    // settlement with caps: complete every daily (12 $CG) + the weekly trade (10) + first fusion (10, permanent — not capped)
    quests.recordLogin(db, alice, T);
    for (let i = 0; i < 3; i++) playMatch(T + i * 60);
    // make sure alice has a win (play until she wins once, vs fresh opponents so rewards don't matter)
    for (let i = 0; i < 6 && quests.metricValue(db, alice, 'pvp_won', 0, Number.MAX_SAFE_INTEGER, T + 1000) === 0; i++) {
      const o = kp(); const so = squadOf(mint(db, o, [{ rarity: 1, collection: 1 }, { rarity: 1, collection: 2 }, { rarity: 1, collection: 3 }])); // 435 power, league 0, weaker than alice
      const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: o, squad: so }, T + 500 + i * 60);
      arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, T + 500 + i * 60); arena.reveal(db, o, matchId, { nonce: nb.toString('hex') }, T + 500 + i * 60);
    }
    const mats = mint(db, alice, [{ rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }, { rarity: 0, collection: 0 }]);
    ingestTx(tx([{ program: 'chip_core', name: 'ChipFused', data: { owner: alice, recipe: 0, materials: mats, result: kp(), success: true, rollBps: 0, thresholdBps: 10000, feeBurned: '2500000' } }], { blockTime: T + 1200 }), db);
    ingestTx(tx([{ program: 'market', name: 'ChipSold', data: { asset: sb[0], seller: bob, buyer: alice, price: '1', currency: 0, fee: '0', royalty: '0', viaOffer: false } }], { blockTime: T + 1201 }), db);
    const n = quests.settleWallet(db, alice, T + 1300);
    expect(n).toBeGreaterThanOrEqual(6);
    const rows = db.all<{ quest_id: string; amount: string }>(`SELECT quest_id, amount FROM quest_completions WHERE wallet = ?`, alice);
    const daily = rows.filter((r) => r.quest_id.startsWith('d_')).reduce((s, r) => s + BigInt(r.amount), 0n);
    expect(daily).toBe(12_000_000n); // 2 + 4 + 3 + 3 — under the 15 $CG daily cap
    expect(rows.find((r) => r.quest_id === 'w_trade')!.amount).toBe('3000000'); // capped: 15 − 12 already paid today
    expect(rows.find((r) => r.quest_id === 'p_first_fusion')!.amount).toBe('10000000'); // permanent milestones bypass the daily cap
    expect(quests.settleWallet(db, alice, T + 1400)).toBe(0); // idempotent
    // streak: all 4 $CG dailies done today → 1 day
    expect(quests.streak(db, alice, T + 1400)).toMatchObject({ days: 1, todayDone: true });
    expect(quests.list(db, alice, T + 1400).find((q) => q.id === 'd_login')).toMatchObject({ claimable: false, rooted: false, creditedCgMicro: '2000000' });
    expect(ANTI_FARM.dailyQuestRewardCapCgMicro).toBe(15_000_000);
  });

  it('streak counts consecutive completed days ending today or yesterday, max 7', () => {
    const day = quests.dayIndex(T);
    for (const d of [day - 4, day - 3, day - 2, day - 1]) db.run(`INSERT INTO quest_days (wallet, day, dailies_done) VALUES (?, ?, 1)`, alice, d);
    expect(quests.streak(db, alice, T).days).toBe(4);
    db.run(`DELETE FROM quest_days WHERE wallet = ? AND day = ?`, alice, day - 3);
    expect(quests.streak(db, alice, T).days).toBe(2);
    for (const d of Array.from({ length: 9 }, (_, i) => day - i)) db.run(`INSERT OR REPLACE INTO quest_days (wallet, day, dailies_done) VALUES (?, ?, 1)`, alice, d);
    expect(quests.streak(db, alice, T).days).toBe(7);
  });
});

describe('reward oracle', () => {
  let db: Db; let alice: string; let bob: string; let sa: string[]; let sb: string[];
  const T = 1_800_000_000 + 12 * 3600;
  beforeEach(() => {
    db = new Db(':memory:');
    alice = kp(); bob = kp();
    sa = squadOf(mint(db, alice, [{ rarity: 2, collection: 0 }, { rarity: 2, collection: 1 }, { rarity: 1, collection: 2 }], { blockTime: T - 3 * 86_400 }));
    sb = squadOf(mint(db, bob, [{ rarity: 2, collection: 3 }, { rarity: 1, collection: 4 }, { rarity: 2, collection: 5 }], { blockTime: T - 3 * 86_400 }));
    const { matchId, na, nb } = pair(db, { wallet: alice, squad: sa }, { wallet: bob, squad: sb }, T);
    arena.reveal(db, alice, matchId, { nonce: na.toString('hex') }, T); arena.reveal(db, bob, matchId, { nonce: nb.toString('hex') }, T);
    quests.recordLogin(db, alice, T);
  });

  it('merkle mirrors the on-chain verifier (golden vector shared with client + Rust)', () => {
    const w = (b: number) => new Uint8Array(32).fill(b);
    const leaves = [{ wallet: w(1), amountMicro: 1_500_000n, kind: 2, epoch: 7 }, { wallet: w(2), amountMicro: 12_500_000n, kind: 5, epoch: 7 }, { wallet: w(3), amountMicro: 1n, kind: 6, epoch: 1 }];
    expect(toHex(rewardLeaf(leaves[0]))).toBe('3d0d922cddaa7e75b60963bd999a604e5c858d5996620351b1857bc242a0259f');
    const t = buildRewardTree(leaves);
    expect(toHex(t.root)).toBe('08a5f93435e89ae1fb9ea8821bf61eb469008c475d327b0a0114dd1e980b5027');
    leaves.forEach((l, i) => expect(verifyRewardProof(l, t.proofs[i], t.root)).toBe(true));
    expect(verifyRewardProof({ ...leaves[0], kind: 5 }, t.proofs[0], t.root)).toBe(false);
  });

  it('buildBatch: pvp rewards → kind 3 leaves (sorted wallets, proofs verify), sources marked, min-batch respected, one pending batch at a time', () => {
    expect(oracle.buildBatch(db, oracle.KIND_QUESTS, T)).toBeUndefined();          // nothing settled yet
    expect(oracle.buildBatch(db, oracle.KIND_PVP, T, 10_000_000n)).toBeUndefined(); // 2.5 $CG < min 10
    const b = oracle.buildBatch(db, oracle.KIND_PVP, T, 1_000_000n)!;
    expect(b).toMatchObject({ kind: 3, epoch: 0, budget: 2_500_000n, leaves: 2 });
    const leaves = db.all<{ wallet: string; amount: string; proof: string }>(`SELECT wallet, amount, proof FROM reward_leaves WHERE kind = 3 AND epoch = 0 ORDER BY wallet`);
    expect(leaves.map((l) => l.wallet)).toEqual([alice, bob].sort());
    for (const l of leaves) expect(verifyRewardProof({ wallet: l.wallet, amountMicro: l.amount, kind: 3, epoch: 0 }, (JSON.parse(l.proof) as string[]).map(fromHex), fromHex(b.root))).toBe(true);
    expect(db.scalar(`SELECT COUNT(*) FROM pvp_rewards WHERE root_kind IS NULL`)).toBe(0);
    expect(oracle.buildBatch(db, oracle.KIND_PVP, T, 1n)).toBeUndefined(); // pending batch blocks a second one
    // /quests/claims lists the leaf as not yet published (no claimableAt)
    const c = quests.claims(db, alice, T);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 3, epoch: 0, currency: 'CG', published: false, claimableAt: null, claimed: false });
    expect(c[0].rootPda).toBe(quests.rootPdaOf(3, 0));
  });

  it('publishPending sends publish_root with the right accounts/args, marks published; RootPublished + RootClaimed drive /quests/claims', async () => {
    const seasonOracle = Keypair.generate();
    const conn = new FakeConnection();
    const b = oracle.buildBatch(db, oracle.KIND_PVP, T, 1n)!;
    const r = await oracle.publishPending({ connection: asConn(conn), db, seasonOracle });
    expect(r).toEqual({ published: 1, failed: 0, skipped: 0 });
    const sent = conn.sent[0].ixs.find((ix) => ix.programId.equals(PROGRAMS.staking))!; // after the compute-budget ixs
    expect(sent).toBeDefined();
    expect(Buffer.from(sent.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('publish_root')).toString('hex'));
    expect(sent.data[8]).toBe(3);                                   // kind
    expect(sent.data.readUInt32LE(9)).toBe(0);                      // epoch
    expect(sent.data.subarray(13, 45).toString('hex')).toBe(b.root); // root
    expect(sent.data.readBigUInt64LE(45)).toBe(2_500_000n);          // budget
    expect(sent.keys[0].equals(seasonOracle.publicKey)).toBe(true);
    expect(sent.keys[2].equals(oracle.rewardRootPda(3, 0)[0])).toBe(true);
    expect(db.get<{ status: string }>(`SELECT status FROM reward_batches WHERE kind = 3 AND epoch = 0`)!.status).toBe('published');
    // a quest batch without the quest key is skipped, not failed
    quests.settleWallet(db, alice, T);
    expect(oracle.buildBatch(db, oracle.KIND_QUESTS, T, 1n)).toMatchObject({ kind: 2, epoch: 0 });
    expect(await oracle.publishPending({ connection: asConn(conn), db, seasonOracle })).toMatchObject({ skipped: 1 });
    // indexer sees the root → claimable after the 1 h timelock; claim → claimed
    ingestTx(tx([{ program: 'staking', name: 'RootPublished', data: { kind: 3, epoch: 0, root: b.root, budget: '2500000' } }], { blockTime: T + 10 }), db);
    let c = quests.claims(db, alice, T + 20).find((x) => x.kind === 3)!;
    expect(c.published).toBe(true);
    expect(Date.parse(c.claimableAt!)).toBe((T + 10 + 3600) * 1000);
    ingestTx(tx([{ program: 'staking', name: 'RootClaimed', data: { kind: 3, epoch: 0, wallet: alice, amount: c.amountMicro } }]), db);
    c = quests.claims(db, alice, T + 4000).find((x) => x.kind === 3)!;
    expect(c.claimed).toBe(true);
    // revoked roots disappear from the list
    ingestTx(tx([{ program: 'staking', name: 'RootRevoked', data: { kind: 3, epoch: 0 } }]), db);
    expect(quests.claims(db, alice, T + 5000).some((x) => x.kind === 3)).toBe(false);
    expect(oracle.rewardOracleStatus(db).healthy).toBe(true);
  });

  it('runOnce settles active wallets, builds both kinds and reports; a re-run publishes nothing new', async () => {
    const conn = new FakeConnection();
    const questOracle = Keypair.generate(), seasonOracle = Keypair.generate();
    const r = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T + 100);
    expect(r.settled).toBeGreaterThan(0);
    expect(r.built.map((b) => b.kind).sort()).toEqual([2, 3]);
    expect(r.published).toBe(2);
    const again = await oracle.runOnce({ connection: asConn(conn), db, questOracle, seasonOracle, minBatchMicro: 1n }, T + 200);
    expect(again.built).toEqual([]);
    expect(again.published).toBe(0);
    expect(quests.claims(db, alice, T + 300).map((c) => c.kind).sort()).toEqual([2, 3]);
  });
});

describe('battle resolver', () => {
  it('rolls from the VRF value are deterministic; result_hash canonical; resolve_battle account list mirrors the program', () => {
    const value = new Uint8Array(32).map((_, i) => i * 7);
    const A: FighterChip[] = [{ asset: 'a', collection: 0, rarity: 3, level: 2 }, { asset: 'b', collection: 1, rarity: 3, level: 1 }, { asset: 'c', collection: 2, rarity: 2, level: 1 }];
    const B: FighterChip[] = [{ asset: 'd', collection: 3, rarity: 3, level: 1 }, { asset: 'e', collection: 4, rarity: 3, level: 1 }, { asset: 'f', collection: 5, rarity: 2, level: 3 }];
    const f1 = resolveFight(A, B, rollFromValue(value)), f2 = resolveFight(A, B, rollFromValue(value));
    expect(f1).toEqual(f2);
    expect(resultHash(f1.rounds).equals(resultHash(f2.rounds))).toBe(true);
    expect(resultHash(f1.rounds).equals(resultHash(f1.rounds.slice(0, 1)))).toBe(false);
    const oracleKp = Keypair.generate(), challenger = Keypair.generate().publicKey, cg = Keypair.generate().publicKey;
    const ix = resolveBattleIx({ oracle: oracleKp.publicKey, challenger, nonce: 9n, randomness: Keypair.generate().publicKey, cgMint: cg, winner: challenger, seasonPool: Keypair.generate().publicKey, treasuryCg: Keypair.generate().publicKey, resultHash: resultHash(f1.rounds) });
    expect(ix.programId.equals(PROGRAMS.arena)).toBe(true);
    expect(ix.keys).toHaveLength(11);
    expect(ix.keys[0]).toMatchObject({ isSigner: true });
    expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('resolve_battle')).toString('hex'));
    expect(new PublicKey(ix.data.subarray(8, 40)).equals(challenger)).toBe(true);
    expect(ix.data.length).toBe(8 + 32 + 32);
    // squads come from the chips projection
    const db = new Db(':memory:');
    const owner = kp();
    const assets = mint(db, owner, [{ rarity: 1, collection: 2 }, { rarity: 2, collection: 3 }, { rarity: 0, collection: 4 }]);
    const sq = squadFromDb(db, assets.map((a) => new PublicKey(a)))!;
    expect(sq.map((c) => [c.collection, c.rarity])).toEqual([[2, 1], [3, 2], [4, 0]]);
    expect(squadFromDb(db, [new PublicKey(kp())])).toBeUndefined();
  });
});

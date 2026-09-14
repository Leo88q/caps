import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKS, expandRandomness, effectiveOdds, rollRarity, FUSION_RECIPES, expectedBurn,
  guardedEmission, dailyEmission, fullSetBonusMult, matchWinProbability, elementEdge,
  RARITY_PROFILES, bundlePriceCents,
  REWARD_ROOT_KINDS, isSkrRootKind, rootCurrency, skrPoolMonthlyFunding, BASELINE_SKR_ASSUMPTIONS, SKR_POOL_FUNDING, CURRENCIES,
} from '../src/index.ts';

test('every pack odds table sums to exactly 10 000 bps', () => {
  for (const p of Object.values(PACKS)) assert.equal(p.oddsBps.reduce((a, b) => a + b, 0), 10_000, p.id);
});

test('pity never breaks the 10 000 sum and never drains Common below 5%', () => {
  for (let c = 0; c < 200; c++) {
    const o = effectiveOdds(PACKS.standard, c);
    assert.equal(o.reduce((a, b) => a + b, 0), 10_000);
    assert.ok(o[0] >= 500);
  }
});

test('rollRarity maps boundaries correctly', () => {
  const o = PACKS.standard.oddsBps;
  assert.equal(rollRarity(0, o), 0);
  assert.equal(rollRarity(4499, o), 0);
  assert.equal(rollRarity(4500, o), 1);
  assert.equal(rollRarity(9999, o), 8);
});

test('expandRandomness is deterministic, honours floor and hard pity', () => {
  const vrf = new Uint8Array(32).fill(0); // all-zero → every slot rolls 0 → Common
  const a = expandRandomness(vrf, PACKS.standard, 0, 10);
  const b = expandRandomness(vrf, PACKS.standard, 0, 10);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(a[2].rarity, PACKS.standard.floor, 'last slot is lifted to the floor');
  const pity = expandRandomness(vrf, PACKS.standard, 59, 10);
  assert.equal(pity[2].rarity, 6, 'hard pity forces Legend on the last slot');
});

test('fusion: 8 recipes chain 0→8, always 3 materials, alternating collection rule', () => {
  assert.equal(FUSION_RECIPES.length, 8);
  FUSION_RECIPES.forEach((r, i) => {
    assert.equal(r.from, i); assert.equal(r.to, i + 1); assert.equal(r.materials, 3);
    assert.equal(r.rule, i % 2 === 0 ? 'any' : 'same-collection');
    assert.ok(r.refundOnFail < r.materials);
  });
  assert.equal(expectedBurn(FUSION_RECIPES[0]), 3);
  assert.equal(+expectedBurn(FUSION_RECIPES[7]).toFixed(2), 5); // 50% with 1 refund
});

test('emission guard is a ceiling, floors at 30% of the schedule', () => {
  const cap = dailyEmission(0);
  assert.equal(guardedEmission(cap, 0), 0.3 * cap);
  assert.equal(guardedEmission(cap, cap * 10), cap);
});

test('full-set bonus caps at 1.70x', () => {
  assert.equal(fullSetBonusMult(0), 1);
  assert.equal(+fullSetBonusMult(10).toFixed(2), 1.7);
  assert.equal(+fullSetBonusMult(50).toFixed(2), 2.5); // beyond 10 impossible; formula is monotone anyway
});

test('pvp: symmetric, monotone, upsets possible at 1.35x', () => {
  assert.equal(+matchWinProbability(1000, 1000).toFixed(3), 0.5);
  assert.ok(matchWinProbability(1200, 1000) > matchWinProbability(1100, 1000));
  assert.ok(matchWinProbability(1350, 1000) < 0.95);
  assert.equal(elementEdge('paint', 'steel'), 1.15);
  assert.equal(elementEdge('steel', 'paint'), 0.87);
  assert.equal(elementEdge('paint', 'wheels'), 1);
});

test('rarity ladder is strictly increasing in value, power and weight', () => {
  for (let i = 1; i < RARITY_PROFILES.length; i++) {
    assert.ok(RARITY_PROFILES[i].valueMult > RARITY_PROFILES[i - 1].valueMult);
    assert.ok(RARITY_PROFILES[i].basePower > RARITY_PROFILES[i - 1].basePower);
    assert.ok(RARITY_PROFILES[i].stakeWeight > RARITY_PROFILES[i - 1].stakeWeight);
  }
});

test('bundles never exceed 18% discount and are monotone', () => {
  const one = bundlePriceCents(PACKS.standard, 1);
  assert.equal(one, 499);
  assert.ok(bundlePriceCents(PACKS.standard, 25) >= 25 * 499 * 0.82 - 1);
});

test('SKR reward roots: kinds 5..7 pay SKR, everything below pays $CG', () => {
  assert.deepEqual(Object.values(REWARD_ROOT_KINDS).filter(isSkrRootKind), [5, 6, 7]);
  assert.equal(rootCurrency(REWARD_ROOT_KINDS.cgQuests), 'CG');
  assert.equal(rootCurrency(REWARD_ROOT_KINDS.skrSeason), 'SKR');
  assert.equal(isSkrRootKind(8), false);
  // only $CG and SKR are reward currencies; SOL/USDC never flow through roots
  assert.deepEqual(CURRENCIES.filter((c) => c.rewards).map((c) => c.symbol), ['CG', 'SKR']);
});

test('SKR pool funding scales linearly with SKR revenue and never exceeds the published shares', () => {
  const base = skrPoolMonthlyFunding(BASELINE_SKR_ASSUMPTIONS);
  const doubled = skrPoolMonthlyFunding({ ...BASELINE_SKR_ASSUMPTIONS, packRevenueUsd: BASELINE_SKR_ASSUMPTIONS.packRevenueUsd * 2, marketVolumeUsd: BASELINE_SKR_ASSUMPTIONS.marketVolumeUsd * 2, servicesRevenueUsd: BASELINE_SKR_ASSUMPTIONS.servicesRevenueUsd * 2 });
  assert.ok(Math.abs(doubled.poolUsd - 2 * base.poolUsd) <= 1);
  const maxShare = Math.max(SKR_POOL_FUNDING.packRevenueShareBps, SKR_POOL_FUNDING.marketFeeTreasuryShareBps, SKR_POOL_FUNDING.servicesRevenueShareBps) / 10_000;
  assert.ok(base.giveBackShare <= maxShare);
  // no SKR revenue → no SKR rewards (the pool cannot be promised into existence)
  const none = skrPoolMonthlyFunding({ ...BASELINE_SKR_ASSUMPTIONS, skrPackShare: 0, skrMarketShare: 0, skrServicesShare: 0 });
  assert.equal(none.poolSkr, 0);
});

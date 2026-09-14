// Run: node --experimental-strip-types packages/economy/scripts/report.ts
// Prints every table used in docs/02-economy.md and asserts the invariants
// the economy relies on. Exit code 1 on any violated invariant.

import {
  RARITY_PROFILES, PACKS, BUNDLES, bundlePriceCents, packExpectedValueMult, probabilityAtLeast,
  effectiveOdds, FUSION_RECIPES, expectedBurn, commonsPerTier, fusionParityReport, impliedCommonFloorUsd,
  LOCK_TIERS, fullSetBonusMult, impliedApy, dailyEmission, EMISSION_SPLIT, dailyFlows, MODELLED_TOKEN_TVL_CG, MODELLED_AVG_BOOST,
  BASELINE_ASSUMPTIONS, matchWinProbability, MATCHMAKING, freeValueReport, ANTI_FARM,
} from '../src/index.ts';

let failures = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { failures++; console.error('  ✗ INVARIANT', msg); } else console.log('  ✓', msg); };
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

console.log('\n=== 1. RARITY LADDER ===');
console.table(RARITY_PROFILES.map((p) => ({ tier: p.name, valueMult: p.valueMult, basePower: p.basePower, maxLevel: p.maxLevel, stakeWeight: p.stakeWeight, vfx: p.vfxTier, rim: p.rim })));

console.log('\n=== 2. PACKS ===');
const commonFloorUsd = impliedCommonFloorUsd();
console.log(`  Implied Common floor (Standard EV = 65% of price): $${commonFloorUsd.toFixed(4)}`);
for (const pack of Object.values(PACKS)) {
  const sum = pack.oddsBps.reduce((a, b) => a + b, 0);
  check(sum === 10_000, `${pack.id}: odds sum to 10 000 (got ${sum})`);
  const ev = packExpectedValueMult(pack);
  const evUsd = ev * commonFloorUsd;
  const ratio = evUsd / (pack.priceUsdCents / 100);
  console.log(`  ${pack.name}: ${pack.chips} chips, $${(pack.priceUsdCents / 100).toFixed(2)}  EV=${ev.toFixed(2)} Common-eq  (≈$${evUsd.toFixed(2)} → ${pct(ratio, 0)} of price)`);
  console.log(`     P(≥Rare)=${pct(probabilityAtLeast(pack, 2))}  P(≥Epic)=${pct(probabilityAtLeast(pack, 4))}  P(≥Legend)=${pct(probabilityAtLeast(pack, 6), 3)}  P(Diamond)=${pct(probabilityAtLeast(pack, 8), 3)}`);
  if (pack.id !== 'starter') check(ratio >= 0.55 && ratio <= 0.75, `${pack.id}: EV/price in [55%,75%] (got ${pct(ratio, 0)})`);
  else check(ratio > 1, `${pack.id}: starter is intentionally +EV (acquisition cost) (got ${pct(ratio, 0)})`);
}
console.log('\n  Odds table (bps per slot):');
console.table(Object.fromEntries(Object.values(PACKS).map((p) => [p.id, Object.fromEntries(p.oddsBps.map((b, i) => [RARITY_PROFILES[i].name, `${(b / 100).toFixed(2)}%`]))])));

console.log('\n  Pity curve (standard pack, P(≥Legend) per pack by counter):');
const std = PACKS.standard;
for (const c of [0, 29, 30, 40, 50, 59]) {
  const o = effectiveOdds(std, c);
  const pSlot = o.slice(6).reduce((a, b) => a + b, 0) / 10_000;
  console.log(`     counter=${c.toString().padStart(2)} → per-slot ${pct(pSlot, 2)}  per-pack ${pct(1 - Math.pow(1 - pSlot, std.chips), 2)}${c + 1 >= std.pity!.hardAt ? '  (HARD PITY → 100%)' : ''}`);
  check(o.reduce((a, b) => a + b, 0) === 10_000, `pity odds still sum to 10 000 at counter=${c}`);
}

console.log('\n  Bundles (standard):');
for (const b of BUNDLES) console.log(`     ×${b.qty}: $${(bundlePriceCents(std, b.qty) / 100).toFixed(2)}  (-${b.discountBps / 100}%)`);

console.log('\n=== 3. FUSION ===');
console.table(FUSION_RECIPES.map((r) => ({
  recipe: `${RARITY_PROFILES[r.from].name} → ${RARITY_PROFILES[r.to].name}`,
  burn: r.materials, rule: r.rule, success: `${r.successBps / 100}%`, refundOnFail: r.refundOnFail,
  feeCg: r.feeCgMicro / 1e6, 'E[burn]': +expectedBurn(r).toFixed(2), 'E[burn] boosted': +expectedBurn(r, true).toFixed(2),
  lockH: r.resultLockSeconds / 3600,
})));
console.log('  Per-step parity: value(N+1)/value(N) vs E[burn] — must sit in [0.8, 1.0]');
console.table(fusionParityReport());
for (const row of fusionParityReport()) check(row.parity >= 0.8 && row.parity <= 1.0, `${row.step}: parity in [0.8,1.0] (got ${row.parity})`);
console.log(`  Commons needed for one Diamond via pure fusion: ${commonsPerTier(8).toFixed(0)}  (boosted every step: ${commonsPerTier(8, true).toFixed(0)})`);
console.log(`  → at the implied floor that is ≈ $${(commonsPerTier(8) * commonFloorUsd).toFixed(0)} of Commons, or ${(commonsPerTier(8) / packExpectedValueMult(PACKS.standard)).toFixed(0)} Standard packs' worth of EV.`);

console.log('\n=== 4. STAKING ===');
console.table(Object.values(LOCK_TIERS).map((t) => ({ tier: t.id, lockDays: t.lockSeconds / 86_400, boost: t.boost, earlyExitPenalty: `${t.earlyExitPenaltyBps / 100}%`, targetApy: `${t.targetApyRange[0]}–${t.targetApyRange[1]}%` })));
const y1daily = dailyEmission(0);
const tokenPoolDaily = (y1daily * EMISSION_SPLIT.tokenStaking) / 100;
const modelledWeight = MODELLED_TOKEN_TVL_CG * MODELLED_AVG_BOOST;
console.log(`  Y1 daily emission ${y1daily.toFixed(0)} $CG; token-staking pool ${tokenPoolDaily.toFixed(0)} $CG/day; modelled TVL ${(MODELLED_TOKEN_TVL_CG / 1e6).toFixed(0)}M $CG`);
for (const t of Object.values(LOCK_TIERS)) {
  const apy = impliedApy(10_000, t.id, modelledWeight, tokenPoolDaily);
  console.log(`     ${t.id.padEnd(5)} implied APY @ modelled TVL: ${apy.toFixed(1)}%   (@ half TVL: ${impliedApy(10_000, t.id, modelledWeight / 2, tokenPoolDaily).toFixed(1)}%, @ 2x TVL: ${impliedApy(10_000, t.id, modelledWeight * 2, tokenPoolDaily).toFixed(1)}%)`);
  check(apy >= t.targetApyRange[0] && apy <= t.targetApyRange[1], `${t.id}: modelled APY inside published band ${t.targetApyRange[0]}–${t.targetApyRange[1]}%`);
}
console.log(`  Full-set bonus: 1 set ${fullSetBonusMult(1)}x · 5 sets ${fullSetBonusMult(5)}x · 10 sets ${fullSetBonusMult(10).toFixed(2)}x`);

console.log('\n=== 5. TOKENOMICS FLOWS (baseline: 5 000 DAU, year 1) ===');
const flows = dailyFlows(BASELINE_ASSUMPTIONS, 0);
console.table([flows]);
check(flows.sinkRatio >= 0.5, `sinks absorb ≥50% of daily emission at baseline (got ${flows.sinkRatio})`);
console.log('  Sensitivity (DAU → guarded emission / sink ratio / net inflation):');
for (const dau of [1_000, 5_000, 20_000, 50_000]) {
  const f = dailyFlows({ ...BASELINE_ASSUMPTIONS, dau }, 0);
  console.log(`     ${dau.toString().padStart(6)} DAU → emission ${f.emissionCg.toString().padStart(7)} (cap ${f.scheduleCapCg})  sink ${f.sinkRatio}  net +${f.netInflationCg}/day  per-DAU ${f.perDauEmission} $CG/day`);
}
console.log('  Year-by-year schedule cap (per day):', [0,1,2,3,4].map((y) => `Y${y+1} ${Math.round(dailyEmission(y)).toLocaleString('en')}`).join(' · '));

console.log('\n=== 6. PVP ===');
for (const r of [1.0, 1.1, 1.2, 1.35, 1.5]) console.log(`  power ratio ${r.toFixed(2)} → P(win match) = ${pct(matchWinProbability(r * 1000, 1000), 1)}`);
check(matchWinProbability(1350, 1000) < 0.95, 'a 1.35x power edge does not exceed 95% win rate (upsets remain possible)');
console.log(`  Leagues: ${MATCHMAKING.leagueNames.join(' < ')}`);

console.log('\n=== 7. FREE SOURCES vs PAID (median payer = 2 Standard packs / week) ===');
const fv = freeValueReport(2 * packExpectedValueMult(PACKS.standard));
console.table([fv]);
check(fv.freeShare <= 0.2, `free value (chips + $CG→packs) ≤ 20% of a median payer's weekly pack value (got ${pct(fv.freeShare, 1)})`);
console.log(`  Hard caps: ${ANTI_FARM.freeChipsPerWalletPerWeek} free chips / wallet / week, daily quest $CG cap ${ANTI_FARM.dailyQuestRewardCapCgMicro / 1e6} $CG`);

console.log(`\n${failures === 0 ? 'ALL INVARIANTS HOLD' : `${failures} INVARIANT(S) VIOLATED`}\n`);
process.exit(failures === 0 ? 0 : 1);

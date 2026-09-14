// Guards against drift between the TS economy model (source of truth) and
// the constants baked into the on-chain programs. Parses the Rust sources
// textually (no toolchain needed) and compares every number that matters.
// Exit 1 on any mismatch. Wired into `npm run economy:check` at the root.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PACKS, BUNDLES } from '../src/packs.ts';
import { RARITY_PROFILES } from '../src/rarity.ts';
import { FUSION_RECIPES, BOOSTER } from '../src/fusion.ts';
import { LOCK_TIERS, fullSetBonusMult } from '../src/staking.ts';
import { FEES, SKR, YEARLY_EMISSION_PCT_OF_PLAY, EMISSION_SPLIT, EMISSION_GUARD, CG_HARD_CAP } from '../src/tokenomics.ts';
import { SERVICES, SERVICES_DAILY_CAP_RUST } from '../src/services.ts';
import { MATCHMAKING, MATCH_REWARDS, WAGER } from '../src/pvp.ts';

const root = resolve(import.meta.dirname, '../../..');
const rs = (p: string) => readFileSync(resolve(root, p), 'utf8');
const econ = rs('programs/chip_core/src/economy.rs');
const stakingState = rs('programs/staking/src/state.rs');
const market = rs('programs/market/src/lib.rs');
const arena = rs('programs/arena/src/lib.rs');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { failures++; console.error(`✗ ${name}\n    rust: ${a}\n    ts:   ${e}`); } else { console.log(`✓ ${name}`); }
}
const nums = (s: string) => Array.from(s.matchAll(/-?\d[\d_]*/g)).map((m) => Number(m[0].replace(/_/g, '')));
const int = (s: string) => Number(s.replace(/_/g, ''));
const line = (src: string, re: RegExp) => { const m = src.match(re); if (!m) throw new Error(`pattern not found: ${re}`); return m[1]; };

// ---- rarity tables ----
check('base_power', nums(line(econ, /fn base_power[\s\S]*?\[([^\]]+)\]/)), RARITY_PROFILES.map((r) => r.basePower));
check('stake_weight', nums(line(econ, /fn stake_weight[\s\S]*?\[([^\]]+)\]/)), RARITY_PROFILES.map((r) => r.stakeWeight));
check('max_level', nums(line(econ, /fn max_level[\s\S]*?\[([^\]]+)\]/)), RARITY_PROFILES.map((r) => r.maxLevel));

// ---- packs ----
const packRows = Array.from(econ.matchAll(/PackDef \{ chips: (\d+), price_usd_cents: (\d+),\s+price_cg_micro: ([\d_]+),\s+odds_bps: \[([^\]]+)\],\s+floor: (\d+), daily_cap: (\d+), pity_tier: (\d+), pity_hard_at: (\d+),\s+pity_soft_start: (\d+),\s+pity_soft_step_bps: (\d+)/g));
const skus = ['starter', 'standard', 'premium', 'limited'] as const;
check('pack count', packRows.length, 4);
skus.forEach((k, i) => {
  const r = packRows[i]; const p = PACKS[k];
  if (!r) return;
  check(`${k}.chips`, Number(r[1]), p.chips);
  check(`${k}.price_usd_cents`, Number(r[2]), p.priceUsdCents);
  check(`${k}.price_cg_micro`, Number(r[3].replace(/_/g, '')), p.priceCgMicro ?? 0);
  check(`${k}.odds`, nums(r[4]), p.oddsBps);
  check(`${k}.floor`, Number(r[5]), p.floor);
  check(`${k}.daily_cap`, Number(r[6]), p.dailyCap ?? 0);
  check(`${k}.pity`, [Number(r[7]), Number(r[8]), Number(r[9]), Number(r[10])], p.pity ? [p.pity.tier, p.pity.hardAt, p.pity.softStart, p.pity.softStepBps] : [0, 0, 0, 0]);
});
check('bundle discounts', nums(line(econ, /BUNDLE_DISCOUNT_BPS: \[\(u8, u16\); 4\] = \[([^;]+)\];/)).filter((_, i) => i % 2 === 1),
  BUNDLES.map((b) => b.discountBps));
check('cg pack burn bps', int(line(econ, /CG_PACK_BURN_BPS: u16 = ([\d_]+)/)), FEES.cgPackBurnBps);

// ---- fusion ----
const recipeRows = Array.from(econ.matchAll(/FusionRecipe \{ from: Rarity::\w+,\s+same_collection: (true|false),\s+success_bps: ([\d_]+),\s+refund_on_fail: (\d+), fee_cg_micro: ([\d_]+),\s+result_lock_secs: ([^}]+)\}/g));
check('recipe count', recipeRows.length, FUSION_RECIPES.length);
FUSION_RECIPES.forEach((rec, i) => {
  const r = recipeRows[i]; if (!r) return;
  check(`recipe[${i}].sameCollection`, r[1] === 'true', rec.rule === 'same-collection');
  check(`recipe[${i}].successBps`, Number(r[2].replace(/_/g, '')), rec.successBps);
  check(`recipe[${i}].refund`, Number(r[3]), rec.refundOnFail);
  check(`recipe[${i}].feeCgMicro`, Number(r[4].replace(/_/g, '')), rec.feeCgMicro);
  const lockExpr = r[5].trim();
  const lockSecs = lockExpr === '0' ? 0 : lockExpr === 'H' ? 3600 : Number(lockExpr.split('*')[0]) * 3600;
  check(`recipe[${i}].lockSecs`, lockSecs, rec.resultLockSeconds);
});
check('booster bonus', int(line(econ, /BOOSTER_BONUS_BPS: u16 = ([\d_]+)/)), BOOSTER.bonusBps);
check('booster cap', int(line(econ, /BOOSTER_CAP_BPS: u16 = ([\d_]+)/)), BOOSTER.capBps);

// ---- staking / emission ----
check('yearly pct', nums(line(stakingState, /YEARLY_PCT: \[u8; 8\] = \[([^\]]+)\]/)), [...YEARLY_EMISSION_PCT_OF_PLAY]);
check('hard cap', int(line(stakingState, /HARD_CAP_MICRO: u64 = ([\d_]+) \* MICRO/)), CG_HARD_CAP);
check('guard floor', int(line(stakingState, /GUARD_FLOOR_BPS: u64 = ([\d_]+)/)) / 1e4, EMISSION_GUARD.floorShare);
check('guard burn mult', int(line(stakingState, /GUARD_BURN_MULT_BPS: u64 = ([\d_]+)/)) / 1e4, EMISSION_GUARD.burnMultiple);
const tiers = ['flex', 'd30', 'd90', 'd180'] as const;
check('tier boosts', nums(line(stakingState, /TIER_BOOST_BPS: \[u64; TIER_COUNT\] = \[([^\]]+)\]/)).map((b) => b / 1e4), tiers.map((t) => LOCK_TIERS[t].boost));
check('tier penalties', nums(line(stakingState, /TIER_PENALTY_BPS: \[u64; TIER_COUNT\] = \[([^\]]+)\]/)), tiers.map((t) => LOCK_TIERS[t].earlyExitPenaltyBps));
check('tier locks (days)', line(stakingState, /TIER_LOCK_SECS: \[i64; TIER_COUNT\] = \[([^\]]+)\]/).split(',').map((s) => (s.trim() === '0' ? 0 : Number(s.trim().split('*')[0]))),
  tiers.map((t) => LOCK_TIERS[t].lockSeconds / 86_400));
check('set bonus cap', int(line(stakingState, /SET_BONUS_CAP_BPS: u64 = ([\d_]+)/)), Math.round(fullSetBonusMult(10) * 1e4));
const splitTs = [EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve].map((p) => p * 100);
const splitRs = nums(line(rs('programs/staking/src/lib.rs'), /split_bps: \[([^\]]+)\], split_changed_at/));
check('emission split (test fixture)', splitRs, splitTs);

// ---- market / arena ----
check('market fee bps (default)', Number(line(market, /FEE_BPS: u16 = (\d+)/)), FEES.marketplaceFeeBps);
check('market fee bps (chip_core default)', Number(line(econ, /DEFAULT_MARKET_FEE_BPS: u16 = (\d+)/)), FEES.marketplaceFeeBps);
check('market fee buyback share', Number(line(market, /FEE_BUYBACK_SHARE_BPS: u64 = ([\d_]+)/).replace(/_/g, '')), FEES.marketplaceFeeBuybackShareBps);
check('skr pack discount', Number(line(econ, /DEFAULT_SKR_DISCOUNT_BPS: u16 = ([\d_]+)/).replace(/_/g, '')), FEES.skrPackDiscountBps);
check('skr feed id', line(rs('programs/chip_core/src/instructions/packs.rs'), /SKR_USD_FEED_HEX: &str = "([0-9a-f]+)"/), SKR.pythFeedIdHex);
check('rake treasury share', Number(line(arena, /RAKE_TREASURY_BPS: u64 = ([\d_]+)/).replace(/_/g, '')), FEES.pvpRakeTreasuryShareBps);
check('rake pool share', Number(line(arena, /RAKE_POOL_BPS: u64 = ([\d_]+)/).replace(/_/g, '')), FEES.pvpRakePoolShareBps);
// paid services: every ServiceKind price on-chain must equal the TS catalogue
const svcRs = line(econ, /pub fn price_usd_cents\(self\) -> u64 \{\s*match self \{([\s\S]*?)\}\s*\}/);
const svcPrices = Object.fromEntries(Array.from(svcRs.matchAll(/Self::(\w+) => (\d+)/g)).map((m) => [m[1], Number(m[2])]));
check('service catalogue', svcPrices, Object.fromEntries(SERVICES.map((x) => [x.rustName, x.priceUsdCents])));
const capRs = line(econ, /pub fn daily_cap\(self\) -> u8 \{ match self \{([^}]+)\}/);
check('service daily caps', capRs.replace(/\s+/g, ' ').trim(), SERVICES_DAILY_CAP_RUST);
check('royalty bps', Number(line(market, /ROYALTY_BPS: u16 = (\d+)/)), FEES.creatorRoyaltyBps);
check('listing fee', Number(line(market, /LISTING_FEE_CG: u64 = ([\d_]+)/).replace(/_/g, '')), FEES.listingFeeCgMicro);
check('pvp rake', Number(line(arena, /RAKE_BPS: u64 = (\d+)/)), FEES.pvpRakeBps);
check('wager min', int(line(arena, /MIN_WAGER: u64 = ([\d_]+) \* MICRO/)) * 1e6, WAGER.minCgMicro);
check('wager max', int(line(arena, /MAX_WAGER: u64 = ([\d_]+) \* MICRO/)) * 1e6, WAGER.maxCgMicro);
check('pvp rake (arena)', Number(line(arena, /RAKE_BPS: u64 = (\d+)/)), WAGER.rakeBps);
check('min squad power', Number(line(arena, /MIN_SQUAD_POWER: u32 = (\d+)/)), MATCH_REWARDS.minSquadPowerForRewards);
// match arms `0..=799 => 0, 800..=1399 => 1, ...` → lower bounds of leagues 1..5
const arms = line(arena, /fn league\(power: u32\) -> u8 \{[\s\S]*?match power \{([^}]+)\}/);
// upper bound of each closed arm + 1 == lower bound of the next league; the `_` arm covers the top league
const upperPlusOne = Array.from(arms.matchAll(/(\d+)\.\.=(\d+) => (\d+)/g)).map((m) => Number(m[2]) + 1);
check('league lower bounds', upperPlusOne, MATCHMAKING.powerBandsUpper.slice(0, 5));

if (failures) { console.error(`\n${failures} mismatch(es) between TS economy and on-chain constants`); process.exit(1); }
console.log('\nALL ON-CHAIN CONSTANTS MATCH THE ECONOMY MODEL');

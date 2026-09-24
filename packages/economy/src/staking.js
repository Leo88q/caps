"use strict";
// =============================================================================
// GUTTERCAPS economy — staking
// -----------------------------------------------------------------------------
// Two staking products, both fed from ONE capped emission schedule
// (tokenomics.ts) — never from an open mint:
//
//  1. $CG staking (token lock)   — tiers: flex / 30d / 90d / 180d.
//     Rewards = share of the daily $CG budget for the token-staking pool,
//     weighted by (amount × tierBoost). APY is therefore an OUTPUT of TVL,
//     not a promise. We publish a target range and the admin can rebalance
//     the pool split quarterly.
//  2. Chip staking (NFT lock)    — the existing mechanic, but converted from
//     "fixed rate per hour, unlimited" to "stakeWeight share of the chip pool
//     budget". Full-set bonus and level multiplier apply here.
//
// Why pro-rata instead of fixed APY: a fixed rate is an uncapped faucet whose
// inflation is proportional to adoption — the more successful the game, the
// faster the token dies. A budgeted pool inverts that: more stakers → lower
// APY → natural equilibrium, and total emission is known in advance.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODELLED_AVG_BOOST = exports.MODELLED_TOKEN_TVL_CG = exports.LOCK_TIERS = void 0;
exports.fullSetBonusMult = fullSetBonusMult;
exports.chipStakeWeight = chipStakeWeight;
exports.tokenStakeWeight = tokenStakeWeight;
exports.rewardPerSecond = rewardPerSecond;
exports.impliedApy = impliedApy;
const DAY = 86_400;
exports.LOCK_TIERS = {
    flex: { id: 'flex', lockSeconds: 0, boost: 1.0, earlyExitPenaltyBps: 0, targetApyRange: [12, 30] },
    d30: { id: 'd30', lockSeconds: 30 * DAY, boost: 1.5, earlyExitPenaltyBps: 500, targetApyRange: [18, 45] },
    d90: { id: 'd90', lockSeconds: 90 * DAY, boost: 2.2, earlyExitPenaltyBps: 1000, targetApyRange: [26, 66] },
    d180: { id: 'd180', lockSeconds: 180 * DAY, boost: 3.0, earlyExitPenaltyBps: 1500, targetApyRange: [36, 90] },
};
/**
 * Modelled mid-Y1 token-staking TVL for the indicative APY bands: ~40M $CG
 * (≈ 35% of what has been emitted by then + part of the ecosystem bucket),
 * average boost 1.8. APY is an OUTPUT: half the TVL → double the APY, and
 * vice versa. The daily budget never changes; only its split does. The
 * published bands are ±50% around the modelled point; year-2+ bands fall
 * with the emission schedule and are re-published each season.
 */
exports.MODELLED_TOKEN_TVL_CG = 40_000_000;
exports.MODELLED_AVG_BOOST = 1.8;
/**
 * Full-set bonus (own all 9 tiers of one collection, all staked or held):
 *   +12% chip-staking weight per completed collection, max +60% (5 sets),
 *   +2% additional per set beyond 5 (cap +70% at 10/10).
 * Justification: completing a set costs ~4 000 Common-equivalents (one
 * Diamond!). A 12% yield boost is meaningful for whales but doesn't create
 * a separate class of returns that dwarfs everyone else.
 */
function fullSetBonusMult(completedSets) {
    const first = Math.min(completedSets, 5) * 0.12;
    const rest = Math.max(0, completedSets - 5) * 0.02;
    return 1 + first + rest;
}
/** Weight of a staked chip: rarity weight × level multiplier × set bonus. */
function chipStakeWeight(stakeWeight, level, completedSets) {
    return stakeWeight * (1 + 0.025 * Math.max(0, level - 1)) * fullSetBonusMult(completedSets);
}
/** Token-staking weight. amount in whole $CG. */
function tokenStakeWeight(amount, tier) {
    return amount * exports.LOCK_TIERS[tier].boost;
}
/**
 * Pro-rata reward per second for a participant with weight w in a pool with
 * total weight W and daily budget B (micro-CG). Integer math on-chain uses a
 * "reward per weight-unit" accumulator (MasterChef-style acc_reward_per_share
 * scaled by 1e12) so that N stakers cost O(1) per update.
 */
function rewardPerSecond(w, W, dailyBudgetMicro) {
    if (W === 0)
        return 0;
    return (dailyBudgetMicro / DAY) * (w / W);
}
function impliedApy(amount, tier, poolTotalWeight, dailyBudgetCg) {
    const w = tokenStakeWeight(amount, tier);
    const perYear = dailyBudgetCg * 365 * (w / (poolTotalWeight + w));
    return (perYear / amount) * 100;
}

"use strict";
// =============================================================================
// GUTTERCAPS economy — SKR (Seeker) as the second REWARD currency
// -----------------------------------------------------------------------------
// Owner decision (Phase 6 Q1): SKR is not only a payment rail but also a
// reward currency. Constraint that shapes everything here: the SKR mint
// authority is Solana Mobile's Squads vault, so the game can NEITHER mint
// SKR (no emission schedule) NOR burn it (no sink). Therefore:
//
//   * SKR rewards come from a treasury-funded PRIZE POOL (`SkrPool`,
//     programs/staking/src/instructions/skr.rs). Nothing is promised that
//     has not been deposited first — `vault ≥ budget + reserved` on-chain.
//   * The pool is fed by a fixed share of the SKR the game actually EARNS
//     (packs paid in SKR, SKR listings' fees, services paid in SKR). Real
//     revenue in → a bounded share out. No revenue → no SKR rewards, and the
//     $CG emission keeps the game liquid. The pool can never inflate anything.
//   * Distribution reuses the Merkle-root machinery with dedicated root kinds
//     5..7 (quests / season / events). Same leaf format; the kind byte in the
//     leaf keeps proofs from being replayed across currencies.
//   * $CG stays the token for wagers, fusion fees and staking weight. SKR
//     wagers would need SKR escrow + rake with no burn — explicitly out of
//     scope (see docs/02 §7.7).
//
// Every constant below is mirrored in Rust and checked by scripts/sync-check.ts.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.weeklySkrQuestCapUsd = exports.BASELINE_SKR_ASSUMPTIONS = exports.SKR_ANTI_FARM = exports.SKR_POOL_SPLIT = exports.marketFeeTreasuryPartMicro = exports.SKR_POOL_FUNDING = exports.DEFAULT_MAX_SKR_ROOT_BUDGET_MICRO = exports.CHIP_VOUCHER_REWARDS = exports.ITEM_REWARDS = exports.ROOT_KIND_LABEL = exports.rootCurrency = exports.isChipRootKind = exports.CHIP_ROOT_KIND_BASE = exports.isItemRootKind = exports.ITEM_ROOT_KIND_BASE = exports.isSkrRootKind = exports.SKR_ROOT_KIND_BASE = exports.REWARD_ROOT_KINDS = exports.SKR_TREASURY_WALLET = exports.SKR_MICRO = void 0;
exports.skrPoolDueMicro = skrPoolDueMicro;
exports.skrPoolMonthlyFunding = skrPoolMonthlyFunding;
const tokenomics_ts_1 = require("./tokenomics.ts");
/** 6 decimals, same as $CG and USDC. */
exports.SKR_MICRO = 1_000_000;
/**
 * Treasury wallet for the SKR rail — owner-provided 2026-09-15. It is where
 * `sweep_vault` sends SKR revenue (its SKR ATA) and the signer that runs
 * `fund_skr` every week. Also the address `GET /rewards/skr-pool` reports so
 * players can compare funding with revenue.
 * NOTE: this is an on-curve single-signer key, not a Squads vault — see
 * docs/06 §2.5 (custody recommendation: hardware signer now, Squads 2/3 before
 * the pool holds > 1 week of revenue).
 */
exports.SKR_TREASURY_WALLET = 'HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho';
/**
 * Root kinds understood by `publish_root` / `publish_skr_root` / `publish_item_root` / `publish_chip_root`.
 * 0..4 = $CG emission slices, 5..7 = SKR prize pool, 8 = items (fusion boosters — backlog #27:
 * `claim_item_root` delivers by CPI into chip_core `PlayerItems`; the leaf amount is a unit count),
 * 9 = quest chip vouchers (backlog #28: `claim_chip_root` CPIs chip_core `open_voucher`, which creates a
 * free 1-chip PendingPack committed to Switchboard; the leaf amount is the voucher TEMPLATE id).
 */
exports.REWARD_ROOT_KINDS = {
    cgQuests: 2,
    cgSeason: 3,
    cgEvents: 4,
    skrQuests: 5,
    skrSeason: 6,
    skrEvents: 7,
    itemBoosters: 8,
    chipVouchers: 9,
};
exports.SKR_ROOT_KIND_BASE = 5;
const isSkrRootKind = (kind) => kind >= exports.SKR_ROOT_KIND_BASE && kind < exports.SKR_ROOT_KIND_BASE + 3;
exports.isSkrRootKind = isSkrRootKind;
exports.ITEM_ROOT_KIND_BASE = 8;
const isItemRootKind = (kind) => kind === exports.REWARD_ROOT_KINDS.itemBoosters;
exports.isItemRootKind = isItemRootKind;
exports.CHIP_ROOT_KIND_BASE = 9;
const isChipRootKind = (kind) => kind === exports.REWARD_ROOT_KINDS.chipVouchers;
exports.isChipRootKind = isChipRootKind;
const rootCurrency = (kind) => ((0, exports.isSkrRootKind)(kind) ? 'SKR' : (0, exports.isItemRootKind)(kind) ? 'ITEM' : (0, exports.isChipRootKind)(kind) ? 'CHIP' : 'CG');
exports.rootCurrency = rootCurrency;
exports.ROOT_KIND_LABEL = {
    2: 'Quests', 3: 'PvP season', 4: 'Referrals & events', 5: 'Quests (SKR)', 6: 'PvP season (SKR)', 7: 'Events (SKR)', 8: 'Boosters', 9: 'Quest chips',
};
/**
 * Item roots (kind 8) — mirrored in programs/staking/src/state.rs, checked by sync-check.
 *  - `maxRootBudget`: boosters per root (≈ $790 at the $0.79 service price) = blast radius of a leaked
 *    quest-oracle key inside the 1 h revoke window; the oracle carries a bigger backlog to the next epoch.
 *  - `maxClaim`: boosters per leaf = chip_core `grant_booster(count ≤ 10)`; the remainder rolls over.
 * There is no on-chain supply to debit: boosters are a non-transferable counter (no market, no DEX), so the
 * only economy guard is the quest design itself (2 booster quests: `w_stake` weekly, `p_set1` once).
 */
exports.ITEM_REWARDS = { maxRootBudget: 1_000, maxClaim: 10 };
/**
 * Chip voucher roots (kind 9) — mirrored in programs/staking/src/state.rs, checked by sync-check.
 *  - `maxRootBudget`: vouchers (leaves) per root = blast radius of a leaked quest-oracle key inside the 1 h
 *    revoke window (≈ 500 mostly-Common chips, every one soulbound for days); the oracle carries over.
 *  - `maxTemplate`: highest template id a leaf may carry (`QUEST_CHIP_TEMPLATES.length − 1`, faucets.ts).
 *  - `perLeaf`: exactly ONE voucher per leaf — a wallet owed two chips gets the second in the next epoch
 *    (the leaf amount is the template id, so it cannot also be a count).
 * The chip itself is minted by chip_core's VRF pack flow (`open_voucher` → Switchboard → `open_pack`), so
 * free chips have no mint authority and the same on-chain audit trail as paid ones. Weekly per-wallet cap
 * (`ANTI_FARM.freeChipsPerWalletPerWeek`) is enforced by the oracle when it builds the batch.
 */
exports.CHIP_VOUCHER_REWARDS = { maxRootBudget: 500, maxTemplate: 3, perLeaf: 1 };
/**
 * Per-root ceiling in micro-SKR (100 000 SKR ≈ $1.7 k at $0.017). Bounds the
 * blast radius of a leaked oracle key to one root inside the 1 h revoke window.
 * Admin-tunable on-chain (`set_skr_pool`).
 */
exports.DEFAULT_MAX_SKR_ROOT_BUDGET_MICRO = 100_000 * exports.SKR_MICRO;
/**
 * Funding policy: what share of SKR REVENUE is routed to the prize pool.
 * OWNER DECISION (2026-09-15): 15 / 10 / 5 % (the design proposal was 25/25/15;
 * the owner chose a revenue-first setting — the studio keeps ≈ 86 % of SKR
 * revenue, give-back ≈ 14 % at baseline, see `skrPoolMonthlyFunding`).
 * Revenue lines:
 *  - packs paid in SKR: 100 % of the price is treasury revenue (no burn); 15 %
 *    of it goes back to players as SKR rewards.
 *  - marketplace fee on SKR listings, treasury part only (⅔ of the 7.5 % fee;
 *    the ⅓ buyback part still buys $CG — SKR rewards must not cannibalise the
 *    deflation lever): 10 %.
 *  - services paid in SKR: 5 % — cosmetics are the highest-margin line and were
 *    priced as pure revenue.
 * The pool share is a treasury policy, not a smart-contract rule: the treasury
 * wallet runs `fund_skr` weekly from the previous week's `sweep_vault` proceeds
 * (`npm run skr-pool -- plan …` prints the amount due). It is published here and
 * through `GET /rewards/skr-pool` (`funding.dueMicro` vs `fundedTotalMicro`) so
 * the community can audit funding against revenue. Changing it needs no redeploy.
 */
exports.SKR_POOL_FUNDING = {
    packRevenueShareBps: 1_500,
    marketFeeTreasuryShareBps: 1_000,
    servicesRevenueShareBps: 500,
    cadence: 'weekly, after sweep_vault',
};
/** Treasury part of a marketplace protocol fee after the buyback slice (mirrors `market::saleSplit`). */
const marketFeeTreasuryPartMicro = (feeMicro, buybackShareBps = tokenomics_ts_1.FEES.marketplaceFeeBuybackShareBps) => feeMicro - (feeMicro * BigInt(buybackShareBps)) / 10000n;
exports.marketFeeTreasuryPartMicro = marketFeeTreasuryPartMicro;
/**
 * What the treasury owes the pool for a given amount of REALISED SKR revenue
 * (micro-SKR, bigint — used by the backend ledger and the ops CLI). Realised =
 * packs fully opened (cancelled/pending purchases are refundable, not revenue),
 * settled sales, paid services.
 */
function skrPoolDueMicro(r, policy = exports.SKR_POOL_FUNDING) {
    const part = (v, bps) => (v * BigInt(bps)) / 10000n;
    const fromPacksMicro = part(r.packRevenueMicro, policy.packRevenueShareBps);
    const fromMarketMicro = part(r.marketFeeTreasuryMicro, policy.marketFeeTreasuryShareBps);
    const fromServicesMicro = part(r.servicesRevenueMicro, policy.servicesRevenueShareBps);
    return { fromPacksMicro, fromMarketMicro, fromServicesMicro, dueMicro: fromPacksMicro + fromMarketMicro + fromServicesMicro };
}
/**
 * How the weekly SKR pool budget is split between root kinds. Season-heavy on
 * purpose: SKR is the "competitive" currency — you win it, you don't grind it —
 * so most of it flows through the PvP ladder where the anti-farm rules are
 * strongest (rating, opponent caps, min duration).
 */
exports.SKR_POOL_SPLIT = {
    quests: 25, // weekly quest set "Seeker week": complete all weeklies → SKR
    season: 55, // top-N of each league at season end + weekly ladder snapshots
    events: 20, // tournaments, referral milestones, Seeker-device campaigns
};
/**
 * Anti-farm caps for SKR — stricter than $CG because SKR is liquid on DEXes
 * from day one (no soulbound window exists for a fungible token). All amounts
 * in whole SKR; the oracle enforces them BEFORE building a root.
 */
exports.SKR_ANTI_FARM = {
    /** a wallet can receive at most this much SKR from quest roots per week */
    weeklyQuestCapSkr: 25,
    /** per-season per-wallet cap across season + event roots */
    seasonCapSkr: 2_000,
    /** eligibility: ≥ 1 paid pack (any currency) AND account age ≥ 7 d — no SKR for pure free-riders */
    requiresPaidPack: true,
    minAccountAgeSec: 7 * 86_400,
    /** per-root cap (micro) — mirrored on-chain */
    maxRootBudgetMicro: exports.DEFAULT_MAX_SKR_ROOT_BUDGET_MICRO,
};
exports.BASELINE_SKR_ASSUMPTIONS = {
    packRevenueUsd: 110_000, // docs/02 §7.6 baseline, 5 000 DAU
    skrPackShare: 0.20, // Seeker is a meaningful but minority rail at launch
    marketVolumeUsd: 100_000, // ≈ $6–9 k/mo of fee at 7.5 %
    skrMarketShare: 0.15,
    servicesRevenueUsd: 10_000,
    skrServicesShare: 0.20,
    skrUsd: 0.0174,
};
function skrPoolMonthlyFunding(a) {
    const feeBps = a.marketFeeBps ?? 750;
    const treasuryShare = a.marketFeeTreasuryShare ?? 2 / 3;
    const packSkrUsd = a.packRevenueUsd * a.skrPackShare;
    const marketFeeTreasuryUsd = a.marketVolumeUsd * a.skrMarketShare * (feeBps / 10_000) * treasuryShare;
    const servicesSkrUsd = a.servicesRevenueUsd * a.skrServicesShare;
    const fromPacksUsd = packSkrUsd * (exports.SKR_POOL_FUNDING.packRevenueShareBps / 10_000);
    const fromMarketUsd = marketFeeTreasuryUsd * (exports.SKR_POOL_FUNDING.marketFeeTreasuryShareBps / 10_000);
    const fromServicesUsd = servicesSkrUsd * (exports.SKR_POOL_FUNDING.servicesRevenueShareBps / 10_000);
    const poolUsd = fromPacksUsd + fromMarketUsd + fromServicesUsd;
    const skrRevenueUsd = packSkrUsd + marketFeeTreasuryUsd + servicesSkrUsd;
    const poolSkr = poolUsd / a.skrUsd;
    return {
        skrRevenueUsd: Math.round(skrRevenueUsd),
        poolUsd: Math.round(poolUsd),
        poolSkr: Math.round(poolSkr),
        weeklyPoolSkr: Math.round(poolSkr / (365 / 12 / 7)),
        /** share of the studio's SKR revenue given back — must stay ≤ 30 % (revenue-first mandate) */
        giveBackShare: skrRevenueUsd > 0 ? +(poolUsd / skrRevenueUsd).toFixed(3) : 0,
        split: {
            questsSkr: Math.round((poolSkr * exports.SKR_POOL_SPLIT.quests) / 100),
            seasonSkr: Math.round((poolSkr * exports.SKR_POOL_SPLIT.season) / 100),
            eventsSkr: Math.round((poolSkr * exports.SKR_POOL_SPLIT.events) / 100),
        },
        breakdownUsd: { fromPacksUsd: Math.round(fromPacksUsd), fromMarketUsd: Math.round(fromMarketUsd), fromServicesUsd: Math.round(fromServicesUsd) },
    };
}
/**
 * Free-value impact: SKR rewards are paid out of REVENUE the studio already
 * booked, so they do not add supply to the $CG economy. They do add to the
 * "free value a non-payer can extract", which is why quest SKR requires a
 * paid pack (see SKR_ANTI_FARM). This helper converts the weekly per-wallet
 * quest cap to USD so `freeValueReport` consumers can add it if they model
 * a wallet that has bought ≥ 1 pack.
 */
const weeklySkrQuestCapUsd = (skrUsd = exports.BASELINE_SKR_ASSUMPTIONS.skrUsd) => exports.SKR_ANTI_FARM.weeklyQuestCapSkr * skrUsd;
exports.weeklySkrQuestCapUsd = weeklySkrQuestCapUsd;

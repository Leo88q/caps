"use strict";
// =============================================================================
// GUTTERCAPS economy — rarity ladder (single source of truth)
// -----------------------------------------------------------------------------
// Everything that depends on the 9-tier ladder (pack odds, fusion recipes,
// staking multipliers, PvP power, marketplace filters, site copy) imports
// from here. The on-chain program mirrors these numbers in
// programs/chip_core/src/economy.rs (`base_power` / `stake_weight` /
// `max_level`) — `npm run economy:check` asserts they agree, so the two can't
// drift silently. (Up to 2026-09-18 this comment named the v0.1 monolith, which
// the check never read.)
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.levelMult = exports.profile = exports.RARITY_PROFILES = exports.RARITY_ANCHOR_KEYS = exports.rarityIndex = exports.RARITIES = void 0;
exports.RARITIES = [
    'Common',
    'Common+',
    'Rare',
    'Rare+',
    'Epic',
    'Epic+',
    'Legend',
    'Legend+',
    'Diamond',
];
const rarityIndex = (r) => exports.RARITIES.indexOf(r);
exports.rarityIndex = rarityIndex;
/** Anchor enum variant names, in order — used by the client/indexer decoders. */
exports.RARITY_ANCHOR_KEYS = [
    'common', 'commonPlus', 'rare', 'rarePlus', 'epic', 'epicPlus', 'legend', 'legendPlus', 'diamond',
];
exports.RARITY_PROFILES = [
    { tier: 0, name: 'Common', valueMult: 1, basePower: 100, maxLevel: 12, stakeWeight: 1, vfxTier: 0, rim: 'zinc-scratched' },
    { tier: 1, name: 'Common+', valueMult: 2.7, basePower: 145, maxLevel: 16, stakeWeight: 2, vfxTier: 0, rim: 'zinc-wet' },
    { tier: 2, name: 'Rare', valueMult: 7.3, basePower: 210, maxLevel: 20, stakeWeight: 5, vfxTier: 1, rim: 'steel-polished' },
    { tier: 3, name: 'Rare+', valueMult: 19.7, basePower: 305, maxLevel: 24, stakeWeight: 12, vfxTier: 1, rim: 'steel-oilslick' },
    { tier: 4, name: 'Epic', valueMult: 53, basePower: 440, maxLevel: 28, stakeWeight: 30, vfxTier: 2, rim: 'enamel' },
    { tier: 5, name: 'Epic+', valueMult: 160, basePower: 640, maxLevel: 32, stakeWeight: 80, vfxTier: 2, rim: 'enamel-crackle' },
    { tier: 6, name: 'Legend', valueMult: 528, basePower: 930, maxLevel: 36, stakeWeight: 220, vfxTier: 3, rim: 'bronze-patina' },
    { tier: 7, name: 'Legend+', valueMult: 1850, basePower: 1350, maxLevel: 40, stakeWeight: 650, vfxTier: 3, rim: 'bronze-glow' },
    { tier: 8, name: 'Diamond', valueMult: 8300, basePower: 2000, maxLevel: 50, stakeWeight: 2200, vfxTier: 4, rim: 'prism-holo' },
];
const profile = (r) => typeof r === 'number' ? exports.RARITY_PROFILES[r] : exports.RARITY_PROFILES[(0, exports.rarityIndex)(r)];
exports.profile = profile;
/** Level multiplier shared by PvP power and staking weight: +2.5% per level above 1. */
const levelMult = (level) => 1 + 0.025 * Math.max(0, level - 1);
exports.levelMult = levelMult;

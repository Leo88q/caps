"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chipPower = exports.ELEMENT_ICON = exports.ELEMENT_OF_COLLECTION = exports.chipLore = exports.chipImageOf = exports.chipArtUrl = exports.chipName = exports.collectionSymbol = exports.collectionName = exports.collectionColor = exports.vfxTier = exports.rimClass = exports.rarityColor = exports.rarityName = exports.RARITY_COLOR = exports.RARITY_SHORT = exports.RARITY_PROFILES = exports.RARITIES = void 0;
exports.elementEdge = elementEdge;
exports.squadPower = squadPower;
exports.squadSynergy = squadSynergy;
// UI-side rarity helpers: names, colours (from the design tokens).
// Rarity reads through colour/labels — chips have no rings or glow around them.
const economy_1 = require("@guttercaps/economy");
Object.defineProperty(exports, "RARITIES", { enumerable: true, get: function () { return economy_1.RARITIES; } });
Object.defineProperty(exports, "RARITY_PROFILES", { enumerable: true, get: function () { return economy_1.RARITY_PROFILES; } });
const lore_1 = require("./lore");
exports.RARITY_SHORT = ['C', 'C+', 'R', 'R+', 'E', 'E+', 'L', 'L+', 'D'];
/** Glow / accent per tier — reuses the fixed palette (no new colours). */
exports.RARITY_COLOR = [
    '#8a8a8a', // Common — zinc
    '#16E5D9', // Common+ — cyan
    '#16E5D9', // Rare
    '#2E8BFF', // Rare+ (trust blue is money-only, never for chips — overridden below with a steel/oil-slick tone)
    '#FF2E8A', // Epic — magenta
    '#FF7A1A', // Epic+ — orange
    '#FF7A1A', // Legend
    '#B6FF3C', // Legend+ — acid
    '#D8D8DC', // Diamond — chrome/prism
];
// Rare+ must not use trust-blue (money-only). Override with a steel/oil-slick tone from the chrome family.
exports.RARITY_COLOR[3] = '#9AD9FF';
const rarityName = (r) => economy_1.RARITIES[r] ?? `T${r}`;
exports.rarityName = rarityName;
const rarityColor = (r) => exports.RARITY_COLOR[r] ?? exports.RARITY_COLOR[0];
exports.rarityColor = rarityColor;
// Kept for compatibility (CSS classes are no-ops now — no rings around chips).
const rimClass = (r) => `rim-${economy_1.RARITY_PROFILES[r]?.rim ?? 'zinc-scratched'}`;
exports.rimClass = rimClass;
const vfxTier = (r) => economy_1.RARITY_PROFILES[r]?.vfxTier ?? 0;
exports.vfxTier = vfxTier;
/** Collection colour tokens map to the real palette values (lore.ts uses site var names). */
const COLLECTION_HEX = {
    'var(--cyan)': '#16E5D9', 'var(--orange)': '#FF7A1A', 'var(--magenta)': '#FF2E8A', 'var(--trust)': '#9AD9FF', 'var(--acid)': '#B6FF3C',
};
const collectionColor = (idx) => COLLECTION_HEX[lore_1.COLLECTIONS[idx]?.color ?? ''] ?? '#D8D8DC';
exports.collectionColor = collectionColor;
const collectionName = (idx) => lore_1.COLLECTIONS[idx]?.name ?? `District ${idx + 1}`;
exports.collectionName = collectionName;
const collectionSymbol = (idx) => lore_1.COLLECTIONS[idx]?.symbol ?? `C${idx}`;
exports.collectionSymbol = collectionSymbol;
const chipName = (collectionIdx, rarity) => lore_1.COLLECTIONS[collectionIdx]?.caps[rarity]?.name ?? `${(0, exports.collectionName)(collectionIdx)} ${(0, exports.rarityName)(rarity)}`;
exports.chipName = chipName;
/** Deterministic local master for an archetype — the same files the Codex shows
 *  (`client/public/art/{district}-{rarity}-{256,512}.webp`, all 72 exist).
 *  256 for small tiles (up to ~150 px on screen), 512 for hero displays. */
const chipArtUrl = (collectionIdx, rarity, size = 256) => `/art/${lore_1.COLLECTIONS[collectionIdx]?.num ?? '01'}-${rarity}-${size}.webp`;
exports.chipArtUrl = chipArtUrl;
/** Real art for a chip object: indexer URL first, local master as fallback. */
const chipImageOf = (c, size = 256) => c.art?.image || (0, exports.chipArtUrl)(c.collection ?? 0, c.rarity ?? 0, size);
exports.chipImageOf = chipImageOf;
const chipLore = (collectionIdx, rarity) => lore_1.COLLECTIONS[collectionIdx]?.caps[rarity]?.desc ?? '';
exports.chipLore = chipLore;
exports.ELEMENT_OF_COLLECTION = ['shadow', 'wheels', 'steel', 'wheels', 'noise', 'shadow', 'noise', 'wheels', 'paint', 'paint'];
exports.ELEMENT_ICON = { paint: '🎨', steel: '⚙️', wheels: '🛞', noise: '🔊', shadow: '🌑' };
/** ring: paint > steel > wheels > noise > shadow > paint */
const RING = ['paint', 'steel', 'wheels', 'noise', 'shadow'];
function elementEdge(a, b) {
    if (a === b)
        return 0;
    const ia = RING.indexOf(a), ib = RING.indexOf(b);
    if ((ia + 1) % 5 === ib)
        return 0.15;
    if ((ib + 1) % 5 === ia)
        return -0.13;
    return 0;
}
const chipPower = (rarity, level) => Math.round((economy_1.RARITY_PROFILES[rarity]?.basePower ?? 0) * (0, economy_1.levelMult)(level));
exports.chipPower = chipPower;
function squadPower(chips) {
    return chips.reduce((s, c) => s + (0, exports.chipPower)(c.rarity, c.level), 0);
}
function squadSynergy(chips) {
    const els = chips.map((c) => exports.ELEMENT_OF_COLLECTION[c.collection]);
    let pairs = 0;
    for (let i = 0; i < els.length; i++)
        for (let j = i + 1; j < els.length; j++)
            if (els[i] === els[j])
                pairs++;
    return 1 + 0.08 * pairs;
}

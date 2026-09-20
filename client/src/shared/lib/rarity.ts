// UI-side rarity helpers: names, colours (from the design tokens).
// Rarity reads through colour/labels — chips have no rings or glow around them.
import { RARITIES, RARITY_PROFILES, levelMult, type RarityIndex } from '@guttercaps/economy';
import { COLLECTIONS } from './lore';

export { RARITIES, RARITY_PROFILES };
export type { RarityIndex };

export const RARITY_SHORT = ['C', 'C+', 'R', 'R+', 'E', 'E+', 'L', 'L+', 'D'] as const;

/** Glow / accent per tier — reuses the fixed palette (no new colours). */
export const RARITY_COLOR = [
  '#8a8a8a',  // Common — zinc
  '#16E5D9',  // Common+ — cyan
  '#16E5D9',  // Rare
  '#2E8BFF',  // Rare+ (trust blue is money-only, never for chips — overridden below with a steel/oil-slick tone)
  '#FF2E8A',  // Epic — magenta
  '#FF7A1A',  // Epic+ — orange
  '#FF7A1A',  // Legend
  '#B6FF3C',  // Legend+ — acid
  '#D8D8DC',  // Diamond — chrome/prism
] as const;

// Rare+ must not use trust-blue (money-only). Override with a steel/oil-slick tone from the chrome family.
(RARITY_COLOR as unknown as string[])[3] = '#9AD9FF';

export const rarityName = (r: number) => RARITIES[r] ?? `T${r}`;
export const rarityColor = (r: number) => RARITY_COLOR[r] ?? RARITY_COLOR[0];
// Kept for compatibility (CSS classes are no-ops now — no rings around chips).
export const rimClass = (r: number) => `rim-${RARITY_PROFILES[r]?.rim ?? 'zinc-scratched'}`;
export const vfxTier = (r: number) => RARITY_PROFILES[r]?.vfxTier ?? 0;

/** Collection colour tokens map to the real palette values (lore.ts uses site var names). */
const COLLECTION_HEX: Record<string, string> = {
  'var(--cyan)': '#16E5D9', 'var(--orange)': '#FF7A1A', 'var(--magenta)': '#FF2E8A', 'var(--trust)': '#9AD9FF', 'var(--acid)': '#B6FF3C',
};
export const collectionColor = (idx: number) => COLLECTION_HEX[COLLECTIONS[idx]?.color ?? ''] ?? '#D8D8DC';
export const collectionName = (idx: number) => COLLECTIONS[idx]?.name ?? `District ${idx + 1}`;
export const collectionSymbol = (idx: number) => COLLECTIONS[idx]?.symbol ?? `C${idx}`;
export const chipName = (collectionIdx: number, rarity: number) => COLLECTIONS[collectionIdx]?.caps[rarity]?.name ?? `${collectionName(collectionIdx)} ${rarityName(rarity)}`;

/** Deterministic local master for an archetype — the same files the Codex shows
 *  (`client/public/art/{district}-{rarity}-{256,512}.webp`, all 72 exist).
 *  256 for small tiles (up to ~150 px on screen), 512 for hero displays. */
export const chipArtUrl = (collectionIdx: number, rarity: number, size: 256 | 512 = 256) =>
  `/art/${COLLECTIONS[collectionIdx]?.num ?? '01'}-${rarity}-${size}.webp`;

/** Real art for a chip object: indexer URL first, local master as fallback. */
export const chipImageOf = (
  c: { collection?: number | null; rarity?: number | null; art?: { image?: string | null } | null },
  size: 256 | 512 = 256,
) => c.art?.image || chipArtUrl(c.collection ?? 0, c.rarity ?? 0, size);
export const chipLore = (collectionIdx: number, rarity: number) => COLLECTIONS[collectionIdx]?.caps[rarity]?.desc ?? '';

export const ELEMENT_OF_COLLECTION = ['shadow', 'wheels', 'steel', 'wheels', 'noise', 'shadow', 'noise', 'wheels', 'paint', 'paint'] as const;
export type Element = (typeof ELEMENT_OF_COLLECTION)[number];
export const ELEMENT_ICON: Record<Element, string> = { paint: '🎨', steel: '⚙️', wheels: '🛞', noise: '🔊', shadow: '🌑' };
/** ring: paint > steel > wheels > noise > shadow > paint */
const RING: Element[] = ['paint', 'steel', 'wheels', 'noise', 'shadow'];
export function elementEdge(a: Element, b: Element): number {
  if (a === b) return 0;
  const ia = RING.indexOf(a), ib = RING.indexOf(b);
  if ((ia + 1) % 5 === ib) return 0.15;
  if ((ib + 1) % 5 === ia) return -0.13;
  return 0;
}

export const chipPower = (rarity: number, level: number) => Math.round((RARITY_PROFILES[rarity]?.basePower ?? 0) * levelMult(level));
export function squadPower(chips: { rarity: number; level: number }[]): number {
  return chips.reduce((s, c) => s + chipPower(c.rarity, c.level), 0);
}
export function squadSynergy(chips: { collection: number }[]): number {
  const els = chips.map((c) => ELEMENT_OF_COLLECTION[c.collection]);
  let pairs = 0;
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) if (els[i] === els[j]) pairs++;
  return 1 + 0.08 * pairs;
}

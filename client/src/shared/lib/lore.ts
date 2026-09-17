// Re-export of the canonical lore in `@guttercaps/economy` (see
// packages/economy/src/lore.ts). Kept at this path because the client, the localnet
// specs and scripts/setup.ts all import `@/shared/lib/lore`; the data itself is shared
// with the backend API so the on-chain collection, the game UI and the landing page
// cannot drift apart.
export {
  COLLECTIONS, RARITY_ORDER, chipNameFor, findCollectionBySymbol,
  type ChipLore, type CollectionLore,
} from '@guttercaps/economy';

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findCollectionBySymbol = exports.chipNameFor = exports.RARITY_ORDER = exports.COLLECTIONS = void 0;
// Re-export of the canonical lore in `@guttercaps/economy` (see
// packages/economy/src/lore.ts). Kept at this path because the client, the localnet
// specs and scripts/setup.ts all import `@/shared/lib/lore`; the data itself is shared
// with the backend API so the on-chain collection, the game UI and the landing page
// cannot drift apart.
var economy_1 = require("@guttercaps/economy");
Object.defineProperty(exports, "COLLECTIONS", { enumerable: true, get: function () { return economy_1.COLLECTIONS; } });
Object.defineProperty(exports, "RARITY_ORDER", { enumerable: true, get: function () { return economy_1.RARITY_ORDER; } });
Object.defineProperty(exports, "chipNameFor", { enumerable: true, get: function () { return economy_1.chipNameFor; } });
Object.defineProperty(exports, "findCollectionBySymbol", { enumerable: true, get: function () { return economy_1.findCollectionBySymbol; } });

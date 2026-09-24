"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SKUS = exports.iso = exports.CURRENCY_SYMBOL = void 0;
exports.priceStatus = priceStatus;
exports.toUsd = toUsd;
exports.chipToApi = chipToApi;
exports.myChips = myChips;
exports.myGrid = myGrid;
exports.walletProfile = walletProfile;
exports.me = me;
exports.activity = activity;
exports.packCatalogue = packCatalogue;
exports.packOpen = packOpen;
exports.listings = listings;
exports.floor = floor;
exports.history = history;
exports.chipArchetype = chipArchetype;
exports.chipDetail = chipDetail;
exports.collections = collections;
exports.leaderboard = leaderboard;
exports.pauseStatus = pauseStatus;
exports.stats = stats;
exports.skrPool = skrPool;
exports.skrRevenue = skrRevenue;
exports.walletEvents = walletEvents;
exports.crankStatus = crankStatus;
// Read-model queries behind the REST routes. Everything here is a plain SQL
// projection over the tables in db.ts; nothing touches the chain.
const economy_1 = require("@guttercaps/economy");
const db_ts_1 = require("./db.ts");
const services_ts_1 = require("./services.ts");
const human_ts_1 = require("./human.ts");
const sql_ts_1 = require("./sql.ts");
/** Oracle cache health for /health and /prices — what the pusher last posted and how old it is now. */
function priceStatus(db) {
    const rows = db.all(`SELECT * FROM oracle_prices`);
    const t = (0, db_ts_1.now)();
    const feeds = Object.fromEntries(rows.map((r) => {
        const ageS = r.publish_time === null ? null : t - r.publish_time;
        return [r.symbol, { usd: r.usd, account: r.account, publishTime: (0, exports.iso)(r.publish_time), ageS, confBps: r.conf_bps, cachedAt: (0, exports.iso)(r.updated_at), healthy: ageS !== null && ageS <= economy_1.PYTH_PUSHER.alertAgeS }];
    }));
    return { maxAgeS: economy_1.PYTH_MAX_AGE_SECS, alertAgeS: economy_1.PYTH_PUSHER.alertAgeS, feeds };
}
exports.CURRENCY_SYMBOL = ['SOL', 'USDC', 'CG', 'SKR'];
const iso = (s) => (s === null || s === undefined ? null : new Date(s * 1000).toISOString());
exports.iso = iso;
exports.SKUS = ['starter', 'standard', 'premium', 'limited'];
/** USD value of an on-chain amount in `currency` base units (SOL lamports, USDC/CG/SKR micro). */
function toUsd(amount, currency, px) {
    const n = Number(amount);
    switch (currency) {
        case 0: return (n / 1e9) * px.solUsd;
        case 1: return n / 1e6;
        case 2: return n / 1e6 / 100; // 1 $CG ≙ 1 ¢ reference price for display only
        case 3: return (n / 1e6) * px.skrUsd;
        default: return 0;
    }
}
function chipToApi(r) {
    const p = economy_1.RARITY_PROFILES[r.rarity];
    const lm = (0, economy_1.levelMult)(r.level);
    return {
        asset: r.asset,
        owner: r.owner,
        collection: r.collection_idx,
        rarity: r.rarity,
        level: r.level,
        index: 0,
        flags: { staked: (r.flags & 1) !== 0, listed: (r.flags & 2) !== 0, fusing: (r.flags & 4) !== 0, soulbound: (r.flags & 8) !== 0 },
        lockUntil: r.lock_until > 0 ? (0, exports.iso)(r.lock_until) : null,
        skin: r.skin ?? null,
        power: Math.round(p.basePower * lm),
        stakeWeight: String(Math.round(p.stakeWeight * lm * 1000)),
    };
}
function myChips(db, wallet, q) {
    const where = ['owner = ?', 'burned_at IS NULL'];
    const params = [wallet];
    if (q.collection !== undefined) {
        where.push('collection_idx = ?');
        params.push(q.collection);
    }
    if (q.rarity !== undefined) {
        where.push('rarity = ?');
        params.push(q.rarity);
    }
    const t = (0, db_ts_1.now)();
    switch (q.status) {
        case 'free':
            where.push('(flags & 7) = 0 AND lock_until <= ?');
            params.push(t);
            break;
        case 'staked':
            where.push('(flags & 1) != 0');
            break;
        case 'listed':
            where.push('(flags & 2) != 0');
            break;
        case 'fusing':
            where.push('(flags & 4) != 0');
            break;
        case 'locked':
            where.push('lock_until > ?');
            params.push(t);
            break;
    }
    const limit = Math.min(q.limit ?? 200, 500);
    const offset = q.cursor ? Number(q.cursor) || 0 : 0;
    const total = db.scalar(`SELECT COUNT(*) FROM chips WHERE ${where.join(' AND ')}`, ...params);
    const rows = db.all(`SELECT * FROM chips WHERE ${where.join(' AND ')} ORDER BY rarity DESC, level DESC, minted_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    return { items: rows.map(chipToApi), nextCursor: offset + rows.length < total ? String(offset + rows.length) : null, total };
}
/**
 * N × 9 ownership grid (N = live collection count from lore). `maxSlot` (quest settlement passes the finalized horizon) only counts chips
 * whose last state change is finalized — conservative: a chip minted / bought / re-flagged in the
 * last minute is left out, so a set can be credited a pass later but never on a forked-away mint.
 */
function myGrid(db, wallet, maxSlot = Number.MAX_SAFE_INTEGER) {
    const cells = Array.from({ length: economy_1.COLLECTIONS.length }, () => Array(9).fill(0));
    for (const r of db.all(`SELECT collection_idx, rarity, COUNT(*) n FROM chips WHERE owner = ? AND burned_at IS NULL AND updated_slot <= ? GROUP BY collection_idx, rarity`, wallet, maxSlot)) {
        if (cells[r.collection_idx])
            cells[r.collection_idx][r.rarity] = r.n;
    }
    const completedSets = cells.filter((row) => row.every((n) => n > 0)).length;
    const missingForSet = cells
        .map((row, collection) => ({ collection, rarities: row.map((n, r) => (n === 0 ? r : -1)).filter((r) => r >= 0) }))
        .filter((m) => m.rarities.length > 0 && m.rarities.length <= 3);
    return { cells, completedSets, missingForSet };
}
function walletProfile(db, wallet) {
    const w = db.get(`SELECT address, handle, first_seen, country FROM wallets WHERE address = ?`, wallet);
    return { address: wallet, handle: w?.handle ?? undefined, firstSeen: (0, exports.iso)(w?.first_seen) ?? undefined, country: w?.country ?? undefined };
}
function me(db, wallet, geo) {
    const profile = walletProfile(db, wallet);
    const grid = myGrid(db, wallet);
    const boughtToday = exports.SKUS.map((_, sku) => db.scalar(`SELECT COALESCE(SUM(qty),0) FROM pack_purchases WHERE buyer = ? AND sku = ? AND COALESCE(block_time, ?) >= ?`, wallet, sku, (0, db_ts_1.now)(), (0, db_ts_1.now)() - 86_400));
    const counters = exports.SKUS.map((_, sku) => db.get(`SELECT pity_after FROM pack_opens WHERE buyer = ? AND sku = ? ORDER BY slot DESC LIMIT 1`, wallet, sku)?.pity_after ?? 0);
    const toGuarantee = exports.SKUS.map((id, sku) => { const p = economy_1.PACKS[id].pity; return p ? Math.max(0, p.hardAt - counters[sku]) : 0; });
    const starterClaimed = db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND sku = 0`, wallet) > 0;
    const hasPaidPack = db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND sku > 0`, wallet) > 0;
    const ageH = profile.firstSeen ? Math.floor((Date.now() - Date.parse(profile.firstSeen)) / 3_600_000) : 0;
    let ops = {};
    try {
        ops = JSON.parse(db.get(`SELECT flags FROM wallets WHERE address = ?`, wallet)?.flags ?? '{}');
    }
    catch { /* ignore */ }
    const device = (0, human_ts_1.deviceStatus)(db, wallet);
    return {
        ...profile,
        balances: { lamports: '0', usdc: '0', cg: '0', skr: '0' }, // live balances come from the wallet; the API only knows chain events
        pity: { counters, toGuarantee, boughtToday, starterClaimed },
        boosters: 0,
        flags: { rewardsPaused: ops.rewardsPaused === true, geoRestricted: geo?.restricted === true, accountAgeH: ageH, hasPaidPack, deviceLimited: device.limited && ops.trusted !== true },
        human: (0, human_ts_1.humanStatus)(db, wallet), // T-B-49: Turnstile pass state + site key for the widget
        completedSets: grid.completedSets,
    };
}
/** the payload keys an activity row can be "about" — one list, so the OR-branch cannot drift per dialect */
const ACTIVITY_OWNER_KEYS = ['buyer', 'owner', 'seller', 'winner', 'wallet'];
function activity(db, wallet, limit = 50, cursor) {
    const offset = cursor ? Number(cursor) || 0 : 0;
    const rows = db.all(`SELECT name, signature, block_time, data, program FROM events_raw
     WHERE name IN ('PackOpened','ChipFused','CompressedClaimsFused','ClaimFusionRevealed','ChipListed','ChipSold','BattleResolved','Claimed','RootClaimed','Staked','Unstaked','ServicePaid')
       AND (${ACTIVITY_OWNER_KEYS.map((k) => `${(0, sql_ts_1.jsonAt)('data', k)} = ?`).join(' OR ')})
     ORDER BY slot DESC, id DESC LIMIT ? OFFSET ?`, wallet, wallet, wallet, wallet, wallet, limit + 1, offset);
    const KIND = { PackOpened: 'pack_opened', ChipFused: 'fused', CompressedClaimsFused: 'fused', ClaimFusionRevealed: 'fused', ChipListed: 'listed', ChipSold: 'sold', BattleResolved: 'match_won', Claimed: 'claimed', RootClaimed: 'claimed', Staked: 'staked', Unstaked: 'unstaked', ServicePaid: 'service' };
    const items = rows.slice(0, limit).map((r) => {
        const d = JSON.parse(r.data);
        let kind = KIND[r.name] ?? r.name;
        if (r.name === 'ChipSold' && d.buyer === wallet)
            kind = 'bought';
        return { kind, signature: r.signature, blockTime: (0, exports.iso)(r.block_time) ?? new Date().toISOString(), payload: d };
    });
    return { items, nextCursor: rows.length > limit ? String(offset + limit) : null };
}
// ---------------------------------------------------------------- packs
function packCatalogue(db) {
    const featured = 4;
    return {
        packs: exports.SKUS.map((id, sku) => {
            const p = economy_1.PACKS[id];
            const ev = (((0, economy_1.packExpectedValueMult)(p) * 3.5 * 0.62) / (p.priceUsdCents / 100)) * 100;
            return {
                sku, name: p.name, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: p.priceCgMicro === null ? null : String(p.priceCgMicro),
                currencies: p.priceCgMicro ? ['SOL', 'USDC', 'CG', 'SKR'] : ['SOL', 'USDC', 'SKR'], oddsBps: [...p.oddsBps], floor: p.floor, dailyCap: p.dailyCap,
                pity: p.pity ? { ...p.pity } : null, pool: p.pool, enabled: true, pAtLeastLegend: (0, economy_1.probabilityAtLeast)(p, 6), evPct: Number(ev.toFixed(1)),
            };
        }),
        featuredCollection: featured,
        bundles: economy_1.BUNDLES.map((b) => ({ ...b })),
        // live counters — useful for the shop's "opened today" ticker
        opened24h: db.scalar(`SELECT COUNT(*) FROM pack_opens WHERE COALESCE(block_time, 0) >= ?`, (0, db_ts_1.now)() - 86_400),
    };
}
function packOpen(db, signature) {
    const r = db.get(`SELECT * FROM pack_opens WHERE signature = ?`, signature);
    if (!r)
        return undefined;
    const assets = JSON.parse(r.assets);
    const chips = assets.map((a) => db.get(`SELECT * FROM chips WHERE asset = ?`, a)).filter((c) => !!c).map(chipToApi);
    const rarities = JSON.parse(r.rarities);
    const collections = JSON.parse(r.collections);
    const owned = db.all(`SELECT collection_idx, rarity, COUNT(*) n FROM chips WHERE owner = ? AND burned_at IS NULL GROUP BY collection_idx, rarity`, r.buyer);
    const newForSet = collections.filter((c, i) => (owned.find((o) => o.collection_idx === c && o.rarity === rarities[i])?.n ?? 0) === 1);
    // (#28) a quest chip voucher opens as "sku 0" but rolls its TEMPLATE odds with no floor / pity — the verifier must show those
    const voucher = r.sku === 0 ? db.get(`SELECT template FROM vouchers WHERE wallet = ? AND nonce = ?`, r.buyer, r.nonce) : undefined;
    const template = voucher ? economy_1.QUEST_CHIP_TEMPLATES[voucher.template] : undefined;
    return {
        signature: r.signature, sku: r.sku, chips, rollHex: r.roll_hex, pityBefore: r.pity_before, pityAfter: r.pity_after,
        highlights: { bestRarity: Math.max(...rarities), newForSet: [...new Set(newForSet)], completedSet: null },
        onChain: rarities.map((rarity, i) => ({ rarity, collection: collections[i] })),
        effectiveOddsBps: template ? [...template.odds] : (0, economy_1.effectiveOdds)(economy_1.PACKS[exports.SKUS[r.sku]], r.pity_before),
        voucher: voucher ? { template: voucher.template, odds: template ? [...template.odds] : null, soulboundDays: template?.soulboundDays ?? null } : null,
    };
}
// ---------------------------------------------------------------- market
function listings(db, q) {
    const px = (0, services_ts_1.prices)(db);
    const where = ['c.burned_at IS NULL'];
    const params = [];
    if (q.collection) {
        where.push('c.collection_idx = ?');
        params.push(Number(q.collection));
    }
    if (q.rarity) {
        where.push('c.rarity = ?');
        params.push(Number(q.rarity));
    }
    if (q.rarityMin) {
        where.push('c.rarity >= ?');
        params.push(Number(q.rarityMin));
    }
    if (q.levelMin) {
        where.push('c.level >= ?');
        params.push(Number(q.levelMin));
    }
    if (q.currency) {
        const code = exports.CURRENCY_SYMBOL.indexOf(q.currency);
        if (code >= 0) {
            where.push('l.currency = ?');
            params.push(code);
        }
    }
    const rows = db.all(`SELECT c.*, l.seller, l.price, l.currency, l.created_at FROM listings l JOIN chips c ON c.asset = l.asset WHERE ${where.join(' AND ')}`, ...params);
    let items = rows.map((r) => ({ asset: r.asset, seller: r.seller, price: r.price, currency: exports.CURRENCY_SYMBOL[r.currency] ?? 'SOL', priceUsd: Number(toUsd(r.price, r.currency, px).toFixed(2)), createdAt: (0, exports.iso)(r.created_at) ?? new Date().toISOString(), chip: chipToApi(r) }));
    if (q.priceMaxUsd)
        items = items.filter((i) => i.priceUsd <= Number(q.priceMaxUsd));
    const sort = q.sort ?? 'price_asc';
    items.sort((a, b) => sort === 'price_desc' ? b.priceUsd - a.priceUsd
        : sort === 'rarity_desc' ? b.chip.rarity - a.chip.rarity || a.priceUsd - b.priceUsd
            : sort === 'newest' ? b.createdAt.localeCompare(a.createdAt)
                : a.priceUsd - b.priceUsd);
    const offset = q.cursor ? Number(q.cursor) || 0 : 0;
    const limit = Math.min(Number(q.limit) || 60, 200);
    const page = items.slice(offset, offset + limit);
    return { items: page, nextCursor: offset + limit < items.length ? String(offset + limit) : null, total: items.length };
}
function floor(db) {
    const px = (0, services_ts_1.prices)(db);
    const floors = Array.from({ length: economy_1.COLLECTIONS.length }, () => Array(9).fill(null));
    const listedCount = Array.from({ length: economy_1.COLLECTIONS.length }, () => Array(9).fill(0));
    const rows = db.all(`SELECT c.collection_idx, c.rarity, l.price, l.currency FROM listings l JOIN chips c ON c.asset = l.asset WHERE c.burned_at IS NULL`);
    for (const r of rows) {
        const usd = toUsd(r.price, r.currency, px);
        const cur = floors[r.collection_idx]?.[r.rarity];
        if (floors[r.collection_idx]) {
            floors[r.collection_idx][r.rarity] = cur === null || cur === undefined ? Number(usd.toFixed(2)) : Math.min(cur, Number(usd.toFixed(2)));
            listedCount[r.collection_idx][r.rarity]++;
        }
    }
    const sales = db.all(`SELECT price, currency FROM sales WHERE COALESCE(block_time, 0) >= ?`, (0, db_ts_1.now)() - 86_400);
    const volume24hUsd = Number(sales.reduce((s, r) => s + toUsd(r.price, r.currency, px), 0).toFixed(2));
    return { asOf: new Date().toISOString(), solUsd: px.solUsd, skrUsd: px.skrUsd, floors, listedCount, volume24hUsd };
}
function history(db, q) {
    const px = (0, services_ts_1.prices)(db);
    const where = ['1=1'];
    const params = [];
    if (q.asset) {
        where.push('asset = ?');
        params.push(q.asset);
    }
    if (q.collection) {
        where.push('collection_idx = ?');
        params.push(Number(q.collection));
    }
    if (q.rarity) {
        where.push('rarity = ?');
        params.push(Number(q.rarity));
    }
    const offset = q.cursor ? Number(q.cursor) || 0 : 0;
    const rows = db.all(`SELECT * FROM sales WHERE ${where.join(' AND ')} ORDER BY slot DESC LIMIT 51 OFFSET ?`, ...params, offset);
    return {
        items: rows.slice(0, 50).map((r) => ({ asset: r.asset, seller: r.seller, buyer: r.buyer, price: r.price, currency: exports.CURRENCY_SYMBOL[r.currency] ?? 'SOL', priceUsd: Number(toUsd(r.price, r.currency, px).toFixed(2)), fee: r.fee, royalty: r.royalty, signature: r.signature, blockTime: (0, exports.iso)(r.block_time) ?? new Date().toISOString(), rarity: r.rarity ?? undefined })),
        nextCursor: rows.length > 50 ? String(offset + 50) : null,
    };
}
/** The N × 9 archetype page (lore + live supply/floor/listed/recent sales) — `GET /collections/{idx}/chips/{rarity}`. */
function chipArchetype(db, collection, rarity, salesLimit = 12) {
    if (!Number.isInteger(collection) || collection < 0 || collection >= economy_1.COLLECTIONS.length)
        return undefined;
    if (!Number.isInteger(rarity) || rarity < 0 || rarity >= economy_1.RARITY_PROFILES.length)
        return undefined;
    const c = economy_1.COLLECTIONS[collection];
    const p = economy_1.RARITY_PROFILES[rarity];
    const supply = db.scalar(`SELECT COUNT(*) FROM chips WHERE collection_idx = ? AND rarity = ? AND burned_at IS NULL`, collection, rarity);
    const listed = db.scalar(`SELECT COUNT(*) FROM listings l JOIN chips c ON c.asset = l.asset WHERE c.collection_idx = ? AND c.rarity = ?`, collection, rarity);
    const fl = floor(db).floors[collection]?.[rarity] ?? null;
    const sales = history(db, { collection: String(collection), rarity: String(rarity) }).items.slice(0, salesLimit);
    return {
        collection, rarity, name: c.caps[rarity].name, lore: c.caps[rarity].desc, symbol: c.symbol,
        district: c.district, rim: p.rim, supply, floorUsd: fl, listed, basePower: p.basePower, maxLevel: p.maxLevel, sales,
    };
}
function chipDetail(db, asset) {
    const r = db.get(`SELECT * FROM chips WHERE asset = ?`, asset);
    if (!r)
        return undefined;
    const px = (0, services_ts_1.prices)(db);
    const listing = db.get(`SELECT seller, price, currency, created_at FROM listings WHERE asset = ?`, asset);
    const sales = history(db, { asset }).items;
    const open = (r.origin === 'pack' || r.origin === 'voucher') && r.origin_signature ? db.get(`SELECT roll_hex FROM pack_opens WHERE signature = ?`, r.origin_signature) : undefined;
    const fusion = r.origin === 'fusion' && r.origin_signature ? db.get(`SELECT recipe FROM fusions WHERE signature = ? AND result = ?`, r.origin_signature, asset) : undefined;
    return {
        ...chipToApi(r),
        burned: r.burned_at !== null,
        listing: listing ? { asset, seller: listing.seller, price: listing.price, currency: exports.CURRENCY_SYMBOL[listing.currency], priceUsd: Number(toUsd(listing.price, listing.currency, px).toFixed(2)), createdAt: (0, exports.iso)(listing.created_at) } : null,
        provenance: { origin: r.origin, signature: r.origin_signature ?? '', rollHex: open?.roll_hex ?? '', recipe: fusion?.recipe ?? undefined },
        sales,
        archetype: chipArchetype(db, r.collection_idx, r.rarity, 4),
    };
}
function collections(db) {
    const minted = db.all(`SELECT collection_idx, rarity, COUNT(*) n FROM chips WHERE burned_at IS NULL GROUP BY collection_idx, rarity`);
    const fl = floor(db).floors;
    return Array.from({ length: economy_1.COLLECTIONS.length }, (_, idx) => {
        const byR = Array(9).fill(0);
        for (const m of minted)
            if (m.collection_idx === idx)
                byR[m.rarity] = m.n;
        const lore = economy_1.COLLECTIONS[idx];
        return { idx, symbol: lore.symbol, name: lore.name, district: lore.district, theme: lore.theme, minted: byR.reduce((a, b) => a + b, 0), mintedByRarity: byR, floors: fl[idx], featured: idx === 4 };
    });
}
// ---------------------------------------------------------------- leaderboards
/**
 * Public boards. `rating` is the arena's Glicko-lite ladder for one season (default: the season open
 * right now — docs/02 §4.4; `seasons` rows are created lazily by arena.currentSeason, so before the
 * first match the board is simply empty); `wins` counts chain-verified wager-battle wins (arena
 * program `BattleResolved`); the rest are inventory / staking / fusion projections.
 * Shadow-banned wallets (ops flag, antifraud.ts) are hidden from every board, but `me` is still
 * computed for them as if they were listed — a shadow ban must not be observable from the inside.
 */
function leaderboard(db, board, limit = 50, cursor, meWallet, season) {
    const offset = cursor ? Number(cursor) || 0 : 0;
    let sql;
    let seasonId = 0;
    const params = [];
    switch (board) {
        case 'rating': { // arena season rating (server ladder: ratings table, games > 0)
            const t = (0, db_ts_1.now)();
            seasonId = season ?? db.get(`SELECT id FROM seasons WHERE starts_at <= ? AND ends_at > ? ORDER BY id DESC LIMIT 1`, t, t)?.id ?? 0;
            sql = `SELECT wallet, ROUND(rating) AS value, league FROM ratings WHERE season = ? AND games > 0`;
            params.push(seasonId);
            break;
        }
        case 'wins': // wager-battle wins the chain saw (escrowed $CG fights, any season)
            sql = `SELECT winner AS wallet, COUNT(*) AS value, 0 AS league FROM battles WHERE status = 'resolved' AND winner IS NOT NULL GROUP BY winner`;
            break;
        case 'collection': // distinct (collection, rarity) archetypes owned, out of 90
            sql = `SELECT owner AS wallet, COUNT(DISTINCT collection_idx * 16 + rarity) AS value, 0 AS league FROM chips WHERE burned_at IS NULL GROUP BY owner`;
            break;
        case 'staking': // active stake weight
            sql = `SELECT owner AS wallet, SUM(CAST(weight AS REAL)) AS value, 0 AS league FROM stakes WHERE active = 1 GROUP BY owner`;
            break;
        case 'fusion':
            sql = `SELECT owner AS wallet, COUNT(*) AS value, 0 AS league FROM fusions WHERE success = 1 GROUP BY owner`;
            break;
        default: throw new Error('unknown board');
    }
    const visible = `SELECT t.wallet, t.value, t.league, w.handle FROM (${sql}) t LEFT JOIN wallets w ON w.address = t.wallet WHERE ${(0, sql_ts_1.jsonFlagEq)('w.flags', 'shadowBanned', false)}`;
    const rows = db.all(`${visible} ORDER BY t.value DESC, t.wallet ASC LIMIT ? OFFSET ?`, ...params, limit + 1, offset);
    const items = rows.slice(0, limit).map((r, i) => ({ rank: offset + i + 1, wallet: r.wallet, handle: r.handle ?? '', value: Number(r.value), league: r.league, avatar: '' }));
    let me = null;
    if (meWallet) {
        const mine = db.get(`SELECT value FROM (${sql}) WHERE wallet = ?`, ...params, meWallet);
        if (mine) {
            // rank = 1 + visible rows ordered before me (same order as the list; a hidden wallet ranks as if it were listed)
            const above = db.scalar(`SELECT COUNT(*) FROM (${visible}) v WHERE v.value > ? OR (v.value = ? AND v.wallet < ?)`, ...params, mine.value, mine.value, meWallet);
            me = { rank: above + 1, value: Number(mine.value) };
        }
    }
    return { board, season: seasonId, me, items, nextCursor: rows.length > limit ? String(offset + limit) : null };
}
// ---------------------------------------------------------------- stats (legacy /stats, kept for the landing page)
/** Latest known pause state per program from the PauseChanged audit trail (SEC-H2). */
function pauseStatus(db) {
    const out = { chip_core: null, staking: null, arena: null };
    for (const r of db.all(`SELECT program, by_wallet, paused, slot, block_time FROM pause_changes p WHERE slot = (SELECT MAX(slot) FROM pause_changes WHERE program = p.program)`))
        out[r.program] = { paused: r.paused === 1, by: r.by_wallet, slot: r.slot, blockTime: r.block_time };
    return out;
}
function stats(db) {
    return {
        chipsMinted: db.scalar(`SELECT COUNT(*) FROM chips`),
        chipsAlive: db.scalar(`SELECT COUNT(*) FROM chips WHERE burned_at IS NULL`),
        packsOpened: db.scalar(`SELECT COUNT(*) FROM pack_opens`),
        activeWallets: db.scalar(`SELECT COUNT(DISTINCT buyer) FROM pack_opens`),
        chipsCurrentlyStaked: db.scalar(`SELECT COUNT(*) FROM stakes WHERE kind = 1 AND active = 1`),
        tokenStakedMicro: String(db.all(`SELECT amount FROM stakes WHERE kind = 0 AND active = 1`).reduce((s, r) => s + BigInt(r.amount), 0n)),
        totalBattlesResolved: db.scalar(`SELECT COUNT(*) FROM battles WHERE status = 'resolved'`),
        fusions: db.scalar(`SELECT COUNT(*) FROM fusions`),
        sales: db.scalar(`SELECT COUNT(*) FROM sales`),
        burnedCgMicro: String(db.all(`SELECT amount FROM burns`).reduce((s, r) => s + BigInt(r.amount), 0n)),
        servicesSold: db.scalar(`SELECT COUNT(*) FROM service_payments`),
        skrRewardsPaidMicro: String(db.all(`SELECT amount FROM reward_claims WHERE currency = 'SKR'`).reduce((s, r) => s + BigInt(r.amount), 0n)),
        lastSlot: db.scalar(`SELECT COALESCE(MAX(slot),0) FROM events_raw`),
    };
}
/** SKR prize pool: funded/paid totals and live roots — proves rewards ≤ funding (treasury liability, never supply). */
function skrPool(db) {
    const sum = (sql) => db.all(sql).reduce((s, r) => s + BigInt(r.amount), 0n);
    const funded = sum(`SELECT amount FROM skr_pool_events WHERE kind = 'funded'`);
    const withdrawn = sum(`SELECT amount FROM skr_pool_events WHERE kind = 'withdrawn'`);
    const paid = sum(`SELECT amount FROM reward_claims WHERE currency = 'SKR'`);
    const roots = db.all(`SELECT kind, epoch, budget, revoked, slot FROM reward_roots WHERE currency = 'SKR' ORDER BY slot DESC LIMIT 50`);
    const claimedByRoot = new Map(db.all(`SELECT kind, epoch, amount FROM reward_claims WHERE currency = 'SKR'`).reduce((m, r) => {
        const k = `${r.kind}:${r.epoch}`;
        m.set(k, (m.get(k) ?? 0n) + BigInt(r.amount));
        return m;
    }, new Map()));
    const reserved = roots.filter((r) => !r.revoked).reduce((s, r) => s + BigInt(r.budget) - (claimedByRoot.get(`${r.kind}:${r.epoch}`) ?? 0n), 0n);
    const last = db.get(`SELECT max_root_budget, paused FROM skr_pool_events WHERE kind = 'changed' ORDER BY slot DESC LIMIT 1`);
    const revenue = skrRevenue(db);
    const due = (0, economy_1.skrPoolDueMicro)(revenue);
    return {
        fundedTotalMicro: funded.toString(),
        withdrawnTotalMicro: withdrawn.toString(),
        paidTotalMicro: paid.toString(),
        reservedMicro: reserved.toString(),
        budgetMicro: (funded - withdrawn - paid - reserved).toString(),
        maxRootBudgetMicro: last?.max_root_budget ?? null,
        paused: last?.paused === 1,
        roots: roots.map((r) => ({ kind: r.kind, epoch: r.epoch, budgetMicro: r.budget, claimedMicro: (claimedByRoot.get(`${r.kind}:${r.epoch}`) ?? 0n).toString(), revoked: r.revoked === 1, slot: r.slot })),
        /** Treasury policy audit: realised SKR revenue × the published shares vs. what was actually funded. */
        funding: {
            treasuryWallet: economy_1.SKR_TREASURY_WALLET,
            policyBps: { packRevenue: economy_1.SKR_POOL_FUNDING.packRevenueShareBps, marketFeeTreasury: economy_1.SKR_POOL_FUNDING.marketFeeTreasuryShareBps, servicesRevenue: economy_1.SKR_POOL_FUNDING.servicesRevenueShareBps },
            cadence: economy_1.SKR_POOL_FUNDING.cadence,
            revenue: { packRevenueMicro: revenue.packRevenueMicro.toString(), marketFeeTreasuryMicro: revenue.marketFeeTreasuryMicro.toString(), servicesRevenueMicro: revenue.servicesRevenueMicro.toString() },
            dueMicro: due.dueMicro.toString(),
            dueBreakdownMicro: { packs: due.fromPacksMicro.toString(), market: due.fromMarketMicro.toString(), services: due.fromServicesMicro.toString() },
            /** funded − due; negative = the treasury is behind on the published policy */
            surplusMicro: (funded - due.dueMicro).toString(),
        },
    };
}
/**
 * Realised SKR revenue (micro) from on-chain events — the base the funding policy applies to.
 * Packs count only once fully opened (pending/cancelled purchases are refundable liabilities,
 * not revenue); sales count the protocol fee's treasury part (buyback slice excluded);
 * services count the full SKR price (nothing is burned on the SKR rail).
 */
function skrRevenue(db) {
    const SKR = exports.CURRENCY_SYMBOL.indexOf('SKR');
    const sum = (sql, currency) => db.all(sql, currency).reduce((s, r) => s + BigInt(r.amount), 0n);
    const packRevenueMicro = sum(`SELECT amount FROM pack_purchases WHERE currency = ? AND status = 'opened'`, SKR);
    const marketFeeTreasuryMicro = db.all(`SELECT fee FROM sales WHERE currency = ?`, SKR).reduce((s, r) => s + (0, economy_1.marketFeeTreasuryPartMicro)(BigInt(r.fee)), 0n);
    const servicesRevenueMicro = sum(`SELECT amount FROM service_payments WHERE currency = ?`, SKR);
    return { packRevenueMicro, marketFeeTreasuryMicro, servicesRevenueMicro };
}
function walletEvents(db, wallet, limit = 50) {
    return db.all(
    // `name`, unaliased: the openapi RawEvent schema (and the generated client type) say `name`, and a
    // rename here is invisible to typecheck because the row type below is a cast, not an inference.
    // The `LIKE` scan is the accepted cost of querying a JSON blob (docs/06 §4.1); a wallet column with
    // an index would be the fix, and it is deliberately not worth a migration for an events feed.
    `SELECT name, data, block_time, signature FROM events_raw WHERE data LIKE '%' || ? || '%' ORDER BY slot DESC LIMIT ?`, wallet, Math.min(limit, 200));
}
/** Crank health for /health: queue depth, head age and abandoned jobs (SLA/alerts — docs/06 §4.3). Any process with the DB can answer. */
function crankStatus(db, nowMs = Date.now()) {
    const counts = Object.fromEntries(db.all(`SELECT phase, COUNT(*) AS n FROM crank_jobs GROUP BY phase`).map((r) => [r.phase, r.n]));
    const oldest = db.get(`SELECT MIN(created_at) AS t FROM crank_jobs WHERE phase = 'pending'`)?.t ?? null;
    const last = db.get(`SELECT MAX(updated_at) AS t FROM crank_jobs`)?.t ?? null;
    const headAgeS = oldest === null ? null : Math.round((nowMs - oldest) / 1000);
    return {
        pending: counts.pending ?? 0, stale: counts.stale ?? 0, settled: counts.settled ?? 0, closed: counts.closed ?? 0, abandoned: counts.abandoned ?? 0,
        headAgeS, lastActivity: last === null ? null : new Date(last).toISOString(),
        healthy: (counts.pending ?? 0) <= 200 && (headAgeS === null || headAgeS <= 60) && (counts.abandoned ?? 0) === 0,
    };
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snake = exports.WIRE_TYPE = void 0;
exports.wireEvent = wireEvent;
const bus_ts_1 = require("./bus.ts");
// Same conversion the REST market read-model uses, so a toast can never disagree with the market page.
const services_ts_1 = require("./services.ts");
const queries_ts_1 = require("./queries.ts");
/** Event name → the client's invalidation key. Anything not listed still ships under its snake_case name. */
exports.WIRE_TYPE = {
    PackOpened: 'pack_opened',
    ChipFused: 'chip_fused',
    CompressedClaimsFused: 'chip_fused',
    ClaimFusionRevealed: 'chip_fused',
    ChipListed: 'listing_changed',
    OfferCancelled: 'offer',
    ListingUpdated: 'listing_changed',
    ListingCancelled: 'listing_changed',
    ChipSold: 'sale',
    OfferMade: 'offer',
    Staked: 'stake_changed',
    Unstaked: 'stake_changed',
    Claimed: 'reward_claimed',
    RootClaimed: 'reward_claimed',
    VoucherIssued: 'quest_progress',
    BattleCreated: 'match_found',
    BattleAccepted: 'match_found',
    BattleResolved: 'match_resolved',
    BattleCancelled: 'match_resolved',
    DayClosed: 'day_closed',
    ParamsChanged: 'params_changed',
    PauseChanged: 'params_changed',
    PauserChanged: 'params_changed',
    AdminProposed: 'params_changed',
    AdminAccepted: 'params_changed',
    ArenaConfigChanged: 'params_changed',
    OraclesChanged: 'params_changed',
    CollectionCreated: 'params_changed',
};
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
exports.snake = snake;
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v));
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : undefined);
/**
 * The frame for one event, or null when nothing should be sent. `db` is only read for the display
 * price of a market trade (the same `oracle_prices` cache REST uses, so the toast cannot disagree
 * with the market page).
 */
function wireEvent(db, e, ctx = {}) {
    const type = exports.WIRE_TYPE[e.name] ?? (0, exports.snake)(e.name);
    const d = (e.data ?? {});
    const wallets = (0, bus_ts_1.walletsOf)(d);
    // Field names below are the decoded event fields (`backend/src/events.ts` is the schema, mirrored
    // from the Rust `#[event]` structs) — not the DB column names. A payload built from the wrong one is
    // a frame that looks fine and invalidates nothing.
    let payload = {};
    const s_ = (k) => str(d[k]);
    const n_ = (k) => num(d[k]);
    switch (e.name) {
        case 'ChipListed':
            payload = { asset: s_('asset'), seller: s_('seller'), price: s_('price'), currency: n_('currency') ?? 0 };
            break;
        case 'ListingUpdated':
            payload = { asset: s_('asset'), price: s_('price') };
            break;
        case 'ListingCancelled':
            payload = { asset: s_('asset') };
            break;
        case 'ChipSold': {
            const currency = n_('currency') ?? 0;
            const price = s_('price');
            payload = { asset: s_('asset'), seller: s_('seller'), buyer: s_('buyer'), price, currency, viaOffer: Boolean(d.viaOffer) };
            if (price !== undefined) {
                try {
                    payload.priceUsd = Number((0, queries_ts_1.toUsd)(price, currency, (0, services_ts_1.prices)(db)).toFixed(2));
                }
                catch { /* no price cache yet → the toast shows no USD, which beats a wrong one */ }
            }
            break;
        }
        case 'OfferMade':
            payload = { asset: s_('asset'), bidder: s_('bidder'), amount: s_('amount'), expiresAt: s_('expiresAt') };
            break;
        case 'OfferCancelled':
            payload = { asset: s_('asset'), bidder: s_('bidder') };
            break;
        case 'BattleCreated':
            payload = { id: s_('battle'), challenger: s_('challenger'), wager: s_('wager') };
            break;
        case 'BattleAccepted':
            payload = { id: s_('battle'), opponent: s_('opponent') };
            break;
        case 'BattleResolved':
            payload = { id: s_('battle'), winner: s_('winner'), pot: s_('pot') };
            break;
        case 'BattleCancelled':
            payload = { id: s_('battle'), status: 'cancelled' };
            break;
        case 'PackOpened':
            payload = { buyer: s_('buyer'), nonce: s_('nonce'), sku: n_('sku'), count: n_('count'), pityAfter: n_('pityAfter') };
            break;
        case 'PackCancelled':
            payload = { buyer: s_('buyer'), nonce: s_('nonce'), refunded: s_('refunded') };
            break;
        case 'ChipFused':
            payload = { owner: s_('owner'), result: s_('result'), recipe: n_('recipe'), success: Boolean(d.success) };
            break;
        // SEC-G04: same wire shape as ChipFused so the fusion toast / invalidation is one client code path.
        case 'CompressedClaimsFused':
            payload = { owner: s_('owner'), result: s_('resultClaim'), recipe: n_('recipe'), success: true };
            break;
        // H3: same again, but the roll is real — `success` comes from the chain, `resultClaim` is the default pubkey on failure.
        case 'ClaimFusionRevealed':
            payload = { owner: s_('owner'), result: s_('resultClaim'), recipe: n_('recipe'), success: Boolean(d.success) };
            break;
        case 'VoucherIssued':
            payload = { wallet: s_('wallet'), nonce: s_('nonce'), template: n_('template') };
            break;
        case 'Staked':
            payload = { owner: s_('owner'), kind: n_('kind'), key: s_('key'), amount: s_('amount') };
            break;
        case 'Unstaked':
            payload = { owner: s_('owner'), kind: n_('kind'), key: s_('key'), amount: s_('amount'), penaltyBurned: s_('penaltyBurned') };
            break;
        case 'Claimed':
            payload = { owner: s_('owner'), kind: n_('kind'), amount: s_('amount') };
            break;
        case 'RootClaimed':
            payload = { wallet: s_('wallet'), kind: n_('kind'), epoch: n_('epoch'), amount: s_('amount') };
            break;
        case 'RootPublished':
            payload = { kind: n_('kind'), epoch: n_('epoch'), budget: s_('budget') };
            break;
        case 'ParamsChanged':
            payload = { admin: s_('admin'), version: n_('version') };
            break;
        case 'PauseChanged':
            payload = { by: s_('by'), paused: Boolean(d.paused) };
            break;
        case 'DayClosed':
            payload = { dayIndex: n_('dayIndex'), year: n_('year'), guarded: s_('guarded') };
            break;
        default: {
            // Unknown (a program event that shipped before the client learned it): scalars only. The client
            // ignores an unlisted type, so this is forward-compat for a program release, not a data channel.
            for (const [k, v] of Object.entries(d).slice(0, 16))
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
                    payload[k] = v;
        }
    }
    for (const k of Object.keys(payload))
        if (payload[k] === undefined)
            delete payload[k];
    return { wallets, type, payload, slot: ctx.slot };
}

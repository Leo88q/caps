"use strict";
// Pyth price-posting ops CLI (owner decision Q7: the studio runs its own pusher).
//
//   npm run pyth-pusher -- <command> [args]
//
//   accounts [shard]      print the push-oracle PDAs for SOL/USD + SKR/USD (default: our shard 0xCA75,
//                         plus the Pyth-sponsored shard 0 for comparison).
//   check [rpcUrl]        read both PriceUpdateV2 accounts of our shard via RPC, print price / conf /
//                         age / verification level; exit 1 if any feed is older than PYTH_PUSHER.alertAgeS.
//   cost [cuPrice]        estimated SOL per month for the pusher at a given priority fee (µlamports/CU).
//   set-params-args       the two pubkeys to put into GameConfig via `set_params` (ParamsPatch layout).
//   quote <cents> [rpc]   what a buyer would pay right now for `cents` in SOL and SKR (same integer math
//                         as chip_core::units_for_cents) — sanity check against /packs/quote.
//
// No SDK needed: PriceUpdateV2 is decoded by hand (layout pinned in client/src/chain/pyth.ts and
// backend/src/pyth.ts); the pusher itself is Pyth's `price_pusher` image (ops/pyth-pusher/).
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushOracleAccount = pushOracleAccount;
exports.decodePriceUpdateV2 = decodePriceUpdateV2;
const web3_js_1 = require("@solana/web3.js");
const index_ts_1 = require("../packages/economy/src/index.ts");
const PUSH_ORACLE = new web3_js_1.PublicKey(index_ts_1.PYTH_PROGRAMS.pushOracle);
const RECEIVER = new web3_js_1.PublicKey(index_ts_1.PYTH_PROGRAMS.receiver);
const RPC_DEFAULT = process.env.ANCHOR_PROVIDER_URL ?? 'https://api.mainnet-beta.solana.com';
function pushOracleAccount(shard, feedIdHex) {
    const s = Buffer.alloc(2);
    s.writeUInt16LE(shard);
    return web3_js_1.PublicKey.findProgramAddressSync([s, Buffer.from(feedIdHex, 'hex')], PUSH_ORACLE)[0];
}
/** PriceUpdateV2: 8 disc ‖ write_authority[32] ‖ VerificationLevel ‖ PriceFeedMessage ‖ posted_slot u64 */
function decodePriceUpdateV2(data) {
    let o = 8;
    const writeAuthority = new web3_js_1.PublicKey(data.subarray(o, o + 32));
    o += 32;
    const vl = data[o++];
    let verification = 'full';
    if (vl === 0) {
        verification = `partial(${data[o]})`;
        o += 1;
    }
    const feedIdHex = data.subarray(o, o + 32).toString('hex');
    o += 32;
    const price = data.readBigInt64LE(o);
    o += 8;
    const conf = data.readBigUInt64LE(o);
    o += 8;
    const exponent = data.readInt32LE(o);
    o += 4;
    const publishTime = data.readBigInt64LE(o);
    o += 8;
    const prevPublishTime = data.readBigInt64LE(o);
    o += 8;
    const emaPrice = data.readBigInt64LE(o);
    o += 8;
    const emaConf = data.readBigUInt64LE(o);
    o += 8;
    const postedSlot = data.readBigUInt64LE(o);
    o += 8;
    return { writeAuthority, verification, feedIdHex, price, conf, exponent, publishTime, prevPublishTime, emaPrice, emaConf, postedSlot };
}
const parseShard = (s, fallback) => (s === undefined ? fallback : Number(s.startsWith('0x') ? parseInt(s, 16) : s));
const hex4 = (n) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
function accounts(shardArg) {
    const shards = shardArg === undefined ? [index_ts_1.PYTH_SHARD_ID, index_ts_1.PYTH_SPONSORED_SHARD_ID] : [parseShard(shardArg, index_ts_1.PYTH_SHARD_ID)];
    console.log(`push oracle ${PUSH_ORACLE.toBase58()} · receiver ${RECEIVER.toBase58()} (same ids on mainnet-beta and devnet)`);
    for (const shard of shards) {
        console.log(`\nshard ${shard} (${hex4(shard)})${shard === index_ts_1.PYTH_SHARD_ID ? ' — OURS (GameConfig.pyth_*_feed)' : shard === 0 ? ' — Pyth-sponsored (SOL/USD only, 55 s heartbeat)' : ''}`);
        for (const f of Object.values(index_ts_1.PYTH_FEEDS))
            console.log(`  ${f.pair.padEnd(15)} ${pushOracleAccount(shard, f.feedIdHex).toBase58()}   feed ${f.feedIdHex.slice(0, 8)}…${f.feedIdHex.slice(-4)}`);
    }
}
async function readFeeds(conn, shard = index_ts_1.PYTH_SHARD_ID) {
    const keys = Object.values(index_ts_1.PYTH_FEEDS).map((f) => pushOracleAccount(shard, f.feedIdHex));
    const infos = await conn.getMultipleAccountsInfo(keys, 'confirmed');
    const now = Math.floor(Date.now() / 1000);
    return Object.values(index_ts_1.PYTH_FEEDS).map((f, i) => {
        const info = infos[i];
        if (!info)
            return { feed: f, key: keys[i], missing: true };
        const ownerOk = info.owner.equals(RECEIVER);
        const p = decodePriceUpdateV2(info.data);
        return { feed: f, key: keys[i], missing: false, ownerOk, p, ageS: now - Number(p.publishTime) };
    });
}
async function check(rpc = RPC_DEFAULT) {
    const conn = new web3_js_1.Connection(rpc, 'confirmed');
    console.log(`rpc ${rpc} · shard ${hex4(index_ts_1.PYTH_SHARD_ID)} · max age ${index_ts_1.PYTH_MAX_AGE_SECS} s · alert ${index_ts_1.PYTH_PUSHER.alertAgeS} s · pusher worst case ${index_ts_1.PYTH_WORST_CASE_AGE_S} s`);
    let bad = 0;
    for (const r of await readFeeds(conn)) {
        if (r.missing) {
            console.log(`✗ ${r.feed.pair.padEnd(15)} ${r.key.toBase58()}  NOT FOUND (pusher never posted to this shard)`);
            bad++;
            continue;
        }
        const { p, ageS } = r;
        const feedOk = p.feedIdHex === r.feed.feedIdHex;
        const stale = ageS > index_ts_1.PYTH_PUSHER.alertAgeS;
        const flag = !r.ownerOk || !feedOk || stale || p.verification !== 'full' ? '✗' : '✓';
        if (flag === '✗')
            bad++;
        console.log(`${flag} ${r.feed.pair.padEnd(15)} ${r.key.toBase58()}  $${(0, index_ts_1.pythPriceToUsd)(p.price, p.exponent).toFixed(r.feed.symbol === 'SOL' ? 2 : 5)} ± ${(Number(p.conf) / Number(p.price) * 100).toFixed(2)} %  age ${ageS} s  ${p.verification}  slot ${p.postedSlot}${r.ownerOk ? '' : '  OWNER≠receiver'}${feedOk ? '' : '  FEED MISMATCH'}${stale ? `  STALE>${index_ts_1.PYTH_PUSHER.alertAgeS}s` : ''}`);
    }
    if (bad) {
        console.error(`\n${bad} feed(s) unhealthy`);
        process.exit(1);
    }
    console.log('\nall feeds healthy');
}
async function quote(centsArg, rpc = RPC_DEFAULT) {
    const cents = BigInt(centsArg ?? '499');
    const conn = new web3_js_1.Connection(rpc, 'confirmed');
    console.log(`quote for $${(Number(cents) / 100).toFixed(2)} (shard ${hex4(index_ts_1.PYTH_SHARD_ID)}):`);
    for (const r of await readFeeds(conn)) {
        if (r.missing) {
            console.log(`  ${r.feed.pair}: account not found`);
            continue;
        }
        const units = (0, index_ts_1.unitsForCents)(cents, r.p.price, r.p.exponent, r.feed.decimals);
        const max = (0, index_ts_1.maxUnitsWithSlippage)(units);
        const human = (u) => (Number(u) / 10 ** r.feed.decimals).toFixed(r.feed.decimals === 9 ? 6 : 3);
        console.log(`  ${r.feed.pair.padEnd(15)} ${human(units)} ${r.feed.symbol} (max_units ${human(max)} ${r.feed.symbol}, +1 %)  age ${r.ageS} s${r.ageS > index_ts_1.PYTH_MAX_AGE_SECS ? '  ← would FAIL on-chain (StalePrice)' : ''}`);
    }
}
function cost(cuPriceArg) {
    const rows = [0, 200, 1_000, 5_000, ...(cuPriceArg ? [Number(cuPriceArg)] : [])];
    console.log(`one push (full verification) ≈ 3 tx / 4 signatures / 600 k CU; cadence ≈ ${index_ts_1.PYTH_PUSHER.timeDifferenceS + index_ts_1.PYTH_PUSHER.pushingFrequencyS / 2} s (+15 % deviation-triggered)`);
    for (const cu of rows)
        console.log(`  ${String(cu).padStart(6)} µlamports/CU → ${(0, index_ts_1.pusherCostSolPerMonth)({ cuPriceMicroLamports: cu }).toFixed(3)} SOL / month`);
    console.log(`account rent (once): 2 × ≈ 0.0019 SOL`);
}
function setParamsArgs() {
    const sol = pushOracleAccount(index_ts_1.PYTH_SHARD_ID, index_ts_1.PYTH_FEEDS.SOL.feedIdHex);
    const skr = pushOracleAccount(index_ts_1.PYTH_SHARD_ID, index_ts_1.PYTH_FEEDS.SKR.feedIdHex);
    console.log('chip_core::set_params(ParamsPatch) — leave every other field None:');
    console.log(`  pyth_sol_usd_feed = Some(${sol.toBase58()})`);
    console.log(`  pyth_skr_usd_feed = Some(${skr.toBase58()})`);
    console.log('Borsh: [disc sha256("global:set_params")[..8]] ‖ packs:None(0) ‖ market_fee_bps:None(0) ‖ featured_collection:None(0) ‖ treasury:None(0) ‖ buyback_wallet:None(0)');
    console.log('       ‖ pyth_sol_usd_feed:Some(1)+32 B ‖ pyth_skr_usd_feed:Some(1)+32 B ‖ skr_mint:None(0) ‖ skr_discount_bps:None(0)');
    console.log('Signer: GameConfig.admin (Squads 3/5 on mainnet). The client and the backend read the keys back from GameConfig — nothing else to redeploy.');
    console.log(`\nEnv for the backend cache worker: PYTH_SHARD_ID=${index_ts_1.PYTH_SHARD_ID} (or PYTH_SOL_ACCOUNT=${sol.toBase58()} PYTH_SKR_ACCOUNT=${skr.toBase58()})`);
}
async function main() {
    const [cmd, a, b] = process.argv.slice(2);
    switch (cmd) {
        case 'accounts': return accounts(a);
        case 'check': return check(a);
        case 'cost': return cost(a);
        case 'set-params-args': return setParamsArgs();
        case 'quote': return quote(a, b);
        default:
            console.log('usage: npm run pyth-pusher -- accounts [shard] | check [rpc] | cost [cuPrice] | set-params-args | quote <cents> [rpc]');
            process.exit(cmd ? 2 : 0);
    }
}
main().catch((e) => { console.error(e); process.exit(1); });

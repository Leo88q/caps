"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_NAME = exports.EXPLORER = exports.DAS_RPC_URL = exports.LOOKUP_TABLE = exports.MINTS = exports.PROGRAM_IDS = exports.ONRAMP_URL = exports.FLAGS = exports.WS_BASE = exports.API_BASE = exports.RPC_WS_URL = exports.RPC_URL = exports.CLUSTER = void 0;
// Typed access to Vite env. Everything here is public (bundled into the
// client) — never put secrets in VITE_* vars.
const web3_js_1 = require("@solana/web3.js");
function bool(v, dflt = false) {
    if (v === undefined || v === '')
        return dflt;
    return v === 'true' || v === '1';
}
function pk(v, fallback) {
    try {
        return new web3_js_1.PublicKey(v && v.length > 0 ? v : fallback);
    }
    catch {
        return new web3_js_1.PublicKey(fallback);
    }
}
const env = import.meta.env;
exports.CLUSTER = env.VITE_CLUSTER ?? 'devnet';
exports.RPC_URL = env.VITE_RPC_URL && env.VITE_RPC_URL.length > 0
    ? env.VITE_RPC_URL
    : exports.CLUSTER === 'localnet'
        ? 'http://127.0.0.1:8899'
        : (0, web3_js_1.clusterApiUrl)(exports.CLUSTER);
exports.RPC_WS_URL = env.VITE_RPC_WS_URL && env.VITE_RPC_WS_URL.length > 0 ? env.VITE_RPC_WS_URL : undefined;
exports.API_BASE = env.VITE_API_BASE ?? '/v1';
exports.WS_BASE = env.VITE_WS_BASE ?? '/ws';
exports.FLAGS = {
    geoGate: bool(env.VITE_FLAG_GEO_GATE),
    /** 18+ confirmation before the purchase surface (docs/09 §5.2). Independent of the geo gate: age is a rule you answer, region is a rule that answers for you. */
    ageGate: bool(env.VITE_FLAG_AGE_GATE),
    limitedPackPreview: bool(env.VITE_FLAG_LIMITED_PACK),
    debugPanel: bool(env.VITE_FLAG_DEBUG_PANEL, env.DEV),
    /** Use the deterministic in-browser mock API instead of the backend. Auto-enabled in dev when /v1/health is unreachable. */
    apiMock: bool(env.VITE_API_MOCK),
};
exports.ONRAMP_URL = env.VITE_ONRAMP_URL ?? 'https://buy.moonpay.com/?defaultCurrencyCode=sol';
// Program ids — placeholders until `anchor keys sync` (see programs/README.md).
exports.PROGRAM_IDS = {
    chipCore: pk(env.VITE_PROGRAM_CHIP_CORE, 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q'),
    market: pk(env.VITE_PROGRAM_MARKET, 'GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz'),
    staking: pk(env.VITE_PROGRAM_STAKING, 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA'),
    arena: pk(env.VITE_PROGRAM_ARENA, 'GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM'),
};
exports.MINTS = {
    /** Filled after `scripts/setup.ts`; empty → $CG features render in "not deployed" state. */
    cg: env.VITE_CG_MINT && env.VITE_CG_MINT.length > 0 ? new web3_js_1.PublicKey(env.VITE_CG_MINT) : undefined,
    usdc: pk(env.VITE_USDC_MINT, exports.CLUSTER === 'mainnet-beta' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    /**
     * Seeker (SKR) — Solana Mobile's ecosystem token (SPL Token, 6 dp). Only the
     * mainnet mint is canonical; on devnet a test mint is created by scripts/setup.ts
     * and passed via VITE_SKR_MINT. Empty → SKR rail hidden in the UI.
     */
    skr: env.VITE_SKR_MINT && env.VITE_SKR_MINT.length > 0
        ? new web3_js_1.PublicKey(env.VITE_SKR_MINT)
        : exports.CLUSTER === 'mainnet-beta' ? new web3_js_1.PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3') : undefined,
};
/**
 * Static Address Lookup Table created by `npm run create-lut` (docs/06 §4.2 вывод 3): lets
 * `reveal + open` land in ONE transaction. Unset → the flows send reveal and open separately
 * (fine for ≤3-chip packs; 5-chip bundles and 30-node registers need the table).
 */
exports.LOOKUP_TABLE = env.VITE_LOOKUP_TABLE && env.VITE_LOOKUP_TABLE.length > 0 ? new web3_js_1.PublicKey(env.VITE_LOOKUP_TABLE) : undefined;
/**
 * Bubblegum V2 DAS endpoint for the mint → register step (`getAssetsByOwner` /
 * `getAsset` / `getAssetProof`). Defaults to the app RPC, which is valid only
 * when the provider exposes DAS methods (Helius / Triton do; the public
 * cluster endpoints do not) — otherwise set VITE_DAS_RPC_URL.
 */
exports.DAS_RPC_URL = env.VITE_DAS_RPC_URL && env.VITE_DAS_RPC_URL.length > 0 ? env.VITE_DAS_RPC_URL : exports.RPC_URL;
exports.EXPLORER = {
    tx: (sig) => `https://solscan.io/tx/${sig}${exports.CLUSTER === 'mainnet-beta' ? '' : `?cluster=${exports.CLUSTER === 'localnet' ? 'custom' : exports.CLUSTER}`}`,
    account: (key) => `https://solscan.io/account/${key}${exports.CLUSTER === 'mainnet-beta' ? '' : `?cluster=${exports.CLUSTER === 'localnet' ? 'custom' : exports.CLUSTER}`}`,
};
exports.APP_NAME = 'GUTTERCAPS';

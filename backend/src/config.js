"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LISTEN_HEAL_EVERY_MS = exports.LISTEN_RECONNECT_MS = exports.BACKFILL_CONCURRENCY = exports.BACKFILL_PAGE = exports.HANDLE_BLOCKLIST = exports.HANDLE_QUARANTINE_S = exports.HANDLE_CHANGE_COOLDOWN_S = exports.HANDLE_RESERVE_MS = exports.HANDLE_RE = exports.DEVICE_SALT = exports.DEVICE_MAX_WALLETS = exports.HUMAN_CHECK_TTL_S = exports.HUMAN_CHECK_ENABLED = exports.HUMAN_CHECK_OPT_OUT = exports.TURNSTILE_SITEVERIFY_URL = exports.TURNSTILE_SITE_KEY = exports.TURNSTILE_SECRET = exports.RATE_LIMIT_ENABLED = exports.SIWS_MAX_DRIFT_S = exports.SIWS_DOMAINS = exports.COOKIE_SECURE = exports.COOKIE_NAME = exports.SESSION_TTL_S = exports.SESSION_SECRET = exports.SHUTDOWN_TIMEOUT_MS = exports.API_INGEST = exports.WS_MAX_BACKLOG_BYTES = exports.WS_PING_MS = exports.WS_MAX_CLIENTS = exports.WS_PATH = exports.EVENT_BUS_CHANNEL = exports.EVENT_BUS = exports.RATE_LIMIT_REDIS_WINDOW_MS = exports.RATE_LIMIT_REDIS_MAX = exports.REDIS_URL = exports.CORS_ALLOW_CREDENTIALS = exports.CORS_ORIGINS = exports.IS_PRODUCTION = exports.API_HOST = exports.API_PORT = exports.DB_PATH = exports.BUBBLEGUM_V2_ENABLED = exports.DAS_TIMEOUT_MS = exports.DAS_RPC_URL = exports.COMMITMENT = exports.RPC_WS_URL = exports.RPC_URL = exports.SKR_MINT = exports.PROGRAM_NAMES = exports.PROGRAMS = void 0;
exports.SKR_USD_FALLBACK = exports.SOL_USD_FALLBACK = exports.CRANK_GATEWAY_RPC = exports.LOOKUP_TABLES = exports.CRANK_STALE_RECHECK_MS = exports.CRANK_MAX_FEE_LAMPORTS = exports.CRANK_CU_PRICE_CAP = exports.CRANK_CU_PRICE_FLOOR = exports.CRANK_MAX_ATTEMPTS = exports.CRANK_GATEWAY_TIMEOUT_MS = exports.CRANK_MAX_BALANCE_SOL = exports.CRANK_HARD_FLOOR_SOL = exports.CRANK_MIN_BALANCE_SOL = exports.CRANK_CONCURRENCY = exports.CRANK_SWEEP_MS = exports.CRANK_POLL_MS = exports.CRANK_KEYPAIR = exports.SWITCHBOARD_PROGRAM_ID = exports.SWITCHBOARD_QUEUE = exports.QUOTE_CACHE_MS = exports.PYTH_CACHE_EVERY_MS = exports.PYTH_ACCOUNTS = exports.PYTH_SHARD_ID = exports.LISTEN_HEAL_DEPTH = void 0;
exports.programNameOf = programNameOf;
exports.assertProductionConfig = assertProductionConfig;
// Runtime configuration for the backend processes (indexer + API).
// Everything is env-driven with devnet defaults that match client/src/app/config.ts.
const web3_js_1 = require("@solana/web3.js");
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const env = process.env;
function pk(v, fallback) {
    return new web3_js_1.PublicKey(v && v.length > 0 ? v : fallback);
}
/** The four GUTTERCAPS programs. Same defaults as the client — override per cluster with env. */
exports.PROGRAMS = {
    chip_core: pk(env.PROGRAM_CHIP_CORE, 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q'),
    market: pk(env.PROGRAM_MARKET, 'GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz'),
    staking: pk(env.PROGRAM_STAKING, 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA'),
    arena: pk(env.PROGRAM_ARENA, 'GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM'),
};
exports.PROGRAM_NAMES = Object.keys(exports.PROGRAMS);
function programNameOf(id) {
    const s = typeof id === 'string' ? id : id.toBase58();
    for (const n of exports.PROGRAM_NAMES)
        if (exports.PROGRAMS[n].toBase58() === s)
            return n;
    return undefined;
}
/** Genuine SKR mint — never resolve by symbol (counterfeits exist). */
exports.SKR_MINT = new web3_js_1.PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3');
exports.RPC_URL = env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
exports.RPC_WS_URL = env.SOLANA_WS_URL; // optional; web3.js derives it from RPC_URL when unset
exports.COMMITMENT = 'confirmed';
/** Bubblegum V2 DAS endpoint. A plain Solana RPC URL is valid only when the provider exposes DAS methods. */
exports.DAS_RPC_URL = env.METAPLEX_DAS_RPC_URL ?? exports.RPC_URL;
exports.DAS_TIMEOUT_MS = Number(env.METAPLEX_DAS_TIMEOUT_MS ?? 10_000);
/** Closed-market migration gate: no cNFT ownership path is enabled until the V2 fixtures are deployed. */
exports.BUBBLEGUM_V2_ENABLED = (env.BUBBLEGUM_V2_ENABLED ?? '0') === '1';
const here = node_path_1.default.dirname((0, node_url_1.fileURLToPath)(import.meta.url));
/** SQLite file for local/dev and the explicitly acknowledged single-instance production mode. `:memory:` is for tests; the Prisma Postgres schema is not the running adapter yet. */
exports.DB_PATH = env.DB_PATH ?? node_path_1.default.join(here, '..', 'guttercaps.sqlite');
exports.API_PORT = Number(env.PORT ?? env.API_PORT ?? 8787);
exports.API_HOST = env.HOST ?? '0.0.0.0';
exports.IS_PRODUCTION = (env.NODE_ENV ?? '') === 'production';
/** Comma-separated list; `*` allows any origin (dev only — refused in production, SEC-M4). */
exports.CORS_ORIGINS = (env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
/**
 * `Access-Control-Allow-Credentials` is only ever sent with an explicit origin allowlist: with `*`
 * browsers reject the pair anyway, and the header is a smell in a security review (SEC-M4).
 */
exports.CORS_ALLOW_CREDENTIALS = !exports.CORS_ORIGINS.includes('*');
// ------------------------------------------------------------ ops surface (docs/09 §4.1)
/** Shared Redis: the cross-instance rate-limit budget and the event bus that feeds `/ws`. */
exports.REDIS_URL = env.REDIS_URL ?? '';
/** Requests per IP per window allowed by the *shared* counter (the per-process bucket is tighter). */
exports.RATE_LIMIT_REDIS_MAX = Number(env.RATE_LIMIT_REDIS_MAX ?? 900);
exports.RATE_LIMIT_REDIS_WINDOW_MS = Number(env.RATE_LIMIT_REDIS_WINDOW_MS ?? 60_000);
/** `inproc` (single process, default) | `redis` (indexer and API in different containers) | `off`. */
exports.EVENT_BUS = env.EVENT_BUS || 'inproc';
exports.EVENT_BUS_CHANNEL = env.EVENT_BUS_CHANNEL ?? 'chip:events';
exports.WS_PATH = env.WS_PATH ?? '/ws';
exports.WS_MAX_CLIENTS = Number(env.WS_MAX_CLIENTS ?? 500);
exports.WS_PING_MS = Number(env.WS_PING_MS ?? 30_000);
exports.WS_MAX_BACKLOG_BYTES = Number(env.WS_MAX_BACKLOG_BYTES ?? 1 << 20);
/**
 * Run the on-chain indexer *inside* the API process (docs/09 §4.1). `1` (the default) is what makes
 * `/ws` work on a single box without Redis: the frames are produced by the same process that owns the
 * sockets. Set `API_INGEST=0` on the API when a dedicated `npm run listen` container indexes — then
 * the fan-out has to cross a process boundary, i.e. `EVENT_BUS=redis` + `REDIS_URL`.
 */
exports.API_INGEST = (env.API_INGEST ?? '1') !== '0';
/** SIGTERM → SIGKILL gap the deployer must give us; keep it below the supervisor's own timeout. */
exports.SHUTDOWN_TIMEOUT_MS = Number(env.SHUTDOWN_TIMEOUT_MS ?? 25_000);
/** HMAC key for session cookies. Ephemeral per process when unset (dev only). */
exports.SESSION_SECRET = env.SESSION_SECRET ?? '';
exports.SESSION_TTL_S = Number(env.SESSION_TTL_S ?? 7 * 86_400);
exports.COOKIE_NAME = 'gc_session';
/** Set when the API is served over https behind a proxy (secure cookies, SameSite=None). */
exports.COOKIE_SECURE = (env.COOKIE_SECURE ?? '') === '1';
/**
 * SIWS (SEC-M4): the `domain` of a sign-in message must be one of these (comma-separated hosts,
 * e.g. `app.guttercaps.gg,localhost:5173`). Empty → derived from CORS_ORIGINS' hosts; if that is
 * `*` too (dev) the domain is not checked. Never trust `X-Forwarded-Host` for this.
 */
exports.SIWS_DOMAINS = (env.SIWS_DOMAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).length
    ? (env.SIWS_DOMAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    : exports.CORS_ORIGINS.filter((o) => o !== '*').map((o) => { try {
        return new URL(o).host;
    }
    catch {
        return o;
    } });
/** |now − issuedAt| allowed on a SIWS message (seconds). */
exports.SIWS_MAX_DRIFT_S = Number(env.SIWS_MAX_DRIFT_S ?? 300);
/** Rate limiting (SEC-H3) — on by default; `RATE_LIMIT=0` only for local load scripts. */
exports.RATE_LIMIT_ENABLED = (env.RATE_LIMIT ?? '1') !== '0';
/**
 * Proof of human (docs/02 §"Жёсткие ограничители", docs/03 §3.4, T-B-49): quest / SKR rewards are
 * only settled for wallets that passed a Cloudflare Turnstile challenge inside the last
 * `HUMAN_CHECK_TTL_S`. `TURNSTILE_SECRET` turns the gate on (`POST /me/human` verifies tokens
 * against siteverify); `HUMAN_CHECK=0` is the explicit opt-out (dev / staging — refused silently
 * in production only when the opt-out is explicit). `TURNSTILE_SITE_KEY` is handed to the client
 * through `/me.human.siteKey` so the widget needs no separate build-time config.
 */
exports.TURNSTILE_SECRET = env.TURNSTILE_SECRET ?? '';
exports.TURNSTILE_SITE_KEY = env.TURNSTILE_SITE_KEY ?? '';
exports.TURNSTILE_SITEVERIFY_URL = env.TURNSTILE_SITEVERIFY_URL ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
exports.HUMAN_CHECK_OPT_OUT = (env.HUMAN_CHECK ?? '') === '0';
exports.HUMAN_CHECK_ENABLED = !exports.HUMAN_CHECK_OPT_OUT && exports.TURNSTILE_SECRET.length > 0;
exports.HUMAN_CHECK_TTL_S = Number(env.HUMAN_CHECK_TTL_S ?? 7 * 86_400);
/** Device dedupe: wallets beyond this many on one device (salted client fingerprint) earn no quest / SKR rewards. */
exports.DEVICE_MAX_WALLETS = Number(env.DEVICE_MAX_WALLETS ?? 3);
/** Salt for device hashes (never store the raw fingerprint). Defaults to the session secret (ephemeral in dev). */
exports.DEVICE_SALT = env.DEVICE_SALT ?? exports.SESSION_SECRET;
/**
 * Production fail-fast (SEC-M4): refuse to start with dev defaults that would silently weaken
 * auth — wildcard CORS with credentials, insecure cookies, ephemeral session secret, no SIWS domain.
 */
function assertProductionConfig() {
    if (!exports.IS_PRODUCTION)
        return;
    const problems = [];
    if (exports.CORS_ORIGINS.includes('*'))
        problems.push('CORS_ORIGINS must be an explicit allowlist (no `*`)');
    if (!exports.BUBBLEGUM_V2_ENABLED)
        problems.push('BUBBLEGUM_V2_ENABLED=1 is required after the Bubblegum V2 migration and its release gates are complete');
    if (!exports.COOKIE_SECURE)
        problems.push('COOKIE_SECURE=1 is required (https + SameSite=None)');
    if (exports.SESSION_SECRET.length < 32)
        problems.push('SESSION_SECRET must be ≥ 32 chars (sessions would not survive a restart)');
    if (exports.SIWS_DOMAINS.length === 0)
        problems.push('SIWS_DOMAINS (or non-wildcard CORS_ORIGINS) is required');
    if (env.FINALITY_ASSUME === '1')
        problems.push('FINALITY_ASSUME=1 is a dev shortcut — paid services must wait for finalized transactions (SEC-M5)');
    if (!exports.HUMAN_CHECK_OPT_OUT && exports.TURNSTILE_SECRET.length === 0)
        problems.push('TURNSTILE_SECRET is required (proof of human on reward settlement) — or set HUMAN_CHECK=0 explicitly');
    if (!env.DB_PATH || exports.DB_PATH === ':memory:')
        problems.push('DB_PATH must be explicit and persistent in production — an indexer restart would otherwise wipe or split projections');
    if (env.PRODUCTION_DB_MODE !== 'sqlite-single-instance')
        problems.push('the running backend uses node:sqlite; set PRODUCTION_DB_MODE=sqlite-single-instance only for one API/indexer instance with a persistent volume, or implement the Postgres adapter before scaling');
    if (exports.EVENT_BUS === 'redis' && !exports.REDIS_URL)
        problems.push('EVENT_BUS=redis requires REDIS_URL (otherwise the API process never sees events indexed by the listener process)');
    if (!exports.API_INGEST && exports.EVENT_BUS !== 'redis')
        problems.push('API_INGEST=0 with a non-redis event bus: nothing would ever reach /ws — either run the indexer in this process, or set EVENT_BUS=redis + REDIS_URL');
    if (!exports.API_INGEST && !exports.LISTEN_HEAL_EVERY_MS)
        problems.push('API_INGEST=0 assumes a separate `npm run listen` process is running (docs/09 §4.1) — if it is not, the projections never advance');
    if (exports.EVENT_BUS === 'off' && !exports.CORS_ORIGINS.includes('*'))
        problems.push('EVENT_BUS=off disables /ws fan-out: the client silently degrades to polling, which is a choice, not a default');
    if (exports.WS_MAX_CLIENTS <= 0)
        problems.push('WS_MAX_CLIENTS must be > 0 (0 means unbounded sockets per process)');
    if (exports.SHUTDOWN_TIMEOUT_MS <= 2_000)
        problems.push('SHUTDOWN_TIMEOUT_MS must leave room to drain in-flight requests and let the crank finish its current iteration');
    // A gate that is "on" but cannot see a country is worse than off: it produces a config that looks
    // compliant in review and sells to nobody/everybody depending on who reads the code first.
    const geoProblem = (0, geo_ts_1.geoMisconfiguration)();
    if (geoProblem)
        problems.push(`GEO: ${geoProblem}`);
    if (problems.length)
        throw new Error(`refusing to start in production:\n  - ${problems.join('\n  - ')}`);
}
/** Handle rules (mirrors openapi.yaml /me/handle). */
const geo_ts_1 = require("./geo.ts");
exports.HANDLE_RE = /^[a-zA-Z0-9_]{3,16}$/;
exports.HANDLE_RESERVE_MS = 120_000;
exports.HANDLE_CHANGE_COOLDOWN_S = 30 * 86_400;
exports.HANDLE_QUARANTINE_S = 90 * 86_400;
exports.HANDLE_BLOCKLIST = new Set(['admin', 'administrator', 'guttercaps', 'gutter_caps', 'support', 'moderator', 'mod', 'treasury', 'solana', 'seeker', 'skr', 'official', 'team', 'root', 'system', 'null', 'undefined']);
/** Backfill / listen tuning. */
exports.BACKFILL_PAGE = Number(env.BACKFILL_PAGE ?? 1000);
exports.BACKFILL_CONCURRENCY = Number(env.BACKFILL_CONCURRENCY ?? 4);
exports.LISTEN_RECONNECT_MS = Number(env.LISTEN_RECONNECT_MS ?? 5_000);
/** The listener periodically re-scans the last N signatures per program to heal gaps (WS drops). */
exports.LISTEN_HEAL_EVERY_MS = Number(env.LISTEN_HEAL_EVERY_MS ?? 60_000);
exports.LISTEN_HEAL_DEPTH = Number(env.LISTEN_HEAL_DEPTH ?? 200);
/**
 * Pyth (owner decision Q7 — we run our own price pusher, ops/pyth-pusher/). The API quotes from
 * the push-oracle accounts of PYTH_SHARD_ID (default 0xCA75 — packages/economy/src/oracle.ts) and
 * hands the same accounts to the client. Override per account when GameConfig points elsewhere
 * (e.g. the Pyth-sponsored shard 0 during an incident).
 */
exports.PYTH_SHARD_ID = Number(env.PYTH_SHARD_ID ?? 0xca75);
exports.PYTH_ACCOUNTS = {
    SOL: env.PYTH_SOL_ACCOUNT ? new web3_js_1.PublicKey(env.PYTH_SOL_ACCOUNT) : undefined,
    SKR: env.PYTH_SKR_ACCOUNT ? new web3_js_1.PublicKey(env.PYTH_SKR_ACCOUNT) : undefined,
};
/** pyth-cache worker: how often oracle_prices is refreshed from the chain (ms). */
exports.PYTH_CACHE_EVERY_MS = Number(env.PYTH_CACHE_EVERY_MS ?? 10_000);
/** /packs/quote: the API's own view of a price is considered fresh for this long (ms) before it re-reads the chain. */
exports.QUOTE_CACHE_MS = Number(env.QUOTE_CACHE_MS ?? 2_000);
/** Switchboard queue the quote advertises to the client (per cluster; devnet default). */
exports.SWITCHBOARD_QUEUE = env.SWITCHBOARD_QUEUE ?? (exports.RPC_URL.includes('mainnet') ? 'A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w' : 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7');
/**
 * Switchboard On-Demand program — a DIFFERENT program per cluster (SEC-H1): the crank's reveal /
 * close instructions carry it as an account and the on-chain programs pin it, so it must match
 * the cluster the programs were built for (`programs/chip_core/src/randomness.rs`; sync-check).
 * Localnet: set to the `sb_mock` id (`ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH`).
 */
exports.SWITCHBOARD_PROGRAM_ID = new web3_js_1.PublicKey(env.SWITCHBOARD_PROGRAM_ID ?? (exports.RPC_URL.includes('mainnet') ? 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv' : 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'));
/**
 * Crank worker (docs/06 §4.3, SEC-I2): reveals oracle randomness and settles pending packs /
 * fusions / wagers for players who closed the app, then reclaims Switchboard rent for them.
 */
/** JSON keypair file (solana-keygen format). Pays tx fees + fronts rent that the programs reimburse. */
exports.CRANK_KEYPAIR = env.CRANK_KEYPAIR ?? '';
exports.CRANK_POLL_MS = Number(env.CRANK_POLL_MS ?? 2_000);
/** Full on-chain sweep (getProgramAccounts) cadence — catches what the indexer's DB has not seen (fusions have no commit event). */
exports.CRANK_SWEEP_MS = Number(env.CRANK_SWEEP_MS ?? 30_000);
exports.CRANK_CONCURRENCY = Number(env.CRANK_CONCURRENCY ?? 4);
/** Alert below this balance (SOL); sending pauses below CRANK_HARD_FLOOR_SOL. Keep ≤ CRANK_MAX_BALANCE_SOL on the hot key. */
exports.CRANK_MIN_BALANCE_SOL = Number(env.CRANK_MIN_BALANCE_SOL ?? 0.5);
exports.CRANK_HARD_FLOOR_SOL = Number(env.CRANK_HARD_FLOOR_SOL ?? 0.05);
exports.CRANK_MAX_BALANCE_SOL = Number(env.CRANK_MAX_BALANCE_SOL ?? 2);
/** Oracle gateway HTTP timeout and the per-job retry ceiling (then `abandoned` + alert). */
exports.CRANK_GATEWAY_TIMEOUT_MS = Number(env.CRANK_GATEWAY_TIMEOUT_MS ?? 10_000);
exports.CRANK_MAX_ATTEMPTS = Number(env.CRANK_MAX_ATTEMPTS ?? 60);
/** Priority fee (µlamports/CU): floor, hard cap, and the "≤ 0.001 SOL per tx" budget cap derived from the CU limit. */
exports.CRANK_CU_PRICE_FLOOR = Number(env.CRANK_CU_PRICE_FLOOR ?? 1_000);
exports.CRANK_CU_PRICE_CAP = Number(env.CRANK_CU_PRICE_CAP ?? 200_000);
exports.CRANK_MAX_FEE_LAMPORTS = Number(env.CRANK_MAX_FEE_LAMPORTS ?? 1_000_000);
/** Stale (refund-window) jobs are re-checked this often so the rent reclaim still happens after the player's refund. */
exports.CRANK_STALE_RECHECK_MS = Number(env.CRANK_STALE_RECHECK_MS ?? 10 * 60_000);
/**
 * Our static Address Lookup Table(s) (docs/06 §4.2 вывод 3, backlog #13): `reveal + open_pack`
 * carries 33–44 account keys and does not fit in one 1 232-byte transaction without one. Created
 * per cluster by `npm run create-lut` (scripts/create-lut.ts); the same address goes to the client
 * as VITE_LOOKUP_TABLE. Comma-separated. Empty → the crank splits reveal and open into two
 * transactions (works for ≤ 3-chip packs; 5-chip $CG bundles then fail with a clear alert).
 */
exports.LOOKUP_TABLES = (env.LOOKUP_TABLE ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => new web3_js_1.PublicKey(s));
/**
 * RPC URL handed to the oracle gateway in the reveal request. The gateway uses it to look at the
 * committed account, so it must be a URL the oracle can reach — and it is sent to a third party,
 * hence never our keyed RPC_URL by default (public cluster endpoint matching the cluster).
 */
exports.CRANK_GATEWAY_RPC = env.CRANK_GATEWAY_RPC ?? (exports.RPC_URL.includes('mainnet') ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
/** Price fallbacks used by /services and /market/floor when no oracle cache exists yet (dev). */
exports.SOL_USD_FALLBACK = Number(env.SOL_USD_FALLBACK ?? 150);
exports.SKR_USD_FALLBACK = Number(env.SKR_USD_FALLBACK ?? 0.0174);

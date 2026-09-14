// Runtime configuration for the backend processes (indexer + API).
// Everything is env-driven with devnet defaults that match client/src/app/config.ts.
import { PublicKey } from '@solana/web3.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

function pk(v: string | undefined, fallback: string): PublicKey {
  return new PublicKey(v && v.length > 0 ? v : fallback);
}

export type ProgramName = 'chip_core' | 'market' | 'staking' | 'arena';

/** The four GUTTERCAPS programs. Same defaults as the client — override per cluster with env. */
export const PROGRAMS: Record<ProgramName, PublicKey> = {
  chip_core: pk(env.PROGRAM_CHIP_CORE, 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q'),
  market: pk(env.PROGRAM_MARKET, 'GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz'),
  staking: pk(env.PROGRAM_STAKING, 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA'),
  arena: pk(env.PROGRAM_ARENA, 'GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM'),
};

export const PROGRAM_NAMES = Object.keys(PROGRAMS) as ProgramName[];

export function programNameOf(id: PublicKey | string): ProgramName | undefined {
  const s = typeof id === 'string' ? id : id.toBase58();
  for (const n of PROGRAM_NAMES) if (PROGRAMS[n].toBase58() === s) return n;
  return undefined;
}

/** Genuine SKR mint — never resolve by symbol (counterfeits exist). */
export const SKR_MINT = new PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3');

export const RPC_URL = env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
export const RPC_WS_URL = env.SOLANA_WS_URL; // optional; web3.js derives it from RPC_URL when unset
export const COMMITMENT = 'confirmed' as const;

const here = path.dirname(fileURLToPath(import.meta.url));
/** SQLite file for local/dev. `:memory:` for tests. Production: Postgres via prisma/schema.prisma (same shapes). */
export const DB_PATH = env.DB_PATH ?? path.join(here, '..', 'guttercaps.sqlite');

export const API_PORT = Number(env.PORT ?? env.API_PORT ?? 8787);
export const API_HOST = env.HOST ?? '0.0.0.0';
/** Comma-separated list; `*` allows any origin (credentials are still cookie-scoped). */
export const CORS_ORIGINS = (env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);

/** HMAC key for session cookies. Ephemeral per process when unset (dev only). */
export const SESSION_SECRET = env.SESSION_SECRET ?? '';
export const SESSION_TTL_S = Number(env.SESSION_TTL_S ?? 7 * 86_400);
export const COOKIE_NAME = 'gc_session';
/** Set when the API is served over https behind a proxy (secure cookies, SameSite=None). */
export const COOKIE_SECURE = (env.COOKIE_SECURE ?? '') === '1';

/** Handle rules (mirrors openapi.yaml /me/handle). */
export const HANDLE_RE = /^[a-zA-Z0-9_]{3,16}$/;
export const HANDLE_RESERVE_MS = 120_000;
export const HANDLE_CHANGE_COOLDOWN_S = 30 * 86_400;
export const HANDLE_QUARANTINE_S = 90 * 86_400;
export const HANDLE_BLOCKLIST = new Set(['admin', 'administrator', 'guttercaps', 'gutter_caps', 'support', 'moderator', 'mod', 'treasury', 'solana', 'seeker', 'skr', 'official', 'team', 'root', 'system', 'null', 'undefined']);

/** Backfill / listen tuning. */
export const BACKFILL_PAGE = Number(env.BACKFILL_PAGE ?? 1000);
export const BACKFILL_CONCURRENCY = Number(env.BACKFILL_CONCURRENCY ?? 4);
export const LISTEN_RECONNECT_MS = Number(env.LISTEN_RECONNECT_MS ?? 5_000);
/** The listener periodically re-scans the last N signatures per program to heal gaps (WS drops). */
export const LISTEN_HEAL_EVERY_MS = Number(env.LISTEN_HEAL_EVERY_MS ?? 60_000);
export const LISTEN_HEAL_DEPTH = Number(env.LISTEN_HEAL_DEPTH ?? 200);

/** Price fallbacks used by /services and /market/floor when no oracle cache exists yet (dev). */
export const SOL_USD_FALLBACK = Number(env.SOL_USD_FALLBACK ?? 150);
export const SKR_USD_FALLBACK = Number(env.SKR_USD_FALLBACK ?? 0.0174);

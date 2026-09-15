// Typed access to Vite env. Everything here is public (bundled into the
// client) — never put secrets in VITE_* vars.
import { PublicKey, clusterApiUrl } from '@solana/web3.js';

export type Cluster = 'devnet' | 'mainnet-beta' | 'localnet';

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined || v === '') return dflt;
  return v === 'true' || v === '1';
}

function pk(v: string | undefined, fallback: string): PublicKey {
  try {
    return new PublicKey(v && v.length > 0 ? v : fallback);
  } catch {
    return new PublicKey(fallback);
  }
}

const env = import.meta.env;

export const CLUSTER: Cluster = (env.VITE_CLUSTER as Cluster | undefined) ?? 'devnet';

export const RPC_URL: string =
  env.VITE_RPC_URL && env.VITE_RPC_URL.length > 0
    ? env.VITE_RPC_URL
    : CLUSTER === 'localnet'
      ? 'http://127.0.0.1:8899'
      : clusterApiUrl(CLUSTER);

export const RPC_WS_URL: string | undefined =
  env.VITE_RPC_WS_URL && env.VITE_RPC_WS_URL.length > 0 ? env.VITE_RPC_WS_URL : undefined;

export const API_BASE: string = env.VITE_API_BASE ?? '/v1';
export const WS_BASE: string = env.VITE_WS_BASE ?? '/ws';

export const FLAGS = {
  geoGate: bool(env.VITE_FLAG_GEO_GATE),
  limitedPackPreview: bool(env.VITE_FLAG_LIMITED_PACK),
  debugPanel: bool(env.VITE_FLAG_DEBUG_PANEL, env.DEV),
  /** Use the deterministic in-browser mock API instead of the backend. Auto-enabled in dev when /v1/health is unreachable. */
  apiMock: bool(env.VITE_API_MOCK),
} as const;

export const ONRAMP_URL: string = env.VITE_ONRAMP_URL ?? 'https://buy.moonpay.com/?defaultCurrencyCode=sol';

// Program ids — placeholders until `anchor keys sync` (see programs/README.md).
export const PROGRAM_IDS = {
  chipCore: pk(env.VITE_PROGRAM_CHIP_CORE, 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q'),
  market: pk(env.VITE_PROGRAM_MARKET, 'GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz'),
  staking: pk(env.VITE_PROGRAM_STAKING, 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA'),
  arena: pk(env.VITE_PROGRAM_ARENA, 'GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM'),
} as const;

export const MINTS = {
  /** Filled after `scripts/setup.ts`; empty → $CG features render in "not deployed" state. */
  cg: env.VITE_CG_MINT && env.VITE_CG_MINT.length > 0 ? new PublicKey(env.VITE_CG_MINT) : undefined,
  usdc: pk(
    env.VITE_USDC_MINT,
    CLUSTER === 'mainnet-beta' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  ),
  /**
   * Seeker (SKR) — Solana Mobile's ecosystem token (SPL Token, 6 dp). Only the
   * mainnet mint is canonical; on devnet a test mint is created by scripts/setup.ts
   * and passed via VITE_SKR_MINT. Empty → SKR rail hidden in the UI.
   */
  skr: env.VITE_SKR_MINT && env.VITE_SKR_MINT.length > 0
    ? new PublicKey(env.VITE_SKR_MINT)
    : CLUSTER === 'mainnet-beta' ? new PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3') : undefined,
} as const;

/**
 * Static Address Lookup Table created by `npm run create-lut` (docs/06 §4.2 вывод 3): lets
 * `reveal + open_pack` land in ONE transaction. Unset → the flows send reveal and open separately
 * (fine for 3-chip packs; 5-chip $CG bundles need the table).
 */
export const LOOKUP_TABLE: PublicKey | undefined = env.VITE_LOOKUP_TABLE && env.VITE_LOOKUP_TABLE.length > 0 ? new PublicKey(env.VITE_LOOKUP_TABLE) : undefined;

export const EXPLORER = {
  tx: (sig: string) => `https://solscan.io/tx/${sig}${CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER === 'localnet' ? 'custom' : CLUSTER}`}`,
  account: (key: string) => `https://solscan.io/account/${key}${CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER === 'localnet' ? 'custom' : CLUSTER}`}`,
};

export const APP_NAME = 'GUTTERCAPS';

// One gauge, one job: "how much SOL is left on the key that opens packs".
//
// It is a scrape-time gauge rather than a polled timer because the answer is only needed when someone
// is looking, and because the RPC call is the failure mode: an unreachable RPC returns -1 (and the
// alert on `< 0.5` would then fire for the wrong reason), so the series also carries the reason as a
// separate 0/1 `crank_balance_readable`.
import { CRANK_KEYPAIR, RPC_URL } from './config.ts';
import { metrics } from './metrics.ts';
import { log, errFields } from './log.ts';

const cache = { at: 0, sol: -1, readable: 0 };
const TTL_MS = 30_000;

/**
 * Two series, not one with a label: `crank_balance_readable` exists so the `< 0.5` alert can say "and
 * we actually looked" — a labeled gauge would hide the unreadable state inside a series whose value is
 * still the last known good number, which is precisely how a monitoring lie is born.
 */
export async function balanceGauge(): Promise<{ value: number }[]> {
  if (!CRANK_KEYPAIR) return [{ value: -1 }, { value: 0 }];
  if (Date.now() - cache.at < TTL_MS) return [{ value: cache.sol }, { value: cache.readable }];
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(CRANK_KEYPAIR, 'utf8');
    const arr = JSON.parse(raw) as number[];
    // Accept both shapes people actually use: a 64-byte secret key array and a keypair.json file.
    const { Keypair } = await import('@solana/web3.js');
    const pk = arr.length === 64 ? Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey : new PublicKey(String(raw.trim()));
    const lamports = await new Connection(RPC_URL, 'confirmed').getBalance(pk);
    cache.at = Date.now();
    cache.sol = lamports / 1e9;
    cache.readable = 1;
  } catch (e) {
    cache.at = Date.now();
    cache.readable = 0; // keep the last known balance, mark it unreadable, and never throw from a scrape
    log.warn('crank balance read failed', errFields(e));
  }
  return [{ value: cache.sol }, { value: cache.readable }];
}

/** Same numbers, for the /health payload and the alert annotations. */
export function lastBalance() { return { sol: cache.sol, readable: cache.readable === 1, ageMs: Date.now() - cache.at }; }
void metrics;

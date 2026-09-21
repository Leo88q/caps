/** Shared backend entry point for Bubblegum V2 DAS reads. */
import { DAS_RPC_URL, DAS_TIMEOUT_MS } from './config.ts';
import { DasClient } from './das.ts';

let client: DasClient | undefined;

export function getDasClient(): DasClient {
  return client ??= new DasClient({ endpoint: DAS_RPC_URL, timeoutMs: DAS_TIMEOUT_MS });
}

/** Reset hook for isolated tests and provider failover tests. */
export function resetDasClient(): void {
  client = undefined;
}

// Switchboard On-Demand randomness for pack opens, risky fusions and wagers.
// The SDK is heavy (~250 KB) so everything here is behind dynamic imports and
// only loaded when a user actually starts a commit-reveal flow.
import { Connection, Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { CLUSTER } from '@/app/config';
import { SWITCHBOARD_ON_DEMAND_ID, SWITCHBOARD_QUEUE } from './ids';

type Sb = typeof import('@switchboard-xyz/on-demand');
type SbProgram = Awaited<ReturnType<Sb['AnchorUtils']['loadProgramFromConnection']>>;

let sbMod: Promise<Sb> | undefined;
const loadSb = () => (sbMod ??= import('@switchboard-xyz/on-demand'));

const programCache = new WeakMap<Connection, Promise<SbProgram>>();

async function sbProgram(connection: Connection, payer: PublicKey): Promise<SbProgram> {
  let p = programCache.get(connection);
  if (!p) {
    p = (async () => {
      const sb = await loadSb();
      // A "wallet" that can't sign: we never let the SDK send; we only build ixs.
      const wallet = {
        publicKey: payer,
        signTransaction: async () => { throw new Error('read-only'); },
        signAllTransactions: async () => { throw new Error('read-only'); },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return sb.AnchorUtils.loadProgramFromConnection(connection, wallet as any, SWITCHBOARD_ON_DEMAND_ID);
    })();
    programCache.set(connection, p);
  }
  return p;
}

export function defaultQueue(): PublicKey {
  return SWITCHBOARD_QUEUE[CLUSTER];
}

export interface RandomnessCommit {
  /** the randomness account (also a required signer for `create`) */
  keypair: Keypair;
  pubkey: PublicKey;
  /** [randomness_init, randomness_commit] — MUST be in the same tx as buy_pack / fuse / create_battle */
  ixs: TransactionInstruction[];
}

/** Build create+commit instructions for a brand-new randomness account. */
export async function prepareRandomness(connection: Connection, payer: PublicKey, queue: PublicKey = defaultQueue()): Promise<RandomnessCommit> {
  const sb = await loadSb();
  const program = await sbProgram(connection, payer);
  const kp = Keypair.generate();
  const [randomness, initIx] = await sb.Randomness.create(program, kp, queue, payer);
  const commitIx = await randomness.commitIx(queue, payer);
  return { keypair: kp, pubkey: randomness.pubkey, ixs: [initIx, commitIx] };
}

/**
 * Fetch the oracle's reveal for a committed account. The SDK waits ~3 s and
 * calls the oracle gateway; we retry with backoff because the oracle needs the
 * committed slot to be finalized. Resolves to the reveal instruction plus the
 * 32 revealed bytes (parsed from the instruction data so the UI can pre-simulate
 * the roll before the chain confirms).
 */
export async function prepareReveal(
  connection: Connection,
  payer: PublicKey,
  randomness: PublicKey,
  opts: { maxWaitMs?: number; onAttempt?: (n: number) => void } = {},
): Promise<{ ix: TransactionInstruction; value: Uint8Array }> {
  const sb = await loadSb();
  const program = await sbProgram(connection, payer);
  const r = new sb.Randomness(program, randomness);
  const deadline = Date.now() + (opts.maxWaitMs ?? 60_000);
  let delay = 1_000;
  let attempt = 0;
  for (;;) {
    attempt++;
    opts.onAttempt?.(attempt);
    try {
      const ix = await r.revealIx(payer);
      return { ix, value: revealValueFromIx(ix) };
    } catch (e) {
      if (Date.now() + delay > deadline) throw e;
      await new Promise((f) => setTimeout(f, delay));
      delay = Math.min(delay * 2, 8_000);
    }
  }
}

/**
 * randomness_reveal data layout: 8 (discriminator) ‖ signature[64] ‖ recovery_id u8 ‖ value[32].
 */
export function revealValueFromIx(ix: TransactionInstruction): Uint8Array {
  const d = ix.data;
  if (d.length < 8 + 64 + 1 + 32) throw new Error('unexpected reveal ix layout');
  return new Uint8Array(d.subarray(8 + 64 + 1, 8 + 64 + 1 + 32));
}

/** Decode the on-chain RandomnessAccountData enough to know whether it has been revealed. */
export async function readRandomness(connection: Connection, payer: PublicKey, randomness: PublicKey): Promise<{ seedSlot: bigint; revealSlot: bigint; value: Uint8Array | null } | null> {
  const program = await sbProgram(connection, payer);
  try {
    const r = new (await loadSb()).Randomness(program, randomness);
    const data = await r.loadData();
    const seedSlot = BigInt(data.seedSlot.toString());
    const revealSlot = BigInt(data.revealSlot.toString());
    const value = revealSlot > 0n ? Uint8Array.from(data.value as number[]) : null;
    return { seedSlot, revealSlot, value };
  } catch {
    return null;
  }
}

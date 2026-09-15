// Switchboard On-Demand randomness for pack opens, risky fusions and wagers.
//
// SEC-C3 part 2: the randomness account is a PDA of OUR program (`["rng", kind,
// owner, nonce]`) whose Switchboard `authority` is the program's `["rng_auth"]`
// PDA. The client therefore never holds a randomness keypair and never signs a
// Switchboard instruction itself:
//   init   → `init_randomness` (chip_core) / `init_battle_randomness` (arena) — CPI randomness_init
//   commit → done INSIDE buy_pack / fuse / create_battle (CPI, PDA-signed)
//   reveal → `reveal_randomness` / `reveal_battle_randomness` (permissionless relay of the
//            oracle gateway response; CPI randomness_reveal, PDA-signed) — the crank or the player
//   close  → `close_randomness` / `close_battle_randomness` (rent back to the player, SEC-M7)
// The SDK (~250 KB) is only used to pick a healthy oracle and to talk to the oracle gateway,
// so it stays behind dynamic imports.
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { CLUSTER } from '@/app/config';
import { SWITCHBOARD_ON_DEMAND_ID, SWITCHBOARD_QUEUE } from './ids';
import { closeRandomnessIx, initRandomnessIx, revealRandomnessIx, rngAccounts, type RngAccounts } from './ix/rng';
import type { RngKind } from './pdas';

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
      // A "wallet" that can't sign: we never let the SDK send; we only read and build.
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

export interface RandomnessPrep extends RngAccounts {
  /** the pinned queue and the oracle chosen for this request (both go into the commit accounts) */
  queue: PublicKey;
  oracle: PublicKey;
  /** [init_randomness] — MUST be in the same tx as buy_pack / fuse / create_battle (they commit) */
  ixs: TransactionInstruction[];
}

/**
 * Pick a healthy randomness oracle from the queue (SDK health snapshots + on-chain heartbeat).
 * On localnet `sb_mock` ignores the oracle, so any key works.
 */
export async function selectOracle(connection: Connection, payer: PublicKey, queue: PublicKey = defaultQueue()): Promise<PublicKey> {
  if (CLUSTER === 'localnet') return queue;
  const sb = await loadSb();
  const program = await sbProgram(connection, payer);
  const { oracle } = await new sb.Queue(program, queue).selectRandomnessOracle();
  return oracle.pubkey;
}

/** Build the init instruction for the program-owned randomness account of (kind, owner, nonce). */
export async function prepareRandomness(
  connection: Connection, owner: PublicKey, kind: RngKind, nonce: bigint, queue: PublicKey = defaultQueue(),
): Promise<RandomnessPrep> {
  const [oracle, recentSlot] = await Promise.all([selectOracle(connection, owner, queue), connection.getSlot('finalized')]);
  const acc = rngAccounts(kind, owner, nonce);
  return { ...acc, queue, oracle, ixs: [initRandomnessIx({ ...acc, queue, recentSlot: BigInt(recentSlot) })] };
}

/**
 * Fetch the oracle's reveal for a committed account and wrap it into our permissionless
 * `reveal_randomness` instruction. The SDK waits ~3 s and calls the oracle gateway; we retry
 * with backoff because the oracle needs the committed slot to be finalized. Resolves to the
 * instruction plus the 32 revealed bytes (so the UI can pre-simulate the roll before the chain
 * confirms).
 */
export async function prepareReveal(
  connection: Connection,
  payer: PublicKey,
  kind: RngKind,
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
      // The SDK instruction targets Switchboard directly with `authority` as a signer we do not
      // have (it is our PDA); we only borrow its gateway round-trip and re-wrap the payload.
      const sdkIx = await r.revealIx(payer);
      const reveal = revealPayloadFromIx(sdkIx);
      const oracle = sdkIx.keys[1].pubkey;
      const queue = sdkIx.keys[2].pubkey;
      const ix = revealRandomnessIx({ kind, payer, randomness, oracle, queue, ...reveal });
      return { ix, value: reveal.value };
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
export function revealPayloadFromIx(ix: TransactionInstruction): { signature: Uint8Array; recoveryId: number; value: Uint8Array } {
  const d = ix.data;
  if (d.length < 8 + 64 + 1 + 32) throw new Error('unexpected reveal ix layout');
  return {
    signature: new Uint8Array(d.subarray(8, 8 + 64)),
    recoveryId: d[8 + 64],
    value: new Uint8Array(d.subarray(8 + 64 + 1, 8 + 64 + 1 + 32)),
  };
}
export const revealValueFromIx = (ix: TransactionInstruction): Uint8Array => revealPayloadFromIx(ix).value;

export interface RandomnessView {
  authority: PublicKey;
  queue: PublicKey;
  oracle: PublicKey;
  seedSlot: bigint;
  revealSlot: bigint;
  lutSlot: bigint;
  value: Uint8Array | null;
}

/** Decode the on-chain RandomnessAccountData (authority / oracle / slots / revealed value). */
export async function readRandomness(connection: Connection, payer: PublicKey, randomness: PublicKey): Promise<RandomnessView | null> {
  const program = await sbProgram(connection, payer);
  try {
    const r = new (await loadSb()).Randomness(program, randomness);
    const data = await r.loadData();
    const seedSlot = BigInt(data.seedSlot.toString());
    const revealSlot = BigInt(data.revealSlot.toString());
    const value = revealSlot > 0n ? Uint8Array.from(data.value as number[]) : null;
    return {
      authority: new PublicKey(data.authority), queue: new PublicKey(data.queue), oracle: new PublicKey(data.oracle),
      seedSlot, revealSlot, lutSlot: BigInt(data.lutSlot.toString()), value,
    };
  } catch {
    return null;
  }
}

/**
 * Rent reclaim (SEC-M7): after the pending pack / fusion is closed (battle settled), anyone can
 * close the randomness account; Switchboard pays the rent to `rng_auth` and the program forwards
 * it to the player. Returns null when the account is already gone.
 */
export async function prepareClose(
  connection: Connection, payer: PublicKey, kind: RngKind, owner: PublicKey, nonce: bigint,
): Promise<TransactionInstruction | null> {
  const acc = rngAccounts(kind, owner, nonce);
  const view = await readRandomness(connection, payer, acc.randomness);
  if (!view) return null;
  return closeRandomnessIx({ ...acc, payer, lutSlot: view.lutSlot });
}

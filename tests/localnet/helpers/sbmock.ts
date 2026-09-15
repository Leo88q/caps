// Switchboard On-Demand mock helpers (programs/sb_mock).
//
// Our programs do init / commit / reveal / close by CPI with the `rng_auth` PDA, so the
// happy path never talks to the mock directly — it goes through the real client builders
// (`initRandomnessIx`, `buyPackIx` (commit inside), `revealRandomnessIx`, `closeRandomnessIx`).
// What lives here:
//   * `randomnessAccount(...)` — decode the 480-byte account (same reader as the crank),
//   * `revealIx(...)`         — the permissionless reveal through OUR program with a chosen
//                               32-byte value (the "oracle signature" is 64 zero bytes: the mock
//                               does not verify secp256k1),
//   * `mockInitIx(...)`       — call the mock's `randomness_init` DIRECTLY with an arbitrary
//                               authority (negative tests: authority ≠ rng_auth → `RandomnessAuthority`),
//   * `setRawIx(...)`         — overwrite fields of a mock-owned account (negative tests),
//   * `forgeRandomness(...)`  — LiteSVM only: a byte-identical account under a *foreign* owner
//                               (SEC-C1 / T-L-C10: `RandomnessMismatch`).
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BorshReader, BorshWriter } from '@/chain/borsh';
import { expectDiscriminator, ixData, ro, rw, signer } from '@/chain/anchor';
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ID, SWITCHBOARD_ON_DEMAND_ID, WSOL_MINT } from '@/chain/ids';
import { RNG_KIND, rngAccounts, revealRandomnessIx, closeRandomnessIx, initRandomnessIx } from '@/chain/ix/rng';
import { sbLutPda, sbLutSignerPda, sbRewardEscrow, sbStatePda, type RngKind } from '@/chain/pdas';
import type { Chain } from './chain';
import { SB_ORACLE, SB_QUEUE } from './env';

export { RNG_KIND, rngAccounts, initRandomnessIx, closeRandomnessIx };

export const RANDOMNESS_SIZE = 480;
export const RANDOMNESS_DISC = Uint8Array.from([10, 66, 229, 135, 220, 239, 217, 114]);
export const ZERO_SIG = new Uint8Array(64);

export interface RandomnessData {
  authority: PublicKey; queue: PublicKey; seedSlothash: Uint8Array; seedSlot: bigint; oracle: PublicKey; revealSlot: bigint; value: Uint8Array; lutSlot: bigint;
}

export function decodeRandomness(data: Uint8Array): RandomnessData {
  const r: BorshReader = expectDiscriminator(data, 'RandomnessAccountData');
  if (data.length < RANDOMNESS_SIZE) throw new Error(`RandomnessAccountData: ${data.length} bytes`);
  return { authority: r.pubkey(), queue: r.pubkey(), seedSlothash: r.bytes(32), seedSlot: r.u64(), oracle: r.pubkey(), revealSlot: r.u64(), value: r.bytes(32), lutSlot: r.u64() };
}

export async function randomnessAccount(chain: Chain, key: PublicKey): Promise<RandomnessData | null> {
  const a = await chain.getAccount(key);
  return a && a.data.length ? decodeRandomness(a.data) : null;
}

/** Encode a full 472-byte payload (everything after the discriminator) for `set_raw` / `forgeRandomness`. */
export function encodeRandomnessPayload(d: Partial<RandomnessData>): Uint8Array {
  const w = new BorshWriter()
    .pubkey(d.authority ?? PublicKey.default).pubkey(d.queue ?? SB_QUEUE).bytes(d.seedSlothash ?? new Uint8Array(32)).u64(d.seedSlot ?? 0n)
    .pubkey(d.oracle ?? SB_ORACLE).u64(d.revealSlot ?? 0n).bytes(d.value ?? new Uint8Array(32)).u64(d.lutSlot ?? 0n);
  const head = w.toBytes();
  const out = new Uint8Array(RANDOMNESS_SIZE - 8);
  out.set(head, 0);
  return out;
}

/** Deterministic 32-byte "oracle value" for a scenario (e.g. `valueOf('C07')`). */
export function valueOf(label: string, salt = 0): Uint8Array {
  const out = new Uint8Array(32);
  const src = new TextEncoder().encode(`${label}:${salt}`);
  let h = 2166136261;
  for (let i = 0; i < 32; i++) {
    h ^= src[i % src.length] + i;
    h = Math.imul(h, 16777619) >>> 0;
    out[i] = (h >>> ((i % 4) * 8)) & 0xff;
  }
  return out;
}

/** Reveal through our program (chip_core `reveal_randomness` / arena `reveal_battle_randomness`) with a chosen value. */
export function revealIx(a: { kind: RngKind; payer: PublicKey; randomness: PublicKey; value: Uint8Array; oracle?: PublicKey; queue?: PublicKey }): TransactionInstruction {
  return revealRandomnessIx({ kind: a.kind, payer: a.payer, randomness: a.randomness, oracle: a.oracle ?? SB_ORACLE, queue: a.queue ?? SB_QUEUE, signature: ZERO_SIG, recoveryId: 0, value: a.value });
}

/**
 * Call the MOCK's `randomness_init` directly (bypassing our programs) — `randomness` is a fresh
 * keypair, `authority` any key you want stored. Used for the "authority ≠ rng_auth" scenarios.
 */
export function mockInitIx(a: { payer: PublicKey; randomness: PublicKey; authority: PublicKey; recentSlot: bigint; queue?: PublicKey }): TransactionInstruction {
  const lutSigner = sbLutSignerPda(a.randomness)[0];
  return new TransactionInstruction({
    programId: SWITCHBOARD_ON_DEMAND_ID,
    keys: [
      signer(a.randomness), rw(sbRewardEscrow(a.randomness)), signer(a.authority, false), rw(a.queue ?? SB_QUEUE), signer(a.payer),
      ro(SystemProgram.programId), ro(TOKEN_PROGRAM_ID), ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(WSOL_MINT), ro(sbStatePda()[0]),
      ro(lutSigner), rw(sbLutPda(lutSigner, a.recentSlot)[0]), ro(ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('randomness_init', new BorshWriter().u64(a.recentSlot).toBytes())),
  });
}

/** Mock-only `set_raw(payload)`: overwrite bytes after the discriminator of a mock-owned account. */
export function setRawIx(a: { payer: PublicKey; randomness: PublicKey; payload: Uint8Array }): TransactionInstruction {
  const w = new BorshWriter();
  w.vec(Array.from(a.payload), (b) => w.u8(b));
  return new TransactionInstruction({
    programId: SWITCHBOARD_ON_DEMAND_ID,
    keys: [rw(a.randomness), signer(a.payer, false)],
    data: Buffer.from(ixData('set_raw', w.toBytes())),
  });
}

/**
 * LiteSVM only: write a byte-perfect RandomnessAccountData (revealed, authority = rng_auth of
 * `kind`) at an arbitrary address under `owner`. With `owner ≠ sb_mock` this is exactly the
 * SEC-C1 attack: a look-alike account carrying a chosen value.
 */
export async function forgeRandomness(chain: Chain, a: { owner: PublicKey; kind: RngKind; seedSlot: bigint; revealSlot: bigint; value: Uint8Array; address?: PublicKey }): Promise<PublicKey> {
  const address = a.address ?? Keypair.generate().publicKey;
  const authority = rngAccounts(a.kind, PublicKey.default, 0n).rngAuth;
  const data = new Uint8Array(RANDOMNESS_SIZE);
  data.set(RANDOMNESS_DISC, 0);
  data.set(encodeRandomnessPayload({ authority, seedSlot: a.seedSlot, revealSlot: a.revealSlot, value: a.value }), 8);
  await chain.setAccount(address, { owner: a.owner, data });
  return address;
}

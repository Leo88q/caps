// One transaction/account API for both localnet back-ends of the suite:
//
//   * `LiteSvmChain` — in-process SVM (litesvm). Loads the compiled programs from
//     `target/deploy/*.so` (+ a dump of Metaplex Core), controls the Clock / SlotHashes
//     (`warpSlots`, `warpSeconds`) and can forge any account (`setAccount`) — that is
//     what the SEC-C1 "look-alike randomness account" and the 72-minute stale-pack
//     scenarios need. Default for `npm test`.
//   * `RpcChain` — a real validator (`anchor test` / `solana-test-validator`) through
//     web3.js `Connection`. No clock control: scenarios that need it are skipped
//     (`it.skipIf(!chain.canWarp)`), everything else runs against the exact same specs.
//
// Both return the same `TxResult` and throw the same `TxFailure` (custom error code +
// the program that raised it, parsed from the logs), so assertions stay back-end agnostic.
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { existsSync } from 'node:fs';
import { recordCu } from './cu';
import { ARENA_ID, CHIP_CORE_ID, MARKET_ID, MPL_CORE_ID, STAKING_ID, SWITCHBOARD_ON_DEMAND_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@/chain/ids';

/** litesvm's kit wrapper types addresses as a branded string — one cast at the boundary. */
const addr = (k: PublicKey) => k.toBase58() as never;

export interface AccountView { owner: PublicKey; data: Uint8Array; lamports: bigint; executable: boolean }
export interface TxResult { signature: string; logs: string[]; cu: bigint }
export interface SendOpts { signers?: Keypair[]; payer?: Keypair; cu?: number; label?: string }

export class TxFailure extends Error {
  constructor(
    message: string,
    public readonly logs: string[],
    /** Anchor / SPL custom error code, if the failure was `custom program error` */
    public readonly code?: number,
    /** program that raised it (from `Program X failed`) */
    public readonly programId?: string,
    /** raw error string from the runtime */
    public readonly raw?: string,
  ) { super(message); this.name = 'TxFailure'; }
}

/**
 * `Program <id> failed: custom program error: 0x1770` → { code, programId }. The FIRST failing program
 * wins: on a CPI failure the runtime logs the inner `failed:` line before the outer one with the same
 * code, and the inner program is the one whose error table applies (e.g. chip_core::ChipNotFree
 * surfacing through market::list). Same rule as the client (`parseCustomError`).
 */
export function parseFailure(logs: string[], raw: string): { code?: number; programId?: string } {
  let code: number | undefined;
  let programId: string | undefined;
  for (const l of logs) {
    const m = /Program (\w+) failed: custom program error: (0x[0-9a-fA-F]+|\d+)/.exec(l);
    if (m) { programId = m[1]; code = m[2].startsWith('0x') ? parseInt(m[2], 16) : Number(m[2]); break; }
  }
  if (code === undefined) {
    const m = /[Cc]ustom(?:ProgramError|\()?[^0-9]*(\d+)/.exec(raw) ?? /custom program error: (0x[0-9a-fA-F]+)/.exec(raw);
    if (m) code = m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
  }
  return { code, programId };
}

/**
 * CPI breadcrumb trail for failure triage. LiteSVM records the inner instructions that actually
 * EXECUTED — including on a failed transaction — so for `UnbalancedInstruction` / pre-CPI crashes
 * this names the exact CPI sequence that ran before the runtime rejected the tx. The logs alone
 * cannot do that: the digest cap cuts them mid-line, and `UnbalancedInstruction` never says which
 * leg moved the lamports. One line per inner instruction: `[outer#n depth] program ix-data[0..8]`.
 */
export function innerTrace(
  inner: readonly (readonly unknown[])[],
  tx: Transaction,
): string {
  if (!inner || inner.length === 0) return '';
  const names = new Map<string, string>([
    [CHIP_CORE_ID.toBase58(), 'chip_core'],
    [MARKET_ID.toBase58(), 'market'],
    [ARENA_ID.toBase58(), 'arena'],
    [STAKING_ID.toBase58(), 'staking'],
    [MPL_CORE_ID.toBase58(), 'mpl_core'],
    [TOKEN_PROGRAM_ID.toBase58(), 'token'],
    [SYSTEM_PROGRAM_ID.toBase58(), 'system'],
    [SWITCHBOARD_ON_DEMAND_ID.toBase58(), 'switchboard'],
  ]);
  const short = (id: PublicKey): string => names.get(id.toBase58()) ?? id.toBase58().slice(0, 6) + '…';
  let keys: PublicKey[] = [];
  try { keys = tx.compileMessage().accountKeys; } catch { return ''; }
  const lines: string[] = [];
  // inner[] indexes are MESSAGE indexes — `chain.send` prepends the compute-budget ix, so the
  // outer program must be read from the tx's own instruction list, not the caller's `ixs`
  inner.forEach((list, i) => {
    const outerIx = tx.instructions[i];
    const outer = outerIx ? short(outerIx.programId) : `ix${i}`;
    lines.push(`inner# ${i} (${outer}): ${list.length} cpi`);
    for (const raw of list as { instruction?: () => { programIdIndex: () => number; data: () => Uint8Array }; stackHeight?: () => number }[]) {
      try {
        const ci = raw.instruction!();
        const pid = keys[ci.programIdIndex()] ?? SystemProgram.programId;
        const data = ci.data();
        const head = Array.from(data.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
        lines.push(`  [d${raw.stackHeight?.() ?? '?'}] ${short(pid)} data=${head}${data.length > 8 ? `+${data.length - 8}B` : ''}`);
      } catch { lines.push('  [?] <unreadable inner>'); }
    }
  });
  return lines.join('\n');
}

export interface Chain {
  readonly kind: 'litesvm' | 'rpc';
  readonly canWarp: boolean;
  /** funded fee payer / admin of the whole environment */
  readonly admin: Keypair;
  airdrop(to: PublicKey, lamports: bigint): Promise<void>;
  send(ixs: TransactionInstruction[], opts?: SendOpts): Promise<TxResult>;
  getAccount(key: PublicKey): Promise<AccountView | null>;
  /** LiteSVM only — create/overwrite an account bypassing the runtime (forged owners, stale oracles). */
  setAccount(key: PublicKey, acc: { owner: PublicKey; data: Uint8Array; lamports?: bigint }): Promise<void>;
  balance(key: PublicKey): Promise<bigint>;
  slot(): Promise<bigint>;
  now(): Promise<bigint>;
  /** LiteSVM only — advance Clock.slot by `n` (and unix_timestamp by ≈ 0.4 s per slot). */
  warpSlots(n: bigint | number): Promise<void>;
  /** LiteSVM only — advance unix_timestamp by `secs` (and the slot accordingly). */
  warpSeconds(secs: bigint | number): Promise<void>;
  rentExempt(space: number): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// LiteSVM
// ---------------------------------------------------------------------------

export interface ProgramBinary { id: PublicKey; path: string }

type Svm = import('litesvm').LiteSVM;

/** web3.js Transaction → the `{ messageBytes, signatures }` shape litesvm's kit wrapper encodes. */
function toKitTx(tx: Transaction) {
  const signatures: Record<string, Uint8Array> = {};
  // a required signer we could not sign for (e.g. a program PDA passed from a wallet) gets an all-zero
  // signature so the SVM rejects the tx with a signature failure instead of the encoder throwing
  for (const s of tx.signatures) signatures[s.publicKey.toBase58()] = s.signature ? new Uint8Array(s.signature) : new Uint8Array(64);
  return { messageBytes: new Uint8Array(tx.serializeMessage()), signatures } as unknown as Parameters<Svm['sendTransaction']>[0];
}

export class LiteSvmChain implements Chain {
  readonly kind = 'litesvm' as const;
  readonly canWarp = true;
  readonly admin = Keypair.generate();
  private svm!: Svm;
  private txCounter = 0;

  static async create(programs: ProgramBinary[], opts: { startSlot?: bigint; startUnixTs?: bigint } = {}): Promise<LiteSvmChain> {
    const { LiteSVM } = await import('litesvm');
    const c = new LiteSvmChain();
    c.svm = new LiteSVM().withNativeMints().withLogBytesLimit();
    for (const p of programs) {
      if (!existsSync(p.path)) throw new Error(`program binary missing: ${p.path} (run \`anchor build -- --features localnet\` / see tests/localnet/README.md)`);
      try {
        c.svm.addProgramFromFile(addr(p.id), p.path);
      } catch (e) {
        // Without this the annotation says «Offset or value is out of bounds» and you get to guess
        // WHICH of the ~10 binaries (ours + fixtures) litesvm refused — see tests/localnet/README.md.
        throw new Error(`failed to load program ${p.id} from ${p.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // A fresh LiteSVM starts at unix_timestamp 0 — every time-lock in the programs would be "expired".
    const clock = c.svm.getClock();
    clock.slot = opts.startSlot ?? 100_000n;
    clock.unixTimestamp = opts.startUnixTs ?? BigInt(Math.floor(Date.now() / 1000));
    c.svm.setClock(clock);
    c.refreshSlotHashes();
    await c.airdrop(c.admin.publicKey, 10_000n * 1_000_000_000n);
    return c;
  }

  /** SlotHashes must contain the previous slots (Switchboard-shaped code reads it; ALT creation checks it). */
  private refreshSlotHashes() {
    const slot = this.svm.getClock().slot;
    const bh = this.svm.latestBlockhash();
    const hashes = [] as { slot: bigint; hash: string }[];
    for (let i = 1n; i <= 8n && slot - i >= 0n; i++) hashes.push({ slot: slot - i, hash: bh });
    this.svm.setSlotHashes(hashes);
  }

  async airdrop(to: PublicKey, lamports: bigint) {
    const r = this.svm.airdrop(addr(to), lamports as never);
    if (r && 'err' in r) throw new Error(`airdrop failed: ${String(r.err())}`);
  }

  async send(ixs: TransactionInstruction[], opts: SendOpts = {}): Promise<TxResult> {
    const signers = opts.signers ?? [];
    const payer = opts.payer ?? signers[0] ?? this.admin;
    const all = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
    // new blockhash per tx → identical instruction sets are never rejected as duplicates
    this.svm.expireBlockhash();
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu ?? 1_400_000 }), ...ixs);
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    tx.sign(...all);
    const res = this.svm.sendTransaction(toKitTx(tx));
    const signature = `litesvm-${++this.txCounter}`;
    if ('err' in res) {
      const meta = res.meta();
      const logs = meta.logs();
      const raw = String(res.err());
      const { code, programId } = parseFailure(logs, raw);
      const trace = innerTrace(meta.innerInstructions() as never, tx);
      throw new TxFailure(`${opts.label ?? 'tx'} failed: ${raw}${code !== undefined ? ` (custom ${code}${programId ? ` from ${programId}` : ''})` : ''}${trace ? `\nCPI trace:\n${trace}` : ''}\n${logs.join('\n')}`, logs, code, programId, raw);
    }
    // one slot per transaction, like a (very quiet) real chain — commit/reveal/settle land in distinct slots
    await this.warpSlots(1n);
    const cu = res.computeUnitsConsumed();
    recordCu(opts.label, cu, signature, this.kind, ixs);
    return { signature, logs: res.logs(), cu };
  }

  async getAccount(key: PublicKey): Promise<AccountView | null> {
    const a = this.svm.getAccount(addr(key));
    if (!a.exists) return null;
    return { owner: new PublicKey(a.programAddress), data: new Uint8Array(a.data), lamports: BigInt(a.lamports), executable: a.executable };
  }

  async setAccount(key: PublicKey, acc: { owner: PublicKey; data: Uint8Array; lamports?: bigint }) {
    const lamports = acc.lamports ?? this.svm.minimumBalanceForRentExemption(BigInt(acc.data.length));
    this.svm.setAccount({
      address: addr(key), lamports: lamports as never, data: acc.data, programAddress: addr(acc.owner),
      executable: false, space: BigInt(acc.data.length),
    });
  }

  async balance(key: PublicKey) { return BigInt(this.svm.getBalance(addr(key)) ?? 0n); }
  async slot() { return this.svm.getClock().slot; }
  async now() { return this.svm.getClock().unixTimestamp; }

  async warpSlots(n: bigint | number) {
    const clock = this.svm.getClock();
    const dn = BigInt(n);
    clock.slot += dn;
    clock.unixTimestamp += (dn * 4n) / 10n; // 400 ms slots
    this.svm.setClock(clock);
    this.refreshSlotHashes();
  }

  async warpSeconds(secs: bigint | number) {
    const clock = this.svm.getClock();
    const ds = BigInt(secs);
    clock.unixTimestamp += ds;
    clock.slot += (ds * 10n) / 4n;
    this.svm.setClock(clock);
    this.refreshSlotHashes();
  }

  async rentExempt(space: number) { return this.svm.minimumBalanceForRentExemption(BigInt(space)); }
}

// ---------------------------------------------------------------------------
// RPC (anchor test / solana-test-validator)
// ---------------------------------------------------------------------------

export class RpcChain implements Chain {
  readonly kind = 'rpc' as const;
  readonly canWarp = false;
  constructor(readonly connection: Connection, readonly admin: Keypair) {}

  async airdrop(to: PublicKey, lamports: bigint) {
    // test validators cap single airdrops; the admin wallet is pre-funded by anchor, so pay from it
    if (lamports <= 5n * 1_000_000_000n) {
      try {
        const sig = await this.connection.requestAirdrop(to, Number(lamports));
        await this.connection.confirmTransaction(sig, 'confirmed');
        return;
      } catch { /* fall through to a transfer */ }
    }
    await this.send([SystemProgram.transfer({ fromPubkey: this.admin.publicKey, toPubkey: to, lamports })], { signers: [this.admin] });
  }

  async send(ixs: TransactionInstruction[], opts: SendOpts = {}): Promise<TxResult> {
    const signers = opts.signers ?? [];
    const payer = opts.payer ?? signers[0] ?? this.admin;
    const all = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu ?? 1_400_000 }), ...ixs);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(...all);
    // no client-side signature check: a tx that lacks a required signature must be rejected by the validator
    // (same outcome as on LiteSVM) so the "unsigned PDA caller" scenarios behave identically on both back-ends
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(wire, { skipPreflight: true, preflightCommitment: 'confirmed' });
    } catch (e) {
      const err = e as { message?: string; logs?: string[] };
      const raw = String(err.message ?? e);
      const logs = err.logs ?? [];
      const { code, programId } = parseFailure(logs, raw);
      throw new TxFailure(`${opts.label ?? 'tx'} rejected: ${raw}\n${logs.join('\n')}`, logs, code, programId, raw);
    }
    const conf = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    const t = await this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const logs = t?.meta?.logMessages ?? [];
    const err = conf.value.err ?? t?.meta?.err ?? null;
    if (err) {
      const raw = JSON.stringify(err);
      const { code, programId } = parseFailure(logs, raw);
      throw new TxFailure(`${opts.label ?? 'tx'} failed: ${raw}${code !== undefined ? ` (custom ${code}${programId ? ` from ${programId}` : ''})` : ''}\n${logs.join('\n')}`, logs, code, programId, raw);
    }
    const cu = BigInt(t?.meta?.computeUnitsConsumed ?? 0);
    recordCu(opts.label, cu, signature, this.kind, ixs);
    return { signature, logs, cu };
  }

  async getAccount(key: PublicKey): Promise<AccountView | null> {
    const a = await this.connection.getAccountInfo(key, 'confirmed');
    return a ? { owner: a.owner, data: new Uint8Array(a.data), lamports: BigInt(a.lamports), executable: a.executable } : null;
  }

  async setAccount(): Promise<void> { throw new Error('setAccount is only available on LiteSVM (chain.kind === "litesvm")'); }
  async balance(key: PublicKey) { return BigInt(await this.connection.getBalance(key, 'confirmed')); }
  async slot() { return BigInt(await this.connection.getSlot('confirmed')); }
  async now() { const s = await this.connection.getSlot('confirmed'); return BigInt((await this.connection.getBlockTime(s)) ?? Math.floor(Date.now() / 1000)); }
  async warpSlots(): Promise<void> { throw new Error('warpSlots is only available on LiteSVM'); }
  async warpSeconds(): Promise<void> { throw new Error('warpSeconds is only available on LiteSVM'); }
  async rentExempt(space: number) { return BigInt(await this.connection.getMinimumBalanceForRentExemption(space)); }
}

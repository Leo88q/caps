"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcChain = exports.LiteSvmChain = exports.TxFailure = void 0;
exports.parseFailure = parseFailure;
exports.innerTrace = innerTrace;
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
const web3_js_1 = require("@solana/web3.js");
const node_fs_1 = require("node:fs");
const cu_1 = require("./cu");
const ids_1 = require("@/chain/ids");
/** litesvm's kit wrapper types addresses as a branded string — one cast at the boundary. */
const addr = (k) => k.toBase58();
class TxFailure extends Error {
    logs;
    code;
    programId;
    raw;
    constructor(message, logs, 
    /** Anchor / SPL custom error code, if the failure was `custom program error` */
    code, 
    /** program that raised it (from `Program X failed`) */
    programId, 
    /** raw error string from the runtime */
    raw) {
        super(message);
        this.logs = logs;
        this.code = code;
        this.programId = programId;
        this.raw = raw;
        this.name = 'TxFailure';
    }
}
exports.TxFailure = TxFailure;
/**
 * `Program <id> failed: custom program error: 0x1770` → { code, programId }. The FIRST failing program
 * wins: on a CPI failure the runtime logs the inner `failed:` line before the outer one with the same
 * code, and the inner program is the one whose error table applies (e.g. chip_core::ChipNotFree
 * surfacing through market::list). Same rule as the client (`parseCustomError`).
 */
function parseFailure(logs, raw) {
    let code;
    let programId;
    for (const l of logs) {
        const m = /Program (\w+) failed: custom program error: (0x[0-9a-fA-F]+|\d+)/.exec(l);
        if (m) {
            programId = m[1];
            code = m[2].startsWith('0x') ? parseInt(m[2], 16) : Number(m[2]);
            break;
        }
    }
    if (code === undefined) {
        const m = /[Cc]ustom(?:ProgramError|\()?[^0-9]*(\d+)/.exec(raw) ?? /custom program error: (0x[0-9a-fA-F]+)/.exec(raw);
        if (m)
            code = m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
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
function innerTrace(inner, tx) {
    if (!inner || inner.length === 0)
        return '';
    const names = new Map([
        [ids_1.CHIP_CORE_ID.toBase58(), 'chip_core'],
        [ids_1.MARKET_ID.toBase58(), 'market'],
        [ids_1.ARENA_ID.toBase58(), 'arena'],
        [ids_1.STAKING_ID.toBase58(), 'staking'],
        [ids_1.MPL_CORE_ID.toBase58(), 'mpl_core'],
        [ids_1.TOKEN_PROGRAM_ID.toBase58(), 'token'],
        [ids_1.SYSTEM_PROGRAM_ID.toBase58(), 'system'],
        [ids_1.SWITCHBOARD_ON_DEMAND_ID.toBase58(), 'switchboard'],
    ]);
    const short = (id) => names.get(id.toBase58()) ?? id.toBase58().slice(0, 6) + '…';
    let keys = [];
    try {
        keys = tx.compileMessage().accountKeys;
    }
    catch {
        return '';
    }
    const lines = [];
    // inner[] indexes are MESSAGE indexes — `chain.send` prepends the compute-budget ix, so the
    // outer program must be read from the tx's own instruction list, not the caller's `ixs`
    inner.forEach((list, i) => {
        const outerIx = tx.instructions[i];
        const outer = outerIx ? short(outerIx.programId) : `ix${i}`;
        lines.push(`inner# ${i} (${outer}): ${list.length} cpi`);
        for (const raw of list) {
            try {
                const ci = raw.instruction();
                const pid = keys[ci.programIdIndex()] ?? web3_js_1.SystemProgram.programId;
                const data = ci.data();
                const head = Array.from(data.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
                lines.push(`  [d${raw.stackHeight?.() ?? '?'}] ${short(pid)} data=${head}${data.length > 8 ? `+${data.length - 8}B` : ''}`);
            }
            catch {
                lines.push('  [?] <unreadable inner>');
            }
        }
    });
    return lines.join('\n');
}
/** web3.js Transaction → the `{ messageBytes, signatures }` shape litesvm's kit wrapper encodes. */
function toKitTx(tx) {
    const signatures = {};
    // a required signer we could not sign for (e.g. a program PDA passed from a wallet) gets an all-zero
    // signature so the SVM rejects the tx with a signature failure instead of the encoder throwing
    for (const s of tx.signatures)
        signatures[s.publicKey.toBase58()] = s.signature ? new Uint8Array(s.signature) : new Uint8Array(64);
    return { messageBytes: new Uint8Array(tx.serializeMessage()), signatures };
}
class LiteSvmChain {
    kind = 'litesvm';
    canWarp = true;
    admin = web3_js_1.Keypair.generate();
    svm;
    txCounter = 0;
    static async create(programs, opts = {}) {
        const { LiteSVM } = await Promise.resolve().then(() => __importStar(require('litesvm')));
        const c = new LiteSvmChain();
        c.svm = new LiteSVM().withNativeMints().withLogBytesLimit();
        for (const p of programs) {
            if (!(0, node_fs_1.existsSync)(p.path))
                throw new Error(`program binary missing: ${p.path} (run \`anchor build -- --features localnet\` / see tests/localnet/README.md)`);
            try {
                c.svm.addProgramFromFile(addr(p.id), p.path);
            }
            catch (e) {
                // Without this the annotation says «Offset or value is out of bounds» and you get to guess
                // WHICH of the ~10 binaries (ours + fixtures) litesvm refused — see tests/localnet/README.md.
                throw new Error(`failed to load program ${p.id} from ${p.path}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        // A fresh LiteSVM starts at unix_timestamp 0 — every time-lock in the programs would be "expired".
        const clock = c.svm.getClock();
        clock.slot = opts.startSlot ?? 100000n;
        clock.unixTimestamp = opts.startUnixTs ?? BigInt(Math.floor(Date.now() / 1000));
        c.svm.setClock(clock);
        c.refreshSlotHashes();
        await c.airdrop(c.admin.publicKey, 10000n * 1000000000n);
        return c;
    }
    /** SlotHashes must contain the previous slots (Switchboard-shaped code reads it; ALT creation checks it). */
    refreshSlotHashes() {
        const slot = this.svm.getClock().slot;
        const bh = this.svm.latestBlockhash();
        const hashes = [];
        for (let i = 1n; i <= 8n && slot - i >= 0n; i++)
            hashes.push({ slot: slot - i, hash: bh });
        this.svm.setSlotHashes(hashes);
    }
    async airdrop(to, lamports) {
        const r = this.svm.airdrop(addr(to), lamports);
        if (r && 'err' in r)
            throw new Error(`airdrop failed: ${String(r.err())}`);
    }
    async send(ixs, opts = {}) {
        const signers = opts.signers ?? [];
        const payer = opts.payer ?? signers[0] ?? this.admin;
        const all = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
        // new blockhash per tx → identical instruction sets are never rejected as duplicates
        this.svm.expireBlockhash();
        const tx = new web3_js_1.Transaction().add(web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu ?? 1_400_000 }), ...ixs);
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
            const trace = innerTrace(meta.innerInstructions(), tx);
            throw new TxFailure(`${opts.label ?? 'tx'} failed: ${raw}${code !== undefined ? ` (custom ${code}${programId ? ` from ${programId}` : ''})` : ''}${trace ? `\nCPI trace:\n${trace}` : ''}\n${logs.join('\n')}`, logs, code, programId, raw);
        }
        // one slot per transaction, like a (very quiet) real chain — commit/reveal/settle land in distinct slots
        await this.warpSlots(1n);
        const cu = res.computeUnitsConsumed();
        (0, cu_1.recordCu)(opts.label, cu, signature, this.kind, ixs);
        return { signature, logs: res.logs(), cu };
    }
    async getAccount(key) {
        const a = this.svm.getAccount(addr(key));
        if (!a.exists)
            return null;
        return { owner: new web3_js_1.PublicKey(a.programAddress), data: new Uint8Array(a.data), lamports: BigInt(a.lamports), executable: a.executable };
    }
    async setAccount(key, acc) {
        const lamports = acc.lamports ?? this.svm.minimumBalanceForRentExemption(BigInt(acc.data.length));
        this.svm.setAccount({
            address: addr(key), lamports: lamports, data: acc.data, programAddress: addr(acc.owner),
            executable: false, space: BigInt(acc.data.length),
        });
    }
    async balance(key) { return BigInt(this.svm.getBalance(addr(key)) ?? 0n); }
    async slot() { return this.svm.getClock().slot; }
    async now() { return this.svm.getClock().unixTimestamp; }
    async warpSlots(n) {
        const clock = this.svm.getClock();
        const dn = BigInt(n);
        clock.slot += dn;
        clock.unixTimestamp += (dn * 4n) / 10n; // 400 ms slots
        this.svm.setClock(clock);
        this.refreshSlotHashes();
    }
    async warpSeconds(secs) {
        const clock = this.svm.getClock();
        const ds = BigInt(secs);
        clock.unixTimestamp += ds;
        clock.slot += (ds * 10n) / 4n;
        this.svm.setClock(clock);
        this.refreshSlotHashes();
    }
    async rentExempt(space) { return this.svm.minimumBalanceForRentExemption(BigInt(space)); }
}
exports.LiteSvmChain = LiteSvmChain;
// ---------------------------------------------------------------------------
// RPC (anchor test / solana-test-validator)
// ---------------------------------------------------------------------------
class RpcChain {
    connection;
    admin;
    kind = 'rpc';
    canWarp = false;
    constructor(connection, admin) {
        this.connection = connection;
        this.admin = admin;
    }
    async airdrop(to, lamports) {
        // test validators cap single airdrops; the admin wallet is pre-funded by anchor, so pay from it
        if (lamports <= 5n * 1000000000n) {
            try {
                const sig = await this.connection.requestAirdrop(to, Number(lamports));
                await this.connection.confirmTransaction(sig, 'confirmed');
                return;
            }
            catch { /* fall through to a transfer */ }
        }
        await this.send([web3_js_1.SystemProgram.transfer({ fromPubkey: this.admin.publicKey, toPubkey: to, lamports })], { signers: [this.admin] });
    }
    async send(ixs, opts = {}) {
        const signers = opts.signers ?? [];
        const payer = opts.payer ?? signers[0] ?? this.admin;
        const all = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
        const tx = new web3_js_1.Transaction().add(web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu ?? 1_400_000 }), ...ixs);
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = payer.publicKey;
        tx.sign(...all);
        // no client-side signature check: a tx that lacks a required signature must be rejected by the validator
        // (same outcome as on LiteSVM) so the "unsigned PDA caller" scenarios behave identically on both back-ends
        const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        let signature;
        try {
            signature = await this.connection.sendRawTransaction(wire, { skipPreflight: true, preflightCommitment: 'confirmed' });
        }
        catch (e) {
            const err = e;
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
        (0, cu_1.recordCu)(opts.label, cu, signature, this.kind, ixs);
        return { signature, logs, cu };
    }
    async getAccount(key) {
        const a = await this.connection.getAccountInfo(key, 'confirmed');
        return a ? { owner: a.owner, data: new Uint8Array(a.data), lamports: BigInt(a.lamports), executable: a.executable } : null;
    }
    async setAccount() { throw new Error('setAccount is only available on LiteSVM (chain.kind === "litesvm")'); }
    async balance(key) { return BigInt(await this.connection.getBalance(key, 'confirmed')); }
    async slot() { return BigInt(await this.connection.getSlot('confirmed')); }
    async now() { const s = await this.connection.getSlot('confirmed'); return BigInt((await this.connection.getBlockTime(s)) ?? Math.floor(Date.now() / 1000)); }
    async warpSlots() { throw new Error('warpSlots is only available on LiteSVM'); }
    async warpSeconds() { throw new Error('warpSeconds is only available on LiteSVM'); }
    async rentExempt(space) { return BigInt(await this.connection.getMinimumBalanceForRentExemption(space)); }
}
exports.RpcChain = RpcChain;

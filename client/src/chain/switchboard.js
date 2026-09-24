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
exports.revealValueFromIx = void 0;
exports.defaultQueue = defaultQueue;
exports.selectOracle = selectOracle;
exports.prepareRandomness = prepareRandomness;
exports.prepareReveal = prepareReveal;
exports.revealPayloadFromIx = revealPayloadFromIx;
exports.readRandomness = readRandomness;
exports.prepareClose = prepareClose;
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
const web3_js_1 = require("@solana/web3.js");
const config_1 = require("@/app/config");
const ids_1 = require("./ids");
const rng_1 = require("./ix/rng");
let sbMod;
const loadSb = () => (sbMod ??= Promise.resolve().then(() => __importStar(require('@switchboard-xyz/on-demand'))));
const programCache = new WeakMap();
async function sbProgram(connection, payer) {
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
            return sb.AnchorUtils.loadProgramFromConnection(connection, wallet, ids_1.SWITCHBOARD_ON_DEMAND_ID);
        })();
        programCache.set(connection, p);
    }
    return p;
}
function defaultQueue() {
    return ids_1.SWITCHBOARD_QUEUE[config_1.CLUSTER];
}
/**
 * Pick a healthy randomness oracle from the queue (SDK health snapshots + on-chain heartbeat).
 * On localnet `sb_mock` ignores the oracle, so any key works.
 */
async function selectOracle(connection, payer, queue = defaultQueue()) {
    if (config_1.CLUSTER === 'localnet')
        return queue;
    const sb = await loadSb();
    const program = await sbProgram(connection, payer);
    const { oracle } = await new sb.Queue(program, queue).selectRandomnessOracle();
    return oracle.pubkey;
}
/** Build the init instruction for the program-owned randomness account of (kind, owner, nonce). */
async function prepareRandomness(connection, owner, kind, nonce, queue = defaultQueue()) {
    const [oracle, recentSlot] = await Promise.all([selectOracle(connection, owner, queue), connection.getSlot('finalized')]);
    const acc = (0, rng_1.rngAccounts)(kind, owner, nonce);
    return { ...acc, queue, oracle, ixs: [(0, rng_1.initRandomnessIx)({ ...acc, queue, recentSlot: BigInt(recentSlot) })] };
}
/**
 * Fetch the oracle's reveal for a committed account and wrap it into our permissionless
 * `reveal_randomness` instruction. The SDK waits ~3 s and calls the oracle gateway; we retry
 * with backoff because the oracle needs the committed slot to be finalized. Resolves to the
 * instruction plus the 32 revealed bytes (so the UI can pre-simulate the roll before the chain
 * confirms).
 */
async function prepareReveal(connection, payer, kind, randomness, opts = {}) {
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
            const ix = (0, rng_1.revealRandomnessIx)({ kind, payer, randomness, oracle, queue, ...reveal });
            return { ix, value: reveal.value };
        }
        catch (e) {
            if (Date.now() + delay > deadline)
                throw e;
            await new Promise((f) => setTimeout(f, delay));
            delay = Math.min(delay * 2, 8_000);
        }
    }
}
/**
 * randomness_reveal data layout: 8 (discriminator) ‖ signature[64] ‖ recovery_id u8 ‖ value[32].
 */
function revealPayloadFromIx(ix) {
    const d = ix.data;
    if (d.length < 8 + 64 + 1 + 32)
        throw new Error('unexpected reveal ix layout');
    return {
        signature: new Uint8Array(d.subarray(8, 8 + 64)),
        recoveryId: d[8 + 64],
        value: new Uint8Array(d.subarray(8 + 64 + 1, 8 + 64 + 1 + 32)),
    };
}
const revealValueFromIx = (ix) => revealPayloadFromIx(ix).value;
exports.revealValueFromIx = revealValueFromIx;
/** Decode the on-chain RandomnessAccountData (authority / oracle / slots / revealed value). */
async function readRandomness(connection, payer, randomness) {
    const program = await sbProgram(connection, payer);
    try {
        const r = new (await loadSb()).Randomness(program, randomness);
        const data = await r.loadData();
        const seedSlot = BigInt(data.seedSlot.toString());
        const revealSlot = BigInt(data.revealSlot.toString());
        const value = revealSlot > 0n ? Uint8Array.from(data.value) : null;
        return {
            authority: new web3_js_1.PublicKey(data.authority), queue: new web3_js_1.PublicKey(data.queue), oracle: new web3_js_1.PublicKey(data.oracle),
            seedSlot, revealSlot, lutSlot: BigInt(data.lutSlot.toString()), value,
        };
    }
    catch {
        return null;
    }
}
/**
 * Rent reclaim (SEC-M7): after the pending pack / fusion is closed (battle settled), anyone can
 * close the randomness account; Switchboard pays the rent to `rng_auth` and the program forwards
 * it to the player. Returns null when the account is already gone.
 */
async function prepareClose(connection, payer, kind, owner, nonce) {
    const acc = (0, rng_1.rngAccounts)(kind, owner, nonce);
    const view = await readRandomness(connection, payer, acc.randomness);
    if (!view)
        return null;
    return (0, rng_1.closeRandomnessIx)({ ...acc, payer, lutSlot: view.lutSlot });
}

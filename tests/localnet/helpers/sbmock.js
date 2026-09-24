"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZERO_SIG = exports.RANDOMNESS_DISC = exports.RANDOMNESS_SIZE = exports.closeRandomnessIx = exports.initRandomnessIx = exports.rngAccounts = exports.RNG_KIND = void 0;
exports.decodeRandomness = decodeRandomness;
exports.randomnessAccount = randomnessAccount;
exports.encodeRandomnessPayload = encodeRandomnessPayload;
exports.valueOf = valueOf;
exports.revealIx = revealIx;
exports.mockInitIx = mockInitIx;
exports.setRawIx = setRawIx;
exports.forgeRandomness = forgeRandomness;
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
const node_crypto_1 = require("node:crypto");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const borsh_1 = require("@/chain/borsh");
const anchor_1 = require("@/chain/anchor");
const ids_1 = require("@/chain/ids");
const rng_1 = require("@/chain/ix/rng");
Object.defineProperty(exports, "rngAccounts", { enumerable: true, get: function () { return rng_1.rngAccounts; } });
Object.defineProperty(exports, "closeRandomnessIx", { enumerable: true, get: function () { return rng_1.closeRandomnessIx; } });
Object.defineProperty(exports, "initRandomnessIx", { enumerable: true, get: function () { return rng_1.initRandomnessIx; } });
const pdas_1 = require("@/chain/pdas");
Object.defineProperty(exports, "RNG_KIND", { enumerable: true, get: function () { return pdas_1.RNG_KIND; } });
const pdas_2 = require("@/chain/pdas");
const env_1 = require("./env");
exports.RANDOMNESS_SIZE = 480;
exports.RANDOMNESS_DISC = Uint8Array.from([10, 66, 229, 135, 220, 239, 217, 114]);
exports.ZERO_SIG = new Uint8Array(64);
function decodeRandomness(data) {
    const r = (0, anchor_1.expectDiscriminator)(data, 'RandomnessAccountData');
    if (data.length < exports.RANDOMNESS_SIZE)
        throw new Error(`RandomnessAccountData: ${data.length} bytes`);
    return { authority: r.pubkey(), queue: r.pubkey(), seedSlothash: r.bytes(32), seedSlot: r.u64(), oracle: r.pubkey(), revealSlot: r.u64(), value: r.bytes(32), lutSlot: r.u64() };
}
async function randomnessAccount(chain, key) {
    const a = await chain.getAccount(key);
    return a && a.data.length ? decodeRandomness(a.data) : null;
}
/** Encode a full 472-byte payload (everything after the discriminator) for `set_raw` / `forgeRandomness`. */
function encodeRandomnessPayload(d) {
    const w = new borsh_1.BorshWriter()
        .pubkey(d.authority ?? web3_js_1.PublicKey.default).pubkey(d.queue ?? env_1.SB_QUEUE).bytes(d.seedSlothash ?? new Uint8Array(32)).u64(d.seedSlot ?? 0n)
        .pubkey(d.oracle ?? env_1.SB_ORACLE).u64(d.revealSlot ?? 0n).bytes(d.value ?? new Uint8Array(32)).u64(d.lutSlot ?? 0n);
    const head = w.toBytes();
    const out = new Uint8Array(exports.RANDOMNESS_SIZE - 8);
    out.set(head, 0);
    return out;
}
/** Deterministic 32-byte "oracle value" for a scenario (e.g. `valueOf('C07')`).
 *  SHA-256, not a hand-rolled FNV: the first version derived every byte from four rotating lanes of one
 *  32-bit FNV state, which made slot rolls anti-correlated — for the label `chipsOf-0-any` NO salt in
 *  200k ever produced two Common chips (slots 0/1 alternated 0/1), and the fusion spec's rarity mining
 *  died with "no value yields rarity 0" on the suite's first real run (2026-09-19). SHA-256 diffuses;
 *  it is still deterministic, which is the only property the harness needs. */
function valueOf(label, salt = 0) {
    return new Uint8Array((0, node_crypto_1.createHash)('sha256').update(`${label}:${salt}`).digest());
}
/** Reveal through our program (chip_core `reveal_randomness` / arena `reveal_battle_randomness`) with a chosen value. */
function revealIx(a) {
    return (0, rng_1.revealRandomnessIx)({ kind: a.kind, payer: a.payer, randomness: a.randomness, oracle: a.oracle ?? env_1.SB_ORACLE, queue: a.queue ?? env_1.SB_QUEUE, signature: exports.ZERO_SIG, recoveryId: 0, value: a.value });
}
/**
 * Call the MOCK's `randomness_init` directly (bypassing our programs) — `randomness` is a fresh
 * keypair, `authority` any key you want stored. Used for the "authority ≠ rng_auth" scenarios.
 */
function mockInitIx(a) {
    const lutSigner = (0, pdas_2.sbLutSignerPda)(a.randomness)[0];
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.SWITCHBOARD_ON_DEMAND_ID,
        keys: [
            (0, anchor_1.signer)(a.randomness), (0, anchor_1.rw)((0, pdas_2.sbRewardEscrow)(a.randomness)), (0, anchor_1.signer)(a.authority, false), (0, anchor_1.rw)(a.queue ?? env_1.SB_QUEUE), (0, anchor_1.signer)(a.payer),
            (0, anchor_1.ro)(web3_js_1.SystemProgram.programId), (0, anchor_1.ro)(spl_token_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.WSOL_MINT), (0, anchor_1.ro)((0, pdas_2.sbStatePda)()[0]),
            (0, anchor_1.ro)(lutSigner), (0, anchor_1.rw)((0, pdas_2.sbLutPda)(lutSigner, a.recentSlot)[0]), (0, anchor_1.ro)(ids_1.ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('randomness_init', new borsh_1.BorshWriter().u64(a.recentSlot).toBytes())),
    });
}
/** Mock-only `set_raw(payload)`: overwrite bytes after the discriminator of a mock-owned account. */
function setRawIx(a) {
    const w = new borsh_1.BorshWriter();
    w.vec(Array.from(a.payload), (b) => w.u8(b));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.SWITCHBOARD_ON_DEMAND_ID,
        keys: [(0, anchor_1.rw)(a.randomness), (0, anchor_1.signer)(a.payer, false)],
        data: Buffer.from((0, anchor_1.ixData)('set_raw', w.toBytes())),
    });
}
/**
 * LiteSVM only: write a byte-perfect RandomnessAccountData (revealed, authority = rng_auth of
 * `kind`) at an arbitrary address under `owner`. With `owner ≠ sb_mock` this is exactly the
 * SEC-C1 attack: a look-alike account carrying a chosen value.
 */
async function forgeRandomness(chain, a) {
    const address = a.address ?? web3_js_1.Keypair.generate().publicKey;
    const authority = (0, rng_1.rngAccounts)(a.kind, web3_js_1.PublicKey.default, 0n).rngAuth;
    const data = new Uint8Array(exports.RANDOMNESS_SIZE);
    data.set(exports.RANDOMNESS_DISC, 0);
    data.set(encodeRandomnessPayload({ authority, seedSlot: a.seedSlot, revealSlot: a.revealSlot, value: a.value }), 8);
    await chain.setAccount(address, { owner: a.owner, data });
    return address;
}

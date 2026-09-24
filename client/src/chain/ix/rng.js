"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rngAccounts = rngAccounts;
exports.initRandomnessIx = initRandomnessIx;
exports.commitAccountMetas = commitAccountMetas;
exports.revealRandomnessIx = revealRandomnessIx;
exports.closeRandomnessIx = closeRandomnessIx;
// Program-owned Switchboard randomness (SEC-C3 part 2): init / reveal / close
// wrappers of chip_core (kinds 0 pack, 1 fusion, 3 claim fusion) and arena (kind 2 battle).
// The *commit* has no client instruction any more — buy_pack / fuse / fuse_claims_commit /
// create_battle CPI `randomness_commit` themselves with the `rng_auth` PDA
// signature. Account order MUST match programs/chip_core/src/instructions/rng.rs
// and the InitBattleRandomness / RevealBattleRandomness / CloseBattleRandomness
// structs in programs/arena/src/lib.rs.
const web3_js_1 = require("@solana/web3.js");
const borsh_1 = require("../borsh");
const anchor_1 = require("../anchor");
const ids_1 = require("../ids");
const pdas_1 = require("../pdas");
const programOf = (kind) => (kind === pdas_1.RNG_KIND.BATTLE ? ids_1.ARENA_ID : ids_1.CHIP_CORE_ID);
function rngAccounts(kind, owner, nonce) {
    return { kind, owner, nonce, randomness: (0, pdas_1.rngPda)(kind, owner, nonce)[0], rngAuth: (0, pdas_1.rngAuthPda)(kind)[0] };
}
/**
 * `init_randomness(kind, nonce, recent_slot)` (chip_core) / `init_battle_randomness(nonce, recent_slot)` (arena).
 * `recentSlot` must be a *finalized* slot (the LUT address is derived from it and Switchboard
 * checks it against SlotHashes) — `connection.getSlot('finalized')`.
 */
function initRandomnessIx(a) {
    const lutSigner = (0, pdas_1.sbLutSignerPda)(a.randomness)[0];
    const keys = [
        (0, anchor_1.signer)(a.owner),
        (0, anchor_1.rw)(a.randomness),
        (0, anchor_1.ro)(a.rngAuth),
        (0, anchor_1.rw)((0, pdas_1.sbRewardEscrow)(a.randomness)),
        (0, anchor_1.rw)(a.queue),
        (0, anchor_1.ro)((0, pdas_1.sbStatePda)()[0]),
        (0, anchor_1.ro)(lutSigner),
        (0, anchor_1.rw)((0, pdas_1.sbLutPda)(lutSigner, a.recentSlot)[0]),
        (0, anchor_1.ro)(ids_1.SWITCHBOARD_ON_DEMAND_ID),
        (0, anchor_1.ro)(ids_1.WSOL_MINT),
        (0, anchor_1.ro)(ids_1.ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        (0, anchor_1.ro)(ids_1.ASSOCIATED_TOKEN_PROGRAM_ID),
        (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
    ];
    const data = a.kind === pdas_1.RNG_KIND.BATTLE
        ? (0, anchor_1.ixData)('init_battle_randomness', new borsh_1.BorshWriter().u64(a.nonce).u64(a.recentSlot).toBytes())
        : (0, anchor_1.ixData)('init_randomness', new borsh_1.BorshWriter().u8(a.kind).u64(a.nonce).u64(a.recentSlot).toBytes());
    return new web3_js_1.TransactionInstruction({ programId: programOf(a.kind), keys, data: Buffer.from(data) });
}
/** Extra accounts `buy_pack` / `fuse` / `create_battle` take for the commit CPI (in program order). */
function commitAccountMetas(a) {
    return [(0, anchor_1.ro)((0, pdas_1.rngAuthPda)(a.kind)[0]), (0, anchor_1.ro)(ids_1.SWITCHBOARD_ON_DEMAND_ID), (0, anchor_1.ro)(a.queue), (0, anchor_1.rw)(a.oracle), (0, anchor_1.ro)(ids_1.SYSVAR_SLOT_HASHES_ID)];
}
/** `reveal_randomness(signature, recovery_id, value)` (chip_core) / `reveal_battle_randomness` (arena) — permissionless. */
function revealRandomnessIx(a) {
    if (a.signature.length !== 64)
        throw new Error('oracle signature must be 64 bytes');
    if (a.value.length !== 32)
        throw new Error('revealed value must be 32 bytes');
    const keys = [
        (0, anchor_1.signer)(a.payer),
        (0, anchor_1.rw)(a.randomness),
        (0, anchor_1.ro)((0, pdas_1.rngAuthPda)(a.kind)[0]),
        (0, anchor_1.ro)(a.oracle),
        (0, anchor_1.ro)(a.queue),
        (0, anchor_1.rw)((0, pdas_1.sbOracleStatsPda)(a.oracle)[0]),
        (0, anchor_1.rw)((0, pdas_1.sbRewardEscrow)(a.randomness)),
        (0, anchor_1.ro)((0, pdas_1.sbStatePda)()[0]),
        (0, anchor_1.ro)(ids_1.SYSVAR_SLOT_HASHES_ID),
        (0, anchor_1.ro)(ids_1.SWITCHBOARD_ON_DEMAND_ID),
        (0, anchor_1.ro)(ids_1.WSOL_MINT),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
    ];
    const name = a.kind === pdas_1.RNG_KIND.BATTLE ? 'reveal_battle_randomness' : 'reveal_randomness';
    const data = (0, anchor_1.ixData)(name, new borsh_1.BorshWriter().bytes(a.signature).u8(a.recoveryId).bytes(a.value).toBytes());
    return new web3_js_1.TransactionInstruction({ programId: programOf(a.kind), keys, data: Buffer.from(data) });
}
/**
 * `close_randomness(kind, nonce)` / `close_battle_randomness(nonce)` — permissionless once the
 * pending pack / fusion is closed (battle resolved or cancelled). Rent → `owner` (SEC-M7).
 * `lutSlot` = `RandomnessAccountData.lut_slot` (readRandomness).
 */
function closeRandomnessIx(a) {
    const lutSigner = (0, pdas_1.sbLutSignerPda)(a.randomness)[0];
    const pinned = a.kind === pdas_1.RNG_KIND.PACK ? (0, pdas_1.pendingPackPda)(a.owner, a.nonce)[0]
        : a.kind === pdas_1.RNG_KIND.FUSION ? (0, pdas_1.pendingFusionPda)(a.owner, a.nonce)[0]
            : a.kind === pdas_1.RNG_KIND.CLAIM_FUSION ? (0, pdas_1.claimFusionPda)(a.owner, a.nonce)[0]
                : (0, pdas_1.battlePda)(a.owner, a.nonce)[0];
    const keys = [
        (0, anchor_1.signer)(a.payer),
        (0, anchor_1.rw)(a.owner),
        (0, anchor_1.rw)(a.randomness),
        (0, anchor_1.rw)(a.rngAuth),
        (0, anchor_1.ro)(pinned),
        (0, anchor_1.rw)((0, pdas_1.sbRewardEscrow)(a.randomness)),
        (0, anchor_1.ro)((0, pdas_1.sbStatePda)()[0]),
        (0, anchor_1.rw)((0, pdas_1.sbLutPda)(lutSigner, a.lutSlot)[0]),
        (0, anchor_1.ro)(lutSigner),
        (0, anchor_1.ro)(ids_1.SWITCHBOARD_ON_DEMAND_ID),
        (0, anchor_1.ro)(ids_1.WSOL_MINT),
        (0, anchor_1.ro)(ids_1.ADDRESS_LOOKUP_TABLE_PROGRAM_ID),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
    ];
    const data = a.kind === pdas_1.RNG_KIND.BATTLE
        ? (0, anchor_1.ixData)('close_battle_randomness', new borsh_1.BorshWriter().u64(a.nonce).toBytes())
        : (0, anchor_1.ixData)('close_randomness', new borsh_1.BorshWriter().u8(a.kind).u64(a.nonce).toBytes());
    return new web3_js_1.TransactionInstruction({ programId: programOf(a.kind), keys, data: Buffer.from(data) });
}

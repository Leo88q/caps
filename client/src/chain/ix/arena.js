"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.leagueOf = exports.LEAGUE_NAMES = exports.LEAGUE_UPPER = exports.MIN_SQUAD_POWER = exports.RAKE_POOL_BPS = exports.RAKE_TREASURY_BPS = exports.RAKE_BPS = exports.MAX_WAGER = exports.MIN_WAGER = void 0;
exports.createBattleIx = createBattleIx;
exports.acceptBattleIx = acceptBattleIx;
exports.createCompressedBattleIx = createCompressedBattleIx;
exports.acceptCompressedBattleIx = acceptCompressedBattleIx;
exports.createCompressedBattleV2Ix = createCompressedBattleV2Ix;
exports.acceptCompressedBattleV2Ix = acceptCompressedBattleV2Ix;
exports.cancelStaleBattleIx = cancelStaleBattleIx;
exports.wagerSplit = wagerSplit;
// Instruction builders for programs/arena (wagered 3v3 battles with $CG escrow).
const web3_js_1 = require("@solana/web3.js");
const borsh_1 = require("../borsh");
const anchor_1 = require("../anchor");
const ids_1 = require("../ids");
const pdas_1 = require("../pdas");
const rng_1 = require("./rng");
exports.MIN_WAGER = 5000000n;
exports.MAX_WAGER = 5000000000n;
exports.RAKE_BPS = 500;
exports.RAKE_TREASURY_BPS = 4_000;
exports.RAKE_POOL_BPS = 2_000;
exports.MIN_SQUAD_POWER = 400;
exports.LEAGUE_UPPER = [800, 1400, 2400, 4000, 7000, Infinity];
exports.LEAGUE_NAMES = ['Curb', 'Alley', 'Block', 'District', 'Skyline', 'Rooftop'];
const leagueOf = (power) => exports.LEAGUE_UPPER.findIndex((u) => power < u);
exports.leagueOf = leagueOf;
function createBattleIx(a) {
    const [battle] = (0, pdas_1.battlePda)(a.challenger, a.nonce);
    const keys = [
        (0, anchor_1.signer)(a.challenger), (0, anchor_1.ro)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.rw)(battle), (0, anchor_1.rw)(a.randomness),
        ...(0, rng_1.commitAccountMetas)({ kind: pdas_1.RNG_KIND.BATTLE, queue: a.queue, oracle: a.oracle }),
        (0, anchor_1.ro)(a.cgMint),
        (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.challenger)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, battle)),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.ASSOCIATED_TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
    ];
    for (const asset of a.squad)
        keys.push((0, anchor_1.ro)(asset), (0, anchor_1.ro)((0, pdas_1.chipStatePda)(asset)[0]));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.ARENA_ID,
        keys,
        data: Buffer.from((0, anchor_1.ixData)('create_battle', new borsh_1.BorshWriter().u64(a.nonce).u64(a.wager).toBytes())),
    });
}
function acceptBattleIx(a) {
    const [battle] = (0, pdas_1.battlePda)(a.challenger, a.nonce);
    const keys = [
        (0, anchor_1.signer)(a.opponent), (0, anchor_1.ro)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.rw)(battle), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.opponent)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, battle)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
    ];
    for (const asset of a.squad)
        keys.push((0, anchor_1.ro)(asset), (0, anchor_1.ro)((0, pdas_1.chipStatePda)(asset)[0]));
    return new web3_js_1.TransactionInstruction({ programId: ids_1.ARENA_ID, keys, data: Buffer.from((0, anchor_1.ixData)('accept_battle')) });
}
/** Same wager escrow as create_battle, but the pinned squad is a set of
 * chip_core-owned CompressedMintClaim accounts (one account per claim). */
function createCompressedBattleIx(a) {
    const [battle] = (0, pdas_1.battlePda)(a.challenger, a.nonce);
    const keys = [
        (0, anchor_1.signer)(a.challenger), (0, anchor_1.ro)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.rw)(battle), (0, anchor_1.rw)(a.randomness),
        ...(0, rng_1.commitAccountMetas)({ kind: pdas_1.RNG_KIND.BATTLE, queue: a.queue, oracle: a.oracle }),
        (0, anchor_1.ro)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.challenger)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, battle)),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.ASSOCIATED_TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ...a.claims.map(anchor_1.ro),
    ];
    return new web3_js_1.TransactionInstruction({ programId: ids_1.ARENA_ID, keys, data: Buffer.from((0, anchor_1.ixData)('create_battle', new borsh_1.BorshWriter().u64(a.nonce).u64(a.wager).toBytes())) });
}
function acceptCompressedBattleIx(a) {
    const [battle] = (0, pdas_1.battlePda)(a.challenger, a.nonce);
    const keys = [
        (0, anchor_1.signer)(a.opponent), (0, anchor_1.ro)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.rw)(battle), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.opponent)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, battle)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        ...a.claims.map(anchor_1.ro),
    ];
    return new web3_js_1.TransactionInstruction({ programId: ids_1.ARENA_ID, keys, data: Buffer.from((0, anchor_1.ixData)('accept_battle')) });
}
function compressedBattleV2Data(name, delegates, proofs, depths, nonce, wager) {
    if (delegates.length !== 3 || proofs.length !== 3 || depths.length !== 3)
        throw new Error('A compressed squad must contain exactly three proofs');
    const w = new borsh_1.BorshWriter();
    if (nonce !== undefined)
        w.u64(nonce);
    if (wager !== undefined)
        w.u64(wager);
    for (const delegate of delegates)
        w.pubkey(delegate);
    for (const proof of proofs) {
        w.bytes(proof.root).bytes(proof.dataHash).bytes(proof.creatorHash).bytes(proof.collectionHash).bytes(proof.assetDataHash)
            .u8(proof.flags).u64(proof.nonce).u32(proof.index);
    }
    for (const depth of depths)
        w.u8(depth);
    return Buffer.from((0, anchor_1.ixData)(name, w.toBytes()));
}
/** Production arena entry point: each squad slot carries a registered chip
 * projection and its current Bubblegum V2 proof, never a claim-only handle. */
function createCompressedBattleV2Ix(a) {
    if (a.squad.length !== 3)
        throw new Error('A compressed squad must contain exactly three chips');
    const [battle] = (0, pdas_1.battlePda)(a.challenger, a.nonce);
    const keys = [
        (0, anchor_1.signer)(a.challenger), (0, anchor_1.ro)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.rw)(battle), (0, anchor_1.rw)(a.randomness),
        ...(0, rng_1.commitAccountMetas)({ kind: pdas_1.RNG_KIND.BATTLE, queue: a.queue, oracle: a.oracle }), (0, anchor_1.ro)(a.cgMint),
        (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.challenger)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, battle)), (0, anchor_1.ro)(ids_1.MPL_ACCOUNT_COMPRESSION_ID),
        (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.ASSOCIATED_TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
    ];
    for (const chip of a.squad)
        keys.push((0, anchor_1.ro)(chip.claim), (0, anchor_1.ro)(chip.chip), (0, anchor_1.ro)(chip.merkleTree), ...chip.proof.proofNodes.map(anchor_1.ro));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.ARENA_ID,
        keys,
        data: compressedBattleV2Data('create_battle_v2', a.delegates, a.squad.map((x) => x.proof), a.squad.map((x) => x.proof.proofNodes.length), a.nonce, a.wager),
    });
}
function acceptCompressedBattleV2Ix(a) {
    if (a.squad.length !== 3)
        throw new Error('A compressed squad must contain exactly three chips');
    const [battle] = (0, pdas_1.battlePda)(a.challenger, a.nonce);
    const keys = [
        (0, anchor_1.signer)(a.opponent), (0, anchor_1.ro)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.rw)(battle), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.opponent)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, battle)),
        (0, anchor_1.ro)(ids_1.MPL_ACCOUNT_COMPRESSION_ID), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
    ];
    for (const chip of a.squad)
        keys.push((0, anchor_1.ro)(chip.claim), (0, anchor_1.ro)(chip.chip), (0, anchor_1.ro)(chip.merkleTree), ...chip.proof.proofNodes.map(anchor_1.ro));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.ARENA_ID,
        keys,
        data: compressedBattleV2Data('accept_battle_v2', a.delegates, a.squad.map((x) => x.proof), a.squad.map((x) => x.proof.proofNodes.length)),
    });
}
function cancelStaleBattleIx(a) {
    const [battle] = (0, pdas_1.battlePda)(a.challenger, a.nonce);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.ARENA_ID,
        keys: [
            (0, anchor_1.signer)(a.caller), (0, anchor_1.ro)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.rw)(battle), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, battle)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.challenger)),
            (0, anchor_1.optional)(a.opponent ? (0, pdas_1.ata)(a.cgMint, a.opponent) : undefined, ids_1.ARENA_ID), (0, anchor_1.rw)(a.challenger), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('cancel_stale_battle')),
    });
}
/** Pot math shown before signing: winner gets 2×wager − 5 % rake; rake → 40 % treasury / 40 % burned / 20 % season pool. */
function wagerSplit(wager) {
    const pot = wager * 2n;
    const rake = (pot * BigInt(exports.RAKE_BPS)) / 10000n;
    const treasury = (rake * BigInt(exports.RAKE_TREASURY_BPS)) / 10000n;
    const seasonPool = (rake * BigInt(exports.RAKE_POOL_BPS)) / 10000n;
    return { pot, rake, treasury, seasonPool, burn: rake - treasury - seasonPool, payout: pot - rake };
}

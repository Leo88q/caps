"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SLICE_PVP_SEASON = exports.TIER_NAMES = exports.MIN_STAKE_MICRO = exports.TIER_PENALTY_BPS = exports.TIER_BOOST_BPS = exports.TIER_LOCK_SECS = void 0;
exports.stakeCgIx = stakeCgIx;
exports.unstakeCgIx = unstakeCgIx;
exports.stakeChipIx = stakeChipIx;
exports.unstakeChipIx = unstakeChipIx;
exports.stakeCompressedChipIx = stakeCompressedChipIx;
exports.stakeCompressedChipV2Ix = stakeCompressedChipV2Ix;
exports.unstakeCompressedChipIx = unstakeCompressedChipIx;
exports.claimChipIx = claimChipIx;
exports.claimRootIx = claimRootIx;
exports.claimSkrRootIx = claimSkrRootIx;
exports.claimItemRootIx = claimItemRootIx;
exports.claimChipRootIx = claimChipRootIx;
exports.claimAnyRootIx = claimAnyRootIx;
exports.fundSkrIx = fundSkrIx;
exports.fundSliceIx = fundSliceIx;
exports.unstakePenalty = unstakePenalty;
// Instruction builders for programs/staking ($CG tiers, chip staking, Merkle claims).
const web3_js_1 = require("@solana/web3.js");
const borsh_1 = require("../borsh");
const anchor_1 = require("../anchor");
const ids_1 = require("../ids");
const pdas_1 = require("../pdas");
const ids_2 = require("../ids");
const economy_1 = require("@guttercaps/economy");
exports.TIER_LOCK_SECS = [0, 30 * 86_400, 90 * 86_400, 180 * 86_400];
exports.TIER_BOOST_BPS = [10_000, 15_000, 22_000, 30_000];
exports.TIER_PENALTY_BPS = [0, 500, 1_000, 1_500];
exports.MIN_STAKE_MICRO = 10000000n;
exports.TIER_NAMES = ['Flex', '30 days', '90 days', '180 days'];
function stakeCgIx(a) {
    const [emission] = (0, pdas_1.emissionPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.rw)(emission), (0, anchor_1.rw)((0, pdas_1.tokenPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.tokenStakePda)(a.owner, a.tier)[0]),
            (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, emission)),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('stake_cg', new borsh_1.BorshWriter().u8(a.tier).u64(a.amount).toBytes())),
    });
}
/** amount = 0n → claim only */
function unstakeCgIx(a) {
    const [emission] = (0, pdas_1.emissionPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.rw)(emission), (0, anchor_1.rw)((0, pdas_1.tokenPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.tokenStakePda)(a.owner, a.tier)[0]),
            (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, emission)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('unstake_cg', new borsh_1.BorshWriter().u8(a.tier).u64(a.amount).toBytes())),
    });
}
function stakeChipIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipStakePda)(a.asset)[0]), (0, anchor_1.rw)((0, pdas_1.setBonusPda)(a.owner)[0]),
            (0, anchor_1.ro)((0, pdas_1.stakeAuthPda)()[0]), (0, anchor_1.rw)(a.asset), (0, anchor_1.rw)((0, pdas_1.chipStatePda)(a.asset)[0]), (0, anchor_1.ro)((0, pdas_1.collectionMetaPda)(a.collectionIdx)[0]), (0, anchor_1.rw)(a.coreCollection),
            (0, anchor_1.ro)((0, pdas_1.configPda)()[0]), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.MPL_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('stake_chip')),
    });
}
function unstakeChipIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipStakePda)(a.asset)[0]), (0, anchor_1.ro)((0, pdas_1.stakeAuthPda)()[0]),
            (0, anchor_1.rw)(a.asset), (0, anchor_1.rw)((0, pdas_1.chipStatePda)(a.asset)[0]), (0, anchor_1.ro)((0, pdas_1.collectionMetaPda)(a.collectionIdx)[0]), (0, anchor_1.rw)(a.coreCollection), (0, anchor_1.ro)((0, pdas_1.configPda)()[0]),
            (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.MPL_CORE_ID), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('unstake_chip')),
    });
}
/** Bubblegum V2 claim staking: staking state is separate and chip_core owns the claim transition. */
function stakeCompressedChipIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.compressedChipStakePda)(a.claim)[0]),
            (0, anchor_1.rw)((0, pdas_1.setBonusPda)(a.owner)[0]), (0, anchor_1.ro)((0, pdas_1.stakeAuthPda)()[0]), (0, anchor_1.rw)(a.claim), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('stake_compressed_chip')),
    });
}
/** Production Bubblegum V2 staking. The proof nodes are remaining accounts and
 * are verified against the registered projection before weight is added. */
function stakeCompressedChipV2Ix(a) {
    const w = new borsh_1.BorshWriter()
        .pubkey(a.delegate)
        .bytes(a.proof.root)
        .bytes(a.proof.dataHash)
        .bytes(a.proof.creatorHash)
        .bytes(a.proof.collectionHash)
        .bytes(a.proof.assetDataHash)
        .u8(a.proof.flags)
        .u64(a.proof.nonce)
        .u32(a.proof.index)
        .toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.compressedChipStakePda)(a.claim)[0]),
            (0, anchor_1.rw)((0, pdas_1.setBonusPda)(a.owner)[0]), (0, anchor_1.ro)((0, pdas_1.stakeAuthPda)()[0]), (0, anchor_1.rw)(a.claim), (0, anchor_1.ro)(a.chip), (0, anchor_1.ro)(a.merkleTree),
            (0, anchor_1.ro)(ids_1.MPL_ACCOUNT_COMPRESSION_ID), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
            ...a.proof.proofNodes.map(anchor_1.ro),
        ],
        data: Buffer.from((0, anchor_1.ixData)('stake_compressed_chip_v2', w)),
    });
}
function unstakeCompressedChipIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.compressedChipStakePda)(a.claim)[0]),
            (0, anchor_1.ro)((0, pdas_1.stakeAuthPda)()[0]), (0, anchor_1.rw)(a.claim), (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID),
            (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('unstake_compressed_chip')),
    });
}
function claimChipIx(a) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.owner), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipStakePda)(a.asset)[0]), (0, anchor_1.ro)((0, pdas_1.setBonusPda)(a.owner)[0]),
            (0, anchor_1.ro)((0, pdas_1.chipStatePda)(a.asset)[0]), (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.owner)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('claim_chip')),
    });
}
/** $CG Merkle claim (kinds 2..4) — mints from the emission slice. Rejects SKR / item kinds: use `claimSkrRootIx` / `claimItemRootIx`. */
function claimRootIx(a) {
    if ((0, economy_1.isSkrRootKind)(a.kind))
        throw new Error(`kind ${a.kind} is an SKR root — use claimSkrRootIx`);
    if ((0, economy_1.isItemRootKind)(a.kind))
        throw new Error(`kind ${a.kind} is an item root — use claimItemRootIx`);
    const [root] = (0, pdas_1.rewardRootPda)(a.kind, a.epoch);
    const w = new borsh_1.BorshWriter().u64(a.amount);
    w.vec(a.proof, (p) => w.bytes(p));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.wallet), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)(root), (0, anchor_1.rw)((0, pdas_1.claimReceiptPda)(root, a.wallet)[0]),
            (0, anchor_1.rw)(a.cgMint), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, a.wallet)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('claim_root', w.toBytes())),
    });
}
/** SKR Merkle claim (kinds 5..7) — transfers from the treasury-funded prize pool vault (never minted). */
function claimSkrRootIx(a) {
    if (!(0, economy_1.isSkrRootKind)(a.kind))
        throw new Error(`kind ${a.kind} is a $CG root — use claimRootIx`);
    const [root] = (0, pdas_1.rewardRootPda)(a.kind, a.epoch);
    const [pool] = (0, pdas_1.skrPoolPda)();
    const w = new borsh_1.BorshWriter().u64(a.amount);
    w.vec(a.proof, (p) => w.bytes(p));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.wallet), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)(pool), (0, anchor_1.rw)(root), (0, anchor_1.rw)((0, pdas_1.claimReceiptPda)(root, a.wallet)[0]),
            (0, anchor_1.rw)((0, pdas_1.ata)(a.skrMint, pool)), (0, anchor_1.rw)((0, pdas_1.ata)(a.skrMint, a.wallet)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('claim_skr_root', w.toBytes())),
    });
}
/**
 * Item Merkle claim (kind 8 = fusion boosters, backlog #27) — `amount` is the booster COUNT (≤ 10). The program
 * verifies the proof and CPIs chip_core `grant_booster` signed by its `["rewarder"]` PDA, so the boosters land in
 * `PlayerItems` (`["items", wallet]`, created on first claim with the wallet as payer) in this transaction.
 */
function claimItemRootIx(a) {
    if (!(0, economy_1.isItemRootKind)(a.kind))
        throw new Error(`kind ${a.kind} is not an item root — use claimRootIx / claimSkrRootIx`);
    if (a.amount <= 0n || a.amount > BigInt(economy_1.ITEM_REWARDS.maxClaim))
        throw new Error(`item claim must be 1..${economy_1.ITEM_REWARDS.maxClaim} boosters`);
    const [root] = (0, pdas_1.rewardRootPda)(a.kind, a.epoch);
    const w = new borsh_1.BorshWriter().u64(a.amount);
    w.vec(a.proof, (p) => w.bytes(p));
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.wallet), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)(root), (0, anchor_1.rw)((0, pdas_1.claimReceiptPda)(root, a.wallet)[0]),
            (0, anchor_1.ro)((0, pdas_1.rewarderPda)()[0]), (0, anchor_1.ro)((0, pdas_1.configPda)()[0]), (0, anchor_1.rw)((0, pdas_1.playerItemsPda)(a.wallet)[0]), (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('claim_item_root', w.toBytes())),
    });
}
/**
 * Chip voucher Merkle claim (kind 9 = quest chips, backlog #28) — `amount` is the voucher TEMPLATE id (0..3). The program
 * verifies the proof and CPIs chip_core `open_voucher(nonce, template)` signed by its `["rewarder"]` PDA: a free 1-chip
 * `PendingPack` `["pending", wallet, nonce]` is created and committed to Switchboard in this tx, so the SAME transaction
 * must carry chip_core `init_randomness(0, nonce)` first (see `prepareRandomness`) — exactly like `buy_pack`. The chip is
 * then minted by the regular `open_pack` crank / `PackFlow.open()` (soulbound for the template's days). The wallet fronts
 * the pending rent + one chip's rent reserve + the Switchboard request, all returned when the pending closes.
 */
function claimChipRootIx(a) {
    if (!(0, economy_1.isChipRootKind)(a.kind))
        throw new Error(`kind ${a.kind} is not a chip voucher root — use claimRootIx / claimSkrRootIx / claimItemRootIx`);
    if (a.amount < 0n || a.amount > BigInt(economy_1.CHIP_VOUCHER_REWARDS.maxTemplate))
        throw new Error(`chip voucher template must be 0..${economy_1.CHIP_VOUCHER_REWARDS.maxTemplate}`);
    const [root] = (0, pdas_1.rewardRootPda)(a.kind, a.epoch);
    const w = new borsh_1.BorshWriter().u64(a.amount);
    w.vec(a.proof, (p) => w.bytes(p));
    w.u64(a.nonce);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [
            (0, anchor_1.signer)(a.wallet), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)(root), (0, anchor_1.rw)((0, pdas_1.claimReceiptPda)(root, a.wallet)[0]),
            (0, anchor_1.ro)((0, pdas_1.rewarderPda)()[0]), (0, anchor_1.ro)((0, pdas_1.configPda)()[0]), (0, anchor_1.rw)((0, pdas_1.pityPda)(a.wallet)[0]), (0, anchor_1.rw)((0, pdas_1.pendingPackPda)(a.wallet, a.nonce)[0]),
            (0, anchor_1.rw)((0, pdas_1.rngPda)(pdas_1.RNG_KIND.PACK, a.wallet, a.nonce)[0]), (0, anchor_1.ro)((0, pdas_1.rngAuthPda)(pdas_1.RNG_KIND.PACK)[0]), (0, anchor_1.ro)(ids_2.SWITCHBOARD_ON_DEMAND_ID), (0, anchor_1.ro)(a.queue), (0, anchor_1.rw)(a.oracle), (0, anchor_1.ro)(ids_2.SYSVAR_SLOT_HASHES_ID),
            (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID),
        ],
        data: Buffer.from((0, anchor_1.ixData)('claim_chip_root', w.toBytes())),
    });
}
/** Route a claim leaf to the right instruction by its root kind (2..4 $CG, 5..7 SKR, 8 boosters). Kind 9 (chip vouchers) needs its own tx — `claimChipRootIx`. */
function claimAnyRootIx(a) {
    if ((0, economy_1.isChipRootKind)(a.kind))
        throw new Error('chip voucher claims need a randomness account in the same tx — use claimChipRootIx');
    if ((0, economy_1.isItemRootKind)(a.kind))
        return claimItemRootIx(a);
    if ((0, economy_1.isSkrRootKind)(a.kind)) {
        if (!a.skrMint)
            throw new Error('SKR mint not configured');
        return claimSkrRootIx({ ...a, skrMint: a.skrMint });
    }
    if (!a.cgMint)
        throw new Error('$CG mint not configured');
    return claimRootIx({ ...a, cgMint: a.cgMint });
}
/** Treasury / anyone tops up the SKR prize pool (multisig runs this weekly from SKR revenue). */
function fundSkrIx(a) {
    const [pool] = (0, pdas_1.skrPoolPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [(0, anchor_1.signer)(a.funder, false), (0, anchor_1.rw)(pool), (0, anchor_1.rw)((0, pdas_1.ata)(a.skrMint, a.funder)), (0, anchor_1.rw)((0, pdas_1.ata)(a.skrMint, pool)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('fund_skr', new borsh_1.BorshWriter().u64(a.amount).toBytes())),
    });
}
/** SEC-L5 `fund_slice(kind, amount)` — season oracle / admin burns the arena's 20 % wager rake (season pool ATA) into `slice_budget[kind]`; only kind 3 (PvpSeason) is accepted. */
exports.SLICE_PVP_SEASON = 3;
function fundSliceIx(a) {
    const [auth] = (0, pdas_1.seasonPoolAuthPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [(0, anchor_1.signer)(a.authority, false), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)(a.cgMint), (0, anchor_1.ro)(auth), (0, anchor_1.rw)((0, pdas_1.ata)(a.cgMint, auth)), (0, anchor_1.ro)(ids_1.TOKEN_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('fund_slice', new borsh_1.BorshWriter().u8(a.kind ?? exports.SLICE_PVP_SEASON).u64(a.amount).toBytes())),
    });
}
/** Early-exit penalty preview (bps of principal, burned). */
function unstakePenalty(amount, tier, unlockAt, nowSec = Math.floor(Date.now() / 1000)) {
    if (BigInt(nowSec) >= unlockAt)
        return 0n;
    return (amount * BigInt(exports.TIER_PENALTY_BPS[tier] ?? 0)) / 10000n;
}

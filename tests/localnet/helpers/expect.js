"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lamportsClose = exports.Err = exports.ANCHOR = void 0;
exports.expectFail = expectFail;
exports.expectAnyFail = expectAnyFail;
// Assertion helpers shared by every spec: "this tx must fail with <ProgramError>".
// Error names → codes come straight from the Rust enums (position + 6000), the same
// tables client/src/chain/errors.ts renders — a renamed / reordered variant fails here.
const vitest_1 = require("vitest");
const ids_1 = require("@/chain/ids");
const chain_1 = require("./chain");
const CHIP_CORE = [
    'Paused', 'Unauthorized', 'Overflow', 'InvalidSku', 'SkuDisabled', 'InvalidQuantity', 'DailyCapReached', 'StarterAlreadyClaimed', 'CurrencyNotAccepted',
    'OddsSumInvalid', 'OddsGuardRail', 'FeeTooHigh', 'StalePrice', 'Slippage', 'RandomnessExpired', 'RandomnessAlreadyRevealed', 'RandomnessNotResolved',
    'RandomnessMismatch', 'NotStale', 'InvalidCollection', 'CollectionExists', 'NotAssetOwner', 'WrongCollection', 'ChipNotFree', 'InvalidChipState',
    'MaterialRarityMismatch', 'MaterialCollectionMismatch', 'DuplicateMaterial', 'NoRecipe', 'NoBooster', 'StillLocked', 'NotProgramCaller', 'InvalidElement',
    'InvalidService', 'ServiceDailyCap', 'RandomnessAuthority', 'RandomnessUsed', 'PriceUncertain', 'AccountNotWritable', 'InvalidShard', 'InvalidVoucher', 'InvalidBubblegumTree', 'InvalidBubblegumProof',
    'CompressedMigrationRequired', 'CgPriceGuardRail',
];
const MARKET = ['PriceTooLow', 'NotOwner', 'NotSeller', 'CurrencyMismatch', 'OfferExpired', 'TtlTooLong', 'SelfTrade', 'Overflow', 'ChipLocked', 'MissingAccounts', 'CompressedClaimNotTradable', 'CompressedCurrencyMismatch'];
const STAKING = [
    'Paused', 'Unauthorized', 'Overflow', 'SplitSum', 'SplitGuard', 'DayAlreadyClosed', 'YearlyCap', 'InvalidTier', 'BelowMinimum', 'NothingToClaim',
    'BudgetExceeded', 'RootTimelocked', 'RootRevoked', 'BadProof', 'AlreadyClaimed', 'RootBudgetExceeded', 'NotBurnReporter', 'NotOwner', 'ChipNotFree', 'InvalidBubblegumProof',
    'BadOracle', 'TooManySets', 'WrongRootCurrency', 'SkrPoolPaused', 'SkrBudgetExceeded', 'ZeroAmount', 'WrongSlice', 'InsufficientPool', 'ItemBudgetExceeded',
    'ChipBudgetExceeded', 'ClaimExpired', 'BeforeGenesis',
];
const ARENA = [
    'Paused', 'Unauthorized', 'WagerRange', 'BadStatus', 'NotOwner', 'ChipBusy', 'InvalidBubblegumProof', 'DuplicateChip', 'SquadTooWeak', 'LeagueMismatch', 'BadWinner', 'OracleCap',
    'NotStale', 'SelfBattle', 'Randomness', 'Overflow',
];
const SB_MOCK = ['InvalidAuthority', 'InvalidAccount', 'RandomnessNotRequested', 'AlreadyRevealed', 'PayloadTooLong'];
/** Anchor framework errors we assert on by name. */
exports.ANCHOR = {
    ConstraintSeeds: 2006, ConstraintHasOne: 2001, ConstraintSigner: 2002, ConstraintRaw: 2003, ConstraintOwner: 2004, ConstraintAddress: 2012, ConstraintTokenOwner: 2015,
    ConstraintMintDecimals: 2018, ConstraintAssociated: 2009, AccountDiscriminatorMismatch: 3002, AccountDidNotDeserialize: 3003, AccountOwnedByWrongProgram: 3007,
    AccountNotInitialized: 3012, ConstraintTokenMint: 2014,
};
exports.Err = {
    chip: (n) => ({ code: 6000 + CHIP_CORE.indexOf(n), program: ids_1.CHIP_CORE_ID.toBase58(), name: `chip_core::${n}` }),
    market: (n) => ({ code: 6000 + MARKET.indexOf(n), program: ids_1.MARKET_ID.toBase58(), name: `market::${n}` }),
    staking: (n) => ({ code: 6000 + STAKING.indexOf(n), program: ids_1.STAKING_ID.toBase58(), name: `staking::${n}` }),
    arena: (n) => ({ code: 6000 + ARENA.indexOf(n), program: ids_1.ARENA_ID.toBase58(), name: `arena::${n}` }),
    mock: (n) => ({ code: 6000 + SB_MOCK.indexOf(n), program: 'ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH', name: `sb_mock::${n}` }),
    anchor: (n, program) => ({ code: exports.ANCHOR[n], program, name: `anchor::${n}` }),
    /** SPL Token program errors (e.g. 1 = InsufficientFunds, 4 = OwnerMismatch) */
    token: (code) => ({ code, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', name: `token::${code}` }),
    /** System program answers — anchor 0.31's `init` on a live PDA does not pre-check existence: the
     *  create_account CPI fails with AccountAlreadyInUse (code 0) instead of a ConstraintSeeds error
     *  (observed on the first real suite run, 2026-09-19: 00-admin G01b and 50-staking S06). */
    system: (code) => ({ code, program: ids_1.SYSTEM_PROGRAM_ID.toBase58(), name: `system::${code}` }),
};
/** Await `p` and assert it failed with `e` (code + raising program). Returns the failure for further checks. */
async function expectFail(p, e, label) {
    const want = typeof e === 'number' ? { code: e, name: `custom ${e}` } : e;
    let failure;
    try {
        await p;
    }
    catch (err) {
        if (!(err instanceof chain_1.TxFailure))
            throw err;
        failure = err;
    }
    if (!failure)
        throw new Error(`${label ?? 'tx'}: expected ${want.name} (${want.code}) but the transaction SUCCEEDED`);
    const got = `${failure.code}${failure.programId ? ` from ${failure.programId}` : ''}`;
    (0, vitest_1.expect)(failure.code, `${label ?? 'tx'}: expected ${want.name} (${want.code}), got ${got}\n${failure.logs.slice(-6).join('\n')}`).toBe(want.code);
    if (want.program)
        (0, vitest_1.expect)(failure.programId, `${label ?? 'tx'}: ${want.name} raised by the wrong program (${got})`).toBe(want.program);
    return failure;
}
/** Assert a tx failed for ANY reason (used when the exact code is runtime-defined, e.g. signature checks). */
async function expectAnyFail(p, label) {
    try {
        await p;
    }
    catch (err) {
        if (err instanceof chain_1.TxFailure)
            return err;
        throw err;
    }
    throw new Error(`${label ?? 'tx'}: expected a failure but the transaction SUCCEEDED`);
}
const lamportsClose = (a, b, tol = 10000n) => (a > b ? a - b : b - a) <= tol;
exports.lamportsClose = lamportsClose;

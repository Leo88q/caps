use anchor_lang::prelude::*;

#[error_code]
pub enum StakeError {
    #[msg("Paused")] Paused,
    #[msg("Unauthorized")] Unauthorized,
    #[msg("Arithmetic overflow")] Overflow,
    #[msg("Split must sum to 10 000 bps")] SplitSum,
    #[msg("Split change exceeds ±10 pp or is too soon")] SplitGuard,
    #[msg("Day already closed")] DayAlreadyClosed,
    #[msg("Yearly emission cap reached")] YearlyCap,
    #[msg("Invalid tier")] InvalidTier,
    #[msg("Below minimum stake")] BelowMinimum,
    #[msg("Nothing to claim")] NothingToClaim,
    #[msg("Root budget exceeds slice budget")] BudgetExceeded,
    #[msg("Root is still in its timelock window")] RootTimelocked,
    #[msg("Root revoked")] RootRevoked,
    #[msg("Invalid Merkle proof")] BadProof,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("Claim exceeds root budget")] RootBudgetExceeded,
    #[msg("Only registered programs may report burns")] NotBurnReporter,
    #[msg("Not the asset owner")] NotOwner,
    #[msg("Chip is not free (listed / locked / already staked)")] ChipNotFree,
    #[msg("Oracle signature/authority mismatch")] BadOracle,
    #[msg("Too many sets")] TooManySets,
}

use anchor_lang::prelude::*;

#[error_code]
pub enum ChipGameError {
    #[msg("Chip has already reached the max level for its rarity tier.")]
    MaxLevelReached,
    #[msg("Not enough material chips or currency supplied for this upgrade.")]
    InsufficientUpgradeCost,
    #[msg("This chip is currently staked and must be unstaked first.")]
    ChipIsStaked,
    #[msg("This chip is currently listed and must be delisted first.")]
    ChipIsListed,
    #[msg("Only the seller can cancel this listing.")]
    NotSeller,
    #[msg("The VRF result for this pack has not been fulfilled yet.")]
    VrfNotFulfilled,
    #[msg("This pack has already been opened.")]
    PackAlreadyOpened,
    #[msg("Provided VRF account does not match the pending pack open request.")]
    VrfAccountMismatch,
    #[msg("Marketplace fee exceeds the maximum allowed basis points.")]
    FeeTooHigh,
    #[msg("The game is currently paused by an admin.")]
    GamePaused,
    #[msg("Only the battle oracle can resolve this battle.")]
    NotBattleOracle,
    #[msg("This battle is not in the expected status for this action.")]
    InvalidBattleStatus,
    #[msg("Winner must be either the challenger or the opponent.")]
    InvalidWinner,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("Unknown quest id for this period.")]
    UnknownQuest,
    #[msg("Quest progress target not yet reached.")]
    QuestNotComplete,
    #[msg("This quest has already been claimed for the current period.")]
    QuestAlreadyClaimed,
}

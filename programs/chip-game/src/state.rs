use anchor_lang::prelude::*;

#[account]
pub struct GameConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub cg_mint: Pubkey,           // reward/staking token mint ($CG)
    pub pack_price_lamports: u64,  // price of a common pack, in lamports (or swap for an SPL price if you sell packs in $CG/USDC instead)
    pub marketplace_fee_bps: u16,  // e.g. 250 = 2.5%
    pub paused: bool,              // emergency stop: blocks buy_pack, list_chip, stake_chip when true
    /// Backend key authorized to resolve PvP battles. Combat itself runs
    /// off-chain (see instructions/battle.rs for why); this key signs the
    /// result so the program can pay out without trusting either player.
    pub battle_oracle: Pubkey,
    pub bump: u8,
}

impl GameConfig {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 2 + 1 + 32 + 1;
}

#[account]
pub struct Collection {
    pub authority: Pubkey,
    pub symbol: [u8; 16],   // fixed-size ascii symbol, e.g. b"PUPPETSTREET"
    pub minted: u64,        // running count, used for on-chip #index
    pub bump: u8,
}

impl Collection {
    pub const SIZE: usize = 8 + 32 + 16 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rarity {
    Common,
    CommonPlus,
    Rare,
    RarePlus,
    Epic,
    EpicPlus,
    Legend,
    LegendPlus,
    Diamond,
}

impl Rarity {
    /// Max upgrade level per rarity tier — higher rarity chips have more headroom.
    pub fn max_level(&self) -> u8 {
        match self {
            Rarity::Common => 12,
            Rarity::CommonPlus => 16,
            Rarity::Rare => 20,
            Rarity::RarePlus => 24,
            Rarity::Epic => 28,
            Rarity::EpicPlus => 32,
            Rarity::Legend => 36,
            Rarity::LegendPlus => 40,
            Rarity::Diamond => 50,
        }
    }

    /// Base $CG staking rate per hour, in micro-CG (6 decimals), before level multiplier.
    pub fn base_stake_rate(&self) -> u64 {
        match self {
            Rarity::Common => 500,
            Rarity::CommonPlus => 800,
            Rarity::Rare => 1_300,
            Rarity::RarePlus => 2_000,
            Rarity::Epic => 3_200,
            Rarity::EpicPlus => 5_000,
            Rarity::Legend => 8_000,
            Rarity::LegendPlus => 12_000,
            Rarity::Diamond => 20_000,
        }
    }

    /// Weighted pack odds out of 10_000, tune freely. Must sum to 10_000.
    pub fn pack_weight(&self) -> u16 {
        match self {
            Rarity::Common => 4500,
            Rarity::CommonPlus => 2500,
            Rarity::Rare => 1500,
            Rarity::RarePlus => 800,
            Rarity::Epic => 450,
            Rarity::EpicPlus => 180,
            Rarity::Legend => 50,
            Rarity::LegendPlus => 18,
            Rarity::Diamond => 2,
        }
    }

    pub fn from_roll(roll: u16) -> Self {
        let tiers = [
            Rarity::Common, Rarity::CommonPlus, Rarity::Rare, Rarity::RarePlus,
            Rarity::Epic, Rarity::EpicPlus, Rarity::Legend, Rarity::LegendPlus, Rarity::Diamond,
        ];
        let mut acc: u16 = 0;
        for tier in tiers {
            acc += tier.pack_weight();
            if roll < acc {
                return tier;
            }
        }
        Rarity::Common // fallback, should be unreachable if weights sum to 10_000
    }
}

/// Per-chip mutable game state, one PDA per chip mint.
/// The mint + metadata stay static (art, name); everything that changes
/// during play lives here instead, so we never touch Metaplex metadata at runtime.
#[account]
pub struct ChipState {
    pub mint: Pubkey,
    pub collection: Pubkey,
    pub rarity: Rarity,
    pub level: u8,
    pub xp: u32,
    pub index: u64,          // e.g. #182104 shown in the UI
    pub staked: bool,
    pub stake_started_at: i64,
    pub accrued_rewards: u64, // micro-$CG banked at last stake/unstake/claim boundary
    pub bump: u8,
}

impl ChipState {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1 + 4 + 8 + 1 + 8 + 8 + 1;
}

/// Escrow-based marketplace listing. The chip's token account is transferred
/// to a PDA-owned escrow token account for the duration of the listing.
#[account]
pub struct Listing {
    pub seller: Pubkey,
    pub chip_mint: Pubkey,
    pub price_lamports: u64,
    pub bump: u8,
}

impl Listing {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1;
}

/// Tracks an in-flight pack purchase awaiting VRF-backed randomness.
#[account]
pub struct PendingPackOpen {
    pub buyer: Pubkey,
    pub collection: Pubkey,
    pub vrf_account: Pubkey,
    pub fulfilled: bool,
    pub bump: u8,
}

impl PendingPackOpen {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 1 + 1;
}

/// Escrow-based PvP wager: both players lock a chip + lamports; the battle
/// itself is simulated off-chain (stats, RNG for the fight), and this
/// account only exists to make the payout trustless once a result exists.
#[account]
pub struct WagerBattle {
    pub challenger: Pubkey,
    pub challenger_chip: Pubkey,
    pub opponent: Pubkey,
    pub opponent_chip: Pubkey,
    pub wager_lamports: u64,
    pub status: BattleStatus,
    pub bump: u8,
}

impl WagerBattle {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BattleStatus {
    AwaitingOpponent,
    AwaitingResolution,
    Resolved,
}

#[event]
pub struct PackOpened {
    pub buyer: Pubkey,
    pub chip_mint: Pubkey,
    pub rarity: Rarity,
    pub index: u64,
}

#[event]
pub struct ChipUpgraded {
    pub chip_mint: Pubkey,
    pub new_level: u8,
}

#[event]
pub struct ChipSold {
    pub chip_mint: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price_lamports: u64,
}

#[event]
pub struct RewardsClaimed {
    pub chip_mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BattleResolved {
    pub battle: Pubkey,
    pub winner: Pubkey,
    pub payout_lamports: u64,
}

/// Per-player quest progress. Daily/weekly counters reset lazily — there's
/// no cron on Solana, so instead each counter carries the timestamp its
/// current window started, and any instruction that touches this account
/// checks "has a full period elapsed?" before incrementing, resetting to
/// zero (and clearing that period's claimed bits) if so. See
/// quests::maybe_reset_windows and quests::record_progress in
/// instructions/quests.rs.
#[account]
pub struct QuestProgress {
    pub owner: Pubkey,
    pub daily_window_start: i64,
    pub weekly_window_start: i64,
    pub packs_opened_daily: u16,
    pub upgrades_daily: u16,
    pub battles_won_daily: u16,
    pub battles_won_weekly: u16,
    pub listings_weekly: u16,
    pub battles_won_lifetime: u32,
    pub claimed_daily_mask: u8,
    pub claimed_weekly_mask: u8,
    pub claimed_permanent_mask: u8,
    pub bump: u8,
}

impl QuestProgress {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 2 + 2 + 2 + 2 + 2 + 4 + 1 + 1 + 1 + 1;
}

#[event]
pub struct QuestClaimed {
    pub owner: Pubkey,
    pub period: u8, // 0 = daily, 1 = weekly, 2 = permanent
    pub quest_id: u8,
    pub reward: u64,
}

#[event]
pub struct ChipStaked {
    pub chip_mint: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct ChipUnstaked {
    pub chip_mint: Pubkey,
    pub owner: Pubkey,
    pub rewards_accrued: u64,
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_weights_sum_to_10_000() {
        let total: u16 = [
            Rarity::Common, Rarity::CommonPlus, Rarity::Rare, Rarity::RarePlus,
            Rarity::Epic, Rarity::EpicPlus, Rarity::Legend, Rarity::LegendPlus, Rarity::Diamond,
        ]
        .iter()
        .map(|r| r.pack_weight())
        .sum();
        assert_eq!(total, 10_000, "rarity weights must sum to 10_000 or from_roll silently favors Common");
    }

    #[test]
    fn from_roll_boundaries_match_expected_tiers() {
        // Cumulative boundaries given the weights in pack_weight():
        // Common 0..4500, CommonPlus 4500..7000, Rare 7000..8500, ... Diamond 9998..10000
        assert_eq!(Rarity::from_roll(0), Rarity::Common);
        assert_eq!(Rarity::from_roll(4499), Rarity::Common);
        assert_eq!(Rarity::from_roll(4500), Rarity::CommonPlus);
        assert_eq!(Rarity::from_roll(9999), Rarity::Diamond);
    }

    #[test]
    fn max_level_increases_with_rarity() {
        assert!(Rarity::Diamond.max_level() > Rarity::Legend.max_level());
        assert!(Rarity::Legend.max_level() > Rarity::Epic.max_level());
        assert!(Rarity::Common.max_level() < Rarity::Diamond.max_level());
    }
}

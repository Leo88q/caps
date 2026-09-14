use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod instructions;

use instructions::*;
use state::Rarity;

declare_id!("ChpGame1111111111111111111111111111111111");

#[program]
pub mod chip_game {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        pack_price_lamports: u64,
        marketplace_fee_bps: u16,
    ) -> Result<()> {
        instructions::admin::initialize_config(ctx, pack_price_lamports, marketplace_fee_bps)
    }

    pub fn create_collection(ctx: Context<CreateCollection>, symbol: [u8; 16]) -> Result<()> {
        instructions::admin::create_collection(ctx, symbol)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_paused(ctx, paused)
    }

    pub fn set_battle_oracle(ctx: Context<SetBattleOracle>) -> Result<()> {
        instructions::admin::set_battle_oracle(ctx)
    }

    pub fn buy_pack(ctx: Context<BuyPack>) -> Result<()> {
        instructions::pack::buy_pack(ctx)
    }

    pub fn open_pack(ctx: Context<OpenPack>, chip_name: String, chip_uri: String) -> Result<()> {
        instructions::pack::open_pack(ctx, chip_name, chip_uri)
    }

    pub fn reveal_chip_metadata(ctx: Context<RevealChipMetadata>, chip_name: String, chip_uri: String) -> Result<()> {
        instructions::pack::reveal_chip_metadata(ctx, chip_name, chip_uri)
    }

    pub fn upgrade_chip(ctx: Context<UpgradeChip>) -> Result<()> {
        instructions::upgrade::upgrade_chip(ctx)
    }

    pub fn list_chip(ctx: Context<ListChip>, price_lamports: u64) -> Result<()> {
        instructions::marketplace::list_chip(ctx, price_lamports)
    }

    pub fn buy_chip(ctx: Context<BuyChip>) -> Result<()> {
        instructions::marketplace::buy_chip(ctx)
    }

    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        instructions::marketplace::cancel_listing(ctx)
    }

    pub fn stake_chip(ctx: Context<StakeChip>) -> Result<()> {
        instructions::staking::stake_chip(ctx)
    }

    pub fn unstake_chip(ctx: Context<UnstakeChip>) -> Result<()> {
        instructions::staking::unstake_chip(ctx)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::staking::claim_rewards(ctx)
    }

    pub fn create_battle(ctx: Context<CreateBattle>, wager_lamports: u64) -> Result<()> {
        instructions::battle::create_battle(ctx, wager_lamports)
    }

    pub fn accept_battle(ctx: Context<AcceptBattle>) -> Result<()> {
        instructions::battle::accept_battle(ctx)
    }

    pub fn resolve_battle(ctx: Context<ResolveBattle>, winner: Pubkey) -> Result<()> {
        instructions::battle::resolve_battle(ctx, winner)
    }

    pub fn init_quest_progress(ctx: Context<InitQuestProgress>) -> Result<()> {
        instructions::quests::init_quest_progress(ctx)
    }

    pub fn claim_quest(ctx: Context<ClaimQuest>, period: u8, quest_id: u8) -> Result<()> {
        instructions::quests::claim_quest(ctx, period, quest_id)
    }

    /// TEST-ONLY, ADMIN-GATED — see instructions/test_utils.rs. Strip before mainnet.
    pub fn seed_chip_state_for_test(
        ctx: Context<SeedChipStateForTest>,
        rarity: Rarity,
        level: u8,
        index: u64,
    ) -> Result<()> {
        instructions::test_utils::seed_chip_state_for_test(ctx, rarity, level, index)
    }
}

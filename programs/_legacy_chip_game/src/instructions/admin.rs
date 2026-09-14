use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::ChipGameError;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = GameConfig::SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, GameConfig>,

    /// CHECK: treasury just needs to be a valid pubkey to receive pack payments.
    pub treasury: UncheckedAccount<'info>,

    pub cg_mint: Account<'info, anchor_spl::token::Mint>,

    /// CHECK: key that will be authorized to resolve PvP battles (a backend
    /// service, not a player). Rotatable later via set_battle_oracle.
    pub battle_oracle: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    pack_price_lamports: u64,
    marketplace_fee_bps: u16,
) -> Result<()> {
    require!(marketplace_fee_bps <= 1000, ChipGameError::FeeTooHigh); // cap fee at 10%

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.treasury = ctx.accounts.treasury.key();
    config.cg_mint = ctx.accounts.cg_mint.key();
    config.pack_price_lamports = pack_price_lamports;
    config.marketplace_fee_bps = marketplace_fee_bps;
    config.paused = false;
    config.battle_oracle = ctx.accounts.battle_oracle.key();
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, has_one = admin @ ChipGameError::NotSeller)]
    pub config: Account<'info, GameConfig>,
    pub admin: Signer<'info>,
}

/// Emergency stop: flips `paused`, which buy_pack / list_chip / stake_chip
/// all check before doing anything irreversible. This does NOT freeze
/// existing listings, stakes, or balances — it only stops new ones from
/// being created while you investigate/patch an incident.
pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}

#[derive(Accounts)]
pub struct SetBattleOracle<'info> {
    #[account(mut, has_one = admin @ ChipGameError::NotSeller)]
    pub config: Account<'info, GameConfig>,
    pub admin: Signer<'info>,
    /// CHECK: new oracle key, no on-chain validation possible beyond admin's say-so.
    pub new_battle_oracle: UncheckedAccount<'info>,
}

pub fn set_battle_oracle(ctx: Context<SetBattleOracle>) -> Result<()> {
    ctx.accounts.config.battle_oracle = ctx.accounts.new_battle_oracle.key();
    Ok(())
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 16])]
pub struct CreateCollection<'info> {
    #[account(mut, has_one = admin @ ChipGameError::NotSeller)]
    pub config: Account<'info, GameConfig>,

    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = Collection::SIZE,
        seeds = [b"collection", symbol.as_ref()],
        bump
    )]
    pub collection: Account<'info, Collection>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_collection(ctx: Context<CreateCollection>, symbol: [u8; 16]) -> Result<()> {
    let collection = &mut ctx.accounts.collection;
    collection.authority = ctx.accounts.admin.key();
    collection.symbol = symbol;
    collection.minted = 0;
    collection.bump = ctx.bumps.collection;
    Ok(())
}

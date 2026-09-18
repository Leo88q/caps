use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, MintTo};
use crate::state::*;
use crate::errors::ChipGameError;

const SECONDS_PER_HOUR: i64 = 3600;

/// Rewards accrue continuously based on wall-clock time since the chip was
/// staked, scaled by rarity base rate and current level. Keeping the math
/// in one place means stake/unstake/claim all settle rewards identically.
/// Every step uses checked arithmetic: an unchecked overflow here would
/// either panic (halting the whole instruction, a griefing vector on a
/// long-staked whale chip) or, worse on release builds without overflow
/// checks, silently wrap and mint an absurd reward — checked_* turns both
/// into an explicit, recoverable error instead.
fn settle_rewards(chip: &mut ChipState, now: i64) -> Result<u64> {
    if !chip.staked {
        return Ok(0);
    }
    let elapsed_secs = now.saturating_sub(chip.stake_started_at).max(0) as u64;
    let level_bonus = 1u64.checked_add(chip.level as u64 / 5).ok_or(ChipGameError::Overflow)?;
    let rate_per_hour = chip
        .rarity
        .base_stake_rate()
        .checked_mul(level_bonus)
        .ok_or(ChipGameError::Overflow)?;
    let earned = rate_per_hour
        .checked_mul(elapsed_secs)
        .ok_or(ChipGameError::Overflow)?
        .checked_div(SECONDS_PER_HOUR as u64)
        .ok_or(ChipGameError::Overflow)?;
    chip.accrued_rewards = chip.accrued_rewards.checked_add(earned).ok_or(ChipGameError::Overflow)?;
    chip.stake_started_at = now;
    Ok(earned)
}

#[derive(Accounts)]
pub struct StakeChip<'info> {
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipGameError::GamePaused)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [b"chip", chip_mint.key().as_ref()],
        bump = chip_state.bump,
        constraint = !chip_state.staked @ ChipGameError::ChipIsStaked,
    )]
    pub chip_state: Account<'info, ChipState>,
    pub chip_mint: Account<'info, Mint>,

    /// Ownership check: the caller must hold the chip's token to stake it.
    /// A separate on-chain custody transfer isn't required here since we
    /// never let a staked chip's ChipState be touched by list/upgrade/etc.
    /// (those instructions already assert `!chip_state.staked`).
    #[account(
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == chip_mint.key(),
        constraint = owner_token_account.amount == 1,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
}

pub fn stake_chip(ctx: Context<StakeChip>) -> Result<()> {
    let chip = &mut ctx.accounts.chip_state;
    chip.staked = true;
    chip.stake_started_at = Clock::get()?.unix_timestamp;
    emit!(ChipStaked { chip_mint: ctx.accounts.chip_mint.key(), owner: ctx.accounts.owner.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct UnstakeChip<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"chip", chip_mint.key().as_ref()],
        bump = chip_state.bump,
        constraint = chip_state.staked @ ChipGameError::ChipIsStaked,
    )]
    pub chip_state: Account<'info, ChipState>,
    pub chip_mint: Account<'info, Mint>,

    #[account(
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == chip_mint.key(),
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
}

pub fn unstake_chip(ctx: Context<UnstakeChip>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let chip = &mut ctx.accounts.chip_state;
    let earned = settle_rewards(chip, now)?;
    chip.staked = false;
    emit!(ChipUnstaked { chip_mint: ctx.accounts.chip_mint.key(), owner: ctx.accounts.owner.key(), rewards_accrued: earned });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [b"chip", chip_mint.key().as_ref()],
        bump = chip_state.bump,
    )]
    pub chip_state: Account<'info, ChipState>,
    pub chip_mint: Account<'info, Mint>,

    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,

    #[account(mut)]
    pub owner_cg_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let chip = &mut ctx.accounts.chip_state;
    settle_rewards(chip, now)?;

    let amount = chip.accrued_rewards;
    chip.accrued_rewards = 0;

    let config_seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.cg_mint.to_account_info(),
                to: ctx.accounts.owner_cg_account.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[config_seeds],
        ),
        amount,
    )?;

    emit!(RewardsClaimed { chip_mint: ctx.accounts.chip_mint.key(), owner: ctx.accounts.owner.key(), amount });
    Ok(())
}

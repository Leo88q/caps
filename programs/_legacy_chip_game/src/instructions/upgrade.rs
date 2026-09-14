use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Mint};
use crate::state::*;
use crate::errors::ChipGameError;

#[derive(Accounts)]
pub struct UpgradeChip<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"chip", target_mint.key().as_ref()],
        bump = chip_state.bump,
        constraint = !chip_state.staked @ ChipGameError::ChipIsStaked,
    )]
    pub chip_state: Account<'info, ChipState>,
    pub target_mint: Account<'info, Mint>,

    /// The chip being burned as upgrade material. Any chip in the same
    /// collection works; swap the constraint for a stricter rule
    /// (same rarity tier, same collection, etc.) as your economy needs.
    #[account(
        mut,
        seeds = [b"chip", material_mint.key().as_ref()],
        bump = material_state.bump,
        constraint = !material_state.staked @ ChipGameError::ChipIsStaked,
        close = owner,
    )]
    pub material_state: Account<'info, ChipState>,
    pub material_mint: Account<'info, Mint>,

    #[account(mut)]
    pub material_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// Feeds the "upgrade a chip" daily quest.
    #[account(
        mut,
        seeds = [b"quest_progress", owner.key().as_ref()],
        bump = quest_progress.bump,
    )]
    pub quest_progress: Account<'info, QuestProgress>,
}

pub fn upgrade_chip(ctx: Context<UpgradeChip>) -> Result<()> {
    let chip = &mut ctx.accounts.chip_state;
    require!(chip.level < chip.rarity.max_level(), ChipGameError::MaxLevelReached);

    // Burn the material chip's single token to consume it.
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.material_mint.to_account_info(),
                from: ctx.accounts.material_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        1,
    )?;

    chip.level += 1;
    chip.xp = 0;

    let now = Clock::get()?.unix_timestamp;
    let progress = &mut ctx.accounts.quest_progress;
    crate::instructions::quests::maybe_reset_windows(progress, now);
    progress.upgrades_daily = progress.upgrades_daily.saturating_add(1);

    emit!(ChipUpgraded { chip_mint: ctx.accounts.target_mint.key(), new_level: chip.level });

    // material_state account closes automatically via `close = owner` above,
    // refunding its rent to the caller.
    Ok(())
}

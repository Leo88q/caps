use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, MintTo};
use crate::state::*;
use crate::errors::ChipGameError;

const DAY_SECONDS: i64 = 86_400;
const WEEK_SECONDS: i64 = 7 * DAY_SECONDS;

/// Called at the top of every instruction that touches quest progress.
/// Solana has no cron, so instead of a scheduled reset, each window
/// carries its own start timestamp and gets lazily zeroed the next time
/// anyone interacts with it after a full period has elapsed. This also
/// clears that period's claimed-quest bitmask, since a new day/week means
/// the same quest ids become claimable again.
pub fn maybe_reset_windows(progress: &mut QuestProgress, now: i64) {
    if now - progress.daily_window_start >= DAY_SECONDS {
        progress.daily_window_start = now;
        progress.packs_opened_daily = 0;
        progress.upgrades_daily = 0;
        progress.battles_won_daily = 0;
        progress.claimed_daily_mask = 0;
    }
    if now - progress.weekly_window_start >= WEEK_SECONDS {
        progress.weekly_window_start = now;
        progress.battles_won_weekly = 0;
        progress.listings_weekly = 0;
        progress.claimed_weekly_mask = 0;
    }
}

/// Fixed quest catalog. Hard-coded rather than a data account because the
/// set is small and rarely changes — adding a quest is a program upgrade,
/// which also means players can audit exactly what's claimable and for how
/// much, the same transparency argument made throughout this program.
/// Rewards are in micro-$CG (6 decimals), reusing the staking reward mint
/// rather than introducing a separate "shards" token.
pub struct QuestDef {
    pub id: u8,
    pub target: u16,
    pub reward: u64,
}

pub const DAILY_QUESTS: [QuestDef; 3] = [
    QuestDef { id: 0, target: 3, reward: 20_000_000 }, // open 3 packs
    QuestDef { id: 1, target: 1, reward: 20_000_000 }, // upgrade a chip
    QuestDef { id: 2, target: 1, reward: 20_000_000 }, // win a PvP battle
];
pub const WEEKLY_QUESTS: [QuestDef; 2] = [
    QuestDef { id: 0, target: 5, reward: 80_000_000 }, // win 5 PvP battles
    QuestDef { id: 1, target: 1, reward: 40_000_000 }, // list a chip
];
pub const PERMANENT_QUESTS: [QuestDef; 1] = [
    QuestDef { id: 0, target: 50, reward: 200_000_000 }, // win 50 battles lifetime
];

#[derive(Accounts)]
pub struct InitQuestProgress<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = QuestProgress::SIZE,
        seeds = [b"quest_progress", owner.key().as_ref()],
        bump
    )]
    pub quest_progress: Account<'info, QuestProgress>,

    pub system_program: Program<'info, System>,
}

pub fn init_quest_progress(ctx: Context<InitQuestProgress>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let progress = &mut ctx.accounts.quest_progress;
    progress.owner = ctx.accounts.owner.key();
    progress.daily_window_start = now;
    progress.weekly_window_start = now;
    progress.bump = ctx.bumps.quest_progress;
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimQuest<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [b"quest_progress", owner.key().as_ref()],
        bump = quest_progress.bump,
        has_one = owner,
    )]
    pub quest_progress: Account<'info, QuestProgress>,

    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,

    #[account(mut)]
    pub owner_cg_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// period: 0 = daily, 1 = weekly, 2 = permanent. quest_id indexes into the
/// matching catalog array above.
pub fn claim_quest(ctx: Context<ClaimQuest>, period: u8, quest_id: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let progress = &mut ctx.accounts.quest_progress;
    maybe_reset_windows(progress, now);

    let (def, current, claimed_mask): (&QuestDef, u16, u8) = match period {
        0 => (
            DAILY_QUESTS.get(quest_id as usize).ok_or(ChipGameError::UnknownQuest)?,
            match quest_id { 0 => progress.packs_opened_daily, 1 => progress.upgrades_daily, 2 => progress.battles_won_daily, _ => 0 },
            progress.claimed_daily_mask,
        ),
        1 => (
            WEEKLY_QUESTS.get(quest_id as usize).ok_or(ChipGameError::UnknownQuest)?,
            match quest_id { 0 => progress.battles_won_weekly, 1 => progress.listings_weekly, _ => 0 },
            progress.claimed_weekly_mask,
        ),
        2 => (
            PERMANENT_QUESTS.get(quest_id as usize).ok_or(ChipGameError::UnknownQuest)?,
            progress.battles_won_lifetime.min(u16::MAX as u32) as u16,
            progress.claimed_permanent_mask,
        ),
        _ => return err!(ChipGameError::UnknownQuest),
    };

    require!(current >= def.target, ChipGameError::QuestNotComplete);
    require!(claimed_mask & (1 << quest_id) == 0, ChipGameError::QuestAlreadyClaimed);

    match period {
        0 => progress.claimed_daily_mask |= 1 << quest_id,
        1 => progress.claimed_weekly_mask |= 1 << quest_id,
        _ => progress.claimed_permanent_mask |= 1 << quest_id,
    }

    let reward = def.reward;
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
        reward,
    )?;

    emit!(QuestClaimed { owner: ctx.accounts.owner.key(), period, quest_id, reward });
    Ok(())
}

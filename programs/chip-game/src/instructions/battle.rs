use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use crate::state::*;
use crate::errors::ChipGameError;

/// Why combat isn't simulated on-chain: a fair fight needs each chip's full
/// stat block (rarity, level, and whatever ability system you build on top),
/// which is cheap to read on-chain but expensive to *resolve* — matchmaking,
/// turn order, and any randomness beyond a single roll belong in a backend
/// that can react in real time. What has to be trustless is the payout, so
/// this module only escrows both wagers and releases them once a result
/// exists, signed by `config.battle_oracle` (your backend's keypair).
/// The oracle is a single point of trust for *fight resolution*, not for
/// custody — it can never move funds anywhere except to challenger or
/// opponent, enforced by the `InvalidWinner` check in resolve_battle.

#[derive(Accounts)]
pub struct CreateBattle<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipGameError::GamePaused)]
    pub config: Account<'info, GameConfig>,

    #[account(
        seeds = [b"chip", challenger_chip.key().as_ref()],
        bump = challenger_chip_state.bump,
        constraint = !challenger_chip_state.staked @ ChipGameError::ChipIsStaked,
    )]
    pub challenger_chip_state: Account<'info, ChipState>,
    /// CHECK: only used as a seed/reference; ownership is asserted by the
    /// wallet already holding it — no token transfer happens for battles.
    pub challenger_chip: UncheckedAccount<'info>,

    #[account(
        init,
        payer = challenger,
        space = WagerBattle::SIZE,
        seeds = [b"battle", challenger.key().as_ref(), challenger_chip.key().as_ref()],
        bump
    )]
    pub battle: Account<'info, WagerBattle>,

    pub system_program: Program<'info, System>,
}

pub fn create_battle(ctx: Context<CreateBattle>, wager_lamports: u64) -> Result<()> {
    invoke(
        &system_instruction::transfer(&ctx.accounts.challenger.key(), &ctx.accounts.battle.key(), wager_lamports),
        &[ctx.accounts.challenger.to_account_info(), ctx.accounts.battle.to_account_info()],
    )?;

    let battle = &mut ctx.accounts.battle;
    battle.challenger = ctx.accounts.challenger.key();
    battle.challenger_chip = ctx.accounts.challenger_chip.key();
    battle.opponent = Pubkey::default();
    battle.opponent_chip = Pubkey::default();
    battle.wager_lamports = wager_lamports;
    battle.status = BattleStatus::AwaitingOpponent;
    battle.bump = ctx.bumps.battle;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptBattle<'info> {
    #[account(mut)]
    pub opponent: Signer<'info>,

    #[account(
        mut,
        constraint = battle.status == BattleStatus::AwaitingOpponent @ ChipGameError::InvalidBattleStatus,
    )]
    pub battle: Account<'info, WagerBattle>,

    #[account(
        seeds = [b"chip", opponent_chip.key().as_ref()],
        bump = opponent_chip_state.bump,
        constraint = !opponent_chip_state.staked @ ChipGameError::ChipIsStaked,
    )]
    pub opponent_chip_state: Account<'info, ChipState>,
    /// CHECK: see note on challenger_chip above.
    pub opponent_chip: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn accept_battle(ctx: Context<AcceptBattle>) -> Result<()> {
    let wager = ctx.accounts.battle.wager_lamports;
    invoke(
        &system_instruction::transfer(&ctx.accounts.opponent.key(), &ctx.accounts.battle.key(), wager),
        &[ctx.accounts.opponent.to_account_info(), ctx.accounts.battle.to_account_info()],
    )?;

    let battle = &mut ctx.accounts.battle;
    battle.opponent = ctx.accounts.opponent.key();
    battle.opponent_chip = ctx.accounts.opponent_chip.key();
    battle.status = BattleStatus::AwaitingResolution;
    // At this point your backend sees both chips locked in and runs the
    // actual fight simulation off-chain, then calls resolve_battle below.
    Ok(())
}

#[derive(Accounts)]
#[instruction(winner: Pubkey)]
pub struct ResolveBattle<'info> {
    #[account(address = config.battle_oracle @ ChipGameError::NotBattleOracle)]
    pub battle_oracle: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        close = challenger, // rent goes back to whoever created the battle
        constraint = battle.status == BattleStatus::AwaitingResolution @ ChipGameError::InvalidBattleStatus,
        has_one = challenger,
    )]
    pub battle: Account<'info, WagerBattle>,

    /// CHECK: receives rent refund only if they aren't the winner (see below).
    #[account(mut)]
    pub challenger: UncheckedAccount<'info>,
    /// CHECK: payout destination if they win.
    #[account(mut, address = battle.opponent)]
    pub opponent: UncheckedAccount<'info>,

    /// Quest progress for whichever side wins — must already exist for
    /// that wallet. Feeds "win a battle" (daily), "win 5 battles" (weekly),
    /// and "win 50 battles lifetime" (permanent).
    #[account(
        mut,
        seeds = [b"quest_progress", winner.as_ref()],
        bump = winner_quest_progress.bump,
    )]
    pub winner_quest_progress: Account<'info, QuestProgress>,
}

pub fn resolve_battle(ctx: Context<ResolveBattle>, winner: Pubkey) -> Result<()> {
    let battle = &ctx.accounts.battle;
    require!(
        winner == battle.challenger || winner == battle.opponent,
        ChipGameError::InvalidWinner
    );

    let payout = battle.wager_lamports.checked_mul(2).ok_or(ChipGameError::Overflow)?;
    let battle_lamports = ctx.accounts.battle.to_account_info();

    // Both wagers currently sit in the battle PDA's own lamport balance
    // (it was funded directly via system_instruction::transfer in
    // create_battle/accept_battle, not through a separate escrow account).
    // `close = challenger` above already queues the account's rent-exempt
    // minimum back to the challenger; here we move the wager pot itself to
    // whichever side actually won.
    let winner_account = if winner == ctx.accounts.opponent.key() {
        &ctx.accounts.opponent
    } else {
        &ctx.accounts.challenger
    };

    **battle_lamports.try_borrow_mut_lamports()? -= payout;
    **winner_account.to_account_info().try_borrow_mut_lamports()? += payout;

    let now = Clock::get()?.unix_timestamp;
    let progress = &mut ctx.accounts.winner_quest_progress;
    crate::instructions::quests::maybe_reset_windows(progress, now);
    progress.battles_won_daily = progress.battles_won_daily.saturating_add(1);
    progress.battles_won_weekly = progress.battles_won_weekly.saturating_add(1);
    progress.battles_won_lifetime = progress.battles_won_lifetime.saturating_add(1);

    emit!(BattleResolved { battle: ctx.accounts.battle.key(), winner, payout_lamports: payout });
    Ok(())
}

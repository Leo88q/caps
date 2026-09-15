//! GUTTERCAPS — arena
//!
//! PvP itself is server-authoritative (queue, matchmaking, resolution,
//! rating — docs/02-economy.md §4). This program only exists so that
//! **wagered** matches never require trusting the server with funds:
//!
//!  * both stakes sit in a PDA-owned $CG escrow;
//!  * the battle oracle can only name a winner ∈ {challenger, opponent};
//!  * rake is fixed at 5 % — 40 % → treasury ATA (studio revenue), 40 % burned
//!    on-chain, 20 % → season pool ATA (Phase 5 fee schedule v2);
//!  * the oracle has a daily payout cap (circuit breaker if its key leaks);
//!  * the squad is pinned at create/accept (ownership + not-listed checked
//!    on-chain), and the battle is bound to a Switchboard randomness
//!    account committed at create — the server derives the battle seed as
//!    sha256(matchId ‖ commitA ‖ commitB ‖ vrf), so it cannot pick the RNG.
//!  * stale battles are cancellable by either side with a full refund.
//!
//! Chips are never at risk; only $CG.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;
use mpl_core::accounts::BaseAssetV1;
use chip_core::randomness;

use chip_core::state::ChipState;

declare_id!("GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM");

pub const MICRO: u64 = 1_000_000;
pub const MIN_WAGER: u64 = 5 * MICRO;
pub const MAX_WAGER: u64 = 5_000 * MICRO;
pub const RAKE_BPS: u64 = 500;
pub const RAKE_TREASURY_BPS: u64 = 4_000; // share of the rake → treasury
pub const RAKE_POOL_BPS: u64 = 2_000;     // share of the rake → season pool; the rest is burned
pub const ACCEPT_TIMEOUT: i64 = 10 * 60;
pub const RESOLVE_TIMEOUT: i64 = 30 * 60;
pub const SQUAD: usize = 3;
pub const DAY: i64 = 86_400;
pub const MIN_SQUAD_POWER: u32 = 400;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum BattleStatus { Open = 0, Accepted = 1, Resolved = 2, Cancelled = 3 }

#[account]
#[derive(InitSpace)]
pub struct ArenaConfig {
    pub admin: Pubkey,
    pub battle_oracle: Pubkey,
    pub cg_mint: Pubkey,
    pub season_pool: Pubkey,          // ATA receiving 20 % of rake (owned by staking emission PDA)
    pub treasury_cg: Pubkey,          // ATA receiving 40 % of rake (Squads treasury)
    pub oracle_daily_cap: u64,        // micro $CG the oracle may pay out per day (sum of pots)
    pub oracle_paid_today: u64,
    pub oracle_day_start: i64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WagerBattle {
    pub challenger: Pubkey,
    pub opponent: Pubkey,
    pub wager: u64,
    pub squad_a: [Pubkey; SQUAD],
    pub squad_b: [Pubkey; SQUAD],
    pub power_a: u32,
    pub power_b: u32,
    pub randomness: Pubkey,
    pub commit_slot: u64,
    pub status: BattleStatus,
    pub created_at: i64,
    pub accepted_at: i64,
    pub winner: Pubkey,
    pub result_hash: [u8; 32],        // sha256 of the full server battle log (auditable vs published season secret)
    pub nonce: u64,
    pub bump: u8,
}

#[event] pub struct BattleCreated { pub battle: Pubkey, pub challenger: Pubkey, pub wager: u64, pub power_a: u32, pub randomness: Pubkey }
#[event] pub struct BattleAccepted { pub battle: Pubkey, pub opponent: Pubkey, pub power_b: u32 }
#[event] pub struct BattleResolved { pub battle: Pubkey, pub winner: Pubkey, pub pot: u64, pub rake_burn: u64, pub rake_pool: u64, pub rake_treasury: u64, pub result_hash: [u8; 32], pub roll: [u8; 32] }
#[event] pub struct BattleCancelled { pub battle: Pubkey, pub refunded_a: u64, pub refunded_b: u64 }

#[error_code]
pub enum ArenaError {
    #[msg("Paused")] Paused,
    #[msg("Unauthorized")] Unauthorized,
    #[msg("Wager out of range (5–5000 $CG)")] WagerRange,
    #[msg("Battle is not in the expected status")] BadStatus,
    #[msg("Squad chip not owned by signer")] NotOwner,
    #[msg("Squad chip is listed / fusing / locked")] ChipBusy,
    #[msg("Duplicate chip in squad")] DuplicateChip,
    #[msg("Squad power below minimum")] SquadTooWeak,
    #[msg("Squad power mismatch between players is beyond league bounds")] LeagueMismatch,
    #[msg("Winner must be challenger or opponent")] BadWinner,
    #[msg("Oracle daily payout cap reached")] OracleCap,
    #[msg("Not stale yet")] NotStale,
    #[msg("Cannot battle yourself")] SelfBattle,
    #[msg("Randomness account expired / already revealed / not resolved")] Randomness,
    #[msg("Arithmetic overflow")] Overflow,
}

/// Squad power = Σ basePower(rarity) × levelMult. Element/synergy live off-chain (they need the opponent).
fn squad_power(chips: &[Account<ChipState>]) -> u32 {
    chips.iter().map(|c| (c.rarity.base_power() as u64 * chip_core::economy::level_mult_bps(c.level) / 10_000) as u32).sum()
}

fn validate_squad<'info>(rem: &[AccountInfo<'info>], owner: &Pubkey, now: i64) -> Result<([Pubkey; SQUAD], u32)> {
    require!(rem.len() == SQUAD * 2, ArenaError::DuplicateChip);
    let mut keys = [Pubkey::default(); SQUAD];
    let mut states: Vec<Account<ChipState>> = Vec::with_capacity(SQUAD);
    for i in 0..SQUAD {
        let asset = &rem[i * 2];
        let state_ai = &rem[i * 2 + 1];
        let base = BaseAssetV1::from_bytes(&asset.try_borrow_data()?).map_err(|_| error!(ArenaError::NotOwner))?;
        require_keys_eq!(base.owner, *owner, ArenaError::NotOwner);
        let (exp, _) = Pubkey::find_program_address(&[b"chip", asset.key().as_ref()], &chip_core::ID);
        require_keys_eq!(exp, state_ai.key(), ArenaError::NotOwner);
        let st: Account<ChipState> = Account::try_from(state_ai)?;
        // staked chips MAY fight (they're frozen, not gone); listed / fusing may not
        require!(st.flags & (ChipState::F_LISTED | ChipState::F_FUSING) == 0, ArenaError::ChipBusy);
        let _ = now;
        for k in &keys[..i] { require!(*k != asset.key(), ArenaError::DuplicateChip); }
        keys[i] = asset.key();
        states.push(st);
    }
    let power = squad_power(&states);
    require!(power >= MIN_SQUAD_POWER, ArenaError::SquadTooWeak);
    Ok((keys, power))
}

/// League bands from docs/02-economy.md §4.5 — opponents must share a league.
fn league(power: u32) -> u8 {
    match power { 0..=799 => 0, 800..=1399 => 1, 1400..=2399 => 2, 2400..=3999 => 3, 4000..=6999 => 4, _ => 5 }
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitArena<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + ArenaConfig::INIT_SPACE, seeds = [b"arena_config"], bump)]
    pub config: Account<'info, ArenaConfig>,
    pub system_program: Program<'info, System>,
}

pub fn init_arena_handler(ctx: Context<InitArena>, battle_oracle: Pubkey, cg_mint: Pubkey, season_pool: Pubkey, treasury_cg: Pubkey, oracle_daily_cap: u64) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key(); c.battle_oracle = battle_oracle; c.cg_mint = cg_mint; c.season_pool = season_pool; c.treasury_cg = treasury_cg;
    c.oracle_daily_cap = oracle_daily_cap; c.oracle_day_start = Clock::get()?.unix_timestamp; c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct ArenaAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"arena_config"], bump = config.bump, has_one = admin @ ArenaError::Unauthorized)]
    pub config: Account<'info, ArenaConfig>,
}

pub fn set_arena_handler(ctx: Context<ArenaAdmin>, battle_oracle: Option<Pubkey>, oracle_daily_cap: Option<u64>, paused: Option<bool>, treasury_cg: Option<Pubkey>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(o) = battle_oracle { c.battle_oracle = o; }
    if let Some(cap) = oracle_daily_cap { c.oracle_daily_cap = cap; }
    if let Some(p) = paused { c.paused = p; }
    if let Some(t) = treasury_cg { c.treasury_cg = t; }
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateBattle<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,
    #[account(seeds = [b"arena_config"], bump = config.bump, constraint = !config.paused @ ArenaError::Paused)]
    pub config: Account<'info, ArenaConfig>,
    #[account(init, payer = challenger, space = 8 + WagerBattle::INIT_SPACE, seeds = [b"battle", challenger.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub battle: Account<'info, WagerBattle>,
    /// CHECK: Switchboard randomness (fresh, unrevealed) — owner = Switchboard enforced (SEC-C1)
    #[account(owner = randomness::SB_PROGRAM_ID @ ArenaError::Randomness)]
    pub randomness: UncheckedAccount<'info>,
    #[account(address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = cg_mint, token::authority = challenger)]
    pub challenger_cg: Account<'info, TokenAccount>,
    #[account(init, payer = challenger, associated_token::mint = cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [asset_i, chip_state_i] × 3
}

pub fn create_battle_handler<'info>(ctx: Context<'_, '_, 'info, 'info, CreateBattle<'info>>, nonce: u64, wager: u64) -> Result<()> {
    require!((MIN_WAGER..=MAX_WAGER).contains(&wager), ArenaError::WagerRange);
    let clock = Clock::get()?;
    let rnd = randomness::parse_checked(&ctx.accounts.randomness).map_err(|_| error!(ArenaError::Randomness))?;
    randomness::assert_fresh_commit(&rnd, clock.slot).map_err(|_| error!(ArenaError::Randomness))?;

    let (squad, power) = validate_squad(ctx.remaining_accounts, &ctx.accounts.challenger.key(), clock.unix_timestamp)?;
    token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), token::Transfer {
        from: ctx.accounts.challenger_cg.to_account_info(), to: ctx.accounts.escrow.to_account_info(), authority: ctx.accounts.challenger.to_account_info(),
    }), wager)?;

    let b = &mut ctx.accounts.battle;
    b.challenger = ctx.accounts.challenger.key(); b.wager = wager; b.squad_a = squad; b.power_a = power;
    b.randomness = ctx.accounts.randomness.key(); b.commit_slot = rnd.seed_slot; b.status = BattleStatus::Open;
    b.created_at = clock.unix_timestamp; b.nonce = nonce; b.bump = ctx.bumps.battle;
    emit!(BattleCreated { battle: b.key(), challenger: b.challenger, wager, power_a: power, randomness: b.randomness });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptBattle<'info> {
    #[account(mut)]
    pub opponent: Signer<'info>,
    #[account(seeds = [b"arena_config"], bump = config.bump, constraint = !config.paused @ ArenaError::Paused)]
    pub config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [b"battle", battle.challenger.as_ref(), &battle.nonce.to_le_bytes()], bump = battle.bump, constraint = battle.status == BattleStatus::Open @ ArenaError::BadStatus)]
    pub battle: Account<'info, WagerBattle>,
    #[account(mut, token::mint = config.cg_mint, token::authority = opponent)]
    pub opponent_cg: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = config.cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: [asset_i, chip_state_i] × 3
}

pub fn accept_battle_handler<'info>(ctx: Context<'_, '_, 'info, 'info, AcceptBattle<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let b = &ctx.accounts.battle;
    require!(b.challenger != ctx.accounts.opponent.key(), ArenaError::SelfBattle);
    require!(now <= b.created_at + ACCEPT_TIMEOUT, ArenaError::BadStatus);
    let (squad, power) = validate_squad(ctx.remaining_accounts, &ctx.accounts.opponent.key(), now)?;
    require!(league(power) == league(b.power_a), ArenaError::LeagueMismatch);
    let wager = b.wager;
    token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), token::Transfer {
        from: ctx.accounts.opponent_cg.to_account_info(), to: ctx.accounts.escrow.to_account_info(), authority: ctx.accounts.opponent.to_account_info(),
    }), wager)?;
    let b = &mut ctx.accounts.battle;
    b.opponent = ctx.accounts.opponent.key(); b.squad_b = squad; b.power_b = power; b.status = BattleStatus::Accepted; b.accepted_at = now;
    emit!(BattleAccepted { battle: b.key(), opponent: b.opponent, power_b: power });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveBattle<'info> {
    pub battle_oracle: Signer<'info>,
    #[account(mut, seeds = [b"arena_config"], bump = config.bump, constraint = config.battle_oracle == battle_oracle.key() @ ArenaError::Unauthorized)]
    pub config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [b"battle", battle.challenger.as_ref(), &battle.nonce.to_le_bytes()], bump = battle.bump, constraint = battle.status == BattleStatus::Accepted @ ArenaError::BadStatus)]
    pub battle: Account<'info, WagerBattle>,
    /// CHECK: pinned
    #[account(address = battle.randomness)]
    pub randomness: UncheckedAccount<'info>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = config.cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    /// winner's ATA — must be owned by `winner`
    #[account(mut, token::mint = config.cg_mint)]
    pub winner_cg: Account<'info, TokenAccount>,
    #[account(mut, address = config.season_pool)]
    pub season_pool: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury_cg)]
    pub treasury_cg: Account<'info, TokenAccount>,
    /// CHECK: ["burn_reporter"] PDA → staking.report_burn CPI (optional in v1; event is indexed anyway)
    #[account(seeds = [b"burn_reporter"], bump)]
    pub burn_reporter: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn resolve_battle_handler(ctx: Context<ResolveBattle>, winner: Pubkey, result_hash: [u8; 32]) -> Result<()> {
    let clock = Clock::get()?;
    let b = &ctx.accounts.battle;
    require!(winner == b.challenger || winner == b.opponent, ArenaError::BadWinner);
    require_keys_eq!(ctx.accounts.winner_cg.owner, winner, ArenaError::BadWinner);
    // the VRF value must exist so the server-side seed is auditable; the program does not
    // re-simulate the battle (that's the documented server-authoritative boundary)
    let rnd = randomness::parse_checked(&ctx.accounts.randomness).map_err(|_| error!(ArenaError::Randomness))?;
    let roll = randomness::revealed_value(&rnd, b.commit_slot).map_err(|_| error!(ArenaError::Randomness))?;

    let pot = b.wager.checked_mul(2).ok_or(ArenaError::Overflow)?;
    let rake = pot * RAKE_BPS / 10_000;
    let rake_treasury = rake * RAKE_TREASURY_BPS / 10_000;
    let rake_pool = rake * RAKE_POOL_BPS / 10_000;
    let rake_burn = rake - rake_treasury - rake_pool; // remainder burned (rounding dust burns too)
    let payout = pot - rake;

    // oracle circuit-breaker
    let c = &mut ctx.accounts.config;
    if clock.unix_timestamp - c.oracle_day_start >= DAY { c.oracle_day_start = clock.unix_timestamp; c.oracle_paid_today = 0; }
    c.oracle_paid_today = c.oracle_paid_today.checked_add(pot).ok_or(ArenaError::Overflow)?;
    require!(c.oracle_paid_today <= c.oracle_daily_cap, ArenaError::OracleCap);

    let (ch, nonce, bump) = (b.challenger, b.nonce, b.bump);
    let seeds: &[&[u8]] = &[b"battle", ch.as_ref(), &nonce.to_le_bytes(), &[bump]];
    let tp = ctx.accounts.token_program.to_account_info();
    let b_ai = ctx.accounts.battle.to_account_info();
    token::transfer(CpiContext::new_with_signer(tp.clone(), token::Transfer { from: ctx.accounts.escrow.to_account_info(), to: ctx.accounts.winner_cg.to_account_info(), authority: b_ai.clone() }, &[seeds]), payout)?;
    token::transfer(CpiContext::new_with_signer(tp.clone(), token::Transfer { from: ctx.accounts.escrow.to_account_info(), to: ctx.accounts.season_pool.to_account_info(), authority: b_ai.clone() }, &[seeds]), rake_pool)?;
    token::transfer(CpiContext::new_with_signer(tp.clone(), token::Transfer { from: ctx.accounts.escrow.to_account_info(), to: ctx.accounts.treasury_cg.to_account_info(), authority: b_ai.clone() }, &[seeds]), rake_treasury)?;
    token::burn(CpiContext::new_with_signer(tp.clone(), token::Burn { mint: ctx.accounts.cg_mint.to_account_info(), from: ctx.accounts.escrow.to_account_info(), authority: b_ai.clone() }, &[seeds]), rake_burn)?;
    token::close_account(CpiContext::new_with_signer(tp, token::CloseAccount { account: ctx.accounts.escrow.to_account_info(), destination: ctx.accounts.battle_oracle.to_account_info(), authority: b_ai }, &[seeds]))?;

    let b = &mut ctx.accounts.battle;
    b.status = BattleStatus::Resolved; b.winner = winner; b.result_hash = result_hash;
    emit!(BattleResolved { battle: b.key(), winner, pot, rake_burn, rake_pool, rake_treasury, result_hash, roll });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelStaleBattle<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"arena_config"], bump = config.bump)]
    pub config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [b"battle", battle.challenger.as_ref(), &battle.nonce.to_le_bytes()], bump = battle.bump)]
    pub battle: Account<'info, WagerBattle>,
    #[account(mut, associated_token::mint = config.cg_mint, associated_token::authority = battle)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.cg_mint, token::authority = battle.challenger)]
    pub challenger_cg: Account<'info, TokenAccount>,
    /// only required when status == Accepted
    #[account(mut, token::mint = config.cg_mint)]
    pub opponent_cg: Option<Account<'info, TokenAccount>>,
    /// CHECK: rent destination = challenger
    #[account(mut, address = battle.challenger)]
    pub challenger: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn cancel_stale_battle_handler(ctx: Context<CancelStaleBattle>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let b = &ctx.accounts.battle;
    let caller = ctx.accounts.caller.key();
    require!(caller == b.challenger || caller == b.opponent, ArenaError::Unauthorized);
    let (ref_a, ref_b) = match b.status {
        BattleStatus::Open => { require!(now > b.created_at + ACCEPT_TIMEOUT || caller == b.challenger, ArenaError::NotStale); (b.wager, 0) }
        BattleStatus::Accepted => { require!(now > b.accepted_at + RESOLVE_TIMEOUT, ArenaError::NotStale); (b.wager, b.wager) }
        _ => return err!(ArenaError::BadStatus),
    };
    let (ch, nonce, bump) = (b.challenger, b.nonce, b.bump);
    let seeds: &[&[u8]] = &[b"battle", ch.as_ref(), &nonce.to_le_bytes(), &[bump]];
    let tp = ctx.accounts.token_program.to_account_info();
    let b_ai = ctx.accounts.battle.to_account_info();
    token::transfer(CpiContext::new_with_signer(tp.clone(), token::Transfer { from: ctx.accounts.escrow.to_account_info(), to: ctx.accounts.challenger_cg.to_account_info(), authority: b_ai.clone() }, &[seeds]), ref_a)?;
    if ref_b > 0 {
        let o = ctx.accounts.opponent_cg.as_ref().ok_or(ArenaError::BadStatus)?;
        require_keys_eq!(o.owner, b.opponent, ArenaError::Unauthorized);
        token::transfer(CpiContext::new_with_signer(tp.clone(), token::Transfer { from: ctx.accounts.escrow.to_account_info(), to: o.to_account_info(), authority: b_ai.clone() }, &[seeds]), ref_b)?;
    }
    token::close_account(CpiContext::new_with_signer(tp, token::CloseAccount { account: ctx.accounts.escrow.to_account_info(), destination: ctx.accounts.challenger.to_account_info(), authority: b_ai }, &[seeds]))?;
    let b = &mut ctx.accounts.battle;
    b.status = BattleStatus::Cancelled;
    emit!(BattleCancelled { battle: b.key(), refunded_a: ref_a, refunded_b: ref_b });
    Ok(())
}

// ---------------------------------------------------------------------------

#[program]
pub mod arena {
    use super::*;
    pub fn init_arena(ctx: Context<InitArena>, battle_oracle: Pubkey, cg_mint: Pubkey, season_pool: Pubkey, treasury_cg: Pubkey, oracle_daily_cap: u64) -> Result<()> {
        init_arena_handler(ctx, battle_oracle, cg_mint, season_pool, treasury_cg, oracle_daily_cap)
    }
    pub fn set_arena(ctx: Context<ArenaAdmin>, battle_oracle: Option<Pubkey>, oracle_daily_cap: Option<u64>, paused: Option<bool>, treasury_cg: Option<Pubkey>) -> Result<()> {
        set_arena_handler(ctx, battle_oracle, oracle_daily_cap, paused, treasury_cg)
    }
    pub fn create_battle<'info>(ctx: Context<'_, '_, 'info, 'info, CreateBattle<'info>>, nonce: u64, wager: u64) -> Result<()> { create_battle_handler(ctx, nonce, wager) }
    pub fn accept_battle<'info>(ctx: Context<'_, '_, 'info, 'info, AcceptBattle<'info>>) -> Result<()> { accept_battle_handler(ctx) }
    pub fn resolve_battle(ctx: Context<ResolveBattle>, winner: Pubkey, result_hash: [u8; 32]) -> Result<()> { resolve_battle_handler(ctx, winner, result_hash) }
    pub fn cancel_stale_battle(ctx: Context<CancelStaleBattle>) -> Result<()> { cancel_stale_battle_handler(ctx) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rake_split_exact() {
        let pot = 2 * 1_000 * MICRO;
        let rake = pot * RAKE_BPS / 10_000;
        assert_eq!(rake, 100 * MICRO);
        let tr = rake * RAKE_TREASURY_BPS / 10_000;
        let pool = rake * RAKE_POOL_BPS / 10_000;
        assert_eq!((tr, pool, rake - tr - pool), (40 * MICRO, 20 * MICRO, 40 * MICRO));
        assert_eq!(pot - rake, 1_900 * MICRO);
    }
    #[test]
    fn leagues() {
        assert_eq!(league(799), 0); assert_eq!(league(800), 1); assert_eq!(league(2399), 2); assert_eq!(league(7000), 5);
    }
}

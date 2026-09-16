use anchor_lang::prelude::*;

pub const CG_DECIMALS: u8 = 6;
pub const MICRO: u64 = 1_000_000;
pub const HARD_CAP_MICRO: u64 = 1_000_000_000 * MICRO;
pub const PLAY_BUCKET_MICRO: u64 = HARD_CAP_MICRO / 100 * 55;
/// % of the play bucket emitted per year (schedule ceiling). Σ = 78 %.
pub const YEARLY_PCT: [u8; 8] = [18, 15, 12, 10, 8, 6, 5, 4];
pub const DAY: i64 = 86_400;
pub const YEAR_DAYS: i64 = 365;
pub const ACC_PRECISION: u128 = 1_000_000_000_000; // 1e12
pub const SPLIT_COUNT: usize = 5;                    // chip / token / quests / pvp / events
pub const MAX_SPLIT_DELTA_BPS: u16 = 1_000;          // ±10 pp per change
pub const MIN_SPLIT_INTERVAL: i64 = 7 * DAY;
pub const GUARD_FLOOR_BPS: u64 = 3_000;              // 0.30 × cap
pub const GUARD_BURN_MULT_BPS: u64 = 12_500;         // 1.25 × trailing burn
/// SEC-M1 sanity clamp for `report_burn`: `burn_today` never exceeds this multiple of the
/// day's schedule cap. The guard saturates at `cap` once the 7-day average passes 0.56 × cap,
/// so nothing above 3 × cap can change the emission — a lying oracle is bounded by the schedule.
pub const BURN_SANITY_MULT: u64 = 3;
pub const ROOT_TIMELOCK: i64 = 3_600;
pub const TIER_COUNT: usize = 4;
pub const TIER_LOCK_SECS: [i64; TIER_COUNT] = [0, 30 * DAY, 90 * DAY, 180 * DAY];
pub const TIER_BOOST_BPS: [u64; TIER_COUNT] = [10_000, 15_000, 22_000, 30_000];
pub const TIER_PENALTY_BPS: [u64; TIER_COUNT] = [0, 500, 1_000, 1_500];
pub const MIN_STAKE_MICRO: u64 = 10 * MICRO;
pub const SET_BONUS_CAP_BPS: u64 = 17_000;
/// Reward-root kinds: 0..4 are $CG emission slices (`Slice`), 5..7 are SKR prize-pool roots
/// (quests / season / events) paid from `SkrPool` — never minted. Mirrored in
/// packages/economy/src/skrRewards.ts (`REWARD_ROOT_KINDS`) and checked by sync-check.
pub const SKR_ROOT_KIND_BASE: u8 = 5;
pub const SKR_KIND_QUESTS: u8 = 5;
pub const SKR_KIND_SEASON: u8 = 6;
pub const SKR_KIND_EVENTS: u8 = 7;
/// SKR (Seeker) is a classic SPL token with 6 decimals; devnet test mints must match.
pub const SKR_DECIMALS: u8 = 6;
/// Per-root ceiling used when `init_skr_pool` is called with 0 (100 000 SKR). Bounds the blast
/// radius of a leaked oracle key to one root per epoch inside the 1 h revoke window.
pub const DEFAULT_MAX_SKR_ROOT_BUDGET: u64 = 100_000 * MICRO;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum Slice { ChipStaking = 0, TokenStaking = 1, Quests = 2, PvpSeason = 3, Events = 4 }

/// Sole holder of the $CG mint authority. `["emission"]`.
#[account]
#[derive(InitSpace)]
pub struct EmissionState {
    pub admin: Pubkey,
    pub cg_mint: Pubkey,
    pub chip_core_program: Pubkey,
    pub market_program: Pubkey,
    pub arena_program: Pubkey,
    pub quest_oracle: Pubkey,        // may publish Quests roots
    pub season_oracle: Pubkey,       // may publish PvpSeason/Events roots
    pub set_oracle: Pubkey,          // may sync SetBonus
    pub genesis_ts: i64,             // day 0
    pub day_index: u32,              // last closed day
    pub minted_total: u64,           // lifetime minted by this PDA (micro)
    pub schedule_minted: [u64; 8],   // per-year minted, to enforce yearly caps
    pub burn_ring: [u64; 7],         // daily burn totals, 7-day ring
    pub burn_today: u64,
    pub split_bps: [u16; SPLIT_COUNT],
    pub split_changed_at: i64,
    /// unminted budget accumulated per slice (micro). Quests/PvP/Events roots draw from these.
    pub slice_budget: [u64; SPLIT_COUNT],
    pub paused: bool,
    pub bump: u8,
    /// SEC-H2 hot pauser (may only call `pause`); `Pubkey::default()` = none. Appended last.
    pub pauser: Pubkey,
    /// SEC-M1 burn oracle: the indexer's keeper key that may call `report_burn` with the $CG
    /// burned by chip_core / market / arena (which only emit events, no CPI in v1).
    /// `Pubkey::default()` = none. Appended after `pauser`.
    pub burn_oracle: Pubkey,
}

impl EmissionState {
    pub fn year_index(&self, now: i64) -> usize {
        (((now - self.genesis_ts) / DAY) / YEAR_DAYS).clamp(0, 7) as usize
    }
    pub fn yearly_cap_micro(year: usize) -> u64 {
        (PLAY_BUCKET_MICRO as u128 * YEARLY_PCT[year.min(7)] as u128 / 100) as u64
    }
    pub fn daily_schedule_cap(year: usize) -> u64 { Self::yearly_cap_micro(year) / YEAR_DAYS as u64 }
    pub fn trailing_burn_avg(&self) -> u64 {
        let s: u128 = self.burn_ring.iter().map(|&b| b as u128).sum();
        (s / 7) as u64
    }
    /// min(cap, 0.30·cap + 1.25·burn7d)
    pub fn guarded_daily(&self, year: usize) -> u64 {
        let cap = Self::daily_schedule_cap(year) as u128;
        let g = cap * GUARD_FLOOR_BPS as u128 / 10_000 + self.trailing_burn_avg() as u128 * GUARD_BURN_MULT_BPS as u128 / 10_000;
        g.min(cap) as u64
    }
}

/// MasterChef pool. `["token_pool"]` and `["chip_pool"]`.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub kind: u8,                    // 0 token, 1 chip
    pub total_weight: u128,
    pub acc_reward_per_weight: u128, // scaled 1e12
    pub budget_per_sec: u64,         // micro/sec, set at tick_day
    pub budget_remaining: u64,       // micro left to distribute today
    pub last_update: i64,
    pub bump: u8,
}

impl Pool {
    /// Accrue rewards since last_update into the accumulator (bounded by today's remaining budget).
    pub fn update(&mut self, now: i64) -> Result<()> {
        if now <= self.last_update { return Ok(()); }
        let dt = (now - self.last_update) as u64;
        self.last_update = now;
        if self.total_weight == 0 { return Ok(()); }
        let reward = (self.budget_per_sec as u128 * dt as u128).min(self.budget_remaining as u128);
        self.budget_remaining -= reward as u64;
        self.acc_reward_per_weight = self.acc_reward_per_weight
            .checked_add(reward * ACC_PRECISION / self.total_weight).ok_or(crate::errors::StakeError::Overflow)?;
        Ok(())
    }
    pub fn pending(&self, weight: u128, debt: u128) -> u64 {
        ((weight * self.acc_reward_per_weight / ACC_PRECISION).saturating_sub(debt)) as u64
    }
}

/// `["tstake", wallet, tier]`
#[account]
#[derive(InitSpace)]
pub struct TokenStake {
    pub owner: Pubkey,
    pub tier: u8,
    pub amount: u64,
    pub weight: u128,
    pub reward_debt: u128,
    pub unlock_at: i64,
    pub bump: u8,
}

/// `["cstake", asset]` — one per staked chip
#[account]
#[derive(InitSpace)]
pub struct ChipStake {
    pub owner: Pubkey,
    pub asset: Pubkey,
    pub weight: u128,
    pub reward_debt: u128,
    pub staked_at: i64,
    pub bump: u8,
}

/// `["setbonus", wallet]` — completed sets proven by the set-oracle (indexer)
#[account]
#[derive(InitSpace)]
pub struct SetBonus {
    pub owner: Pubkey,
    pub completed_sets: u8,
    pub updated_at: i64,
    pub bump: u8,
}

impl SetBonus {
    /// 1 + 0.12·min(sets,5) + 0.02·max(0,sets−5), cap 1.70 → bps
    pub fn mult_bps(sets: u8) -> u64 {
        let s = sets as u64;
        let m = 10_000 + 1_200 * s.min(5) + 200 * s.saturating_sub(5);
        m.min(SET_BONUS_CAP_BPS)
    }
}

/// `["root", kind, epoch]` — Merkle root of off-chain computed payouts.
#[account]
#[derive(InitSpace)]
pub struct RewardRoot {
    pub kind: u8,                    // Slice index (2 quests / 3 pvp / 4 events)
    pub epoch: u32,
    pub root: [u8; 32],
    pub budget: u64,                 // micro; ≤ slice_budget at publish
    pub claimed: u64,
    pub published_at: i64,
    pub publisher: Pubkey,
    pub revoked: bool,
    pub bump: u8,
}

/// `["claim", root, wallet]`
#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt { pub amount: u64, pub bump: u8 }

/// `["skr_pool"]` — treasury-funded SKR prize pool (the game cannot mint SKR).
/// Invariant: `vault.amount ≥ budget + reserved` — funding only credits `budget`,
/// roots move `budget → reserved` at publish, claims only draw from `reserved`.
#[account]
#[derive(InitSpace)]
pub struct SkrPool {
    pub skr_mint: Pubkey,
    pub vault: Pubkey,            // token account, authority = this PDA
    pub budget: u64,              // micro-SKR available for new roots
    pub reserved: u64,            // micro-SKR locked in live roots, not yet claimed
    pub funded_total: u64,
    pub paid_total: u64,
    pub max_root_budget: u64,     // per-root ceiling (admin-tunable)
    pub paused: bool,
    pub bump: u8,
}

impl SkrPool {
    pub fn is_skr_kind(kind: u8) -> bool { (SKR_ROOT_KIND_BASE..SKR_ROOT_KIND_BASE + 3).contains(&kind) }
    /// Some(true) → season oracle, Some(false) → quest oracle, None → not an SKR kind.
    pub fn uses_season_oracle(kind: u8) -> Option<bool> {
        match kind { SKR_KIND_QUESTS => Some(false), SKR_KIND_SEASON | SKR_KIND_EVENTS => Some(true), _ => None }
    }
}

#[event] pub struct DayClosed { pub day_index: u32, pub year: u8, pub schedule_cap: u64, pub guarded: u64, pub burn_7d_avg: u64, pub slice_budget: [u64; SPLIT_COUNT] }
#[event] pub struct Staked { pub owner: Pubkey, pub kind: u8, pub key: Pubkey, pub amount: u64, pub weight: u128, pub unlock_at: i64 }
#[event] pub struct Unstaked { pub owner: Pubkey, pub kind: u8, pub key: Pubkey, pub amount: u64, pub penalty_burned: u64 }
#[event] pub struct Claimed { pub owner: Pubkey, pub kind: u8, pub amount: u64 }
#[event] pub struct RootPublished { pub kind: u8, pub epoch: u32, pub root: [u8; 32], pub budget: u64 }
#[event] pub struct RootRevoked { pub kind: u8, pub epoch: u32 }
#[event] pub struct RootClaimed { pub kind: u8, pub epoch: u32, pub wallet: Pubkey, pub amount: u64 }
#[event] pub struct BurnRecorded { pub source: Pubkey, pub amount: u64, pub burn_today: u64 }
#[event] pub struct SetBonusSynced { pub owner: Pubkey, pub sets: u8 }
/// `funder = Pubkey::default()` when a direct vault transfer was absorbed by `sync_skr_pool`.
#[event] pub struct SkrFunded { pub funder: Pubkey, pub amount: u64, pub budget: u64, pub reserved: u64 }
#[event] pub struct SkrWithdrawn { pub to: Pubkey, pub amount: u64, pub budget: u64 }
#[event] pub struct SkrPoolChanged { pub max_root_budget: u64, pub paused: bool }
#[event] pub struct PauseChanged { pub by: Pubkey, pub paused: bool }

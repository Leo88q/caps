//! GUTTERCAPS — staking + emission
//!
//! Holds the $CG mint authority (EmissionState PDA). Two MasterChef pools
//! (token / chip) plus Merkle reward roots for quests, PvP seasons and
//! events. Daily budget = min(schedule, 0.30·schedule + 1.25·burn7d).

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::SPLIT_COUNT;

declare_id!("GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA");

#[program]
pub mod staking {
    use super::*;

    pub fn init_emission(ctx: Context<InitEmission>, args: InitEmissionArgs) -> Result<()> { instructions::init_emission(ctx, args) }
    pub fn set_split(ctx: Context<EmissionAdmin>, split_bps: [u16; SPLIT_COUNT]) -> Result<()> { instructions::set_split(ctx, split_bps) }
    pub fn set_paused(ctx: Context<EmissionAdmin>, paused: bool) -> Result<()> { instructions::set_paused(ctx, paused) }
    pub fn set_oracles(ctx: Context<EmissionAdmin>, patch: OraclePatch) -> Result<()> { instructions::set_oracles(ctx, patch) }
    pub fn tick_day(ctx: Context<TickDay>) -> Result<()> { instructions::tick_day(ctx) }
    pub fn report_burn(ctx: Context<ReportBurn>, amount: u64) -> Result<()> { instructions::report_burn(ctx, amount) }

    pub fn publish_root(ctx: Context<PublishRoot>, kind: u8, epoch: u32, root: [u8; 32], budget: u64) -> Result<()> {
        instructions::publish_root(ctx, kind, epoch, root, budget)
    }
    pub fn revoke_root(ctx: Context<RevokeRoot>) -> Result<()> { instructions::revoke_root(ctx) }
    pub fn claim_root(ctx: Context<ClaimRoot>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> { instructions::claim_root(ctx, amount, proof) }

    pub fn stake_cg(ctx: Context<StakeCg>, tier: u8, amount: u64) -> Result<()> { instructions::stake_cg(ctx, tier, amount) }
    pub fn unstake_cg(ctx: Context<UnstakeCg>, tier: u8, amount: u64) -> Result<()> { instructions::unstake_cg(ctx, tier, amount) }
    pub fn stake_chip(ctx: Context<StakeChip>) -> Result<()> { instructions::stake_chip(ctx) }
    pub fn unstake_chip(ctx: Context<UnstakeChip>) -> Result<()> { instructions::unstake_chip(ctx) }
    pub fn claim_chip(ctx: Context<ClaimChip>) -> Result<()> { instructions::claim_chip(ctx) }
    pub fn sync_set_bonus(ctx: Context<SyncSetBonus>, sets: u8) -> Result<()> { instructions::sync_set_bonus(ctx, sets) }
}

#[cfg(test)]
mod tests {
    use super::state::*;

    #[test]
    fn schedule_matches_ts_model() {
        // Y1 daily cap = 1e9 × 0.55 × 0.18 / 365 = 271 232.87 $CG
        assert_eq!(EmissionState::daily_schedule_cap(0) / MICRO, 271_232);
        assert_eq!(EmissionState::daily_schedule_cap(1) / MICRO, 226_027);
        assert_eq!(EmissionState::daily_schedule_cap(4) / MICRO, 120_547);
        let total: u128 = (0..8).map(|y| EmissionState::yearly_cap_micro(y) as u128).sum();
        assert_eq!(total, PLAY_BUCKET_MICRO as u128 * 78 / 100);
    }

    #[test]
    fn guard_floor_and_ceiling() {
        let mut e = EmissionState {
            admin: Default::default(), cg_mint: Default::default(), chip_core_program: Default::default(), market_program: Default::default(),
            arena_program: Default::default(), quest_oracle: Default::default(), season_oracle: Default::default(), set_oracle: Default::default(),
            genesis_ts: 0, day_index: 0, minted_total: 0, schedule_minted: [0; 8], burn_ring: [0; 7], burn_today: 0,
            split_bps: [3000, 1500, 1700, 2300, 1500], split_changed_at: 0, slice_budget: [0; 5], paused: false, bump: 0,
        };
        let cap = EmissionState::daily_schedule_cap(0);
        assert_eq!(e.guarded_daily(0), cap * 3 / 10);
        e.burn_ring = [cap; 7];
        assert_eq!(e.guarded_daily(0), cap);
        e.burn_ring = [117_433 * MICRO; 7]; // baseline burn from the TS report
        assert_eq!(e.guarded_daily(0) / MICRO, 228_161);
    }

    #[test]
    fn set_bonus_curve() {
        assert_eq!(SetBonus::mult_bps(0), 10_000);
        assert_eq!(SetBonus::mult_bps(1), 11_200);
        assert_eq!(SetBonus::mult_bps(5), 16_000);
        assert_eq!(SetBonus::mult_bps(10), 17_000);
        assert_eq!(SetBonus::mult_bps(40), 17_000);
    }

    #[test]
    fn pool_accrual_is_budget_bounded() {
        let mut p = Pool { kind: 0, total_weight: 1_000, acc_reward_per_weight: 0, budget_per_sec: 10, budget_remaining: 100, last_update: 0, bump: 0 };
        p.update(5).unwrap();
        assert_eq!(p.budget_remaining, 50);
        p.update(1_000).unwrap();
        assert_eq!(p.budget_remaining, 0);
        assert_eq!(p.pending(1_000, 0), 100);
    }

    #[test]
    fn merkle_proof_roundtrip() {
        use anchor_lang::solana_program::keccak::hashv;
        use crate::instructions::verify_proof;
        let a = [1u8; 32]; let b = [2u8; 32]; let c = [3u8; 32];
        let ab = hashv(&[&[1u8], &a, &b]).to_bytes();
        let cc = hashv(&[&[1u8], &c, &c]).to_bytes();
        let root = if ab <= cc { hashv(&[&[1u8], &ab, &cc]).to_bytes() } else { hashv(&[&[1u8], &cc, &ab]).to_bytes() };
        assert!(verify_proof(&root, a, &[b, cc]));
        assert!(!verify_proof(&root, a, &[c, cc]));
    }
}

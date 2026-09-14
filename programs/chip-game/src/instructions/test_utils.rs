use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::ChipGameError;

/// ⚠️ TEST-ONLY, ADMIN-GATED, MUST BE STRIPPED BEFORE MAINNET. ⚠️
///
/// Normally a ChipState only comes into existence inside open_pack, tied to
/// a VRF-verified rarity roll. Integration tests can't run a live
/// Switchboard oracle against a local validator, so this instruction lets
/// the program admin fabricate a ChipState directly for an already-minted
/// SPL token, with whatever rarity/level/index the test wants — purely so
/// upgrade/marketplace/staking/quest logic can be exercised without a real
/// pack open.
///
/// This is restricted to the config admin, so a stranger can't use it to
/// conjure chips — but the admin key itself absolutely could, which is
/// exactly the kind of centralized-trust hole the rest of this program is
/// designed to avoid (see the "Rules & fairness" pitch: odds are supposed
/// to be provably fair, not admin-assigned). Remove this instruction (or
/// gate it behind a Cargo feature that's off by default) before any
/// mainnet deployment — see README "Что доделать перед mainnet".
#[derive(Accounts)]
pub struct SeedChipStateForTest<'info> {
    #[account(has_one = admin @ ChipGameError::NotSeller)]
    pub config: Account<'info, GameConfig>,
    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = ChipState::SIZE,
        seeds = [b"chip", mint.key().as_ref()],
        bump
    )]
    pub chip_state: Account<'info, ChipState>,

    /// CHECK: must already exist as an SPL mint (created via spl-token in
    /// the test, outside this program) — not validated as Account<Mint>
    /// here to keep this instruction's own footprint minimal.
    pub mint: UncheckedAccount<'info>,

    pub collection: Account<'info, Collection>,

    pub system_program: Program<'info, System>,
}

pub fn seed_chip_state_for_test(
    ctx: Context<SeedChipStateForTest>,
    rarity: Rarity,
    level: u8,
    index: u64,
) -> Result<()> {
    let chip = &mut ctx.accounts.chip_state;
    chip.mint = ctx.accounts.mint.key();
    chip.collection = ctx.accounts.collection.key();
    chip.rarity = rarity;
    chip.level = level;
    chip.xp = 0;
    chip.index = index;
    chip.staked = false;
    chip.stake_started_at = 0;
    chip.accrued_rewards = 0;
    chip.bump = ctx.bumps.chip_state;
    Ok(())
}

// ---------------------------------------------------------------------------
// Chip voucher roots (backlog #28) — quest rewards that are a CHIP.
//
// Kind 9. Same Merkle machinery as $CG / SKR / item roots (leaf = keccak(0x00 ‖ wallet ‖
// amount_le_u64 ‖ kind ‖ epoch_le_u32), `RewardRoot` / `ClaimReceipt` PDAs, 1 h timelock, admin
// revoke), but the leaf amount is a voucher TEMPLATE id and the claim delivers by CPI:
// `chip_core::open_voucher(nonce, template)` signed by this program's `["rewarder"]` PDA. chip_core
// creates a free 1-chip `PendingPack` for the wallet, committed to Switchboard in the same tx (the
// wallet prepends `init_randomness(0, nonce)`), and the regular permissionless `open_pack` crank mints
// the chip a few slots later with the template's odds + soulbound lock. So a free chip goes through
// exactly the VRF path a paid one does — no mint authority, no hot key, a Merkle trail per chip.
//
// The wallet pays what a buyer pays minus the price: the pending rent, the 0.008 SOL rent reserve and
// the Switchboard request — all returned when the chip is minted / the request is cancelled stale.
//
// Budgets: `budget` = number of leaves (vouchers) in the tree, ≤ `MAX_CHIP_ROOT_BUDGET`; one leaf per
// wallet per epoch (a second voucher rides the next epoch) and `ClaimReceipt` makes a leaf single-use.
// Publishing is restricted to the quest oracle (chips only come from quests / referrals / PvP quests).
// ---------------------------------------------------------------------------

use anchor_lang::prelude::*;

use chip_core::cpi::accounts::OpenVoucher;
use chip_core::program::ChipCore;
use chip_core::state::GameConfig;

use crate::errors::StakeError;
use crate::instructions::emission::verify_proof;
use crate::state::*;

pub fn is_chip_kind(kind: u8) -> bool {
    kind == CHIP_KIND_VOUCHERS
}

#[derive(Accounts)]
#[instruction(kind: u8, epoch: u32)]
pub struct PublishChipRoot<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(init, payer = oracle, space = 8 + RewardRoot::INIT_SPACE, seeds = [b"root", &[kind], &epoch.to_le_bytes()], bump)]
    pub root: Box<Account<'info, RewardRoot>>,
    pub system_program: Program<'info, System>,
}

/// `budget` = number of vouchers (leaves) in the tree, ≤ `MAX_CHIP_ROOT_BUDGET`. `claimed` counts claims.
pub fn publish_chip_root(
    ctx: Context<PublishChipRoot>,
    kind: u8,
    epoch: u32,
    root: [u8; 32],
    budget: u64,
) -> Result<()> {
    require!(is_chip_kind(kind), StakeError::WrongRootCurrency);
    let e = &ctx.accounts.emission;
    let o = ctx.accounts.oracle.key();
    require!(o == e.quest_oracle, StakeError::BadOracle);
    require!(budget > 0, StakeError::ZeroAmount);
    require!(
        budget <= MAX_CHIP_ROOT_BUDGET,
        StakeError::ChipBudgetExceeded
    );
    let r = &mut ctx.accounts.root;
    r.kind = kind;
    r.epoch = epoch;
    r.root = root;
    r.budget = budget;
    r.claimed = 0;
    r.published_at = Clock::get()?.unix_timestamp;
    r.publisher = o;
    r.revoked = false;
    r.bump = ctx.bumps.root;
    emit!(RootPublished {
        kind,
        epoch,
        root,
        budget
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeChipRoot<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, has_one = admin @ StakeError::Unauthorized)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"root", &[root.kind], &root.epoch.to_le_bytes()], bump = root.bump)]
    pub root: Box<Account<'info, RewardRoot>>,
}

/// Nothing to refund (no budget was reserved) — the flag just blocks further claims.
pub fn revoke_chip_root(ctx: Context<RevokeChipRoot>) -> Result<()> {
    let r = &mut ctx.accounts.root;
    require!(is_chip_kind(r.kind), StakeError::WrongRootCurrency);
    require!(!r.revoked, StakeError::RootRevoked);
    r.revoked = true;
    emit!(RootRevoked {
        kind: r.kind,
        epoch: r.epoch
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(amount: u64, proof: Vec<[u8; 32]>, nonce: u64)]
pub struct ClaimChipRoot<'info> {
    /// Pays the receipt rent and, inside chip_core, the pending rent + the 1-chip rent reserve.
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"root", &[root.kind], &root.epoch.to_le_bytes()], bump = root.bump)]
    pub root: Box<Account<'info, RewardRoot>>,
    #[account(init, payer = wallet, space = 8 + ClaimReceipt::INIT_SPACE, seeds = [b"claim", root.key().as_ref(), wallet.key().as_ref()], bump)]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    /// CHECK: `["rewarder"]` — the authority chip_core's `open_voucher` accepts.
    #[account(seeds = [b"rewarder"], bump)]
    pub rewarder: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID)]
    pub config: Account<'info, GameConfig>,
    /// CHECK: chip_core `["pity", wallet]` (`init_if_needed` inside the CPI, payer = wallet).
    #[account(mut)]
    pub pity: UncheckedAccount<'info>,
    /// CHECK: chip_core `["pending", wallet, nonce]` (`init` inside the CPI, payer = wallet).
    #[account(mut)]
    pub pending: UncheckedAccount<'info>,
    /// CHECK: chip_core-owned Switchboard randomness `["rng", 0, wallet, nonce]` — created by
    /// `init_randomness` earlier in this tx; chip_core derives, owner-checks and commits it.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: chip_core `["rng_auth"]` (derived inside the CPI).
    pub rng_auth: UncheckedAccount<'info>,
    /// CHECK: Switchboard On-Demand program (address-checked inside the CPI).
    pub switchboard_program: UncheckedAccount<'info>,
    /// CHECK: pinned oracle queue (verified inside the CPI).
    pub queue: UncheckedAccount<'info>,
    /// CHECK: oracle chosen by the client (Switchboard verifies queue membership).
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar (address-checked inside the CPI).
    pub recent_slothashes: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

/// Same proof check as `claim_root` / `claim_item_root`; delivery = `open_voucher(nonce, template)` by CPI.
/// `amount` is the template id (≤ `MAX_CHIP_TEMPLATE`); the root's `claimed` counts vouchers, not templates.
pub fn claim_chip_root(
    ctx: Context<ClaimChipRoot>,
    amount: u64,
    proof: Vec<[u8; 32]>,
    nonce: u64,
) -> Result<()> {
    use anchor_lang::solana_program::keccak::hashv;
    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.root;
    require!(is_chip_kind(r.kind), StakeError::WrongRootCurrency);
    require!(!r.revoked, StakeError::RootRevoked);
    require!(
        now >= r.published_at + ROOT_TIMELOCK,
        StakeError::RootTimelocked
    );
    require!(proof.len() <= 24, StakeError::BadProof);
    require!(amount <= MAX_CHIP_TEMPLATE, StakeError::ChipBudgetExceeded);
    let leaf = hashv(&[
        &[0u8],
        ctx.accounts.wallet.key().as_ref(),
        &amount.to_le_bytes(),
        &[r.kind],
        &r.epoch.to_le_bytes(),
    ])
    .to_bytes();
    require!(verify_proof(&r.root, leaf, &proof), StakeError::BadProof);
    r.claimed = r.claimed.checked_add(1).ok_or(StakeError::Overflow)?;
    require!(r.claimed <= r.budget, StakeError::RootBudgetExceeded);
    ctx.accounts.receipt.amount = amount;
    ctx.accounts.receipt.bump = ctx.bumps.receipt;

    // `pity` / `pending` / `randomness` are not re-derived here: chip_core's `OpenVoucher` enforces
    // `["pity", beneficiary]`, `["pending", beneficiary, nonce]` and `["rng", 0, beneficiary, nonce]`
    // with `beneficiary = wallet` (ConstraintSeeds otherwise), so nothing can be issued to a foreign key.
    let seeds: &[&[u8]] = &[b"rewarder", &[ctx.bumps.rewarder]];
    chip_core::cpi::open_voucher(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            OpenVoucher {
                authority: ctx.accounts.rewarder.to_account_info(),
                beneficiary: ctx.accounts.wallet.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                pity: ctx.accounts.pity.to_account_info(),
                pending: ctx.accounts.pending.to_account_info(),
                randomness: ctx.accounts.randomness.to_account_info(),
                rng_auth: ctx.accounts.rng_auth.to_account_info(),
                switchboard_program: ctx.accounts.switchboard_program.to_account_info(),
                queue: ctx.accounts.queue.to_account_info(),
                oracle: ctx.accounts.oracle.to_account_info(),
                recent_slothashes: ctx.accounts.recent_slothashes.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ),
        nonce,
        amount as u8, // ≤ MAX_CHIP_TEMPLATE (3) — checked above
    )?;
    emit!(RootClaimed {
        kind: r.kind,
        epoch: r.epoch,
        wallet: ctx.accounts.wallet.key(),
        amount
    });
    Ok(())
}

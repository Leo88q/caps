// ---------------------------------------------------------------------------
// Item reward roots (backlog #27) — quest rewards that are NOT a token.
//
// Kind 8 = fusion boosters. The reward oracle roots `quest_completions.reward_booster` exactly like
// $CG / SKR (same leaf bytes: keccak(0x00 ‖ wallet ‖ amount_le_u64 ‖ kind ‖ epoch_le_u32), same
// `RewardRoot` / `ClaimReceipt` PDAs, same 1 h timelock + admin revoke), but the leaf amount is a
// UNIT COUNT and the claim delivers by CPI: `chip_core::grant_booster(count)` signed by this
// program's `["rewarder"]` PDA — the authority chip_core already trusts next to its admin
// (`GameConfig.staking_program`, admin.rs). So the player gets the booster in the same tx as the
// proof check, nothing is minted, no slice / pool is debited and ops never touch a key.
//
// Budgets: there is no on-chain supply for boosters, so the only guard is the per-root cap
// (`MAX_ITEM_ROOT_BUDGET` = 1 000 boosters ≈ $790 at the service price) — the blast radius of a
// leaked quest-oracle key inside the revoke window — and the per-leaf cap (`MAX_ITEM_CLAIM` = 10 =
// chip_core's `count ≤ 10`). Publishing is restricted to the quest oracle (boosters only come from
// quests); the season oracle cannot publish kind 8.
//
// Why a separate kind and not "free chips" too: a chip is a Core asset minted through the VRF
// pack flow (`buy_pack` → Switchboard commit → `open_pack`); a free-chip voucher would need a
// paid_* = 0 path through that flow (5th SKU, rent, crank) — a much larger change tracked as its
// own backlog item. Boosters are a plain counter on `PlayerItems`, so they fit the Merkle machinery
// as-is.
// ---------------------------------------------------------------------------

use anchor_lang::prelude::*;

use chip_core::cpi::accounts::GrantBooster;
use chip_core::program::ChipCore;
use chip_core::state::GameConfig;

use crate::errors::StakeError;
use crate::instructions::emission::verify_proof;
use crate::state::*;

/// Kind 8 only for now; the const range leaves room for tickets / skins later.
pub fn is_item_kind(kind: u8) -> bool {
    kind == ITEM_KIND_BOOSTERS
}

#[derive(Accounts)]
#[instruction(kind: u8, epoch: u32)]
pub struct PublishItemRoot<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(init, payer = oracle, space = 8 + RewardRoot::INIT_SPACE, seeds = [b"root".as_ref(), &[kind][..], &epoch.to_le_bytes()[..]], bump)]
    pub root: Box<Account<'info, RewardRoot>>,
    pub system_program: Program<'info, System>,
}

/// `budget` = total boosters in the tree (Σ leaf amounts), ≤ `MAX_ITEM_ROOT_BUDGET`.
pub fn publish_item_root(
    ctx: Context<PublishItemRoot>,
    kind: u8,
    epoch: u32,
    root: [u8; 32],
    budget: u64,
) -> Result<()> {
    require!(is_item_kind(kind), StakeError::WrongRootCurrency);
    let e = &ctx.accounts.emission;
    let o = ctx.accounts.oracle.key();
    require!(o == e.quest_oracle, StakeError::BadOracle);
    require!(budget > 0, StakeError::ZeroAmount);
    require!(
        budget <= MAX_ITEM_ROOT_BUDGET,
        StakeError::ItemBudgetExceeded
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
pub struct RevokeItemRoot<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, has_one = admin @ StakeError::Unauthorized)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"root", &[root.kind], &root.epoch.to_le_bytes()], bump = root.bump)]
    pub root: Box<Account<'info, RewardRoot>>,
}

/// Nothing to refund (no budget was reserved) — the flag just blocks further claims.
pub fn revoke_item_root(ctx: Context<RevokeItemRoot>) -> Result<()> {
    let r = &mut ctx.accounts.root;
    require!(is_item_kind(r.kind), StakeError::WrongRootCurrency);
    require!(!r.revoked, StakeError::RootRevoked);
    r.revoked = true;
    emit!(RootRevoked {
        kind: r.kind,
        epoch: r.epoch
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimItemRoot<'info> {
    /// Pays the receipt rent and (first time) the `PlayerItems` rent inside chip_core.
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [b"emission"], bump = emission.bump, constraint = !emission.paused @ StakeError::Paused)]
    pub emission: Box<Account<'info, EmissionState>>,
    #[account(mut, seeds = [b"root", &[root.kind], &root.epoch.to_le_bytes()], bump = root.bump)]
    pub root: Box<Account<'info, RewardRoot>>,
    #[account(init, payer = wallet, space = 8 + ClaimReceipt::INIT_SPACE, seeds = [b"claim", root.key().as_ref(), wallet.key().as_ref()], bump)]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    /// CHECK: `["rewarder"]` — the authority chip_core's `grant_booster` accepts next to its admin.
    #[account(seeds = [b"rewarder"], bump)]
    pub rewarder: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID)]
    pub config: Account<'info, GameConfig>,
    /// CHECK: chip_core `["items", wallet]` — `init_if_needed` inside the CPI (payer = wallet), so an
    /// UncheckedAccount here; chip_core derives and checks the seeds itself.
    #[account(mut)]
    pub items: UncheckedAccount<'info>,
    pub chip_core: Program<'info, ChipCore>,
    pub system_program: Program<'info, System>,
}

/// Same proof check as `claim_root` / `claim_skr_root`; delivery = `grant_booster(amount)` by CPI.
pub fn claim_item_root(
    ctx: Context<ClaimItemRoot>,
    amount: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    use anchor_lang::solana_program::keccak::hashv;
    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.root;
    require!(is_item_kind(r.kind), StakeError::WrongRootCurrency);
    require!(!r.revoked, StakeError::RootRevoked);
    require!(
        now >= r.published_at + ROOT_TIMELOCK,
        StakeError::RootTimelocked
    );
    require!(proof.len() <= 24, StakeError::BadProof);
    require!(amount > 0, StakeError::ZeroAmount);
    require!(amount <= MAX_ITEM_CLAIM, StakeError::ItemBudgetExceeded);
    let leaf = hashv(&[
        &[0u8],
        ctx.accounts.wallet.key().as_ref(),
        &amount.to_le_bytes(),
        &[r.kind],
        &r.epoch.to_le_bytes(),
    ])
    .to_bytes();
    require!(verify_proof(&r.root, leaf, &proof), StakeError::BadProof);
    r.claimed = r.claimed.checked_add(amount).ok_or(StakeError::Overflow)?;
    require!(r.claimed <= r.budget, StakeError::RootBudgetExceeded);
    ctx.accounts.receipt.amount = amount;
    ctx.accounts.receipt.bump = ctx.bumps.receipt;

    // `items` is not re-derived here: chip_core's `GrantBooster` enforces `["items", owner]` with
    // `owner = wallet` (ConstraintSeeds otherwise), so a foreign account can never be credited.
    let seeds: &[&[u8]] = &[b"rewarder", &[ctx.bumps.rewarder]];
    chip_core::cpi::grant_booster(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            GrantBooster {
                authority: ctx.accounts.rewarder.to_account_info(),
                payer: ctx.accounts.wallet.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                owner: ctx.accounts.wallet.to_account_info(),
                items: ctx.accounts.items.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ),
        amount as u16, // ≤ MAX_ITEM_CLAIM (10) — checked above
    )?;
    emit!(RootClaimed {
        kind: r.kind,
        epoch: r.epoch,
        wallet: ctx.accounts.wallet.key(),
        amount
    });
    Ok(())
}

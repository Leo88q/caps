//! Admin surface: initialize, collections, params with guard-rails, 2-step
//! admin transfer, pause. Admin key = Squads multisig (48 h timelock on
//! set_params is enforced at the multisig level; on-chain we additionally
//! bump `params_version` so the indexer/admin-panel can diff & audit).

use anchor_lang::prelude::*;
use mpl_core::{
    instructions::CreateCollectionV2CpiBuilder,
    types::{Creator, Plugin, PluginAuthority, PluginAuthorityPair, Royalties, RuleSet},
    ID as MPL_CORE_ID,
};

use crate::economy::*;
use crate::errors::ChipError;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + GameConfig::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: vault PDA, system-owned, holds SOL
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitArgs {
    pub treasury: Pubkey,
    pub buyback_wallet: Pubkey,
    pub cg_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub skr_mint: Pubkey,
    pub staking_program: Pubkey,
    pub pyth_sol_usd_feed: Pubkey,
    pub pyth_skr_usd_feed: Pubkey,
}

pub fn initialize(ctx: Context<Initialize>, args: InitArgs) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.pending_admin = Pubkey::default();
    c.treasury = args.treasury;
    c.buyback_wallet = args.buyback_wallet;
    c.cg_mint = args.cg_mint;
    c.usdc_mint = args.usdc_mint;
    c.skr_mint = args.skr_mint;
    c.staking_program = args.staking_program;
    c.pyth_sol_usd_feed = args.pyth_sol_usd_feed;
    c.pyth_skr_usd_feed = args.pyth_skr_usd_feed;
    c.skr_discount_bps = DEFAULT_SKR_DISCOUNT_BPS;
    c.featured_collection = 0;
    c.paused = false;
    c.packs = DEFAULT_PACKS;
    c.market_fee_bps = DEFAULT_MARKET_FEE_BPS;
    c.collections_created = 0;
    c.params_version = 1;
    c.vault_bump = ctx.bumps.vault;
    c.bump = ctx.bumps.config;
    c.pauser = Pubkey::default();
    // fund vault with rent-exempt minimum so it can never be garbage-collected
    let min = Rent::get()?.minimum_balance(0);
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        min,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct CreateCollection<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
    // `.as_ref()` / `[..]` on the seeds, and only on the `init` accounts: anchor's `init` path puts the
    // seed expressions into an array literal with no annotation, so element 0 decides the type of all of
    // them — with `b"collection"` (a `+[u8; 10]`) first, `&[idx]` was demanded to be the same array and got
    // E0308 "expected an array with a size of 10". Making every element a `&[u8]` is the same bytes and the
    // same PDA, so no client-side derivation moves; the non-`init` constraints elsewhere in the workspace do
    // not need it (chip.rs's identical `seeds = [b"collection", &[chip.collection_idx]]` compiled clean) and
    // are deliberately left alone.
    #[account(init, payer = admin, space = 8 + CollectionMeta::INIT_SPACE, seeds = [b"collection".as_ref(), &[idx][..]], bump)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK: fresh keypair for the Core collection account
    #[account(mut)]
    pub core_collection: Signer<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_collection(
    ctx: Context<CreateCollection>,
    idx: u8,
    symbol: String,
    name: String,
    uri: String,
    element: u8,
) -> Result<()> {
    require!(idx < COLLECTION_COUNT, ChipError::InvalidCollection);
    require!(
        idx == ctx.accounts.config.collections_created,
        ChipError::CollectionExists
    ); // sequential
    require!(element < 5, ChipError::InvalidElement);
    require!(symbol.len() <= 16, ChipError::InvalidCollection);

    let meta = &mut ctx.accounts.meta;
    meta.idx = idx;
    meta.core_collection = ctx.accounts.core_collection.key();
    meta.symbol = symbol;
    meta.element = element;
    meta.minted = 0;
    meta.minted_by_rarity = [0; RARITY_COUNT];
    meta.bump = ctx.bumps.meta;

    // Royalties enforced at the collection level (2.5 % → treasury). Marketplaces that
    // respect Core royalties apply it automatically; our own market applies it explicitly.
    let plugins = vec![PluginAuthorityPair {
        plugin: Plugin::Royalties(Royalties {
            basis_points: ROYALTY_BPS,
            creators: vec![Creator {
                address: ctx.accounts.config.treasury,
                percentage: 100,
            }],
            rule_set: RuleSet::None,
        }),
        authority: Some(PluginAuthority::UpdateAuthority),
    }];
    let seeds: &[&[u8]] = &[b"collection", &[idx], &[meta.bump]];
    CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
        .collection(&ctx.accounts.core_collection.to_account_info())
        .update_authority(Some(&meta.to_account_info()))
        .payer(&ctx.accounts.admin.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .name(name)
        .uri(uri)
        .plugins(plugins)
        .invoke_signed(&[seeds])?;

    ctx.accounts.config.collections_created += 1;
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ParamsPatch {
    pub packs: Option<[PackDef; 4]>,
    pub market_fee_bps: Option<u16>,
    pub featured_collection: Option<u8>,
    pub treasury: Option<Pubkey>,
    pub buyback_wallet: Option<Pubkey>,
    pub pyth_sol_usd_feed: Option<Pubkey>,
    pub pyth_skr_usd_feed: Option<Pubkey>,
    pub skr_mint: Option<Pubkey>,
    pub skr_discount_bps: Option<u16>,
}

/// Every edit is validated against economy guard-rails. These are the
/// bounds inside which the live-ops admin panel may tune without a program
/// upgrade; anything outside needs a new deploy (and therefore the 48 h
/// timelock + public diff).
pub fn set_params(ctx: Context<AdminOnly>, patch: ParamsPatch) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(packs) = patch.packs {
        for (i, p) in packs.iter().enumerate() {
            let sum: u32 = p.odds_bps.iter().map(|&b| b as u32).sum();
            require!(sum == BPS_DENOM, ChipError::OddsSumInvalid);
            require!(
                (1..=MAX_CHIPS_PER_PACK as u8).contains(&p.chips),
                ChipError::InvalidQuantity
            );
            require!(p.floor < RARITY_COUNT as u8, ChipError::OddsGuardRail);
            require!(p.pity_tier < RARITY_COUNT as u8, ChipError::OddsGuardRail);
            require!(p.odds_bps[0] >= 500, ChipError::OddsGuardRail); // Common ≥ 5 % always
            let top2 = p.odds_bps[7] as u32 + p.odds_bps[8] as u32;
            // Starter/Standard may never exceed 2 % Legend+/Diamond per slot; Premium/Limited 4 %.
            let cap = if i <= 1 {
                MAX_TOP2_BPS_STANDARD as u32
            } else {
                2 * MAX_TOP2_BPS_STANDARD as u32
            };
            require!(top2 <= cap, ChipError::OddsGuardRail);
            // price sanity: never free, never > $500
            require!(
                (50..=50_000).contains(&p.price_usd_cents),
                ChipError::OddsGuardRail
            );
            if p.pity_tier > 0 {
                require!(
                    p.pity_hard_at >= 10
                        && p.pity_soft_start <= p.pity_hard_at
                        && p.pity_soft_step_bps <= 200,
                    ChipError::OddsGuardRail
                );
            }
            // Starter stays soulbound + 1/wallet by construction (sku 0 semantics are in code).
        }
        c.packs = packs;
    }
    if let Some(fee) = patch.market_fee_bps {
        require!(fee <= MAX_MARKET_FEE_BPS, ChipError::FeeTooHigh);
        c.market_fee_bps = fee;
    }
    if let Some(f) = patch.featured_collection {
        require!(f < c.collections_created, ChipError::InvalidCollection);
        c.featured_collection = f;
    }
    if let Some(t) = patch.treasury {
        c.treasury = t;
    }
    if let Some(b) = patch.buyback_wallet {
        c.buyback_wallet = b;
    }
    if let Some(p) = patch.pyth_sol_usd_feed {
        c.pyth_sol_usd_feed = p;
    }
    if let Some(p) = patch.pyth_skr_usd_feed {
        c.pyth_skr_usd_feed = p;
    }
    if let Some(m) = patch.skr_mint {
        c.skr_mint = m;
    }
    if let Some(d) = patch.skr_discount_bps {
        require!(d <= MAX_SKR_DISCOUNT_BPS, ChipError::FeeTooHigh);
        c.skr_discount_bps = d;
    }
    c.params_version = c.params_version.checked_add(1).ok_or(ChipError::Overflow)?;
    emit!(ParamsChanged {
        admin: ctx.accounts.admin.key(),
        version: c.params_version
    });
    Ok(())
}

/// Admin: pause or un-pause. Un-pausing is admin-only by construction (the pauser has no
/// instruction that writes `paused = false`).
pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(PauseChanged {
        by: ctx.accounts.admin.key(),
        paused
    });
    Ok(())
}

/// Admin: designate (or clear with `Pubkey::default()`) the hot pauser key (SEC-H2).
pub fn set_pauser(ctx: Context<AdminOnly>, pauser: Pubkey) -> Result<()> {
    ctx.accounts.config.pauser = pauser;
    Ok(())
}

#[derive(Accounts)]
pub struct Pause<'info> {
    /// Either the configured pauser or the admin.
    pub authority: Signer<'info>,
    #[account(
        mut, seeds = [b"config"], bump = config.bump,
        constraint = authority.key() == config.admin || (config.pauser != Pubkey::default() && authority.key() == config.pauser) @ ChipError::Unauthorized,
    )]
    pub config: Box<Account<'info, GameConfig>>,
}

/// Emergency stop (SEC-H2): pauser **or** admin, `paused = true` only, idempotent. No timelock:
/// the pauser is a 1/3 hot multisig, the runbook target is ≤ 10 min from alert to pause.
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.config.paused = true;
    emit!(PauseChanged {
        by: ctx.accounts.authority.key(),
        paused: true
    });
    Ok(())
}

pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, constraint = config.pending_admin == new_admin.key() @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = c.pending_admin;
    c.pending_admin = Pubkey::default();
    Ok(())
}

// ---------------------------------------------------------------------------
// Grant boosters (quest rewards) — only via the staking program's reward
// claim path (CPI) or admin for support cases. Boosters are never sold.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct GrantBooster<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: any wallet
    pub owner: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, space = 8 + PlayerItems::INIT_SPACE, seeds = [b"items", owner.key().as_ref()], bump)]
    pub items: Box<Account<'info, PlayerItems>>,
    pub system_program: Program<'info, System>,
}

pub fn grant_booster(ctx: Context<GrantBooster>, count: u16) -> Result<()> {
    let c = &ctx.accounts.config;
    // authority = admin (support) or the staking program's reward-signer PDA ["rewarder"] (quest claims)
    let (rewarder, _) = Pubkey::find_program_address(&[b"rewarder"], &c.staking_program);
    let a = ctx.accounts.authority.key();
    require!(a == c.admin || a == rewarder, ChipError::Unauthorized);
    require!(count <= 10, ChipError::InvalidQuantity);
    let items = &mut ctx.accounts.items;
    if items.owner == Pubkey::default() {
        items.owner = ctx.accounts.owner.key();
        items.bump = ctx.bumps.items;
    }
    items.boosters = items
        .boosters
        .checked_add(count)
        .ok_or(ChipError::Overflow)?;
    Ok(())
}

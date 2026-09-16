//! Paid services — the "voluntary spend" rail (Phase 5 decision: the studio
//! earns on fees AND on optional services). One instruction settles any
//! `ServiceKind` in any accepted currency:
//!
//!  * $CG  → 100 % burned (sink; reported to the emission guard)
//!  * SOL  → 100 % straight to the treasury (Squads vault), priced via Pyth SOL/USD
//!  * USDC → 100 % treasury ATA
//!  * SKR  → 100 % treasury ATA, priced via Pyth SKR/USD
//!
//! What the player receives is *not* stored here except for boosters (which
//! live in PlayerItems and gate fusion). Handles, skins, themes, passes are
//! off-chain entitlements: the indexer consumes `ServicePaid` and binds the
//! purchase to the payload the player committed to via `ref_hash`
//! (= keccak(kind ‖ wallet ‖ canonical payload)). This keeps strings and
//! cosmetics off-chain (cheap, easily extended) while the payment itself is
//! verifiable by anyone.
//!
//! Anti-abuse: per-kind daily caps in `ServiceKind::daily_cap` (boosters ≤ 3 /
//! wallet / day so they cannot be farmed into a fusion-odds advantage), and
//! nothing purchasable here changes drop odds, PvP power or staking weight.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::economy::*;
use crate::errors::ChipError;
use crate::instructions::packs::{oracle_price, units_for_cents, SKR_USD_FEED_HEX, SOL_USD_FEED_HEX};
use crate::state::*;

/// Per-wallet rolling daily counters for paid services (tiny PDA, created lazily).
#[account]
#[derive(InitSpace)]
pub struct ServiceLedger {
    pub owner: Pubkey,
    pub day_start: i64,
    pub bought_today: [u8; 16], // indexed by ServiceKind
    pub spent_usd_cents_total: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(kind: u8, currency: u8)]
pub struct PayService<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipError::Paused, has_one = treasury)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(init_if_needed, payer = buyer, space = 8 + ServiceLedger::INIT_SPACE, seeds = [b"services", buyer.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, ServiceLedger>>,
    /// Burn shard of the buyer (#12): `$CG` services add to `burned_total` (services are low
    /// volume, so the shard is simply `mut` for every currency).
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&buyer.key())]], bump = vault_ledger.bump)]
    pub vault_ledger: Box<Account<'info, VaultLedger>>,
    /// Boosters land here (only touched for ServiceKind::Booster).
    #[account(init_if_needed, payer = buyer, space = 8 + PlayerItems::INIT_SPACE, seeds = [b"items", buyer.key().as_ref()], bump)]
    pub items: Box<Account<'info, PlayerItems>>,

    /// CHECK: treasury (Squads vault) — SOL destination; pinned by `has_one`.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    // --- volatile currencies (SOL / SKR): Pyth price update ---
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

    // --- SPL legs (USDC / SKR → treasury ATA; $CG → burn) ---
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = treasury)]
    pub treasury_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Option<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `max_units` = slippage guard for volatile currencies (max lamports / max micro-SKR the buyer accepts).
pub fn pay_service(ctx: Context<PayService>, kind: u8, currency: u8, max_units: u64, ref_hash: [u8; 32]) -> Result<()> {
    let svc = ServiceKind::from_u8(kind).ok_or(ChipError::InvalidService)?;
    let clock = Clock::get()?;
    let cents = svc.price_usd_cents();

    // --- daily cap ---
    let ledger = &mut ctx.accounts.ledger;
    if ledger.owner == Pubkey::default() { ledger.owner = ctx.accounts.buyer.key(); ledger.bump = ctx.bumps.ledger; }
    if clock.unix_timestamp - ledger.day_start >= 86_400 { ledger.day_start = clock.unix_timestamp; ledger.bought_today = [0; 16]; }
    let slot = &mut ledger.bought_today[kind as usize];
    require!(*slot < svc.daily_cap(), ChipError::ServiceDailyCap);
    *slot += 1;
    ledger.spent_usd_cents_total = ledger.spent_usd_cents_total.saturating_add(cents);

    let spl = |mint: Pubkey, amount: u64, to_treasury: bool| -> Result<()> {
        let from = ctx.accounts.buyer_token.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
        require_keys_eq!(from.mint, mint, ChipError::CurrencyNotAccepted);
        if to_treasury {
            let to = ctx.accounts.treasury_token.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
            require_keys_eq!(to.mint, mint, ChipError::CurrencyNotAccepted);
            token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), token::Transfer {
                from: from.to_account_info(), to: to.to_account_info(), authority: ctx.accounts.buyer.to_account_info(),
            }), amount)
        } else {
            let m = ctx.accounts.cg_mint.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
            token::burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), token::Burn {
                mint: m.to_account_info(), from: from.to_account_info(), authority: ctx.accounts.buyer.to_account_info(),
            }), amount)
        }
    };

    let (amount, burned) = match currency {
        0 => {
            let pu = ctx.accounts.price_update.as_ref().ok_or(ChipError::StalePrice)?;
            let (price, exponent) = oracle_price(pu, &clock, SOL_USD_FEED_HEX)?;
            let lamports = units_for_cents(cents, price, exponent, 9)?;
            require!(lamports <= max_units, ChipError::Slippage);
            system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.treasury.to_account_info(),
            }), lamports)?;
            (lamports, 0)
        }
        1 => { let a = cents.checked_mul(10_000).ok_or(ChipError::Overflow)?; spl(ctx.accounts.config.usdc_mint, a, true)?; (a, 0) }
        2 => { let a = svc.price_cg_micro(); spl(ctx.accounts.config.cg_mint, a, false)?; (a, a) }
        3 => {
            require!(ctx.accounts.config.skr_mint != Pubkey::default(), ChipError::CurrencyNotAccepted);
            let pu = ctx.accounts.price_update.as_ref().ok_or(ChipError::StalePrice)?;
            let (price, exponent) = oracle_price(pu, &clock, SKR_USD_FEED_HEX)?;
            let a = units_for_cents(cents, price, exponent, 6)?;
            require!(a <= max_units, ChipError::Slippage);
            spl(ctx.accounts.config.skr_mint, a, true)?;
            (a, 0)
        }
        _ => return err!(ChipError::CurrencyNotAccepted),
    };

    if burned > 0 {
        ctx.accounts.vault_ledger.burned(burned);
        emit!(BurnReported { source: 3, amount: burned });
    }

    // on-chain entitlement: boosters only
    if svc == ServiceKind::Booster {
        let items = &mut ctx.accounts.items;
        if items.owner == Pubkey::default() { items.owner = ctx.accounts.buyer.key(); items.bump = ctx.bumps.items; }
        items.boosters = items.boosters.checked_add(1).ok_or(ChipError::Overflow)?;
    }

    emit!(ServicePaid { buyer: ctx.accounts.buyer.key(), kind, currency, amount, burned, ref_hash });
    Ok(())
}

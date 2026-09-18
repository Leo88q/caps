//! GUTTERCAPS — market
//!
//! Freeze-in-place marketplace for Core chips. The asset never leaves the
//! seller's wallet while listed (PermanentFreezeDelegate via chip_core), so
//! wallets/explorers still show it, and there is no escrow account to drain.
//!
//! Fee model v2 (docs/02-economy.md §7, Phase 5): price → 90 % seller,
//! protocol fee `GameConfig.market_fee_bps` (default 7.5 %, hard cap 10 %,
//! live-tunable by the multisig) split ⅓ buyback-wallet / ⅔ treasury, plus
//! 2.5 % creator royalty (treasury). Listing fee 0.5 $CG burned (spam guard).
//! Currencies: SOL, USDC or SKR (Seeker) — SPL legs are generic over the
//! listing's mint, so adding a currency is a config change, not a redeploy.
//!
//! Security: seller-signed listing; buyer pays the exact stored price in the
//! stored currency (no swap-out); settlement transfers the asset via
//! chip_core::deliver_sold which only works for LISTED chips and only when
//! called by ["market_auth"]; offers escrow USDC in a PDA-owned ATA.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use mpl_core::accounts::BaseAssetV1;

use chip_core::cpi::accounts::{DeliverSold, SetChipFlag};
use chip_core::program::ChipCore;
use chip_core::state::{ChipState, CollectionMeta, GameConfig};

declare_id!("GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz");

pub const LISTING_FEE_CG: u64 = 500_000; // 0.5 $CG (6 dp)
/// Default protocol fee; the live value is `GameConfig.market_fee_bps` (≤ MAX_MARKET_FEE_BPS = 10 %).
pub const FEE_BPS: u16 = 750;
/// Share of the protocol fee that goes to the buyback-burn wallet; the rest → treasury.
pub const FEE_BUYBACK_SHARE_BPS: u64 = 3_333;
pub const ROYALTY_BPS: u16 = 250;
pub const BPS: u64 = 10_000;
pub const MIN_PRICE_LAMPORTS: u64 = 1_000_000; // 0.001 SOL
pub const MIN_PRICE_USDC: u64 = 100_000; // $0.10
pub const MIN_PRICE_SKR: u64 = 5_000_000; // 5 SKR (≈ $0.10 at listing time; floor is only an anti-dust guard)
pub const MAX_OFFER_TTL: i64 = 30 * 86_400;

/// Settlement currency of a listing.
///
/// The discriminants are *codes*, not a wire format: 0 SOL / 1 USDC / 3 SKR keeps the numbering the rest of
/// the stack already uses (chip_core `Currency` has CG = 2 in between, the indexer's `CURRENCY_SYMBOL` is
/// `['SOL','USDC','CG','SKR']`, `economy::oracle` carries `currency: 3` for SKR, and the client's
/// `MarketCurrency.SKR` is 3), so `Currency as u8` in an event, the byte in `Listing.currency` and every
/// off-chain consumer agree.
///
/// It is deliberately NOT `AnchorSerialize`: borsh numbers enum variants by *position* and ignores explicit
/// discriminants, so a `Currency` instruction argument encodes `Skr` as 2 while `as u8` says 3. The client
/// sends the code, the decoder expected the position → `InstructionDidNotDeserialize` (0x66) on exactly the
/// SKR leg of M01 in run 35364318967, with the SOL and USDC legs passing. Instructions therefore take the
/// code as `u8` and convert with `from_code`, and `Listing` stores the code.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Currency {
    Sol = 0,
    Usdc = 1,
    Skr = 3,
}

impl Currency {
    /// The wire/storage code — the discriminant, and the number the indexer and the client speak.
    pub fn code(self) -> u8 {
        self as u8
    }

    /// Decode a code from an instruction or from `Listing.currency`. Any other value is a client bug, not a
    /// listing we should try to settle.
    pub fn from_code(code: u8) -> Result<Self> {
        match code {
            0 => Ok(Currency::Sol),
            1 => Ok(Currency::Usdc),
            3 => Ok(Currency::Skr),
            _ => err!(MarketError::BadCurrency),
        }
    }

    pub fn min_price(self) -> u64 {
        match self {
            Currency::Sol => MIN_PRICE_LAMPORTS,
            Currency::Usdc => MIN_PRICE_USDC,
            Currency::Skr => MIN_PRICE_SKR,
        }
    }
    /// Mint of the SPL leg for this currency (None for SOL).
    pub fn mint(self, cfg: &GameConfig) -> Option<Pubkey> {
        match self {
            Currency::Sol => None,
            Currency::Usdc => Some(cfg.usdc_mint),
            Currency::Skr => Some(cfg.skr_mint),
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    /// Currency *code* (`Currency::code`), not a borsh enum — see `Currency`.
    pub currency: u8,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub asset: Pubkey,
    pub bidder: Pubkey,
    pub amount_usdc: u64,
    pub expires_at: i64,
    pub bump: u8,
}

#[event]
pub struct ChipListed {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub currency: u8,
}
#[event]
pub struct ListingUpdated {
    pub asset: Pubkey,
    pub price: u64,
}
#[event]
pub struct ListingCancelled {
    pub asset: Pubkey,
}
#[event]
pub struct ChipSold {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub currency: u8,
    pub fee: u64,
    pub royalty: u64,
    pub via_offer: bool,
}
#[event]
pub struct OfferMade {
    pub asset: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}
#[event]
pub struct OfferCancelled {
    pub asset: Pubkey,
    pub bidder: Pubkey,
}

#[error_code]
pub enum MarketError {
    #[msg("Price below minimum")]
    PriceTooLow,
    #[msg("Not the asset owner")]
    NotOwner,
    #[msg("Not the seller")]
    NotSeller,
    #[msg("Currency mismatch")]
    CurrencyMismatch,
    #[msg("Offer expired")]
    OfferExpired,
    #[msg("Offer TTL too long")]
    TtlTooLong,
    #[msg("Cannot buy your own listing")]
    SelfTrade,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Chip is soulbound / time-locked")]
    ChipLocked,
    #[msg("Missing token accounts for this currency")]
    MissingAccounts,
    #[msg("Unknown currency code")]
    BadCurrency,
}

/// `fee_bps` comes from GameConfig (live-tunable, ≤ 10 %); royalty is fixed at mint time.
fn split(price: u64, fee_bps: u16) -> Result<(u64, u64, u64, u64)> {
    let fee_bps = fee_bps.min(chip_core::economy::MAX_MARKET_FEE_BPS);
    let fee = price
        .checked_mul(fee_bps as u64)
        .ok_or(MarketError::Overflow)?
        / BPS;
    let royalty = price
        .checked_mul(ROYALTY_BPS as u64)
        .ok_or(MarketError::Overflow)?
        / BPS;
    let seller = price
        .checked_sub(fee)
        .and_then(|v| v.checked_sub(royalty))
        .ok_or(MarketError::Overflow)?;
    let fee_buyback = fee * FEE_BUYBACK_SHARE_BPS / BPS;
    let fee_treasury = fee - fee_buyback;
    Ok((seller, fee_buyback, fee_treasury, royalty))
}

// ---------------------------------------------------------------------------
// Shared CPI helper: flag/unflag through chip_core
// ---------------------------------------------------------------------------

struct FlagAccounts<'a, 'info> {
    chip_core: &'a Program<'info, ChipCore>,
    market_auth: &'a AccountInfo<'info>,
    payer: &'a AccountInfo<'info>,
    config: &'a AccountInfo<'info>,
    asset: &'a AccountInfo<'info>,
    chip: &'a AccountInfo<'info>,
    meta: &'a AccountInfo<'info>,
    core_collection: &'a AccountInfo<'info>,
    mpl_core: &'a AccountInfo<'info>,
    system_program: &'a AccountInfo<'info>,
}

fn set_listed(a: FlagAccounts, bump: u8, set: bool, owner: Pubkey) -> Result<()> {
    let seeds: &[&[u8]] = &[b"market_auth", &[bump]];
    chip_core::cpi::set_chip_flag(
        CpiContext::new_with_signer(
            a.chip_core.to_account_info(),
            SetChipFlag {
                caller: a.market_auth.clone(),
                payer: a.payer.clone(),
                config: a.config.clone(),
                asset: a.asset.clone(),
                chip: a.chip.clone(),
                meta: a.meta.clone(),
                core_collection: a.core_collection.clone(),
                mpl_core: a.mpl_core.clone(),
                system_program: a.system_program.clone(),
            },
            &[seeds],
        ),
        ChipState::F_LISTED,
        set,
        owner,
    )
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct List<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(init, payer = seller, space = 8 + Listing::INIT_SPACE, seeds = [b"listing", asset.key().as_ref()], bump)]
    pub listing: Account<'info, Listing>,
    /// CHECK: ["market_auth"] PDA signer for chip_core CPIs
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,

    /// CHECK: Core asset (owner checked in handler)
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"chip", asset.key().as_ref()], bump = chip.bump, seeds::program = chip_core::ID)]
    pub chip: Box<Account<'info, ChipState>>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = meta.bump, seeds::program = chip_core::ID)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = meta.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID)]
    pub config: Account<'info, GameConfig>,

    // listing fee burn
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = config.cg_mint, token::authority = seller)]
    pub seller_cg: Account<'info, TokenAccount>,

    pub chip_core: Program<'info, ChipCore>,
    /// CHECK: Metaplex Core
    #[account(address = mpl_core::ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn list_handler(ctx: Context<List>, price: u64, currency: u8) -> Result<()> {
    let currency = Currency::from_code(currency)?;
    let base = BaseAssetV1::from_bytes(&ctx.accounts.asset.try_borrow_data()?)
        .map_err(|_| error!(MarketError::NotOwner))?;
    require_keys_eq!(base.owner, ctx.accounts.seller.key(), MarketError::NotOwner);
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.chip.lock_until
            && ctx.accounts.chip.flags & ChipState::F_SOULBOUND == 0,
        MarketError::ChipLocked
    );
    require!(price >= currency.min_price(), MarketError::PriceTooLow);
    // 0.5 $CG listing fee → burn
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Burn {
                mint: ctx.accounts.cg_mint.to_account_info(),
                from: ctx.accounts.seller_cg.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        LISTING_FEE_CG,
    )?;

    set_listed(
        FlagAccounts {
            chip_core: &ctx.accounts.chip_core,
            market_auth: &ctx.accounts.market_auth.to_account_info(),
            payer: &ctx.accounts.seller.to_account_info(),
            config: &ctx.accounts.config.to_account_info(),
            asset: &ctx.accounts.asset.to_account_info(),
            chip: &ctx.accounts.chip.to_account_info(),
            meta: &ctx.accounts.meta.to_account_info(),
            core_collection: &ctx.accounts.core_collection.to_account_info(),
            mpl_core: &ctx.accounts.mpl_core.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        },
        ctx.bumps.market_auth,
        true,
        ctx.accounts.seller.key(),
    )?;

    let l = &mut ctx.accounts.listing;
    l.asset = ctx.accounts.asset.key();
    l.seller = ctx.accounts.seller.key();
    l.price = price;
    l.currency = currency.code();
    l.created_at = now;
    l.bump = ctx.bumps.listing;
    emit!(ChipListed {
        asset: l.asset,
        seller: l.seller,
        price,
        currency: currency.code()
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// update_price / cancel
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"listing", listing.asset.as_ref()], bump = listing.bump, has_one = seller @ MarketError::NotSeller)]
    pub listing: Account<'info, Listing>,
}

pub fn update_price_handler(ctx: Context<UpdatePrice>, price: u64) -> Result<()> {
    let l = &mut ctx.accounts.listing;
    require!(
        price >= Currency::from_code(l.currency)?.min_price(),
        MarketError::PriceTooLow
    );
    l.price = price;
    emit!(ListingUpdated {
        asset: l.asset,
        price
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, close = seller, seeds = [b"listing", asset.key().as_ref()], bump = listing.bump, has_one = seller @ MarketError::NotSeller, has_one = asset)]
    pub listing: Account<'info, Listing>,
    /// CHECK:
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"chip", asset.key().as_ref()], bump = chip.bump, seeds::program = chip_core::ID)]
    pub chip: Box<Account<'info, ChipState>>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = meta.bump, seeds::program = chip_core::ID)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = meta.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID)]
    pub config: Account<'info, GameConfig>,
    pub chip_core: Program<'info, ChipCore>,
    /// CHECK:
    #[account(address = mpl_core::ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_handler(ctx: Context<Cancel>) -> Result<()> {
    set_listed(
        FlagAccounts {
            chip_core: &ctx.accounts.chip_core,
            market_auth: &ctx.accounts.market_auth.to_account_info(),
            payer: &ctx.accounts.seller.to_account_info(),
            config: &ctx.accounts.config.to_account_info(),
            asset: &ctx.accounts.asset.to_account_info(),
            chip: &ctx.accounts.chip.to_account_info(),
            meta: &ctx.accounts.meta.to_account_info(),
            core_collection: &ctx.accounts.core_collection.to_account_info(),
            mpl_core: &ctx.accounts.mpl_core.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        },
        ctx.bumps.market_auth,
        false,
        ctx.accounts.seller.key(),
    )?;
    emit!(ListingCancelled {
        asset: ctx.accounts.asset.key()
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// buy
// ---------------------------------------------------------------------------

/// Every deserialized state account is `Box`ed: `anchor`'s `try_accounts` builds each field as a local, and
/// this instruction has the widest context in the program (buyer + seller + listing + chip + meta + config +
/// four optional token accounts). Unboxed, the frame passed the runtime's 4 KiB and the program died inside
/// `try_accounts` — `Access violation in stack frame 5 at address 0x200005ff8 of size 8`, no CPI in the log,
/// so no account was at fault (CI run 35361217764, T-L-X X01). chip_core's structs box GameConfig for the
/// same reason; keep the pattern when this context grows.
#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: seller receives proceeds; must equal listing.seller
    #[account(mut, address = listing.seller)]
    pub seller: UncheckedAccount<'info>,
    #[account(mut, close = seller, seeds = [b"listing", asset.key().as_ref()], bump = listing.bump, has_one = asset)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK:
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"chip", asset.key().as_ref()], bump = chip.bump, seeds::program = chip_core::ID)]
    pub chip: Box<Account<'info, ChipState>>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = meta.bump, seeds::program = chip_core::ID)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = meta.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID, has_one = treasury, has_one = buyback_wallet)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: from config
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: from config
    #[account(mut)]
    pub buyback_wallet: UncheckedAccount<'info>,

    // SPL path (USDC or SKR — mint pinned to the listing's currency in the handler)
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = seller)]
    pub seller_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = treasury)]
    pub treasury_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = buyback_wallet)]
    pub buyback_token: Option<Account<'info, TokenAccount>>,

    pub chip_core: Program<'info, ChipCore>,
    /// CHECK:
    #[account(address = mpl_core::ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn buy_handler(ctx: Context<Buy>, expected_price: u64, expected_currency: u8) -> Result<()> {
    let expected_currency = Currency::from_code(expected_currency)?;
    let l = &ctx.accounts.listing;
    require!(l.seller != ctx.accounts.buyer.key(), MarketError::SelfTrade);
    // front-running guard: the buyer signs for the price they saw
    require!(
        l.price == expected_price && l.currency == expected_currency.code(),
        MarketError::CurrencyMismatch
    );
    let (to_seller, fee_bb, fee_tr, royalty) = split(l.price, ctx.accounts.config.market_fee_bps)?;

    match Currency::from_code(l.currency)?.mint(&ctx.accounts.config) {
        None => {
            let sys = ctx.accounts.system_program.to_account_info();
            let from = ctx.accounts.buyer.to_account_info();
            for (to, amt) in [
                (&ctx.accounts.seller, to_seller),
                (&ctx.accounts.buyback_wallet, fee_bb),
                (&ctx.accounts.treasury, fee_tr + royalty),
            ] {
                if amt > 0 {
                    system_program::transfer(
                        CpiContext::new(
                            sys.clone(),
                            system_program::Transfer {
                                from: from.clone(),
                                to: to.to_account_info(),
                            },
                        ),
                        amt,
                    )?;
                }
            }
        }
        Some(mint) => {
            let tp = ctx.accounts.token_program.to_account_info();
            let buyer_t = ctx
                .accounts
                .buyer_token
                .as_ref()
                .ok_or(MarketError::MissingAccounts)?;
            let seller_t = ctx
                .accounts
                .seller_token
                .as_ref()
                .ok_or(MarketError::MissingAccounts)?;
            let bb_t = ctx
                .accounts
                .buyback_token
                .as_ref()
                .ok_or(MarketError::MissingAccounts)?;
            let tr_t = ctx
                .accounts
                .treasury_token
                .as_ref()
                .ok_or(MarketError::MissingAccounts)?;
            for t in [buyer_t, seller_t, bb_t, tr_t] {
                require_keys_eq!(t.mint, mint, MarketError::CurrencyMismatch);
            }
            let from = buyer_t.to_account_info();
            let auth = ctx.accounts.buyer.to_account_info();
            let legs = [
                (seller_t.to_account_info(), to_seller),
                (bb_t.to_account_info(), fee_bb),
                (tr_t.to_account_info(), fee_tr + royalty),
            ];
            for (to, amt) in legs {
                if amt > 0 {
                    token::transfer(
                        CpiContext::new(
                            tp.clone(),
                            token::Transfer {
                                from: from.clone(),
                                to,
                                authority: auth.clone(),
                            },
                        ),
                        amt,
                    )?;
                }
            }
        }
    }

    // deliver: unfreeze + PermanentTransfer to buyer + clear flag (chip_core checks LISTED + seller)
    let seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    chip_core::cpi::deliver_sold(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            DeliverSold {
                caller: ctx.accounts.market_auth.to_account_info(),
                payer: ctx.accounts.buyer.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                asset: ctx.accounts.asset.to_account_info(),
                chip: ctx.accounts.chip.to_account_info(),
                meta: ctx.accounts.meta.to_account_info(),
                core_collection: ctx.accounts.core_collection.to_account_info(),
                new_owner: ctx.accounts.buyer.to_account_info(),
                mpl_core: ctx.accounts.mpl_core.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ),
        l.seller,
    )?;

    emit!(ChipSold {
        asset: l.asset,
        seller: l.seller,
        buyer: ctx.accounts.buyer.key(),
        price: l.price,
        currency: l.currency,
        fee: fee_bb + fee_tr,
        royalty,
        via_offer: false
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// offers (USDC escrow in PDA ATA)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct MakeOffer<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    /// CHECK: any Core asset
    pub asset: UncheckedAccount<'info>,
    #[account(init, payer = bidder, space = 8 + Offer::INIT_SPACE, seeds = [b"offer", asset.key().as_ref(), bidder.key().as_ref()], bump)]
    pub offer: Account<'info, Offer>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID)]
    pub config: Account<'info, GameConfig>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, token::mint = usdc_mint, token::authority = bidder)]
    pub bidder_usdc: Account<'info, TokenAccount>,
    #[account(init, payer = bidder, associated_token::mint = usdc_mint, associated_token::authority = offer)]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn make_offer_handler(ctx: Context<MakeOffer>, amount: u64, ttl_secs: i64) -> Result<()> {
    require!(amount >= MIN_PRICE_USDC, MarketError::PriceTooLow);
    require!(
        ttl_secs > 0 && ttl_secs <= MAX_OFFER_TTL,
        MarketError::TtlTooLong
    );
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.bidder_usdc.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.bidder.to_account_info(),
            },
        ),
        amount,
    )?;
    let o = &mut ctx.accounts.offer;
    o.asset = ctx.accounts.asset.key();
    o.bidder = ctx.accounts.bidder.key();
    o.amount_usdc = amount;
    o.expires_at = Clock::get()?.unix_timestamp + ttl_secs;
    o.bump = ctx.bumps.offer;
    emit!(OfferMade {
        asset: o.asset,
        bidder: o.bidder,
        amount,
        expires_at: o.expires_at
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(mut, close = bidder, seeds = [b"offer", offer.asset.as_ref(), bidder.key().as_ref()], bump = offer.bump, has_one = bidder)]
    pub offer: Account<'info, Offer>,
    #[account(mut, associated_token::mint = bidder_usdc.mint, associated_token::authority = offer)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::authority = bidder)]
    pub bidder_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn cancel_offer_handler(ctx: Context<CancelOffer>) -> Result<()> {
    let o = &ctx.accounts.offer;
    let asset = o.asset;
    let bidder = o.bidder;
    let bump = o.bump;
    let seeds: &[&[u8]] = &[b"offer", asset.as_ref(), bidder.as_ref(), &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.bidder_usdc.to_account_info(),
                authority: o.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.escrow.amount,
    )?;
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        token::CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.bidder.to_account_info(),
            authority: o.to_account_info(),
        },
        &[seeds],
    ))?;
    emit!(OfferCancelled { asset, bidder });
    Ok(())
}

/// Seller accepts an offer on an UNLISTED chip they own (listed chips must be
/// cancelled first — keeps one code path for delivery). The chip is flagged
/// LISTED and delivered in the same tx, so `deliver_sold`'s invariant holds.
#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: bidder gets the chip and the escrow rent
    #[account(mut, address = offer.bidder)]
    pub bidder: UncheckedAccount<'info>,
    #[account(mut, close = bidder, seeds = [b"offer", asset.key().as_ref(), bidder.key().as_ref()], bump = offer.bump, has_one = asset)]
    pub offer: Account<'info, Offer>,
    #[account(mut, associated_token::mint = config.usdc_mint, associated_token::authority = offer)]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK:
    #[account(seeds = [b"market_auth"], bump)]
    pub market_auth: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"chip", asset.key().as_ref()], bump = chip.bump, seeds::program = chip_core::ID)]
    pub chip: Box<Account<'info, ChipState>>,
    #[account(seeds = [b"collection", &[chip.collection_idx]], bump = meta.bump, seeds::program = chip_core::ID)]
    pub meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = meta.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, seeds::program = chip_core::ID, has_one = treasury, has_one = buyback_wallet)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK:
    pub treasury: UncheckedAccount<'info>,
    /// CHECK:
    pub buyback_wallet: UncheckedAccount<'info>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = seller)]
    pub seller_usdc: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = treasury)]
    pub treasury_usdc: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyback_wallet)]
    pub buyback_usdc: Account<'info, TokenAccount>,
    pub chip_core: Program<'info, ChipCore>,
    /// CHECK:
    #[account(address = mpl_core::ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn accept_offer_handler(ctx: Context<AcceptOffer>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.offer;
    require!(now <= o.expires_at, MarketError::OfferExpired);
    let base = BaseAssetV1::from_bytes(&ctx.accounts.asset.try_borrow_data()?)
        .map_err(|_| error!(MarketError::NotOwner))?;
    require_keys_eq!(base.owner, ctx.accounts.seller.key(), MarketError::NotOwner);
    require!(
        ctx.accounts.chip.flags & ChipState::F_LISTED == 0,
        MarketError::ChipLocked
    );
    require!(
        now >= ctx.accounts.chip.lock_until
            && ctx.accounts.chip.flags & ChipState::F_SOULBOUND == 0,
        MarketError::ChipLocked
    );

    let price = o.amount_usdc;
    let (to_seller, fee_bb, fee_tr, royalty) = split(price, ctx.accounts.config.market_fee_bps)?;
    let (asset, bidder, bump) = (o.asset, o.bidder, o.bump);
    let seeds: &[&[u8]] = &[b"offer", asset.as_ref(), bidder.as_ref(), &[bump]];
    let tp = ctx.accounts.token_program.to_account_info();
    let legs = [
        (ctx.accounts.seller_usdc.to_account_info(), to_seller),
        (ctx.accounts.buyback_usdc.to_account_info(), fee_bb),
        (
            ctx.accounts.treasury_usdc.to_account_info(),
            fee_tr + royalty,
        ),
    ];
    for (to, amt) in legs {
        if amt > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    tp.clone(),
                    token::Transfer {
                        from: ctx.accounts.escrow.to_account_info(),
                        to,
                        authority: o.to_account_info(),
                    },
                    &[seeds],
                ),
                amt,
            )?;
        }
    }
    token::close_account(CpiContext::new_with_signer(
        tp.clone(),
        token::CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.bidder.to_account_info(),
            authority: o.to_account_info(),
        },
        &[seeds],
    ))?;

    // flag LISTED then deliver (both via market_auth).
    //
    // This used to be a closure (`let fa = |payer| FlagAccounts { … }`) shared with the deliver path, and it
    // could not be made to typecheck: `FlagAccounts<'a, 'info>` holds `&'a AccountInfo<'info>` for every
    // field, so `&ctx.accounts.config.to_account_info()` is a reference to a temporary (E0515), and even
    // hoisting the handles into the closure body only trades that for E0597 — a binding inside the closure is
    // still not the `'a` the returned struct needs. A closure cannot name the environment lifetime its
    // return value borrows from, which is the whole reason the second error existed.
    //
    // It had exactly one call site, so the honest shape is the plain literal: handles hoisted to the
    // function body, one borrow each, no lifetime to infer. (If a second caller ever needs it, the reusable
    // form is a `fn` taking `&Context<'_, '_, 'info, 'info, …>` — not a closure.)
    let market_auth_ai = ctx.accounts.market_auth.to_account_info();
    let config_ai = ctx.accounts.config.to_account_info();
    let asset_ai = ctx.accounts.asset.to_account_info();
    let chip_ai = ctx.accounts.chip.to_account_info();
    let meta_ai = ctx.accounts.meta.to_account_info();
    let core_collection_ai = ctx.accounts.core_collection.to_account_info();
    let mpl_core_ai = ctx.accounts.mpl_core.to_account_info();
    let system_program_ai = ctx.accounts.system_program.to_account_info();
    let seller_ai = ctx.accounts.seller.to_account_info();
    set_listed(
        FlagAccounts {
            chip_core: &ctx.accounts.chip_core,
            market_auth: &market_auth_ai,
            payer: &seller_ai,
            config: &config_ai,
            asset: &asset_ai,
            chip: &chip_ai,
            meta: &meta_ai,
            core_collection: &core_collection_ai,
            mpl_core: &mpl_core_ai,
            system_program: &system_program_ai,
        },
        ctx.bumps.market_auth,
        true,
        ctx.accounts.seller.key(),
    )?;
    let ma_seeds: &[&[u8]] = &[b"market_auth", &[ctx.bumps.market_auth]];
    chip_core::cpi::deliver_sold(
        CpiContext::new_with_signer(
            ctx.accounts.chip_core.to_account_info(),
            DeliverSold {
                caller: ctx.accounts.market_auth.to_account_info(),
                payer: ctx.accounts.seller.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                asset: ctx.accounts.asset.to_account_info(),
                chip: ctx.accounts.chip.to_account_info(),
                meta: ctx.accounts.meta.to_account_info(),
                core_collection: ctx.accounts.core_collection.to_account_info(),
                new_owner: ctx.accounts.bidder.to_account_info(),
                mpl_core: ctx.accounts.mpl_core.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[ma_seeds],
        ),
        ctx.accounts.seller.key(),
    )?;
    emit!(ChipSold {
        asset,
        seller: ctx.accounts.seller.key(),
        buyer: bidder,
        price,
        currency: Currency::Usdc.code(),
        fee: fee_bb + fee_tr,
        royalty,
        via_offer: true
    });
    Ok(())
}

// ---------------------------------------------------------------------------

#[program]
pub mod market {
    use super::*;
    pub fn list(ctx: Context<List>, price: u64, currency: u8) -> Result<()> {
        list_handler(ctx, price, currency)
    }
    pub fn update_price(ctx: Context<UpdatePrice>, price: u64) -> Result<()> {
        update_price_handler(ctx, price)
    }
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        cancel_handler(ctx)
    }
    pub fn buy(ctx: Context<Buy>, expected_price: u64, expected_currency: u8) -> Result<()> {
        buy_handler(ctx, expected_price, expected_currency)
    }
    pub fn make_offer(ctx: Context<MakeOffer>, amount: u64, ttl_secs: i64) -> Result<()> {
        make_offer_handler(ctx, amount, ttl_secs)
    }
    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        cancel_offer_handler(ctx)
    }
    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        accept_offer_handler(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `fee_bps` is a GameConfig field, so `split` has no fee of its own: the vectors below are written at
    /// the value `initialize_config` installs (`chip_core::economy::DEFAULT_MARKET_FEE_BPS`), which is the
    /// state a freshly deployed market settles into. Numbers are derived from the three constants by hand —
    /// at price 10 000 the arithmetic is the definition: fee = 750 (bps over BPS), buyback = 750·3333/10 000
    /// = 249, treasury = 750-249 = 501, royalty = 250, seller = everything left = 9 000.
    #[test]
    fn split_sums_to_price() {
        for p in [1_000_000u64, 12_345_678, u32::MAX as u64, 1] {
            let (s, b, t, r) = split(p, chip_core::economy::DEFAULT_MARKET_FEE_BPS).unwrap();
            assert_eq!(s + b + t + r, p);
            assert!(b <= t);
        }
        let (s, b, t, r) = split(10_000, chip_core::economy::DEFAULT_MARKET_FEE_BPS).unwrap();
        assert_eq!((s, b, t, r), (9_000, 249, 501, 250));
    }

    /// The clamp is the only thing between an owner's typo in `set_config` and a market that takes half of
    /// every sale, and it lives in `split` rather than in the admin handler — so it needs its own test, at a
    /// requested fee above `MAX_MARKET_FEE_BPS` where the sum invariant would still hold if the clamp were
    /// deleted (that is what makes `b + t == 1 000` the assertion instead of `s + b + t + r == p`).
    #[test]
    fn split_clamps_a_fee_above_the_cap() {
        let (s, b, t, r) = split(10_000, 5_000).unwrap();
        assert_eq!((s, b, t, r), (8_750, 333, 667, 250));
        assert_eq!(b + t, chip_core::economy::MAX_MARKET_FEE_BPS as u64);
    }
}

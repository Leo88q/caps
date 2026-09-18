use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};
use crate::state::*;
use crate::errors::ChipGameError;

#[derive(Accounts)]
pub struct ListChip<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipGameError::GamePaused)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [b"chip", chip_mint.key().as_ref()],
        bump = chip_state.bump,
        constraint = !chip_state.staked @ ChipGameError::ChipIsStaked,
    )]
    pub chip_state: Account<'info, ChipState>,
    pub chip_mint: Account<'info, Mint>,

    #[account(mut)]
    pub seller_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = seller,
        associated_token::mint = chip_mint,
        associated_token::authority = listing,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = seller,
        space = Listing::SIZE,
        seeds = [b"listing", chip_mint.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// Feeds the "list a chip" weekly quest.
    #[account(
        mut,
        seeds = [b"quest_progress", seller.key().as_ref()],
        bump = quest_progress.bump,
    )]
    pub quest_progress: Account<'info, QuestProgress>,
}

pub fn list_chip(ctx: Context<ListChip>, price_lamports: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.seller_token_account.to_account_info(),
                to: ctx.accounts.escrow_token_account.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        1,
    )?;

    let listing = &mut ctx.accounts.listing;
    listing.seller = ctx.accounts.seller.key();
    listing.chip_mint = ctx.accounts.chip_mint.key();
    listing.price_lamports = price_lamports;
    listing.bump = ctx.bumps.listing;

    let now = Clock::get()?.unix_timestamp;
    let progress = &mut ctx.accounts.quest_progress;
    crate::instructions::quests::maybe_reset_windows(progress, now);
    progress.listings_weekly = progress.listings_weekly.saturating_add(1);

    Ok(())
}

#[derive(Accounts)]
pub struct BuyChip<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    /// CHECK: fee destination, validated against config.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        close = seller,
        seeds = [b"listing", chip_mint.key().as_ref()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, Listing>,

    /// CHECK: receives sale proceeds + gets listing account's rent back.
    #[account(mut, address = listing.seller)]
    pub seller: UncheckedAccount<'info>,

    pub chip_mint: Account<'info, Mint>,

    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = chip_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn buy_chip(ctx: Context<BuyChip>) -> Result<()> {
    let price = ctx.accounts.listing.price_lamports;
    let fee = price * ctx.accounts.config.marketplace_fee_bps as u64 / 10_000;
    let seller_proceeds = price - fee;

    invoke(
        &system_instruction::transfer(&ctx.accounts.buyer.key(), &ctx.accounts.seller.key(), seller_proceeds),
        &[ctx.accounts.buyer.to_account_info(), ctx.accounts.seller.to_account_info()],
    )?;
    invoke(
        &system_instruction::transfer(&ctx.accounts.buyer.key(), &ctx.accounts.treasury.key(), fee),
        &[ctx.accounts.buyer.to_account_info(), ctx.accounts.treasury.to_account_info()],
    )?;

    let chip_mint_key = ctx.accounts.chip_mint.key();
    let listing_seeds = &[b"listing", chip_mint_key.as_ref(), &[ctx.accounts.listing.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            &[listing_seeds],
        ),
        1,
    )?;

    emit!(ChipSold {
        chip_mint: chip_mint_key,
        seller: ctx.accounts.seller.key(),
        buyer: ctx.accounts.buyer.key(),
        price_lamports: price,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        close = seller,
        has_one = seller @ ChipGameError::NotSeller,
        seeds = [b"listing", chip_mint.key().as_ref()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, Listing>,

    pub chip_mint: Account<'info, Mint>,

    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
    let chip_mint_key = ctx.accounts.chip_mint.key();
    let listing_seeds = &[b"listing", chip_mint_key.as_ref(), &[ctx.accounts.listing.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.seller_token_account.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            &[listing_seeds],
        ),
        1,
    )?;
    Ok(())
}

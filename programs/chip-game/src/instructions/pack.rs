use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Mint, Token, TokenAccount, MintTo};
use switchboard_v2::{VrfAccountData, VrfRequestRandomness, OracleQueueAccountData, PermissionAccountData, SbState};
use mpl_token_metadata::instructions::{
    CreateMetadataAccountV3Cpi, CreateMetadataAccountV3CpiAccounts, CreateMetadataAccountV3InstructionArgs,
    UpdateMetadataAccountV2Cpi, UpdateMetadataAccountV2CpiAccounts, UpdateMetadataAccountV2InstructionArgs,
};
use mpl_token_metadata::types::DataV2;
use crate::state::*;
use crate::errors::ChipGameError;

/// Step 1: buyer pays for the pack and requests Switchboard VRF randomness.
/// The VRF account itself must already exist (created + funded by the
/// client in a prior transaction, per the standard Switchboard VRF setup) —
/// this instruction only triggers the request against it.
#[derive(Accounts)]
pub struct BuyPack<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipGameError::GamePaused)]
    pub config: Account<'info, GameConfig>,

    /// CHECK: validated against config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    pub collection: Account<'info, Collection>,

    /// CHECK: Switchboard VRF account, deserialized by the switchboard CPI call.
    #[account(mut)]
    pub vrf: AccountInfo<'info>,

    /// CHECK: Switchboard oracle queue this VRF account is assigned to.
    #[account(mut)]
    pub oracle_queue: AccountInfo<'info>,
    /// CHECK: PDA authority for the oracle queue.
    pub queue_authority: AccountInfo<'info>,
    /// CHECK: data buffer owned by the oracle queue.
    #[account(mut)]
    pub data_buffer: AccountInfo<'info>,
    /// CHECK: permission account authorizing this VRF account against the queue.
    #[account(mut)]
    pub permission: AccountInfo<'info>,
    /// CHECK: token account VRF request fees are paid from (wSOL).
    #[account(mut)]
    pub escrow: AccountInfo<'info>,
    /// CHECK: global Switchboard program state.
    pub program_state: AccountInfo<'info>,
    /// CHECK: Switchboard v2 program.
    pub switchboard_program: AccountInfo<'info>,
    /// CHECK: recent blockhashes sysvar, required by vrf_request_randomness.
    pub recent_blockhashes: AccountInfo<'info>,

    #[account(
        init,
        payer = buyer,
        space = PendingPackOpen::SIZE,
        seeds = [b"pending_pack", buyer.key().as_ref(), vrf.key().as_ref()],
        bump
    )]
    pub pending_pack: Account<'info, PendingPackOpen>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn buy_pack(ctx: Context<BuyPack>) -> Result<()> {
    let price = ctx.accounts.config.pack_price_lamports;

    invoke(
        &system_instruction::transfer(
            &ctx.accounts.buyer.key(),
            &ctx.accounts.treasury.key(),
            price,
        ),
        &[
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
        ],
    )?;

    // Kick off the actual off-chain randomness request. The oracle observes
    // this on-chain request, computes a verifiable random value, and writes
    // it back into `vrf` in a later, separate transaction — that's why
    // opening a pack is a two-step process (buy_pack, then open_pack).
    let vrf_request = VrfRequestRandomness {
        authority: ctx.accounts.config.to_account_info(),
        vrf: ctx.accounts.vrf.clone(),
        oracle_queue: ctx.accounts.oracle_queue.clone(),
        queue_authority: ctx.accounts.queue_authority.clone(),
        data_buffer: ctx.accounts.data_buffer.clone(),
        permission: ctx.accounts.permission.clone(),
        escrow: ctx.accounts.escrow.clone(),
        payer_wallet: ctx.accounts.escrow.clone(),
        payer_authority: ctx.accounts.buyer.to_account_info(),
        recent_blockhashes: ctx.accounts.recent_blockhashes.clone(),
        program_state: ctx.accounts.program_state.clone(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    let config_seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
    vrf_request.invoke_signed(ctx.accounts.switchboard_program.clone(), &[config_seeds])?;

    let pending = &mut ctx.accounts.pending_pack;
    pending.buyer = ctx.accounts.buyer.key();
    pending.collection = ctx.accounts.collection.key();
    pending.vrf_account = ctx.accounts.vrf.key();
    pending.fulfilled = false;
    pending.bump = ctx.bumps.pending_pack;
    Ok(())
}

/// Step 2: once the Switchboard oracle has written a result into the VRF
/// account, anyone can call this (permissionless) to consume it, roll the
/// rarity, mint the chip, create its metadata, and set up its ChipState PDA.
#[derive(Accounts)]
pub struct OpenPack<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pending_pack", pending_pack.buyer.as_ref(), pending_pack.vrf_account.as_ref()],
        bump = pending_pack.bump,
        constraint = !pending_pack.fulfilled @ ChipGameError::PackAlreadyOpened,
        constraint = pending_pack.vrf_account == vrf.key() @ ChipGameError::VrfAccountMismatch,
    )]
    pub pending_pack: Account<'info, PendingPackOpen>,

    /// CHECK: deserialized manually via VrfAccountData below.
    pub vrf: AccountInfo<'info>,

    #[account(mut)]
    pub collection: Account<'info, Collection>,

    #[account(
        init,
        payer = payer,
        mint::decimals = 0,
        mint::authority = collection,
    )]
    pub chip_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = chip_mint,
        associated_token::authority = buyer_token_account_owner,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// CHECK: the original pack buyer, who receives the minted chip.
    #[account(address = pending_pack.buyer)]
    pub buyer_token_account_owner: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = ChipState::SIZE,
        seeds = [b"chip", chip_mint.key().as_ref()],
        bump
    )]
    pub chip_state: Account<'info, ChipState>,

    /// CHECK: Metaplex metadata PDA for chip_mint, created via CPI below.
    #[account(mut)]
    pub metadata: AccountInfo<'info>,
    /// CHECK: Metaplex Token Metadata program.
    pub token_metadata_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// Quest progress for the pack's buyer — must already exist (created
    /// once via init_quest_progress) before opening a pack. Feeds the
    /// "open 3 packs" daily quest.
    #[account(
        mut,
        seeds = [b"quest_progress", buyer_token_account_owner.key().as_ref()],
        bump = quest_progress.bump,
    )]
    pub quest_progress: Account<'info, QuestProgress>,
}

pub fn open_pack(ctx: Context<OpenPack>, chip_name: String, chip_uri: String) -> Result<()> {
    let vrf_data = VrfAccountData::new(&ctx.accounts.vrf)
        .map_err(|_| error!(ChipGameError::VrfNotFulfilled))?;
    let result_buffer = vrf_data.get_result().map_err(|_| error!(ChipGameError::VrfNotFulfilled))?;
    require!(result_buffer != [0u8; 32], ChipGameError::VrfNotFulfilled);

    // Take the first two bytes of verified randomness, map into 0..10_000.
    let roll = (u16::from_le_bytes([result_buffer[0], result_buffer[1]])) % 10_000;
    let rarity = Rarity::from_roll(roll);

    let collection = &mut ctx.accounts.collection;
    collection.minted += 1;
    let index = collection.minted;

    let collection_seeds: &[&[u8]] = &[b"collection", collection.symbol.as_ref(), &[collection.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.chip_mint.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: collection.to_account_info(),
            },
            &[collection_seeds],
        ),
        1,
    )?;

    // Create the wallet-visible metadata (art + name). Mutable so a future
    // "reveal"-style update is possible, but chip GAME state never lives
    // here — it stays in ChipState so we never touch Metaplex at runtime.
    CreateMetadataAccountV3Cpi::new(
        &ctx.accounts.token_metadata_program,
        CreateMetadataAccountV3CpiAccounts {
            metadata: &ctx.accounts.metadata,
            mint: &ctx.accounts.chip_mint.to_account_info(),
            mint_authority: &collection.to_account_info(),
            payer: &ctx.accounts.payer.to_account_info(),
            update_authority: (&collection.to_account_info(), true),
            system_program: &ctx.accounts.system_program.to_account_info(),
            rent: Some(&ctx.accounts.rent.to_account_info()),
        },
        CreateMetadataAccountV3InstructionArgs {
            data: DataV2 {
                name: chip_name,
                symbol: String::from_utf8_lossy(&collection.symbol).trim_end_matches('\0').to_string(),
                uri: chip_uri,
                seller_fee_basis_points: 500, // secondary-sale royalty, tune per collection
                creators: None,
                collection: None,
                uses: None,
            },
            is_mutable: true,
            collection_details: None,
        },
    )
    .invoke_signed(&[collection_seeds])?;

    let chip_state = &mut ctx.accounts.chip_state;
    chip_state.mint = ctx.accounts.chip_mint.key();
    chip_state.collection = collection.key();
    chip_state.rarity = rarity;
    chip_state.level = 1;
    chip_state.xp = 0;
    chip_state.index = index;
    chip_state.staked = false;
    chip_state.stake_started_at = 0;
    chip_state.accrued_rewards = 0;
    chip_state.bump = ctx.bumps.chip_state;

    ctx.accounts.pending_pack.fulfilled = true;

    let now = Clock::get()?.unix_timestamp;
    let progress = &mut ctx.accounts.quest_progress;
    crate::instructions::quests::maybe_reset_windows(progress, now);
    progress.packs_opened_daily = progress.packs_opened_daily.saturating_add(1);

    emit!(PackOpened {
        buyer: ctx.accounts.buyer_token_account_owner.key(),
        chip_mint: ctx.accounts.chip_mint.key(),
        rarity,
        index,
    });
    Ok(())
}

/// The chip's REAL name (e.g. "Moth with a Briefcase") depends on which
/// collection it's from and which of the 9 rarity tiers the VRF roll
/// landed on inside open_pack — neither is known to the client until
/// *after* that transaction confirms, so open_pack necessarily mints with
/// a generic placeholder name/uri ("Sealed Cap"). This instruction lets
/// the chip's current owner immediately follow up: they read the
/// `PackOpened` event for the resolved rarity, look up the matching name
/// in their own lore catalog (client/src/lib/lore.ts mirrors the same 90
/// names as the marketing site's collection gallery), and push it here.
///
/// Trust note: this program does NOT validate that the supplied name
/// actually matches the chip's on-chain rarity — name/uri are display
/// metadata, not consensus-critical state (rarity, level, and everything
/// that affects game economy still lives in ChipState, untouched by this
/// call). A chip owner could theoretically call this with a mismatched or
/// blank name; the only person that cosmetically hurts is whoever's
/// holding or trying to sell that chip, which is a low enough stake to
/// leave unenforced rather than pull the full lore catalog on-chain.
#[derive(Accounts)]
pub struct RevealChipMetadata<'info> {
    pub owner: Signer<'info>,

    #[account(seeds = [b"chip", chip_mint.key().as_ref()], bump = chip_state.bump)]
    pub chip_state: Account<'info, ChipState>,
    pub chip_mint: Account<'info, Mint>,

    #[account(
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == chip_mint.key(),
        constraint = owner_token_account.amount == 1,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub collection: Account<'info, Collection>,

    /// CHECK: the chip's existing Metaplex metadata PDA, updated in place.
    #[account(mut)]
    pub metadata: AccountInfo<'info>,
    /// CHECK: Metaplex Token Metadata program.
    pub token_metadata_program: AccountInfo<'info>,
}

pub fn reveal_chip_metadata(ctx: Context<RevealChipMetadata>, chip_name: String, chip_uri: String) -> Result<()> {
    let collection_seeds: &[&[u8]] = &[b"collection", ctx.accounts.collection.symbol.as_ref(), &[ctx.accounts.collection.bump]];

    UpdateMetadataAccountV2Cpi::new(
        &ctx.accounts.token_metadata_program,
        UpdateMetadataAccountV2CpiAccounts {
            metadata: &ctx.accounts.metadata,
            update_authority: &ctx.accounts.collection.to_account_info(),
        },
        UpdateMetadataAccountV2InstructionArgs {
            data: Some(DataV2 {
                name: chip_name,
                symbol: String::from_utf8_lossy(&ctx.accounts.collection.symbol).trim_end_matches('\0').to_string(),
                uri: chip_uri,
                seller_fee_basis_points: 500,
                creators: None,
                collection: None,
                uses: None,
            }),
            new_update_authority: None,
            primary_sale_happened: None,
            is_mutable: Some(true),
        },
    )
    .invoke_signed(&[collection_seeds])?;

    Ok(())
}

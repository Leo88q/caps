//! Bubblegum V2 compressed-chip registration.
//!
//! Registration is deliberately proof-backed. DAS may supply transport data,
//! but only Account Compression's `verify_leaf` CPI can authorize creation of
//! a Core-owned game projection. The economically relevant roll is authorized
//! first by a one-time `CompressedMintClaim`; a cranker cannot choose rarity or
//! collection while submitting the proof.

use anchor_lang::prelude::*;
use mpl_bubblegum::{
    instructions::MintV2CpiBuilder,
    types::{Creator, MetadataArgsV2, TokenStandard},
};
use mpl_core::ID as MPL_CORE_ID;

use crate::{
    bubblegum::{
        leaf_asset_id, mpl_core_cpi_signer, require_bubblegum_program, tree_config_pda,
        verify_v2_leaf, LeafProofArgs, MPL_ACCOUNT_COMPRESSION_ID, MPL_NOOP_ID,
    },
    economy::Rarity,
    errors::ChipError,
    state::{
        BubblegumTreeMeta, CollectionMeta, CompressedChipState, CompressedMintClaim, GameConfig,
    },
    BUBBLEGUM_V2_ID,
};

#[derive(Accounts)]
#[instruction(buyer: Pubkey, collection_idx: u8, claim_nonce: u64)]
pub struct StageCompressedChip<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        seeds = [b"collection".as_ref(), &[collection_idx][..]],
        bump = collection.bump,
        constraint = collection.idx == collection_idx @ ChipError::InvalidCollection,
    )]
    pub collection: Box<Account<'info, CollectionMeta>>,
    #[account(
        seeds = [b"bubblegum_tree", &[collection_idx]],
        bump = tree_meta.bump,
        constraint = tree_meta.active @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.collection_idx == collection_idx @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.core_collection == collection.core_collection @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.tree_authority == collection.key() @ ChipError::InvalidBubblegumTree,
    )]
    pub tree_meta: Box<Account<'info, BubblegumTreeMeta>>,
    #[account(
        init,
        payer = admin,
        space = 8 + CompressedMintClaim::INIT_SPACE,
        seeds = [b"compressed_claim", buyer.as_ref(), &claim_nonce.to_le_bytes()],
        bump,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    /// CHECK: the buyer is bound into the claim PDA and the later registration.
    #[account(address = buyer)]
    pub buyer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Authorize one expected economic result before the Bubblegum mint and DAS
/// indexing steps. This is currently admin-called; integrating it directly
/// into `open_pack` is the next migration step, so no release should treat
/// this staging entrypoint as a replacement for the old Core pipeline yet.
pub fn stage_compressed_chip(
    ctx: Context<StageCompressedChip>,
    buyer: Pubkey,
    collection_idx: u8,
    claim_nonce: u64,
    rarity: u8,
    level: u8,
    game_index: u64,
    expires_at: i64,
) -> Result<()> {
    let rarity = Rarity::from_index(rarity).ok_or(error!(ChipError::InvalidCollection))?;
    require!(
        level >= 1 && level <= rarity.max_level(),
        ChipError::InvalidChipState
    );
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, ChipError::InvalidBubblegumProof);
    require!(
        expires_at <= now.checked_add(7 * 86_400).ok_or(ChipError::Overflow)?,
        ChipError::InvalidBubblegumProof
    );

    let claim = &mut ctx.accounts.claim;
    claim.buyer = buyer;
    claim.collection_idx = collection_idx;
    claim.rarity = rarity;
    claim.level = level;
    claim.game_index = game_index;
    claim.expires_at = expires_at;
    claim.minted = false;
    claim.bump = ctx.bumps.claim;
    Ok(())
}

#[derive(Accounts)]
#[instruction(buyer: Pubkey, collection_idx: u8, claim_nonce: u64)]
pub struct MintCompressedChip<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        seeds = [b"collection".as_ref(), &[collection_idx][..]],
        bump = collection.bump,
        constraint = collection.idx == collection_idx @ ChipError::InvalidCollection,
    )]
    pub collection: Box<Account<'info, CollectionMeta>>,
    #[account(
        seeds = [b"bubblegum_tree", &[collection_idx]],
        bump = tree_meta.bump,
        constraint = tree_meta.active @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.collection_idx == collection_idx @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.core_collection == collection.core_collection @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.tree_authority == collection.key() @ ChipError::InvalidBubblegumTree,
    )]
    pub tree_meta: Box<Account<'info, BubblegumTreeMeta>>,
    #[account(
        mut,
        seeds = [b"compressed_claim", buyer.as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::InvalidBubblegumProof,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    /// CHECK: the leaf owner is the buyer bound into the claim.
    #[account(address = buyer)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: Bubblegum TreeConfigV2 PDA.
    #[account(mut, address = tree_meta.tree_config)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: Bubblegum V2 Merkle tree.
    #[account(mut, address = tree_meta.merkle_tree)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: configured tree creator/delegate. The deployment binding requires
    /// this to be the collection PDA, which signs through `invoke_signed`.
    #[account(address = tree_meta.tree_authority)]
    pub tree_authority: UncheckedAccount<'info>,
    /// CHECK: MPL-Core collection account.
    #[account(mut, address = collection.core_collection)]
    pub core_collection: UncheckedAccount<'info>,
    /// CHECK: Bubblegum's `collection_cpi` signer PDA.
    #[account(address = mpl_core_cpi_signer())]
    pub mpl_core_cpi_signer: UncheckedAccount<'info>,
    /// CHECK: fixed Bubblegum program.
    #[account(address = BUBBLEGUM_V2_ID)]
    pub bubblegum_program: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Noop log wrapper.
    #[account(address = MPL_NOOP_ID)]
    pub log_wrapper: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Account Compression program.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Core program.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn mint_compressed_chip(
    ctx: Context<MintCompressedChip>,
    buyer: Pubkey,
    collection_idx: u8,
    claim_nonce: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, ChipError::Paused);
    require_bubblegum_program(&ctx.accounts.bubblegum_program.to_account_info())?;
    require!(
        ctx.accounts.bubblegum_program.to_account_info().executable,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        ctx.accounts.tree_meta.tree_config,
        tree_config_pda(&ctx.accounts.tree_meta.merkle_tree),
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.tree_config.to_account_info().owner,
        BUBBLEGUM_V2_ID,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.merkle_tree.to_account_info().owner,
        MPL_ACCOUNT_COMPRESSION_ID,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.core_collection.to_account_info().owner,
        MPL_CORE_ID,
        ChipError::InvalidCollection
    );
    require!(!ctx.accounts.claim.minted, ChipError::InvalidBubblegumProof);
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.claim.expires_at,
        ChipError::InvalidBubblegumProof
    );
    require!(
        ctx.accounts.claim.collection_idx == collection_idx,
        ChipError::InvalidBubblegumProof
    );
    // The collection PDA is both the Bubblegum tree delegate and the MPL-Core
    // collection update authority. This gives the CPI one auditable signer
    // policy instead of accepting an arbitrary tree delegate account.
    require_keys_eq!(
        ctx.accounts.tree_meta.tree_authority,
        ctx.accounts.collection.key(),
        ChipError::InvalidBubblegumTree
    );

    let rarity = ctx.accounts.claim.rarity.index();
    let name = format!(
        "{} #{}",
        ctx.accounts.collection.symbol, ctx.accounts.claim.game_index
    );
    let uri = format!(
        "https://cdn.guttercaps.gg/m/{}/{}.json",
        collection_idx, rarity
    );
    let metadata = MetadataArgsV2 {
        name,
        symbol: ctx.accounts.collection.symbol.clone(),
        uri,
        seller_fee_basis_points: crate::economy::ROYALTY_BPS,
        primary_sale_happened: false,
        is_mutable: false,
        token_standard: Some(TokenStandard::NonFungible),
        creators: vec![Creator {
            address: ctx.accounts.collection.key(),
            verified: true,
            share: 100,
        }],
        collection: Some(ctx.accounts.collection.core_collection),
    };
    let collection_seeds: &[&[u8]] = &[
        b"collection",
        &[ctx.accounts.collection.idx],
        &[ctx.accounts.collection.bump],
    ];

    MintV2CpiBuilder::new(&ctx.accounts.bubblegum_program.to_account_info())
        .tree_config(&ctx.accounts.tree_config.to_account_info())
        .payer(&ctx.accounts.payer.to_account_info())
        .tree_creator_or_delegate(Some(&ctx.accounts.tree_authority.to_account_info()))
        .collection_authority(Some(&ctx.accounts.collection.to_account_info()))
        .leaf_owner(&ctx.accounts.buyer.to_account_info())
        .leaf_delegate(Some(&ctx.accounts.buyer.to_account_info()))
        .merkle_tree(&ctx.accounts.merkle_tree.to_account_info())
        .core_collection(Some(&ctx.accounts.core_collection.to_account_info()))
        .mpl_core_cpi_signer(Some(&ctx.accounts.mpl_core_cpi_signer.to_account_info()))
        .log_wrapper(&ctx.accounts.log_wrapper.to_account_info())
        .compression_program(&ctx.accounts.compression_program.to_account_info())
        .mpl_core_program(&ctx.accounts.mpl_core_program.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .metadata(metadata)
        .invoke_signed(&[collection_seeds])?;

    ctx.accounts.claim.minted = true;
    emit!(CompressedChipMinted {
        buyer,
        collection_idx,
        claim_nonce,
        rarity,
        level: ctx.accounts.claim.level,
        game_index: ctx.accounts.claim.game_index,
    });
    Ok(())
}

#[event]
pub struct CompressedChipMinted {
    pub buyer: Pubkey,
    pub collection_idx: u8,
    pub claim_nonce: u64,
    pub rarity: u8,
    pub level: u8,
    pub game_index: u64,
}

#[derive(Accounts)]
#[instruction(asset_id: Pubkey, collection_idx: u8, owner: Pubkey, delegate: Pubkey, buyer: Pubkey, claim_nonce: u64)]
pub struct RegisterCompressedChip<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        seeds = [b"collection".as_ref(), &[collection_idx][..]],
        bump = collection.bump,
        constraint = collection.idx == collection_idx @ ChipError::InvalidCollection,
    )]
    pub collection: Box<Account<'info, CollectionMeta>>,
    #[account(
        seeds = [b"bubblegum_tree", &[collection_idx]],
        bump = tree_meta.bump,
        constraint = tree_meta.active @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.collection_idx == collection_idx @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.core_collection == collection.core_collection @ ChipError::InvalidBubblegumTree,
        constraint = tree_meta.tree_authority == collection.key() @ ChipError::InvalidBubblegumTree,
    )]
    pub tree_meta: Box<Account<'info, BubblegumTreeMeta>>,
    #[account(
        mut,
        close = payer,
        seeds = [b"compressed_claim", buyer.as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::InvalidBubblegumProof,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    /// CHECK: claim.buyer is the expected leaf owner.
    #[account(address = buyer)]
    pub buyer: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + CompressedChipState::INIT_SPACE,
        seeds = [b"compressed_chip", asset_id.as_ref()],
        bump,
    )]
    pub chip: Box<Account<'info, CompressedChipState>>,
    /// CHECK: the expected Bubblegum leaf asset PDA; it need not be initialized.
    #[account(address = asset_id)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: authenticated by the V2 leaf hash and Account Compression proof.
    #[account(address = owner)]
    pub leaf_owner: UncheckedAccount<'info>,
    /// CHECK: authenticated by the V2 leaf hash.
    #[account(address = delegate)]
    pub leaf_delegate: UncheckedAccount<'info>,
    /// CHECK: Bubblegum tree account; owner is checked before CPI.
    #[account(address = tree_meta.merkle_tree)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: Bubblegum-owned TreeConfigV2 binding.
    #[account(address = tree_meta.tree_config)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: fixed Bubblegum program account.
    #[account(address = BUBBLEGUM_V2_ID)]
    pub bubblegum_program: UncheckedAccount<'info>,
    /// CHECK: fixed MPL Account Compression program.
    #[account(address = MPL_ACCOUNT_COMPRESSION_ID)]
    pub compression_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn register_compressed_chip(
    ctx: Context<RegisterCompressedChip>,
    asset_id: Pubkey,
    collection_idx: u8,
    owner: Pubkey,
    delegate: Pubkey,
    buyer: Pubkey,
    claim_nonce: u64,
    proof: LeafProofArgs,
    rarity: u8,
    level: u8,
    game_index: u64,
) -> Result<()> {
    require_bubblegum_program(&ctx.accounts.bubblegum_program.to_account_info())?;
    require!(
        ctx.accounts.bubblegum_program.to_account_info().executable,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        *ctx.accounts.tree_config.to_account_info().owner,
        BUBBLEGUM_V2_ID,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        ctx.accounts.config.key(),
        Pubkey::find_program_address(&[b"config"], &crate::ID).0,
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(owner, buyer, ChipError::InvalidBubblegumProof);
    require_keys_eq!(delegate, owner, ChipError::InvalidBubblegumProof);
    let rarity = Rarity::from_index(rarity).ok_or(error!(ChipError::InvalidCollection))?;
    require!(
        ctx.accounts.claim.minted
            && ctx.accounts.claim.buyer == buyer
            && ctx.accounts.claim.collection_idx == collection_idx
            && ctx.accounts.claim.rarity == rarity
            && ctx.accounts.claim.level == level
            && ctx.accounts.claim.game_index == game_index,
        ChipError::InvalidBubblegumProof
    );
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.claim.expires_at,
        ChipError::InvalidBubblegumProof
    );
    require_keys_eq!(
        ctx.accounts.tree_meta.tree_config,
        tree_config_pda(&ctx.accounts.tree_meta.merkle_tree),
        ChipError::InvalidBubblegumTree
    );
    require_keys_eq!(
        asset_id,
        leaf_asset_id(&ctx.accounts.tree_meta.merkle_tree, proof.index),
        ChipError::InvalidBubblegumProof
    );
    require!(
        proof.collection_hash
            == mpl_bubblegum::hash::hash_collection_option(Some(
                ctx.accounts.collection.core_collection
            ))?,
        ChipError::InvalidBubblegumProof
    );
    require!(
        proof.index < (1u32 << ctx.accounts.tree_meta.max_depth),
        ChipError::InvalidBubblegumProof
    );
    require!(
        ctx.remaining_accounts.len() <= ctx.accounts.tree_meta.max_depth as usize,
        ChipError::InvalidBubblegumProof
    );

    // The proof CPI is the authority boundary. Do not create the state account
    // from DAS JSON or from the caller's claimed owner/metadata alone.
    verify_v2_leaf(
        &ctx.accounts.compression_program.to_account_info(),
        &ctx.accounts.merkle_tree.to_account_info(),
        asset_id,
        owner,
        delegate,
        &proof,
        ctx.remaining_accounts,
    )?;

    let rarity_index = rarity.index() as usize;
    ctx.accounts.collection.minted = ctx
        .accounts
        .collection
        .minted
        .checked_add(1)
        .ok_or(ChipError::Overflow)?;
    ctx.accounts.collection.minted_by_rarity[rarity_index] =
        ctx.accounts.collection.minted_by_rarity[rarity_index]
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;

    let now = Clock::get()?.unix_timestamp;
    let chip = &mut ctx.accounts.chip;
    chip.asset = asset_id;
    chip.collection_idx = collection_idx;
    chip.merkle_tree = ctx.accounts.tree_meta.merkle_tree;
    chip.leaf_index = proof.index;
    chip.leaf_nonce = proof.nonce;
    chip.data_hash = proof.data_hash;
    chip.creator_hash = proof.creator_hash;
    chip.collection_hash = proof.collection_hash;
    chip.asset_data_hash = proof.asset_data_hash;
    chip.leaf_flags = proof.flags;
    chip.rarity = rarity;
    chip.level = level;
    chip.index = game_index;
    chip.flags = if proof.flags & 0b1000 != 0 {
        CompressedChipState::F_SOULBOUND
    } else {
        0
    };
    chip.lock_until = 0;
    chip.minted_at = now;
    chip.bump = ctx.bumps.chip;

    emit!(CompressedChipRegistered {
        asset: asset_id,
        collection_idx,
        merkle_tree: chip.merkle_tree,
        leaf_index: proof.index,
        leaf_nonce: proof.nonce,
        owner,
        delegate,
        rarity: rarity.index(),
        level,
        game_index,
        flags: chip.flags,
    });
    Ok(())
}

#[event]
pub struct CompressedChipRegistered {
    pub asset: Pubkey,
    pub collection_idx: u8,
    pub merkle_tree: Pubkey,
    pub leaf_index: u32,
    pub leaf_nonce: u64,
    pub owner: Pubkey,
    pub delegate: Pubkey,
    pub rarity: u8,
    pub level: u8,
    pub game_index: u64,
    pub flags: u8,
}

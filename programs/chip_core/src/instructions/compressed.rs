//! Bubblegum V2 compressed-chip registration.
//!
//! Registration is deliberately proof-backed. DAS may supply transport data,
//! but only Account Compression's `verify_leaf` CPI can authorize creation of
//! a Core-owned game projection. The economically relevant roll is authorized
//! first by a one-time `CompressedMintClaim`; a cranker cannot choose rarity or
//! collection while submitting the proof.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use mpl_bubblegum::{
    hash::{hash_asset_data_option, hash_creators, hash_metadata},
    instructions::MintV2CpiBuilder,
    types::{Creator, MetadataArgsV2, TokenStandard},
};
use mpl_core::ID as MPL_CORE_ID;

use crate::{
    bubblegum::{
        leaf_asset_id, require_bubblegum_program, tree_config_pda,
        verify_v2_leaf, LeafProofArgs, MPL_ACCOUNT_COMPRESSION_ID, MPL_NOOP_ID,
    },
    economy::{
        expand, PackDef, Rarity, BPS_DENOM, CG_PACK_BURN_BPS, MAX_CHIPS_PER_PACK,
    },
    errors::ChipError,
    randomness,
    state::{
        BubblegumTreeMeta, CollectionMeta, CompressedChipState, CompressedMintClaim,
        CompressedPackProgress, GameConfig, PendingPack, PlayerPity, VaultLedger,
    },
    BUBBLEGUM_V2_ID,
};

#[derive(Accounts)]
#[instruction(buyer: Pubkey, collection_idx: u8, claim_nonce: u64)]
pub struct StageCompressedChip<'info> {
    #[account(mut)]
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
pub const COMPRESSED_CLAIM_STRIDE: u64 = 32;
/// A buy with no staged claim at all must not remain escrowed forever if the
/// first staging transaction can never be submitted. Slots are intentionally
/// conservative (~7 days at normal Solana slot time); this is a timeout, not a
/// randomness-selection path.
pub const COMPRESSED_PACK_TIMEOUT_SLOTS: u64 = 1_600_000;

fn pack_claim_nonce(pending_nonce: u64, pack_no: u8, chip_no: u8) -> Result<u64> {
    pending_nonce
        .checked_mul(COMPRESSED_CLAIM_STRIDE)
        .and_then(|v| v.checked_add(pack_no as u64))
        .and_then(|v| v.checked_mul(COMPRESSED_CLAIM_STRIDE))
        .and_then(|v| v.checked_add(chip_no as u64))
        .ok_or(ChipError::Overflow.into())
}

fn chip_metadata(
    collection: &CollectionMeta,
    collection_key: Pubkey,
    collection_idx: u8,
    rarity: Rarity,
    game_index: u64,
) -> MetadataArgsV2 {
    MetadataArgsV2 {
        name: format!("{} #{}", collection.symbol, game_index),
        symbol: collection.symbol.clone(),
        uri: format!(
            "https://cdn.guttercaps.gg/m/{}/{}.json",
            collection_idx,
            rarity.index()
        ),
        seller_fee_basis_points: crate::economy::ROYALTY_BPS,
        primary_sale_happened: false,
        is_mutable: false,
        token_standard: Some(TokenStandard::NonFungible),
        creators: vec![Creator {
            address: collection_key,
            verified: true,
            share: 100,
        }],
        collection: Some(collection.core_collection),
    }
}

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
    claim.progress = Pubkey::default();
    Ok(())
}

#[derive(Accounts)]
#[instruction(nonce: u64, pack_no: u8, chip_no: u8, claim_nonce: u64, collection_idx: u8)]
pub struct StageCompressedChipFromPack<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        seeds = [b"pending", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump = pending.bump,
        constraint = pending.randomness == randomness.key() @ ChipError::RandomnessMismatch,
        constraint = pending.buyer == buyer.key() @ ChipError::Unauthorized,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    /// CHECK: parsed and authenticated as the pending pack's program-owned randomness account.
    #[account(mut, owner = randomness::SB_PROGRAM_ID @ ChipError::RandomnessMismatch)]
    pub randomness: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"pity", buyer.key().as_ref()], bump = pity.bump)]
    pub pity: Box<Account<'info, PlayerPity>>,
    /// CHECK: pending buyer, bound to the claim and randomness PDA.
    #[account(address = pending.buyer)]
    pub buyer: UncheckedAccount<'info>,
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
        init_if_needed,
        payer = payer,
        space = 8 + CompressedPackProgress::INIT_SPACE,
        seeds = [b"compressed_progress", pending.key().as_ref()],
        bump,
    )]
    pub progress: Box<Account<'info, CompressedPackProgress>>,
    #[account(
        init,
        payer = payer,
        space = 8 + CompressedMintClaim::INIT_SPACE,
        seeds = [b"compressed_claim", buyer.key().as_ref(), &claim_nonce.to_le_bytes()],
        bump,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    pub system_program: Program<'info, System>,
}

/// Stage one deterministic result from a paid pending pack. This instruction
/// never settles payment: every claim must be minted through Bubblegum and
/// registered from DAS before `finalize_compressed_pack` can release the
/// purchase liability. A cranker can retry failed transactions, but cannot
/// choose the roll, collection, rarity, or game index.
pub fn stage_compressed_chip_from_pack(
    ctx: Context<StageCompressedChipFromPack>,
    nonce: u64,
    pack_no: u8,
    chip_no: u8,
    claim_nonce: u64,
    collection_idx: u8,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, ChipError::Paused);
    let pending = &mut ctx.accounts.pending;
    require!(pack_no == pending.opened, ChipError::InvalidQuantity);
    require!(pack_no < pending.qty, ChipError::InvalidQuantity);
    let expected_claim_nonce = pack_claim_nonce(pending.nonce, pack_no, chip_no)?;
    require!(claim_nonce == expected_claim_nonce, ChipError::InvalidBubblegumProof);

    let def = if pending.voucher {
        PackDef::voucher(pending.voucher_odds)
    } else {
        require!((pending.sku as usize) < ctx.accounts.config.packs.len(), ChipError::InvalidSku);
        ctx.accounts.config.packs[pending.sku as usize]
    };
    let chips = def.chips as usize;
    require!(chips > 0 && chips <= MAX_CHIPS_PER_PACK, ChipError::InvalidQuantity);
    require!((chip_no as usize) < chips, ChipError::InvalidQuantity);

    let progress = &mut ctx.accounts.progress;
    if progress.pending == Pubkey::default() {
        progress.pending = pending.key();
        progress.buyer = pending.buyer;
        progress.expected_claims = (pending.qty as u16)
            .checked_mul(chips as u16)
            .ok_or(ChipError::Overflow)?;
        progress.staged_claims = 0;
        progress.minted_claims = 0;
        progress.registered_claims = 0;
        progress.pack_no = pack_no;
        progress.next_chip = 0;
        progress.pity_before = ctx.accounts.pity.counters[pending.sku as usize];
        progress.got_pity_tier = false;
        progress.bump = ctx.bumps.progress;
    }
    require_keys_eq!(progress.pending, pending.key(), ChipError::InvalidBubblegumProof);
    require_keys_eq!(progress.buyer, pending.buyer, ChipError::InvalidBubblegumProof);
    require!(progress.pack_no == pack_no, ChipError::InvalidQuantity);
    require!(progress.next_chip == chip_no, ChipError::InvalidQuantity);

    let base = if pending.revealed {
        pending.value
    } else {
        let rnd = randomness::parse_checked(&ctx.accounts.randomness.to_account_info())?;
        let value = randomness::revealed_value(&rnd, pending.commit_slot)?;
        pending.value = value;
        pending.revealed = true;
        value
    };
    let bytes = if pending.qty == 1 {
        base
    } else {
        anchor_lang::solana_program::keccak::hashv(&[&base, &[pack_no]]).to_bytes()
    };
    let pool: Vec<u8> = if def.featured_only {
        vec![ctx.accounts.config.featured_collection]
    } else {
        (0..ctx.accounts.config.collections_created).collect()
    };
    require!(!pool.is_empty(), ChipError::InvalidCollection);
    let rolled = expand(&bytes, &def, progress.pity_before, &pool);
    let result = rolled[chip_no as usize].ok_or(ChipError::InvalidQuantity)?;
    require!(result.collection_idx == collection_idx, ChipError::InvalidCollection);
    let rarity_index = result.rarity.index();
    require!(
        ctx.accounts.collection.idx == result.collection_idx,
        ChipError::InvalidCollection
    );

    let now = Clock::get()?.unix_timestamp;
    let expires_at = now.checked_add(7 * 86_400).ok_or(ChipError::Overflow)?;
    let game_index = ctx.accounts.collection.minted;
    ctx.accounts.collection.minted = ctx
        .accounts
        .collection
        .minted
        .checked_add(1)
        .ok_or(ChipError::Overflow)?;
    ctx.accounts.collection.minted_by_rarity[rarity_index as usize] = ctx.accounts.collection.minted_by_rarity[rarity_index as usize]
        .checked_add(1)
        .ok_or(ChipError::Overflow)?;

    let claim = &mut ctx.accounts.claim;
    claim.buyer = pending.buyer;
    claim.collection_idx = result.collection_idx;
    claim.rarity = result.rarity;
    claim.level = 1;
    claim.game_index = game_index;
    claim.expires_at = expires_at;
    claim.minted = false;
    claim.bump = ctx.bumps.claim;
    claim.progress = progress.key();

    progress.staged_claims = progress.staged_claims.checked_add(1).ok_or(ChipError::Overflow)?;
    progress.got_pity_tier |= def.pity_tier > 0 && rarity_index >= def.pity_tier;
    progress.next_chip = progress.next_chip.checked_add(1).ok_or(ChipError::Overflow)?;
    if progress.next_chip == chips as u8 {
        pending.opened = pending.opened.checked_add(1).ok_or(ChipError::Overflow)?;
        if def.pity_tier > 0 {
            let pity_after = if progress.got_pity_tier {
                0
            } else {
                progress.pity_before.saturating_add(1)
            };
            ctx.accounts.pity.counters[pending.sku as usize] = pity_after;
            // The next pack in a bundle must roll against the updated pity
            // counter, not the snapshot taken for pack zero.
            progress.pity_before = pity_after;
        }
        progress.pack_no = pending.opened;
        progress.next_chip = 0;
        progress.got_pity_tier = false;
    }

    emit!(CompressedChipClaimStaged {
        pending: pending.key(),
        claim: claim.key(),
        buyer: pending.buyer,
        claim_nonce,
        pack_no,
        chip_no,
        collection_idx: result.collection_idx,
        rarity: rarity_index,
        game_index,
    });
    Ok(())
}

#[event]
pub struct CompressedChipClaimStaged {
    pub pending: Pubkey,
    pub claim: Pubkey,
    pub buyer: Pubkey,
    pub claim_nonce: u64,
    pub pack_no: u8,
    pub chip_no: u8,
    pub collection_idx: u8,
    pub rarity: u8,
    pub game_index: u64,
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
    /// Optional progress tracker for claims produced by the asynchronous pack path.
    #[account(mut)]
    pub progress: Option<Account<'info, CompressedPackProgress>>,
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
    let claim_progress = ctx.accounts.claim.progress;
    if claim_progress == Pubkey::default() {
        require!(
            ctx.accounts.progress.is_none(),
            ChipError::InvalidBubblegumProof
        );
        require!(
            Clock::get()?.unix_timestamp <= ctx.accounts.claim.expires_at,
            ChipError::InvalidBubblegumProof
        );
    } else {
        let progress = ctx
            .accounts
            .progress
            .as_ref()
            .ok_or(error!(ChipError::InvalidBubblegumProof))?;
        require_keys_eq!(
            progress.key(),
            claim_progress,
            ChipError::InvalidBubblegumProof
        );
    }
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

    let rarity_value = ctx.accounts.claim.rarity;
    let rarity = rarity_value.index();
    let metadata = chip_metadata(
        &ctx.accounts.collection,
        ctx.accounts.collection.key(),
        collection_idx,
        rarity_value,
        ctx.accounts.claim.game_index,
    );
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
    if claim_progress != Pubkey::default() {
        let progress = ctx
            .accounts
            .progress
            .as_mut()
            .ok_or(error!(ChipError::InvalidBubblegumProof))?;
        progress.minted_claims = progress
            .minted_claims
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        require!(
            progress.minted_claims <= progress.staged_claims,
            ChipError::InvalidBubblegumProof
        );
    }
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
    /// Optional progress tracker for claims produced by the asynchronous pack path.
    #[account(mut)]
    pub progress: Option<Account<'info, CompressedPackProgress>>,
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
    // A proof for any buyer-owned leaf is not sufficient: it must be the exact
    // immutable metadata emitted by `mint_compressed_chip` for this claim.
    // Without these checks a caller could consume a claim with a separately
    // minted leaf that merely reuses the same owner/collection/game fields.
    let expected_metadata = chip_metadata(
        &ctx.accounts.collection,
        ctx.accounts.collection.key(),
        collection_idx,
        rarity,
        ctx.accounts.claim.game_index,
    );
    require!(
        proof.data_hash == hash_metadata(&expected_metadata)
            .map_err(|_| error!(ChipError::InvalidBubblegumProof))?
            && proof.creator_hash == hash_creators(&expected_metadata.creators)
            && proof.asset_data_hash
                == hash_asset_data_option(None)
                    .map_err(|_| error!(ChipError::InvalidBubblegumProof))?,
        ChipError::InvalidBubblegumProof
    );
    let claim_progress = ctx.accounts.claim.progress;
    if claim_progress != Pubkey::default() {
        let progress = ctx
            .accounts
            .progress
            .as_ref()
            .ok_or(error!(ChipError::InvalidBubblegumProof))?;
        require_keys_eq!(
            progress.key(),
            claim_progress,
            ChipError::InvalidBubblegumProof
        );
    } else {
        require!(
            ctx.accounts.progress.is_none(),
            ChipError::InvalidBubblegumProof
        );
    }
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
    if claim_progress == Pubkey::default() {
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
    } else {
        let progress = ctx
            .accounts
            .progress
            .as_mut()
            .ok_or(error!(ChipError::InvalidBubblegumProof))?;
        progress.registered_claims = progress
            .registered_claims
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        require!(
            progress.registered_claims <= progress.staged_claims
                && progress.registered_claims <= progress.expected_claims,
            ChipError::InvalidBubblegumProof
        );
    }

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

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct FinalizeCompressedPack<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        close = buyer,
        seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    /// CHECK: the pending buyer receives the remaining reserve and account rent.
    #[account(mut, address = pending.buyer)]
    pub buyer: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&buyer.key())]],
        bump = ledger.bump,
    )]
    pub ledger: Box<Account<'info, VaultLedger>>,
    #[account(
        mut,
        close = payer,
        seeds = [b"compressed_progress", pending.key().as_ref()],
        bump = progress.bump,
    )]
    pub progress: Box<Account<'info, CompressedPackProgress>>,
    /// CHECK: program vault PDA and authority of the optional $CG token account.
    #[account(seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Option<Account<'info, Mint>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = vault)]
    pub vault_cg: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = config.treasury)]
    pub treasury_cg: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Release the purchase liability only after every expected compressed chip
/// has completed Bubblegum minting and proof-backed DAS registration. Closing
/// the pending account refunds its remaining rent reserve to the buyer; closing
/// progress refunds only its bookkeeping rent to the cranker.
pub fn finalize_compressed_pack(
    ctx: Context<FinalizeCompressedPack>,
    _nonce: u64,
) -> Result<()> {
    let progress = &ctx.accounts.progress;
    require_keys_eq!(
        progress.pending,
        ctx.accounts.pending.key(),
        ChipError::InvalidBubblegumProof
    );
    require_keys_eq!(
        progress.buyer,
        ctx.accounts.buyer.key(),
        ChipError::InvalidBubblegumProof
    );
    require!(
        ctx.accounts.pending.opened == ctx.accounts.pending.qty
            && progress.expected_claims > 0
            && progress.staged_claims == progress.expected_claims
            && progress.registered_claims == progress.expected_claims,
        ChipError::InvalidBubblegumProof
    );

    let (paid_lamports, paid_usdc, paid_cg, paid_skr) = (
        ctx.accounts.pending.paid_lamports,
        ctx.accounts.pending.paid_usdc,
        ctx.accounts.pending.paid_cg,
        ctx.accounts.pending.paid_skr,
    );
    ctx.accounts.ledger.release(paid_lamports, paid_usdc, paid_cg, paid_skr)?;
    if paid_cg > 0 {
        let burn = paid_cg
            .checked_mul(CG_PACK_BURN_BPS as u64)
            .ok_or(ChipError::Overflow)?
            / BPS_DENOM as u64;
        let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];
        let mint = ctx
            .accounts
            .cg_mint
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let from = ctx
            .accounts
            .vault_cg
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx
            .accounts
            .treasury_cg
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: mint.to_account_info(),
                    from: from.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            burn,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            paid_cg - burn,
        )?;
        ctx.accounts.ledger.burned(burn);
        emit!(BurnReported {
            source: 0,
            amount: burn,
        });
    }
    emit!(CompressedPackSettled {
        buyer: ctx.accounts.buyer.key(),
        nonce: ctx.accounts.pending.nonce,
        claims: progress.expected_claims,
        paid_lamports,
        paid_usdc,
        paid_cg,
        paid_skr,
    });
    Ok(())
}

#[event]
pub struct CompressedPackSettled {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub claims: u16,
    pub paid_lamports: u64,
    pub paid_usdc: u64,
    pub paid_cg: u64,
    pub paid_skr: u64,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CancelUnstagedCompressedPack<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: pending seeds and the handler bind this refund recipient.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
    #[account(
        mut,
        close = buyer,
        seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump = pending.bump,
        constraint = pending.buyer == buyer.key() @ ChipError::Unauthorized,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    #[account(
        mut,
        seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&buyer.key())]],
        bump = ledger.bump,
    )]
    pub ledger: Box<Account<'info, VaultLedger>>,
    /// CHECK: vault PDA signs the SOL/SPL refund.
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Permissionless recovery for a paid compressed purchase for which staging
/// never created even one claim. This is separate from claim cancellation so a
/// missing progress PDA cannot strand the purchase. It is only available after
/// a long slot timeout and on the migrated (non-legacy) configuration.
pub fn cancel_unstaged_compressed_pack(
    ctx: Context<CancelUnstagedCompressedPack>,
    nonce: u64,
) -> Result<()> {
    require!(ctx.accounts.config.params_version > 0, ChipError::CompressedMigrationRequired);
    // Voucher receipts live in staking and cannot be atomically re-issued by
    // this program. Never burn a quest reward through the generic paid-pack
    // refund path; a dedicated staking-side reissue flow is required first.
    require!(!ctx.accounts.pending.voucher, ChipError::InvalidChipState);
    require!(ctx.accounts.pending.opened == 0, ChipError::InvalidChipState);
    let deadline = ctx
        .accounts
        .pending
        .commit_slot
        .checked_add(COMPRESSED_PACK_TIMEOUT_SLOTS)
        .ok_or(ChipError::Overflow)?;
    require!(Clock::get()?.slot > deadline, ChipError::InvalidChipState);

    let (paid_lamports, paid_usdc, paid_cg, paid_skr) = (
        ctx.accounts.pending.paid_lamports,
        ctx.accounts.pending.paid_usdc,
        ctx.accounts.pending.paid_cg,
        ctx.accounts.pending.paid_skr,
    );
    let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];
    if paid_lamports > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer.to_account_info(),
                },
                &[vault_seeds],
            ),
            paid_lamports,
        )?;
    }
    let spl_amount = paid_usdc.max(paid_cg).max(paid_skr);
    if spl_amount > 0 {
        let from = ctx
            .accounts
            .vault_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx
            .accounts
            .buyer_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let expected_mint = if paid_usdc > 0 {
            ctx.accounts.config.usdc_mint
        } else if paid_skr > 0 {
            ctx.accounts.config.skr_mint
        } else {
            ctx.accounts.config.cg_mint
        };
        require_keys_eq!(from.mint, expected_mint, ChipError::CurrencyNotAccepted);
        require_keys_eq!(to.mint, expected_mint, ChipError::CurrencyNotAccepted);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            spl_amount,
        )?;
    }
    ctx.accounts.ledger.release(paid_lamports, paid_usdc, paid_cg, paid_skr)?;
    emit!(CompressedPackCancelled {
        buyer: ctx.accounts.buyer.key(),
        nonce,
        claims: 0,
        refunded_lamports: paid_lamports,
        refunded_tokens: spl_amount,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CancelCompressedPack<'info> {
    /// Any caller may perform timeout recovery; funds and rent are returned to
    /// the buyer, while the caller only pays transaction fees.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: the pending PDA and the handler bind this recipient to buyer.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
    #[account(
        mut,
        close = buyer,
        seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump = pending.bump,
        constraint = pending.buyer == buyer.key() @ ChipError::Unauthorized,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    #[account(
        mut,
        close = buyer,
        seeds = [b"compressed_progress", pending.key().as_ref()],
        bump = progress.bump,
    )]
    pub progress: Box<Account<'info, CompressedPackProgress>>,
    #[account(
        mut,
        seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&buyer.key())]],
        bump = ledger.bump,
    )]
    pub ledger: Box<Account<'info, VaultLedger>>,
    /// CHECK: vault PDA signs the SOL/SPL refund.
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

fn close_remaining_claim(ai: &AccountInfo, recipient: &AccountInfo) -> Result<()> {
    let lamports = ai.lamports();
    **ai.try_borrow_mut_lamports()? = 0;
    let recipient_lamports = recipient
        .lamports()
        .checked_add(lamports)
        .ok_or(ChipError::Overflow)?;
    **recipient.try_borrow_mut_lamports()? = recipient_lamports;
    ai.resize(0)?;
    ai.assign(&anchor_lang::system_program::ID);
    Ok(())
}

/// Refund an asynchronous pack only when no Bubblegum leaf was minted. The
/// caller must pass every staged, still-unminted claim as a writable remaining
/// account; this prevents a partial close from silently orphaning claim rent.
pub fn cancel_compressed_pack(
    ctx: Context<CancelCompressedPack>,
    nonce: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let progress = &ctx.accounts.progress;
    require_keys_eq!(
        progress.pending,
        ctx.accounts.pending.key(),
        ChipError::InvalidBubblegumProof
    );
    require_keys_eq!(
        progress.buyer,
        ctx.accounts.buyer.key(),
        ChipError::InvalidBubblegumProof
    );
    require!(!ctx.accounts.pending.voucher, ChipError::InvalidChipState);
    require!(progress.minted_claims == 0, ChipError::InvalidChipState);
    require!(
        progress.staged_claims > 0
            && ctx.remaining_accounts.len() == progress.staged_claims as usize,
        ChipError::InvalidBubblegumProof
    );

    let mut seen = Vec::with_capacity(ctx.remaining_accounts.len());
    for ai in ctx.remaining_accounts {
        require!(ai.is_writable, ChipError::AccountNotWritable);
        require!(
            ai.owner == &crate::ID,
            ChipError::InvalidBubblegumProof
        );
        let claim = Account::<CompressedMintClaim>::try_from(ai)?;
        require_keys_eq!(claim.buyer, ctx.accounts.buyer.key(), ChipError::InvalidBubblegumProof);
        require_keys_eq!(claim.progress, progress.key(), ChipError::InvalidBubblegumProof);
        require!(!claim.minted, ChipError::InvalidBubblegumProof);
        require!(now > claim.expires_at, ChipError::InvalidBubblegumProof);
        require!(!seen.contains(ai.key), ChipError::InvalidBubblegumProof);
        seen.push(*ai.key);
        drop(claim);
        close_remaining_claim(ai, &ctx.accounts.buyer.to_account_info())?;
    }

    let (paid_lamports, paid_usdc, paid_cg, paid_skr) = (
        ctx.accounts.pending.paid_lamports,
        ctx.accounts.pending.paid_usdc,
        ctx.accounts.pending.paid_cg,
        ctx.accounts.pending.paid_skr,
    );
    let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];
    if paid_lamports > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer.to_account_info(),
                },
                &[vault_seeds],
            ),
            paid_lamports,
        )?;
    }
    let spl_amount = paid_usdc.max(paid_cg).max(paid_skr);
    if spl_amount > 0 {
        let from = ctx
            .accounts
            .vault_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx
            .accounts
            .buyer_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let expected_mint = if paid_usdc > 0 {
            ctx.accounts.config.usdc_mint
        } else if paid_skr > 0 {
            ctx.accounts.config.skr_mint
        } else {
            ctx.accounts.config.cg_mint
        };
        require_keys_eq!(from.mint, expected_mint, ChipError::CurrencyNotAccepted);
        require_keys_eq!(to.mint, expected_mint, ChipError::CurrencyNotAccepted);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            spl_amount,
        )?;
    }
    ctx.accounts.ledger.release(paid_lamports, paid_usdc, paid_cg, paid_skr)?;
    emit!(CompressedPackCancelled {
        buyer: ctx.accounts.buyer.key(),
        nonce,
        claims: progress.staged_claims,
        refunded_lamports: paid_lamports,
        refunded_tokens: spl_amount,
    });
    Ok(())
}

#[event]
pub struct CompressedPackCancelled {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub claims: u16,
    pub refunded_lamports: u64,
    pub refunded_tokens: u64,
}

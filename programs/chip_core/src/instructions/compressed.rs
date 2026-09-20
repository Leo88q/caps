//! Bubblegum V2 compressed-chip registration.
//!
//! Registration is deliberately proof-backed. DAS may supply transport data,
//! but only Account Compression's `verify_leaf` CPI can authorize creation of
//! a Core-owned game projection. The economically relevant roll is authorized
//! first by a one-time `CompressedMintClaim`; a cranker cannot choose rarity or
//! collection while submitting the proof.

use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use mpl_bubblegum::{
    instructions::MintV2CpiBuilder,
    types::{Creator, MetadataArgsV2, TokenStandard},
};
use mpl_core::ID as MPL_CORE_ID;

use crate::{
    bubblegum::{
        leaf_asset_id, require_bubblegum_program, tree_config_pda, verify_v2_leaf, LeafProofArgs,
        MPL_ACCOUNT_COMPRESSION_ID, MPL_NOOP_ID,
    },
    economy::{expand, PackDef, Rarity, BPS_DENOM, CG_PACK_BURN_BPS, MAX_CHIPS_PER_PACK},
    errors::ChipError,
    instructions::packs::RENT_RESERVE_PER_CHIP,
    randomness,
    state::{
        BubblegumTreeMeta, CollectionMeta, CompressedChipState, CompressedMintClaim,
        CompressedPackSettlement, GameConfig, PendingPack, PlayerPity, VaultLedger,
    },
    BUBBLEGUM_V2_ID,
};

#[derive(Accounts)]
#[instruction(buyer_key: Pubkey, collection_idx: u8, claim_nonce: u64)]
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
        seeds = [b"compressed_claim", buyer_key.as_ref(), &claim_nonce.to_le_bytes()],
        bump,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    /// CHECK: the buyer is bound into the claim PDA and the later registration.
    #[account(address = buyer_key)]
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
    _claim_nonce: u64,
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
    claim.settlement = Pubkey::default();
    claim.index_reserved = false;
    claim.minted = false;
    claim.bump = ctx.bumps.claim;
    Ok(())
}

const COMPRESSED_CLAIM_PACK_STRIDE: u64 = 128;

/// Refund the cancelled share of a pack without losing value to integer
/// truncation. Rounding is upward for the buyer and the registered side gets
/// the complementary remainder.
fn pro_rata_refund(amount: u64, cancelled_claims: u16, total_claims: u16) -> Result<u64> {
    if total_claims == 0 || cancelled_claims > total_claims {
        return Err(error!(ChipError::InvalidChipState));
    }
    let total = u64::from(total_claims);
    let cancelled = u64::from(cancelled_claims);
    let numerator = amount
        .checked_mul(cancelled)
        .ok_or(ChipError::Overflow)?
        .checked_add(total.checked_sub(1).ok_or(ChipError::Overflow)?)
        .ok_or(ChipError::Overflow)?;
    numerator
        .checked_div(total)
        .ok_or(ChipError::Overflow.into())
}

#[derive(Accounts)]
#[instruction(nonce: u64, pack_no: u8)]
pub struct OpenCompressedPack<'info> {
    /// Anyone may crank the deterministic roll and pay claim/settlement rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipError::Paused)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        seeds = [b"pending", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump = pending.bump,
        constraint = pending.randomness == randomness.key() @ ChipError::RandomnessMismatch,
        constraint = pack_no == pending.opened && pack_no < pending.qty @ ChipError::InvalidQuantity,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    /// CHECK: parsed by the randomness helper and pinned in PendingPack.
    pub randomness: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"pity", pending.buyer.as_ref()], bump = pity.bump)]
    pub pity: Box<Account<'info, PlayerPity>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + CompressedPackSettlement::INIT_SPACE,
        seeds = [b"compressed_settlement", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub settlement: Box<Account<'info, CompressedPackSettlement>>,
    /// CHECK: the buyer is bound by PendingPack and receives no authority here.
    #[account(address = pending.buyer)]
    pub buyer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // Remaining accounts, three per rolled chip:
    //   claim PDA, CollectionMeta PDA, BubblegumTreeMeta PDA.
}

/// Resolve one pending pack into claim-bound Bubblegum mints. No Core asset is
/// created here: the claims are later consumed by `mint_compressed_chip`, and
/// registration remains asynchronous until DAS supplies the finalized leaf.
pub fn open_compressed_pack<'info>(
    ctx: Context<'_, '_, 'info, 'info, OpenCompressedPack<'info>>,
    nonce: u64,
    pack_no: u8,
) -> Result<()> {
    let is_voucher = ctx.accounts.pending.voucher;
    let def = if is_voucher {
        PackDef::voucher(ctx.accounts.pending.voucher_odds)
    } else {
        *ctx.accounts
            .config
            .packs
            .get(ctx.accounts.pending.sku as usize)
            .ok_or(ChipError::InvalidSku)?
    };
    let chips = def.chips as usize;
    require!(
        chips > 0 && chips <= MAX_CHIPS_PER_PACK,
        ChipError::InvalidQuantity
    );
    require!(
        ctx.remaining_accounts.len() == chips * 3,
        ChipError::InvalidQuantity
    );

    let base = if ctx.accounts.pending.revealed {
        ctx.accounts.pending.value
    } else {
        let rnd = randomness::parse_checked(&ctx.accounts.randomness)?;
        let value = randomness::revealed_value(&rnd, ctx.accounts.pending.commit_slot)?;
        ctx.accounts.pending.value = value;
        ctx.accounts.pending.revealed = true;
        value
    };
    let bytes = if ctx.accounts.pending.qty == 1 {
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

    let pity_before = ctx.accounts.pity.counters[ctx.accounts.pending.sku as usize];
    let rolled = expand(&bytes, &def, pity_before, &pool);
    let payer_before = ctx.accounts.payer.lamports();
    let settlement_key = ctx.accounts.settlement.key();
    {
        let settlement = &mut ctx.accounts.settlement;
        if settlement.buyer == Pubkey::default() {
            settlement.buyer = ctx.accounts.pending.buyer;
            settlement.pending = ctx.accounts.pending.key();
            settlement.nonce = nonce;
            settlement.total_claims = 0;
            settlement.registered_claims = 0;
            settlement.cancelled_claims = 0;
            settlement.bump = ctx.bumps.settlement;
        } else {
            require_keys_eq!(
                settlement.buyer,
                ctx.accounts.pending.buyer,
                ChipError::InvalidChipState
            );
            require_keys_eq!(
                settlement.pending,
                ctx.accounts.pending.key(),
                ChipError::InvalidChipState
            );
            require!(settlement.nonce == nonce, ChipError::InvalidChipState);
        }
    }

    let buyer = ctx.accounts.pending.buyer;
    let mut claim_nonces = [0u64; MAX_CHIPS_PER_PACK];
    for i in 0..chips {
        let rolled_chip = rolled[i].ok_or(ChipError::Overflow)?;
        let accounts = &ctx.remaining_accounts[i * 3..i * 3 + 3];
        let claim_ai = &accounts[0];
        let collection_ai = &accounts[1];
        let tree_meta_ai = &accounts[2];
        let claim_nonce = nonce
            .checked_mul(COMPRESSED_CLAIM_PACK_STRIDE)
            .and_then(|v| v.checked_add((pack_no as u64) * MAX_CHIPS_PER_PACK as u64))
            .and_then(|v| v.checked_add(i as u64))
            .ok_or(ChipError::Overflow)?;
        claim_nonces[i] = claim_nonce;
        let (expected_claim, claim_bump) = Pubkey::find_program_address(
            &[
                b"compressed_claim",
                buyer.as_ref(),
                &claim_nonce.to_le_bytes(),
            ],
            ctx.program_id,
        );
        require_keys_eq!(expected_claim, claim_ai.key(), ChipError::InvalidChipState);
        require!(claim_ai.data_is_empty(), ChipError::InvalidChipState);

        let (expected_collection, _) = Pubkey::find_program_address(
            &[b"collection", &[rolled_chip.collection_idx]],
            ctx.program_id,
        );
        require_keys_eq!(
            expected_collection,
            collection_ai.key(),
            ChipError::InvalidCollection
        );
        let mut collection: Account<CollectionMeta> = Account::try_from(collection_ai)?;
        require!(
            collection.idx == rolled_chip.collection_idx,
            ChipError::InvalidCollection
        );

        let (expected_tree, _) = Pubkey::find_program_address(
            &[b"bubblegum_tree", &[rolled_chip.collection_idx]],
            ctx.program_id,
        );
        require_keys_eq!(
            expected_tree,
            tree_meta_ai.key(),
            ChipError::InvalidBubblegumTree
        );
        let tree_meta: Account<BubblegumTreeMeta> = Account::try_from(tree_meta_ai)?;
        require!(tree_meta.active, ChipError::InvalidBubblegumTree);
        require!(
            tree_meta.core_collection == collection.core_collection
                && tree_meta.tree_authority == collection.key(),
            ChipError::InvalidBubblegumTree
        );

        collection.minted = collection
            .minted
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        let rarity_index = rolled_chip.rarity.index() as usize;
        collection.minted_by_rarity[rarity_index] = collection.minted_by_rarity[rarity_index]
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        let game_index = collection.minted;
        let claim = CompressedMintClaim {
            buyer,
            collection_idx: rolled_chip.collection_idx,
            rarity: rolled_chip.rarity,
            level: 1,
            game_index,
            expires_at: Clock::get()?
                .unix_timestamp
                .checked_add(7 * 86_400)
                .ok_or(ChipError::Overflow)?,
            settlement: settlement_key,
            index_reserved: true,
            minted: false,
            bump: claim_bump,
        };
        let space = 8 + CompressedMintClaim::INIT_SPACE;
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: claim_ai.clone(),
                },
                &[&[
                    b"compressed_claim",
                    buyer.as_ref(),
                    &claim_nonce.to_le_bytes(),
                    &[claim_bump],
                ]],
            ),
            Rent::get()?.minimum_balance(space),
            space as u64,
            ctx.program_id,
        )?;
        {
            let mut data = claim_ai.try_borrow_mut_data()?;
            data[..8].copy_from_slice(CompressedMintClaim::DISCRIMINATOR);
            claim.serialize(&mut &mut data[8..])?;
        }
        collection.exit(ctx.program_id)?;
        ctx.accounts.settlement.total_claims = ctx
            .accounts
            .settlement
            .total_claims
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
    }

    if def.pity_tier > 0 {
        let sku = ctx.accounts.pending.sku as usize;
        let got_pity_tier = rolled[..chips]
            .iter()
            .flatten()
            .any(|r| r.rarity.index() >= def.pity_tier);
        ctx.accounts.pity.counters[sku] = if got_pity_tier {
            0
        } else {
            ctx.accounts.pity.counters[sku].saturating_add(1)
        };
    }
    let spent = payer_before.saturating_sub(ctx.accounts.payer.lamports());
    let reserve = RENT_RESERVE_PER_CHIP
        .checked_mul(chips as u64)
        .ok_or(ChipError::Overflow)?;
    let reimbursement = spent
        .min(reserve)
        .min(ctx.accounts.pending.to_account_info().lamports());
    if reimbursement > 0 {
        let pending_ai = ctx.accounts.pending.to_account_info();
        let payer_ai = ctx.accounts.payer.to_account_info();
        **pending_ai.try_borrow_mut_lamports()? -= reimbursement;
        **payer_ai.try_borrow_mut_lamports()? += reimbursement;
    }
    ctx.accounts.pending.opened = ctx
        .accounts
        .pending
        .opened
        .checked_add(1)
        .ok_or(ChipError::Overflow)?;
    emit!(CompressedClaimsCreated {
        buyer,
        nonce,
        pack_no,
        claim_nonces,
        count: chips as u8,
    });
    Ok(())
}

#[event]
pub struct CompressedClaimsCreated {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub pack_no: u8,
    pub claim_nonces: [u64; MAX_CHIPS_PER_PACK],
    pub count: u8,
}

#[derive(Accounts)]
#[instruction(claim_nonce: u64, nonce: u64)]
pub struct CancelCompressedClaim<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"compressed_settlement", buyer.key().as_ref(), &nonce.to_le_bytes()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, CompressedPackSettlement>>,
    #[account(seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()], bump = pending.bump)]
    pub pending: Box<Account<'info, PendingPack>>,
    #[account(
        mut,
        close = buyer,
        seeds = [b"compressed_claim", buyer.key().as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::Unauthorized,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_compressed_claim(
    ctx: Context<CancelCompressedClaim>,
    _claim_nonce: u64,
    nonce: u64,
) -> Result<()> {
    require!(
        ctx.accounts.claim.settlement == ctx.accounts.settlement.key()
            && ctx.accounts.settlement.buyer == ctx.accounts.buyer.key()
            && ctx.accounts.settlement.pending == ctx.accounts.pending.key()
            && ctx.accounts.settlement.nonce == nonce
            && ctx.accounts.pending.buyer == ctx.accounts.buyer.key()
            && ctx.accounts.pending.nonce == nonce
            && !ctx.accounts.claim.minted
            && ctx.accounts.settlement.cancelled_claims < ctx.accounts.settlement.total_claims
            && Clock::get()?.unix_timestamp > ctx.accounts.claim.expires_at,
        ChipError::InvalidChipState
    );
    ctx.accounts.settlement.cancelled_claims = ctx
        .accounts
        .settlement
        .cancelled_claims
        .checked_add(1)
        .ok_or(ChipError::Overflow)?;
    emit!(CompressedClaimCancelled {
        buyer: ctx.accounts.buyer.key(),
        nonce,
        claim_nonce: _claim_nonce,
    });
    Ok(())
}

#[event]
pub struct CompressedClaimCancelled {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub claim_nonce: u64,
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
        seeds = [b"compressed_settlement", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump = settlement.bump,
    )]
    pub settlement: Box<Account<'info, CompressedPackSettlement>>,
    #[account(
        mut,
        seeds = [b"pending", pending.buyer.as_ref(), &nonce.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    /// CHECK: buyer is bound by PendingPack and receives the pending reserve.
    #[account(mut, address = pending.buyer)]
    pub buyer: UncheckedAccount<'info>,
    #[account(mut, seeds = [VaultLedger::SEED, &[VaultLedger::shard_of(&pending.buyer)]], bump = ledger.bump)]
    pub ledger: Box<Account<'info, VaultLedger>>,
    /// CHECK: vault PDA holding paid SOL/SPL liabilities.
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Option<Account<'info, Mint>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = vault)]
    pub vault_cg: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = config.treasury)]
    pub treasury_cg: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn finalize_compressed_pack(ctx: Context<FinalizeCompressedPack>, nonce: u64) -> Result<()> {
    require!(
        ctx.accounts.pending.opened == ctx.accounts.pending.qty,
        ChipError::InvalidChipState
    );
    require!(
        ctx.accounts.settlement.buyer == ctx.accounts.buyer.key()
            && ctx.accounts.pending.buyer == ctx.accounts.buyer.key()
            && ctx.accounts.settlement.pending == ctx.accounts.pending.key()
            && ctx.accounts.settlement.nonce == nonce
            && ctx.accounts.settlement.total_claims > 0
            && ctx
                .accounts
                .settlement
                .registered_claims
                .checked_add(ctx.accounts.settlement.cancelled_claims)
                == Some(ctx.accounts.settlement.total_claims),
        ChipError::InvalidChipState
    );

    let (paid_lamports, paid_usdc, paid_cg, paid_skr) = (
        ctx.accounts.pending.paid_lamports,
        ctx.accounts.pending.paid_usdc,
        ctx.accounts.pending.paid_cg,
        ctx.accounts.pending.paid_skr,
    );
    let payment_kinds = (paid_lamports > 0) as u8
        + (paid_usdc > 0) as u8
        + (paid_cg > 0) as u8
        + (paid_skr > 0) as u8;
    require!(payment_kinds <= 1, ChipError::CurrencyNotAccepted);
    let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];
    let cancelled_claims = ctx.accounts.settlement.cancelled_claims;
    let total_claims = ctx.accounts.settlement.total_claims;
    let refund = cancelled_claims > 0;
    let refunded_lamports = pro_rata_refund(paid_lamports, cancelled_claims, total_claims)?;
    let refunded_usdc = pro_rata_refund(paid_usdc, cancelled_claims, total_claims)?;
    let refunded_cg = pro_rata_refund(paid_cg, cancelled_claims, total_claims)?;
    let refunded_skr = pro_rata_refund(paid_skr, cancelled_claims, total_claims)?;

    if refunded_lamports > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer.to_account_info(),
                },
                &[vault_seeds],
            ),
            refunded_lamports,
        )?;
    }

    // USDC and SKR have no settlement-side split. Only the cancelled share is
    // returned; the registered share remains in the vault as revenue.
    let refundable_token_amount = refunded_usdc
        .checked_add(refunded_skr)
        .ok_or(ChipError::Overflow)?;
    if refundable_token_amount > 0 {
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
        } else {
            ctx.accounts.config.skr_mint
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
            refundable_token_amount,
        )?;
    }

    // $CG keeps the existing burn/treasury economics for the successfully
    // registered share, while the cancelled share is returned before the
    // liability is released.
    if refunded_cg > 0 {
        let from = ctx
            .accounts
            .vault_cg
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx
            .accounts
            .buyer_token
            .as_ref()
            .ok_or(ChipError::CurrencyNotAccepted)?;
        require_keys_eq!(
            to.mint,
            ctx.accounts.config.cg_mint,
            ChipError::CurrencyNotAccepted
        );
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
            refunded_cg,
        )?;
    }
    let cg_for_registered = paid_cg
        .checked_sub(refunded_cg)
        .ok_or(ChipError::Overflow)?;
    if cg_for_registered > 0 {
        let burn = cg_for_registered
            .checked_mul(CG_PACK_BURN_BPS as u64)
            .ok_or(ChipError::Overflow)?
            / BPS_DENOM as u64;
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
            cg_for_registered
                .checked_sub(burn)
                .ok_or(ChipError::Overflow)?,
        )?;
        ctx.accounts.ledger.burned(burn);
    }
    ctx.accounts
        .ledger
        .release(paid_lamports, paid_usdc, paid_cg, paid_skr)?;
    ctx.accounts.ledger.exit(ctx.program_id)?;

    let pending_ai = ctx.accounts.pending.to_account_info();
    let buyer_ai = ctx.accounts.buyer.to_account_info();
    let pending_lamports = pending_ai.lamports();
    **pending_ai.try_borrow_mut_lamports()? = 0;
    **buyer_ai.try_borrow_mut_lamports()? = buyer_ai
        .lamports()
        .checked_add(pending_lamports)
        .ok_or(ChipError::Overflow)?;
    pending_ai.assign(&system_program::ID);
    pending_ai.resize(0)?;

    let settlement_ai = ctx.accounts.settlement.to_account_info();
    let settlement_lamports = settlement_ai.lamports();
    let payer_ai = ctx.accounts.payer.to_account_info();
    let payer_next = payer_ai
        .lamports()
        .checked_add(settlement_lamports)
        .ok_or(ChipError::Overflow)?;
    **settlement_ai.try_borrow_mut_lamports()? = 0;
    **payer_ai.try_borrow_mut_lamports()? = payer_next;
    settlement_ai.assign(&system_program::ID);
    settlement_ai.resize(0)?;

    emit!(CompressedPackSettled {
        buyer: ctx.accounts.buyer.key(),
        nonce,
        refunded: refund
    });
    Ok(())
}

#[event]
pub struct CompressedPackSettled {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub refunded: bool,
}

#[derive(Accounts)]
#[instruction(buyer_key: Pubkey, collection_idx: u8, claim_nonce: u64)]
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
        seeds = [b"compressed_claim", buyer_key.as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::InvalidBubblegumProof,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    /// CHECK: the leaf owner is the buyer bound into the claim.
    #[account(address = buyer_key)]
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
    #[account(address = crate::bubblegum::mpl_core_cpi_signer())]
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
#[instruction(asset_id: Pubkey, collection_idx: u8, owner: Pubkey, delegate: Pubkey, buyer_key: Pubkey, claim_nonce: u64)]
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
        seeds = [b"compressed_claim", buyer_key.as_ref(), &claim_nonce.to_le_bytes()],
        bump = claim.bump,
        has_one = buyer @ ChipError::InvalidBubblegumProof,
    )]
    pub claim: Box<Account<'info, CompressedMintClaim>>,
    /// CHECK: compressed-pack settlement PDA, or the system program for the
    /// legacy/admin staging path where the claim has no settlement. The handler
    /// requires it writable only when a settlement is actually used.
    pub settlement: UncheckedAccount<'info>,
    /// CHECK: claim.buyer is the expected leaf owner.
    #[account(address = buyer_key)]
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

pub fn register_compressed_chip<'info>(
    ctx: Context<'_, '_, 'info, 'info, RegisterCompressedChip<'info>>,
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
    // A minted claim remains recoverable after the DAS/indexer SLA expires;
    // only an unminted claim can be cancelled and refunded.
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.claim.expires_at || ctx.accounts.claim.minted,
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
        ctx.accounts.tree_meta.max_depth < 32,
        ChipError::InvalidBubblegumTree
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

    if ctx.accounts.claim.settlement != Pubkey::default() {
        require_keys_eq!(
            ctx.accounts.settlement.key(),
            ctx.accounts.claim.settlement,
            ChipError::InvalidChipState
        );
        let settlement_ai = ctx.accounts.settlement.to_account_info();
        require!(settlement_ai.is_writable, ChipError::AccountNotWritable);
        require_keys_eq!(
            *settlement_ai.owner,
            *ctx.program_id,
            ChipError::InvalidChipState
        );
        let mut settlement_data = settlement_ai.try_borrow_mut_data()?;
        let mut settlement_cursor: &[u8] = &settlement_data;
        let mut settlement = CompressedPackSettlement::try_deserialize(&mut settlement_cursor)?;
        require_keys_eq!(settlement.buyer, buyer, ChipError::InvalidChipState);
        require!(
            settlement.registered_claims < settlement.total_claims,
            ChipError::InvalidChipState
        );
        settlement.registered_claims = settlement
            .registered_claims
            .checked_add(1)
            .ok_or(ChipError::Overflow)?;
        settlement.serialize(&mut &mut settlement_data[8..])?;
    }

    let rarity_index = rarity.index() as usize;
    if !ctx.accounts.claim.index_reserved {
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
        claim_nonce,
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
    pub claim_nonce: u64,
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

#[cfg(test)]
mod tests {
    use super::pro_rata_refund;

    #[test]
    fn refund_rounds_up_and_conserves_value() {
        assert_eq!(pro_rata_refund(100, 1, 2).unwrap(), 50);
        assert_eq!(pro_rata_refund(1, 1, 3).unwrap(), 1);
        assert_eq!(pro_rata_refund(100, 0, 3).unwrap(), 0);
        assert_eq!(pro_rata_refund(100, 3, 3).unwrap(), 100);
    }

    #[test]
    fn refund_rejects_invalid_counters_and_overflow() {
        assert!(pro_rata_refund(100, 4, 3).is_err());
        assert!(pro_rata_refund(100, 0, 0).is_err());
        assert!(pro_rata_refund(u64::MAX, 2, 3).is_err());
    }
}

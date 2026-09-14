//! Fusion: 3 same-rarity chips → 1 chip of the next tier.
//!
//! Recipes 0–3 (Common→Rare+) are 100 % and resolve atomically in `fuse`.
//! Recipes 4–7 need randomness: `fuse` freezes the materials, burns the $CG
//! fee, pins a fresh Switchboard account and creates PendingFusion;
//! `fuse_reveal` burns/mints deterministically from the revealed value.
//! Failure refunds `refund_on_fail` materials (unfrozen) and burns the rest.
//! `cancel_stale_fusion` exists only for an oracle outage: it unfreezes
//! materials but the fee stays burned (fee is the anti-spam sink).

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use mpl_core::{
    accounts::BaseAssetV1,
    instructions::{BurnV1CpiBuilder, CreateV2CpiBuilder, UpdatePluginV1CpiBuilder},
    types::{Attribute, Attributes, PermanentBurnDelegate, PermanentFreezeDelegate, PermanentTransferDelegate, Plugin, PluginAuthority, PluginAuthorityPair},
    ID as MPL_CORE_ID,
};
use switchboard_on_demand::accounts::RandomnessAccountData;

use crate::economy::*;
use crate::errors::ChipError;
use crate::state::*;

/// Materials arrive as remaining_accounts: for m in 0..3 → [asset_m, chip_state_m].
/// Result accounts (asset PDA + chip_state PDA + collection meta + core collection) are named.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Fuse<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipError::Paused)]
    pub config: Box<Account<'info, GameConfig>>,

    #[account(
        init, payer = owner, space = 8 + PendingFusion::INIT_SPACE,
        seeds = [b"fusion", owner.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub pending: Box<Account<'info, PendingFusion>>,

    /// CHECK: Switchboard randomness; only inspected for recipes with < 100 % success.
    pub randomness: UncheckedAccount<'info>,

    #[account(
        init_if_needed, payer = owner, space = 8 + PlayerItems::INIT_SPACE,
        seeds = [b"items", owner.key().as_ref()], bump
    )]
    pub items: Box<Account<'info, PlayerItems>>,

    /// Target collection of the result (any material's collection for "any" recipes; the shared one otherwise).
    #[account(mut, seeds = [b"collection", &[result_meta.idx]], bump = result_meta.bump)]
    pub result_meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK: Core collection of result_meta
    #[account(mut, address = result_meta.core_collection @ ChipError::WrongCollection)]
    pub result_core_collection: UncheckedAccount<'info>,

    /// CHECK: result asset PDA ["asset", pending, 0, 0] — created only on success.
    #[account(mut, seeds = [b"asset", pending.key().as_ref(), &[0u8], &[0u8]], bump)]
    pub result_asset: UncheckedAccount<'info>,
    /// CHECK: result ChipState PDA
    #[account(mut, seeds = [b"chip", result_asset.key().as_ref()], bump)]
    pub result_state: UncheckedAccount<'info>,

    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Account<'info, Mint>,
    #[account(mut, token::mint = config.cg_mint, token::authority = owner)]
    pub owner_cg: Account<'info, TokenAccount>,

    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

struct Material<'a, 'info> { asset: &'a AccountInfo<'info>, state: Account<'info, ChipState> }

fn load_materials<'a, 'info>(
    rem: &'a [AccountInfo<'info>], owner: &Pubkey, program_id: &Pubkey, now: i64,
) -> Result<Vec<Material<'a, 'info>>> {
    // layout: [asset_m, chip_state_m] × 3 followed by [collection_meta_m, core_collection_m] × 3
    require!(rem.len() == MATERIALS_PER_FUSION * 4, ChipError::InvalidQuantity);
    let mut out: Vec<Material<'a, 'info>> = Vec::with_capacity(MATERIALS_PER_FUSION);
    for m in 0..MATERIALS_PER_FUSION {
        let asset = &rem[m * 2];
        let state_ai = &rem[m * 2 + 1];
        // ownership via Core base asset
        let base = BaseAssetV1::from_bytes(&asset.try_borrow_data()?).map_err(|_| error!(ChipError::NotAssetOwner))?;
        require_keys_eq!(base.owner, *owner, ChipError::NotAssetOwner);
        let (exp, _) = Pubkey::find_program_address(&[b"chip", asset.key().as_ref()], program_id);
        require_keys_eq!(exp, state_ai.key(), ChipError::InvalidChipState);
        let state: Account<ChipState> = Account::try_from(state_ai)?;
        require!(state.is_free(now), ChipError::ChipNotFree);
        require!(state.flags & ChipState::F_SOULBOUND == 0 || now >= state.lock_until, ChipError::ChipNotFree);
        for prev in &out { require!(prev.asset.key() != asset.key(), ChipError::DuplicateMaterial); }
        out.push(Material { asset, state });
    }
    Ok(out)
}

fn set_frozen<'info>(mpl_core: &AccountInfo<'info>, asset: &AccountInfo<'info>, collection: &AccountInfo<'info>,
                     authority: &AccountInfo<'info>, payer: &AccountInfo<'info>, sys: &AccountInfo<'info>,
                     seeds: &[&[u8]], frozen: bool) -> Result<()> {
    UpdatePluginV1CpiBuilder::new(mpl_core)
        .asset(asset).collection(Some(collection)).authority(Some(authority)).payer(payer).system_program(sys)
        .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen }))
        .invoke_signed(&[seeds])?;
    Ok(())
}

fn burn_asset<'info>(mpl_core: &AccountInfo<'info>, asset: &AccountInfo<'info>, collection: &AccountInfo<'info>,
                     authority: &AccountInfo<'info>, payer: &AccountInfo<'info>, sys: &AccountInfo<'info>,
                     seeds: &[&[u8]]) -> Result<()> {
    BurnV1CpiBuilder::new(mpl_core)
        .asset(asset).collection(Some(collection)).authority(Some(authority)).payer(payer).system_program(Some(sys))
        .invoke_signed(&[seeds])?;
    Ok(())
}

fn close_state<'info>(state_ai: &AccountInfo<'info>, to: &AccountInfo<'info>) -> Result<()> {
    let lam = state_ai.lamports();
    **state_ai.try_borrow_mut_lamports()? = 0;
    **to.try_borrow_mut_lamports()? += lam;
    state_ai.assign(&system_program::ID);
    state_ai.realloc(0, false)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn mint_result<'info>(
    ctx_program: &Pubkey, mpl_core: &AccountInfo<'info>, sys: &AccountInfo<'info>, payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>, pending_key: &Pubkey, asset_ai: &AccountInfo<'info>, state_ai: &AccountInfo<'info>,
    meta: &mut Account<'info, CollectionMeta>, core_collection: &AccountInfo<'info>, rarity: Rarity, lock_secs: i64, now: i64,
) -> Result<()> {
    let (exp_asset, asset_bump) = Pubkey::find_program_address(&[b"asset", pending_key.as_ref(), &[0u8], &[0u8]], ctx_program);
    require_keys_eq!(exp_asset, asset_ai.key(), ChipError::InvalidChipState);
    require!(asset_ai.data_is_empty(), ChipError::InvalidChipState);

    meta.minted = meta.minted.checked_add(1).ok_or(ChipError::Overflow)?;
    let ri = rarity.index() as usize;
    meta.minted_by_rarity[ri] = meta.minted_by_rarity[ri].checked_add(1).ok_or(ChipError::Overflow)?;
    let index = meta.minted;

    let plugins = vec![
        PluginAuthorityPair { plugin: Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: lock_secs > 0 }), authority: Some(PluginAuthority::UpdateAuthority) },
        PluginAuthorityPair { plugin: Plugin::PermanentBurnDelegate(PermanentBurnDelegate {}), authority: Some(PluginAuthority::UpdateAuthority) },
        PluginAuthorityPair { plugin: Plugin::PermanentTransferDelegate(PermanentTransferDelegate {}), authority: Some(PluginAuthority::UpdateAuthority) },
        PluginAuthorityPair { plugin: Plugin::Attributes(Attributes { attribute_list: vec![
            Attribute { key: "district".into(), value: meta.idx.to_string() },
            Attribute { key: "rarity".into(), value: ri.to_string() },
            Attribute { key: "index".into(), value: index.to_string() },
            Attribute { key: "level".into(), value: "1".into() },
            Attribute { key: "origin".into(), value: "fusion".into() },
        ]}), authority: Some(PluginAuthority::UpdateAuthority) },
    ];
    let asset_seeds: &[&[u8]] = &[b"asset", pending_key.as_ref(), &[0u8], &[0u8], &[asset_bump]];
    let meta_seeds: &[&[u8]] = &[b"collection", &[meta.idx], &[meta.bump]];
    CreateV2CpiBuilder::new(mpl_core)
        .asset(asset_ai).collection(Some(core_collection)).authority(Some(&meta.to_account_info()))
        .payer(payer).owner(Some(owner)).system_program(sys)
        .name(format!("{} #{}", meta.symbol, index))
        .uri(format!("https://cdn.guttercaps.gg/m/{}/{}.json", meta.idx, ri))
        .plugins(plugins)
        .invoke_signed(&[asset_seeds, meta_seeds])?;

    let (exp_state, bump) = Pubkey::find_program_address(&[b"chip", asset_ai.key().as_ref()], ctx_program);
    require_keys_eq!(exp_state, state_ai.key(), ChipError::InvalidChipState);
    let space = 8 + ChipState::INIT_SPACE;
    system_program::create_account(
        CpiContext::new_with_signer(sys.clone(), system_program::CreateAccount { from: payer.clone(), to: state_ai.clone() },
            &[&[b"chip", asset_ai.key().as_ref(), &[bump]]]),
        Rent::get()?.minimum_balance(space), space as u64, ctx_program,
    )?;
    let st = ChipState {
        asset: asset_ai.key(), collection_idx: meta.idx, rarity, level: 1, index, flags: 0,
        lock_until: if lock_secs > 0 { now + lock_secs } else { 0 }, minted_at: now, bump,
    };
    let mut data = state_ai.try_borrow_mut_data()?;
    data[..8].copy_from_slice(ChipState::DISCRIMINATOR);
    st.serialize(&mut &mut data[8..])?;
    Ok(())
}

pub fn fuse<'info>(ctx: Context<'_, '_, 'info, 'info, Fuse<'info>>, nonce: u64, use_booster: bool) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let owner_key = ctx.accounts.owner.key();
    let mats = load_materials(ctx.remaining_accounts, &owner_key, ctx.program_id, now)?;

    // --- recipe validation ---
    let from = mats[0].state.rarity;
    let recipe = recipe_for(from).ok_or(ChipError::NoRecipe)?;
    for m in &mats { require!(m.state.rarity == from, ChipError::MaterialRarityMismatch); }
    if recipe.same_collection {
        for m in &mats { require!(m.state.collection_idx == mats[0].state.collection_idx, ChipError::MaterialCollectionMismatch); }
        require!(ctx.accounts.result_meta.idx == mats[0].state.collection_idx, ChipError::MaterialCollectionMismatch);
    } else {
        // result collection must be one of the inputs' collections (player picks which "story" survives)
        require!(mats.iter().any(|m| m.state.collection_idx == ctx.accounts.result_meta.idx), ChipError::MaterialCollectionMismatch);
    }
    let boosted = use_booster && recipe.success_bps < 10_000;
    if boosted {
        let items = &mut ctx.accounts.items;
        if items.owner == Pubkey::default() { items.owner = owner_key; items.bump = ctx.bumps.items; }
        require!(items.boosters > 0, ChipError::NoBooster);
        items.boosters -= 1;
    }

    // --- fee: 100 % burn ---
    token::burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), token::Burn {
        mint: ctx.accounts.cg_mint.to_account_info(), from: ctx.accounts.owner_cg.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    }), recipe.fee_cg_micro)?;
    ctx.accounts.config.burned_total = ctx.accounts.config.burned_total.saturating_add(recipe.fee_cg_micro);
    emit!(BurnReported { source: 1, amount: recipe.fee_cg_micro });

    let mpl = ctx.accounts.mpl_core.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    let payer = ctx.accounts.owner.to_account_info();
    let core_col = ctx.accounts.result_core_collection.to_account_info();
    let pending_key = ctx.accounts.pending.key();
    let mut material_keys = [Pubkey::default(); MATERIALS_PER_FUSION];
    for (i, m) in mats.iter().enumerate() { material_keys[i] = m.asset.key(); }

    if recipe.success_bps == 10_000 {
        // ---- atomic path: burn all 3, mint 1 ----
        // Materials may be in different collections for "any" recipes; each material's
        // collection meta is needed as the burn authority → we require that the client passes
        // the *materials'* core collection via result_core_collection only when all share it,
        // otherwise via the per-material extra accounts in remaining_accounts[6..].
        for (i, m) in mats.iter().enumerate() {
            let (meta_ai, col_ai, seeds_idx, seeds_bump) = material_collection_accounts(&ctx, i, &m.state)?;
            let seeds: &[&[u8]] = &[b"collection", &[seeds_idx], &[seeds_bump]];
            burn_asset(&mpl, m.asset, &col_ai, &meta_ai, &payer, &sys, seeds)?;
            close_state(&m.state.to_account_info(), &payer)?;
        }
        let next = from.next().ok_or(ChipError::NoRecipe)?;
        let result_asset = ctx.accounts.result_asset.to_account_info();
        let result_state = ctx.accounts.result_state.to_account_info();
        let owner_ai = ctx.accounts.owner.to_account_info();
        mint_result(ctx.program_id, &mpl, &sys, &payer, &owner_ai, &pending_key, &result_asset, &result_state,
                    &mut ctx.accounts.result_meta, &core_col, next, recipe.result_lock_secs, now)?;
        emit!(ChipFused { owner: owner_key, recipe: from.index(), materials: material_keys, result: result_asset.key(),
                          success: true, roll_bps: 0, threshold_bps: 10_000, fee_burned: recipe.fee_cg_micro });
        // PendingFusion not needed: close immediately (rent back to owner)
        let p = ctx.accounts.pending.to_account_info();
        close_state(&p, &payer)?;
        return Ok(());
    }

    // ---- randomized path: commit ----
    let rnd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())
        .map_err(|_| error!(ChipError::RandomnessMismatch))?;
    require!(rnd.seed_slot == clock.slot.saturating_sub(1), ChipError::RandomnessExpired);
    require!(rnd.get_value(clock.slot).is_err(), ChipError::RandomnessAlreadyRevealed);

    for (i, m) in mats.iter().enumerate() {
        let (meta_ai, col_ai, idx, bump) = material_collection_accounts(&ctx, i, &m.state)?;
        let seeds: &[&[u8]] = &[b"collection", &[idx], &[bump]];
        set_frozen(&mpl, m.asset, &col_ai, &meta_ai, &payer, &sys, seeds, true)?;
        let mut st: Account<ChipState> = Account::try_from(&m.state.to_account_info())?;
        st.flags |= ChipState::F_FUSING;
        st.exit(ctx.program_id)?;
    }

    let p = &mut ctx.accounts.pending;
    p.owner = owner_key;
    p.recipe = from.index();
    p.materials = material_keys;
    p.result_collection_idx = ctx.accounts.result_meta.idx;
    p.boosted = boosted;
    p.randomness = ctx.accounts.randomness.key();
    p.commit_slot = rnd.seed_slot;
    p.nonce = nonce;
    p.bump = ctx.bumps.pending;
    Ok(())
}

/// For material i returns (collection_meta AccountInfo, core_collection AccountInfo, idx, bump).
/// Layout: remaining_accounts[6 + i*2] = collection_meta_i, [7 + i*2] = core_collection_i.
/// (Clients always pass them; for same-collection recipes they're just duplicates.)
fn material_collection_accounts<'a, 'info>(
    ctx: &'a Context<'_, '_, 'info, 'info, Fuse<'info>>, i: usize, st: &ChipState,
) -> Result<(AccountInfo<'info>, AccountInfo<'info>, u8, u8)> {
    let rem = ctx.remaining_accounts;
    require!(rem.len() >= 6 + (i + 1) * 2, ChipError::InvalidQuantity);
    let meta_ai = &rem[6 + i * 2];
    let col_ai = &rem[7 + i * 2];
    let (exp, bump) = Pubkey::find_program_address(&[b"collection", &[st.collection_idx]], ctx.program_id);
    require_keys_eq!(exp, meta_ai.key(), ChipError::InvalidCollection);
    let meta: Account<CollectionMeta> = Account::try_from(meta_ai)?;
    require_keys_eq!(meta.core_collection, col_ai.key(), ChipError::WrongCollection);
    Ok((meta_ai.clone(), col_ai.clone(), st.collection_idx, bump))
}

// ---------------------------------------------------------------------------
// fuse_reveal
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct FuseReveal<'info> {
    /// permissionless crank; rent for the result is reimbursed by closing PendingFusion to payer
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        seeds = [b"fusion", pending.owner.as_ref(), &nonce.to_le_bytes()], bump = pending.bump,
        constraint = pending.randomness == randomness.key() @ ChipError::RandomnessMismatch,
    )]
    pub pending: Box<Account<'info, PendingFusion>>,
    /// CHECK: pinned
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: owner receives result / refunds
    #[account(mut, address = pending.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"collection", &[pending.result_collection_idx]], bump = result_meta.bump)]
    pub result_meta: Box<Account<'info, CollectionMeta>>,
    /// CHECK:
    #[account(mut, address = result_meta.core_collection)]
    pub result_core_collection: UncheckedAccount<'info>,
    /// CHECK: ["asset", pending, 0, 0]
    #[account(mut)]
    pub result_asset: UncheckedAccount<'info>,
    /// CHECK: ["chip", result_asset]
    #[account(mut)]
    pub result_state: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: for m in 0..3 → [asset_m, chip_state_m, collection_meta_m, core_collection_m]
}

pub fn fuse_reveal<'info>(ctx: Context<'_, '_, 'info, 'info, FuseReveal<'info>>, _nonce: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pending = &ctx.accounts.pending;
    let recipe = recipe_for(Rarity::from_index(pending.recipe).ok_or(ChipError::NoRecipe)?).ok_or(ChipError::NoRecipe)?;

    let rnd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())
        .map_err(|_| error!(ChipError::RandomnessMismatch))?;
    require!(rnd.seed_slot == pending.commit_slot, ChipError::RandomnessExpired);
    let value = rnd.get_value(clock.slot).map_err(|_| error!(ChipError::RandomnessNotResolved))?;
    let roll = uniform_bps(&value, 0);
    let threshold = success_threshold(recipe, pending.boosted);
    let success = roll < threshold;

    let rem = ctx.remaining_accounts;
    require!(rem.len() == MATERIALS_PER_FUSION * 4, ChipError::InvalidQuantity);
    let mpl = ctx.accounts.mpl_core.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    let payer = ctx.accounts.payer.to_account_info();
    let owner_ai = ctx.accounts.owner.to_account_info();

    // Which materials survive on failure: deterministic — the lowest `refund_on_fail` by asset key
    // (no "keep the best" choice: all materials are the same rarity anyway).
    let mut survivors: Vec<usize> = Vec::new();
    if !success {
        let mut idx: Vec<usize> = (0..MATERIALS_PER_FUSION).collect();
        idx.sort_by_key(|&i| pending.materials[i].to_bytes());
        survivors = idx.into_iter().take(recipe.refund_on_fail as usize).collect();
    }

    for m in 0..MATERIALS_PER_FUSION {
        let asset = &rem[m * 4];
        let state_ai = &rem[m * 4 + 1];
        let meta_ai = &rem[m * 4 + 2];
        let col_ai = &rem[m * 4 + 3];
        require_keys_eq!(asset.key(), pending.materials[m], ChipError::InvalidChipState);
        let (exp_state, _) = Pubkey::find_program_address(&[b"chip", asset.key().as_ref()], ctx.program_id);
        require_keys_eq!(exp_state, state_ai.key(), ChipError::InvalidChipState);
        let mut st: Account<ChipState> = Account::try_from(state_ai)?;
        require!(st.flags & ChipState::F_FUSING != 0, ChipError::InvalidChipState);
        let (exp_meta, bump) = Pubkey::find_program_address(&[b"collection", &[st.collection_idx]], ctx.program_id);
        require_keys_eq!(exp_meta, meta_ai.key(), ChipError::InvalidCollection);
        let meta: Account<CollectionMeta> = Account::try_from(meta_ai)?;
        require_keys_eq!(meta.core_collection, col_ai.key(), ChipError::WrongCollection);
        let seeds: &[&[u8]] = &[b"collection", &[st.collection_idx], &[bump]];

        if survivors.contains(&m) {
            set_frozen(&mpl, asset, col_ai, meta_ai, &payer, &sys, seeds, false)?;
            st.flags &= !ChipState::F_FUSING;
            st.exit(ctx.program_id)?;
        } else {
            burn_asset(&mpl, asset, col_ai, meta_ai, &payer, &sys, seeds)?;
            close_state(state_ai, &owner_ai)?;
        }
    }

    let mut result_key = Pubkey::default();
    if success {
        let next = Rarity::from_index(pending.recipe + 1).ok_or(ChipError::NoRecipe)?;
        let pending_key = ctx.accounts.pending.key();
        let ra = ctx.accounts.result_asset.to_account_info();
        let rs = ctx.accounts.result_state.to_account_info();
        let core_col = ctx.accounts.result_core_collection.to_account_info();
        mint_result(ctx.program_id, &mpl, &sys, &payer, &owner_ai, &pending_key, &ra, &rs,
                    &mut ctx.accounts.result_meta, &core_col, next, recipe.result_lock_secs, now)?;
        result_key = ra.key();
    }

    emit!(ChipFused { owner: pending.owner, recipe: pending.recipe, materials: pending.materials, result: result_key,
                      success, roll_bps: roll, threshold_bps: threshold, fee_burned: 0 });

    // close PendingFusion → payer (covers crank rent; owner already paid it at commit — net zero for a self-crank)
    let p = ctx.accounts.pending.to_account_info();
    close_state(&p, &payer)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// cancel_stale_fusion — oracle outage only
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CancelStaleFusion<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(mut, close = owner, seeds = [b"fusion", owner.key().as_ref(), &nonce.to_le_bytes()], bump = pending.bump, has_one = owner)]
    pub pending: Box<Account<'info, PendingFusion>>,
    /// CHECK: pinned
    #[account(address = pending.randomness)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [asset_m, chip_state_m, collection_meta_m, core_collection_m] × 3
}

pub fn cancel_stale_fusion<'info>(ctx: Context<'_, '_, 'info, 'info, CancelStaleFusion<'info>>, _nonce: u64) -> Result<()> {
    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending;
    require!(clock.slot > pending.commit_slot + STALE_PACK_SLOTS, ChipError::NotStale);
    let rnd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())
        .map_err(|_| error!(ChipError::RandomnessMismatch))?;
    // Same rule as cancel_stale_pack: only an un-revealed, expired request can be unwound (SEC-C3).
    require!(rnd.seed_slot == pending.commit_slot, ChipError::RandomnessExpired);
    require!(rnd.reveal_slot == 0, ChipError::RandomnessAlreadyRevealed);

    let rem = ctx.remaining_accounts;
    require!(rem.len() == MATERIALS_PER_FUSION * 4, ChipError::InvalidQuantity);
    let mpl = ctx.accounts.mpl_core.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    let payer = ctx.accounts.owner.to_account_info();
    for m in 0..MATERIALS_PER_FUSION {
        let (asset, state_ai, meta_ai, col_ai) = (&rem[m * 4], &rem[m * 4 + 1], &rem[m * 4 + 2], &rem[m * 4 + 3]);
        require_keys_eq!(asset.key(), pending.materials[m], ChipError::InvalidChipState);
        let mut st: Account<ChipState> = Account::try_from(state_ai)?;
        require_keys_eq!(st.asset, asset.key(), ChipError::InvalidChipState);
        let (exp_meta, bump) = Pubkey::find_program_address(&[b"collection", &[st.collection_idx]], ctx.program_id);
        require_keys_eq!(exp_meta, meta_ai.key(), ChipError::InvalidCollection);
        let meta: Account<CollectionMeta> = Account::try_from(meta_ai)?;
        require_keys_eq!(meta.core_collection, col_ai.key(), ChipError::WrongCollection);
        let seeds: &[&[u8]] = &[b"collection", &[st.collection_idx], &[bump]];
        set_frozen(&mpl, asset, col_ai, meta_ai, &payer, &sys, seeds, false)?;
        st.flags &= !ChipState::F_FUSING;
        st.exit(ctx.program_id)?;
    }
    Ok(())
}

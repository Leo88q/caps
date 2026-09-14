//! Pack purchase and opening with Switchboard On-Demand randomness.
//!
//! Security model (docs/03-architecture.md §2.5):
//!  * Payment is taken at COMMIT time into a program-owned vault. Taking it
//!    at reveal would allow selective revelation (only "open" winners).
//!  * The randomness account must have `seed_slot == slot − 1` and must not
//!    be revealed yet; its key is pinned in PendingPack.
//!  * `open_pack` is permissionless and pure: the outcome is a deterministic
//!    function of the oracle's 32 bytes + on-chain pity state. Who cranks or
//!    when does not matter.
//!  * Assets are PDAs derived from the PendingPack, so a crank never needs to
//!    coordinate keypairs and a retry can't double-mint.
//!  * $CG paid for packs sits in the vault until the reveal; the 75 % burn and
//!    25 % treasury split happen on the last `open_pack`. Hence
//!    `cancel_stale_pack` refunds 100 % in every currency straight from the
//!    vault (no off-chain keeper, no admin key in the loop).
//!  * `sweep_vault` can never take the vault below outstanding liabilities.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use mpl_core::{
    instructions::CreateV2CpiBuilder,
    types::{Attribute, Attributes, PermanentBurnDelegate, PermanentFreezeDelegate, PermanentTransferDelegate, Plugin, PluginAuthority, PluginAuthorityPair},
    ID as MPL_CORE_ID,
};
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};
use switchboard_on_demand::accounts::RandomnessAccountData;

use crate::economy::*;
use crate::errors::ChipError;
use crate::state::*;

pub const DAY: i64 = 86_400;
/// Pyth SOL/USD price feed id (pull oracle).
pub const SOL_USD_FEED_HEX: &str = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/// Pyth SKR/USD (Seeker) price feed id.
pub const SKR_USD_FEED_HEX: &str = "38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9";

/// Token units for `usd_cents` at a Pyth price: units = cents × 10^decimals × 10^|expo| / 100 / price.
pub fn units_for_cents(usd_cents: u64, price: i64, exponent: i32, decimals: u32) -> Result<u64> {
    require!(price > 0, ChipError::StalePrice);
    let scale = 10u128.pow(exponent.unsigned_abs());
    let v = (usd_cents as u128)
        .checked_mul(10u128.pow(decimals)).ok_or(ChipError::Overflow)?
        .checked_mul(scale).ok_or(ChipError::Overflow)? / 100u128 / (price as u128);
    u64::try_from(v).map_err(|_| error!(ChipError::Overflow))
}
/// Rent the buyer pre-funds per chip so any cranker can mint for free:
/// Core base asset (~0.0029 SOL) + ChipState (~0.0016 SOL) + Core protocol fee (0.0015 SOL).
pub const RENT_RESERVE_PER_CHIP: u64 = 6_000_000;

// ---------------------------------------------------------------------------
// buy_pack
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(sku: u8, qty: u8, currency: u8, nonce: u64)]
pub struct BuyPack<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump, constraint = !config.paused @ ChipError::Paused)]
    pub config: Box<Account<'info, GameConfig>>,

    #[account(
        init_if_needed, payer = buyer, space = 8 + PlayerPity::INIT_SPACE,
        seeds = [b"pity", buyer.key().as_ref()], bump
    )]
    pub pity: Box<Account<'info, PlayerPity>>,

    #[account(
        init, payer = buyer, space = 8 + PendingPack::INIT_SPACE,
        seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub pending: Box<Account<'info, PendingPack>>,

    /// CHECK: Switchboard randomness account; parsed manually, must be fresh + unrevealed.
    pub randomness: UncheckedAccount<'info>,

    /// CHECK: program vault PDA (holds SOL, authority of vault token accounts).
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    // --- SOL / SKR path: Pyth price update (SOL/USD or SKR/USD, feed id checked in the handler) ---
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

    // --- SPL path (USDC, $CG or SKR — mint checked in the handler against `currency`) ---
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn buy_pack(ctx: Context<BuyPack>, sku: u8, qty: u8, currency: u8, nonce: u64, max_lamports: u64) -> Result<()> {
    require!((1..=25).contains(&qty), ChipError::InvalidQuantity);
    let sku_e = PackSku::from_u8(sku).ok_or(ChipError::InvalidSku)?;
    let def = ctx.accounts.config.packs[sku as usize];
    require!(def.enabled, ChipError::SkuDisabled);
    let clock = Clock::get()?;

    // --- randomness must be fresh and unknown ---
    let rnd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())
        .map_err(|_| error!(ChipError::RandomnessMismatch))?;
    require!(rnd.seed_slot == clock.slot.saturating_sub(1), ChipError::RandomnessExpired);
    require!(rnd.get_value(clock.slot).is_err(), ChipError::RandomnessAlreadyRevealed);

    // --- per-wallet caps ---
    let pity = &mut ctx.accounts.pity;
    if pity.owner == Pubkey::default() { pity.owner = ctx.accounts.buyer.key(); pity.bump = ctx.bumps.pity; }
    if clock.unix_timestamp - pity.day_start >= DAY { pity.day_start = clock.unix_timestamp; pity.bought_today = [0; 4]; }
    if sku_e == PackSku::Starter {
        require!(!pity.starter_claimed && qty == 1, ChipError::StarterAlreadyClaimed);
        pity.starter_claimed = true;
    }
    if def.daily_cap > 0 {
        let after = pity.bought_today[sku as usize].checked_add(qty).ok_or(ChipError::Overflow)?;
        require!(after <= def.daily_cap, ChipError::DailyCapReached);
        pity.bought_today[sku as usize] = after;
    }

    // --- price ---
    let mut discount = if matches!(sku_e, PackSku::Limited | PackSku::Starter) { 0 } else { bundle_discount_bps(qty) };
    // SKR promo: stacks additively with bundle discounts, total capped at 30 %
    if currency == 3 { discount = (discount + ctx.accounts.config.skr_discount_bps).min(3_000); }
    let usd_cents = (def.price_usd_cents as u64)
        .checked_mul(qty as u64).ok_or(ChipError::Overflow)?
        .checked_mul((BPS_DENOM as u16 - discount) as u64).ok_or(ChipError::Overflow)? / BPS_DENOM as u64;

    // --- rent reserve so any cranker can open the pack ---
    let rent_reserve = RENT_RESERVE_PER_CHIP
        .checked_mul(def.chips as u64).ok_or(ChipError::Overflow)?
        .checked_mul(qty as u64).ok_or(ChipError::Overflow)?;
    system_program::transfer(
        CpiContext::new(ctx.accounts.system_program.to_account_info(), system_program::Transfer {
            from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.pending.to_account_info(),
        }),
        rent_reserve,
    )?;

    let spl_pay = |mint: Pubkey, amount: u64| -> Result<()> {
        let from = ctx.accounts.buyer_token.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx.accounts.vault_token.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
        require_keys_eq!(from.mint, mint, ChipError::CurrencyNotAccepted);
        require_keys_eq!(to.mint, mint, ChipError::CurrencyNotAccepted);
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), token::Transfer {
            from: from.to_account_info(), to: to.to_account_info(), authority: ctx.accounts.buyer.to_account_info(),
        }), amount)
    };

    let (paid_lamports, paid_usdc, paid_cg, paid_skr) = match currency {
        0 => {
            let pu = ctx.accounts.price_update.as_ref().ok_or(ChipError::StalePrice)?;
            let feed = get_feed_id_from_hex(SOL_USD_FEED_HEX).map_err(|_| error!(ChipError::StalePrice))?;
            let p = pu.get_price_no_older_than(&clock, SOL_PRICE_MAX_AGE_SECS, &feed).map_err(|_| error!(ChipError::StalePrice))?;
            let lamports = units_for_cents(usd_cents, p.price, p.exponent, 9)?;
            require!(lamports <= max_lamports, ChipError::Slippage);
            system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(), system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.vault.to_account_info(),
                }),
                lamports,
            )?;
            (lamports, 0, 0, 0)
        }
        1 => {
            let amount = usd_cents.checked_mul(10_000).ok_or(ChipError::Overflow)?; // cents → micro-USDC
            spl_pay(ctx.accounts.config.usdc_mint, amount)?;
            (0, amount, 0, 0)
        }
        2 => {
            require!(def.price_cg_micro > 0, ChipError::CurrencyNotAccepted);
            let amount = def.price_cg_micro.checked_mul(qty as u64).ok_or(ChipError::Overflow)?
                .checked_mul((BPS_DENOM as u16 - discount) as u64).ok_or(ChipError::Overflow)? / BPS_DENOM as u64;
            spl_pay(ctx.accounts.config.cg_mint, amount)?;
            (0, 0, amount, 0)
        }
        3 => {
            // Seeker: volatile → priced through Pyth SKR/USD; `max_lamports` doubles as the max-SKR slippage guard
            require!(ctx.accounts.config.skr_mint != Pubkey::default(), ChipError::CurrencyNotAccepted);
            let pu = ctx.accounts.price_update.as_ref().ok_or(ChipError::StalePrice)?;
            let feed = get_feed_id_from_hex(SKR_USD_FEED_HEX).map_err(|_| error!(ChipError::StalePrice))?;
            let p = pu.get_price_no_older_than(&clock, SOL_PRICE_MAX_AGE_SECS, &feed).map_err(|_| error!(ChipError::StalePrice))?;
            let amount = units_for_cents(usd_cents, p.price, p.exponent, 6)?;
            require!(amount <= max_lamports, ChipError::Slippage);
            spl_pay(ctx.accounts.config.skr_mint, amount)?;
            (0, 0, 0, amount)
        }
        _ => return err!(ChipError::CurrencyNotAccepted),
    };

    // liabilities: what the vault owes if every pending pack were cancelled
    let cfg = &mut ctx.accounts.config;
    cfg.liab_lamports = cfg.liab_lamports.checked_add(paid_lamports).ok_or(ChipError::Overflow)?;
    cfg.liab_usdc = cfg.liab_usdc.checked_add(paid_usdc).ok_or(ChipError::Overflow)?;
    cfg.liab_cg = cfg.liab_cg.checked_add(paid_cg).ok_or(ChipError::Overflow)?;
    cfg.liab_skr = cfg.liab_skr.checked_add(paid_skr).ok_or(ChipError::Overflow)?;

    let pending = &mut ctx.accounts.pending;
    pending.buyer = ctx.accounts.buyer.key();
    pending.sku = sku;
    pending.qty = qty;
    pending.opened = 0;
    pending.randomness = ctx.accounts.randomness.key();
    pending.commit_slot = rnd.seed_slot;
    pending.paid_lamports = paid_lamports;
    pending.paid_usdc = paid_usdc;
    pending.paid_cg = paid_cg;
    pending.paid_skr = paid_skr;
    pending.pity_snapshot = pity.counters[sku as usize];
    pending.nonce = nonce;
    pending.bump = ctx.bumps.pending;

    emit!(PackBought {
        buyer: pending.buyer, sku, qty, currency,
        amount: paid_lamports.max(paid_usdc).max(paid_cg).max(paid_skr), nonce, randomness: pending.randomness,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// open_pack — one pack (≤ 5 chips) per call; a bundle of N is N sequential
// calls (pack_no must equal `pending.opened`). Each pack derives its own
// 32-byte sub-seed from the single oracle value.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64, pack_no: u8)]
pub struct OpenPack<'info> {
    /// Anyone may crank. Rent for new accounts is fronted by the cranker and
    /// reimbursed from the PendingPack's pre-funded reserve in the same ix.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,

    #[account(
        mut,
        seeds = [b"pending", pending.buyer.as_ref(), &nonce.to_le_bytes()], bump = pending.bump,
        constraint = pending.randomness == randomness.key() @ ChipError::RandomnessMismatch,
        constraint = pack_no == pending.opened && pack_no < pending.qty @ ChipError::InvalidQuantity,
    )]
    pub pending: Box<Account<'info, PendingPack>>,

    /// CHECK: pinned by the constraint above; parsed manually.
    pub randomness: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"pity", pending.buyer.as_ref()], bump = pity.bump)]
    pub pity: Box<Account<'info, PlayerPity>>,

    /// CHECK: receives the minted assets.
    #[account(mut, address = pending.buyer)]
    pub buyer: UncheckedAccount<'info>,

    /// CHECK: vault PDA — signs the $CG burn/split on the final pack.
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.cg_mint)]
    pub cg_mint: Option<Account<'info, Mint>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = vault)]
    pub vault_cg: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.cg_mint, token::authority = config.treasury)]
    pub treasury_cg: Option<Account<'info, TokenAccount>>,

    /// CHECK: Metaplex Core program.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts — for chip i in 0..def.chips, 4 accounts each:
    //   asset_i          PDA ["asset", pending, pack_no, i]     (mut)
    //   chip_state_i     PDA ["chip", asset_i]                  (mut)
    //   collection_meta  PDA ["collection", rolled_idx]          (mut)  ← rolled index, client pre-simulates
    //   core_collection  CollectionMeta.core_collection          (mut)
    // Because collection is chosen by the randomness, the client (crank)
    // simulates `expand()` off-chain with the revealed value to know which
    // collection accounts to pass; the program re-derives and verifies.
}

pub fn open_pack<'info>(ctx: Context<'_, '_, 'info, 'info, OpenPack<'info>>, nonce: u64, pack_no: u8) -> Result<()> {
    let clock = Clock::get()?;
    let def = ctx.accounts.config.packs[ctx.accounts.pending.sku as usize];
    let pending_key = ctx.accounts.pending.key();
    let sku = ctx.accounts.pending.sku as usize;
    let qty = ctx.accounts.pending.qty;

    let rnd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())
        .map_err(|_| error!(ChipError::RandomnessMismatch))?;
    require!(rnd.seed_slot == ctx.accounts.pending.commit_slot, ChipError::RandomnessExpired);
    let base: [u8; 32] = rnd.get_value(clock.slot).map_err(|_| error!(ChipError::RandomnessNotResolved))?;

    let bytes: [u8; 32] = if qty == 1 { base } else {
        anchor_lang::solana_program::keccak::hashv(&[&base, &[pack_no]]).to_bytes()
    };

    let pool: Vec<u8> = if def.featured_only { vec![ctx.accounts.config.featured_collection] }
        else { (0..ctx.accounts.config.collections_created).collect() };
    require!(!pool.is_empty(), ChipError::InvalidCollection);

    let pity_before = ctx.accounts.pity.counters[sku];
    let rolled = expand(&bytes, &def, pity_before, &pool);

    let chips = def.chips as usize;
    require!(ctx.remaining_accounts.len() == chips * 4, ChipError::InvalidQuantity);

    let mut assets = [Pubkey::default(); MAX_CHIPS_PER_PACK];
    let mut rarities = [0u8; MAX_CHIPS_PER_PACK];
    let mut cols = [0u8; MAX_CHIPS_PER_PACK];
    let mut got_pity_tier = false;
    let payer_before = ctx.accounts.payer.lamports();
    let soulbound = sku == PackSku::Starter as usize;

    for i in 0..chips {
        let r = rolled[i].ok_or(ChipError::Overflow)?;
        let acc = &ctx.remaining_accounts[i * 4..i * 4 + 4];
        let (asset_ai, chip_state_ai, col_meta_ai, core_collection) = (&acc[0], &acc[1], &acc[2], &acc[3]);

        // asset PDA
        let (exp_asset, asset_bump) = Pubkey::find_program_address(
            &[b"asset", pending_key.as_ref(), &[pack_no], &[i as u8]], ctx.program_id);
        require_keys_eq!(exp_asset, asset_ai.key(), ChipError::InvalidChipState);
        require!(asset_ai.data_is_empty(), ChipError::InvalidChipState); // idempotency: never re-mint

        // collection meta for the rolled index
        let (exp_meta, _) = Pubkey::find_program_address(&[b"collection", &[r.collection_idx]], ctx.program_id);
        require_keys_eq!(exp_meta, col_meta_ai.key(), ChipError::InvalidCollection);
        let mut col_meta: Account<CollectionMeta> = Account::try_from(col_meta_ai)?;
        require_keys_eq!(col_meta.core_collection, core_collection.key(), ChipError::WrongCollection);

        col_meta.minted = col_meta.minted.checked_add(1).ok_or(ChipError::Overflow)?;
        let ri = r.rarity.index() as usize;
        col_meta.minted_by_rarity[ri] = col_meta.minted_by_rarity[ri].checked_add(1).ok_or(ChipError::Overflow)?;
        let index = col_meta.minted;

        // --- Core asset ---
        let name = format!("{} #{}", col_meta.symbol, index);
        let uri = format!("https://cdn.guttercaps.gg/m/{}/{}.json", col_meta.idx, ri);
        let meta_bump = col_meta.bump;
        let meta_idx = col_meta.idx;
        let plugins = vec![
            PluginAuthorityPair { plugin: Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: soulbound }), authority: Some(PluginAuthority::UpdateAuthority) },
            PluginAuthorityPair { plugin: Plugin::PermanentBurnDelegate(PermanentBurnDelegate {}), authority: Some(PluginAuthority::UpdateAuthority) },
            // lets the market deliver a sold (frozen-in-place) chip without a second seller signature
            PluginAuthorityPair { plugin: Plugin::PermanentTransferDelegate(PermanentTransferDelegate {}), authority: Some(PluginAuthority::UpdateAuthority) },
            PluginAuthorityPair { plugin: Plugin::Attributes(Attributes { attribute_list: vec![
                Attribute { key: "district".into(), value: meta_idx.to_string() },
                Attribute { key: "rarity".into(), value: ri.to_string() },
                Attribute { key: "index".into(), value: index.to_string() },
                Attribute { key: "level".into(), value: "1".into() },
            ]}), authority: Some(PluginAuthority::UpdateAuthority) },
        ];
        let asset_seeds: &[&[u8]] = &[b"asset", pending_key.as_ref(), &[pack_no], &[i as u8], &[asset_bump]];
        let meta_seeds: &[&[u8]] = &[b"collection", &[meta_idx], &[meta_bump]];
        CreateV2CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
            .asset(asset_ai)
            .collection(Some(core_collection))
            .authority(Some(col_meta_ai))
            .payer(&ctx.accounts.payer.to_account_info())
            .owner(Some(&ctx.accounts.buyer.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .name(name)
            .uri(uri)
            .plugins(plugins)
            .invoke_signed(&[asset_seeds, meta_seeds])?;

        // --- ChipState PDA ---
        let (exp_state, state_bump) = Pubkey::find_program_address(&[b"chip", asset_ai.key().as_ref()], ctx.program_id);
        require_keys_eq!(exp_state, chip_state_ai.key(), ChipError::InvalidChipState);
        let space = 8 + ChipState::INIT_SPACE;
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount { from: ctx.accounts.payer.to_account_info(), to: chip_state_ai.clone() },
                &[&[b"chip", asset_ai.key().as_ref(), &[state_bump]]],
            ),
            Rent::get()?.minimum_balance(space), space as u64, ctx.program_id,
        )?;
        let state = ChipState {
            asset: asset_ai.key(), collection_idx: r.collection_idx, rarity: r.rarity, level: 1, index,
            flags: if soulbound { ChipState::F_SOULBOUND } else { 0 },
            lock_until: if soulbound { clock.unix_timestamp + 7 * DAY } else { 0 },
            minted_at: clock.unix_timestamp, bump: state_bump,
        };
        {
            let mut data = chip_state_ai.try_borrow_mut_data()?;
            data[..8].copy_from_slice(ChipState::DISCRIMINATOR);
            state.serialize(&mut &mut data[8..])?;
        }
        col_meta.exit(ctx.program_id)?;

        assets[i] = asset_ai.key(); rarities[i] = ri as u8; cols[i] = r.collection_idx;
        if def.pity_tier > 0 && ri as u8 >= def.pity_tier { got_pity_tier = true; }
    }

    // --- pity ---
    if def.pity_tier > 0 {
        let p = &mut ctx.accounts.pity;
        p.counters[sku] = if got_pity_tier { 0 } else { p.counters[sku].saturating_add(1) };
    }
    let pity_after = ctx.accounts.pity.counters[sku];

    // --- reimburse cranker for rent spent (bounded by the reserve) ---
    let spent = payer_before.saturating_sub(ctx.accounts.payer.lamports());
    let reimburse = spent.min(RENT_RESERVE_PER_CHIP * chips as u64);
    {
        let pending_ai = ctx.accounts.pending.to_account_info();
        let payer_ai = ctx.accounts.payer.to_account_info();
        **pending_ai.try_borrow_mut_lamports()? -= reimburse;
        **payer_ai.try_borrow_mut_lamports()? += reimburse;
    }

    emit!(PackOpened {
        buyer: ctx.accounts.buyer.key(), sku: sku as u8, nonce, assets, rarities, collections: cols,
        count: chips as u8, roll: bytes, pity_before, pity_after,
    });

    let pending = &mut ctx.accounts.pending;
    pending.opened += 1;

    if pending.opened == pending.qty {
        // settle currency + liabilities, then close
        let (pl, pu, pc, ps) = (pending.paid_lamports, pending.paid_usdc, pending.paid_cg, pending.paid_skr);
        let cfg = &mut ctx.accounts.config;
        cfg.liab_lamports -= pl; cfg.liab_usdc -= pu; cfg.liab_cg -= pc; cfg.liab_skr -= ps;
        if pc > 0 {
            let burn = pc.checked_mul(CG_PACK_BURN_BPS as u64).ok_or(ChipError::Overflow)? / BPS_DENOM as u64;
            let vault_seeds: &[&[u8]] = &[b"vault", &[cfg.vault_bump]];
            let mint = ctx.accounts.cg_mint.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
            let from = ctx.accounts.vault_cg.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
            let to = ctx.accounts.treasury_cg.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
            token::burn(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), token::Burn {
                mint: mint.to_account_info(), from: from.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
            }, &[vault_seeds]), burn)?;
            token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), token::Transfer {
                from: from.to_account_info(), to: to.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
            }, &[vault_seeds]), pc - burn)?;
            cfg.burned_total = cfg.burned_total.saturating_add(burn);
            emit!(BurnReported { source: 0, amount: burn });
        }
        // close PendingPack: leftover reserve + rent → buyer
        let pending_ai = ctx.accounts.pending.to_account_info();
        let buyer_ai = ctx.accounts.buyer.to_account_info();
        let lam = pending_ai.lamports();
        **pending_ai.try_borrow_mut_lamports()? = 0;
        **buyer_ai.try_borrow_mut_lamports()? += lam;
        pending_ai.assign(&system_program::ID);
        pending_ai.realloc(0, false)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// cancel_stale_pack — oracle never revealed → 100 % refund from the vault.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CancelStalePack<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut, close = buyer,
        seeds = [b"pending", buyer.key().as_ref(), &nonce.to_le_bytes()], bump = pending.bump,
        has_one = buyer @ ChipError::Unauthorized,
        constraint = pending.opened == 0 @ ChipError::InvalidChipState,
    )]
    pub pending: Box<Account<'info, PendingPack>>,
    /// CHECK: pinned in pending
    #[account(address = pending.randomness)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: vault PDA
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = buyer)]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_stale_pack(ctx: Context<CancelStalePack>, _nonce: u64) -> Result<()> {
    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending;
    require!(clock.slot > pending.commit_slot + STALE_PACK_SLOTS, ChipError::NotStale);
    let rnd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())
        .map_err(|_| error!(ChipError::RandomnessMismatch))?;
    // A revealed pack must be opened, never refunded. `get_value()` only succeeds in the reveal
    // slot itself, so it cannot tell "revealed earlier" from "never revealed" — check the
    // persisted `reveal_slot` instead, and pin the account to the commit we paid for (SEC-C3).
    require!(rnd.seed_slot == pending.commit_slot, ChipError::RandomnessExpired);
    require!(rnd.reveal_slot == 0, ChipError::RandomnessAlreadyRevealed);

    let (pl, pu, pc, ps) = (pending.paid_lamports, pending.paid_usdc, pending.paid_cg, pending.paid_skr);
    let vault_seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];

    if pl > 0 {
        **ctx.accounts.vault.try_borrow_mut_lamports()? -= pl;
        **ctx.accounts.buyer.try_borrow_mut_lamports()? += pl;
    }
    let spl_amount = pu.max(pc).max(ps);
    if spl_amount > 0 {
        let from = ctx.accounts.vault_token.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
        let to = ctx.accounts.buyer_token.as_ref().ok_or(ChipError::CurrencyNotAccepted)?;
        let expected_mint = if pu > 0 { ctx.accounts.config.usdc_mint } else if ps > 0 { ctx.accounts.config.skr_mint } else { ctx.accounts.config.cg_mint };
        require_keys_eq!(from.mint, expected_mint, ChipError::CurrencyNotAccepted);
        require_keys_eq!(to.mint, expected_mint, ChipError::CurrencyNotAccepted);
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), token::Transfer {
            from: from.to_account_info(), to: to.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
        }, &[vault_seeds]), spl_amount)?;
    }
    let cfg = &mut ctx.accounts.config;
    cfg.liab_lamports -= pl; cfg.liab_usdc -= pu; cfg.liab_cg -= pc; cfg.liab_skr -= ps;

    emit!(PackCancelled { buyer: pending.buyer, nonce: pending.nonce, refunded: pl.max(spl_amount) });
    Ok(())
}

// ---------------------------------------------------------------------------
// sweep_vault — admin moves settled revenue to the treasury, never below
// outstanding liabilities (pending-pack refunds).
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SweepVault<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ChipError::Unauthorized, has_one = treasury)]
    pub config: Box<Account<'info, GameConfig>>,
    /// CHECK: vault PDA
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: treasury (Squads vault)
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// Optional SPL leg: USDC or SKR vault ATA (mint decides which liability applies).
    #[account(mut, token::authority = vault)]
    pub vault_token: Option<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = treasury)]
    pub treasury_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn sweep_vault(ctx: Context<SweepVault>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let rent_floor = Rent::get()?.minimum_balance(0);
    let free_lamports = ctx.accounts.vault.lamports()
        .saturating_sub(cfg.liab_lamports).saturating_sub(rent_floor);
    if free_lamports > 0 {
        **ctx.accounts.vault.try_borrow_mut_lamports()? -= free_lamports;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += free_lamports;
    }
    if let (Some(from), Some(to)) = (ctx.accounts.vault_token.as_ref(), ctx.accounts.treasury_token.as_ref()) {
        require_keys_eq!(from.mint, to.mint, ChipError::CurrencyNotAccepted);
        let liab = if from.mint == cfg.usdc_mint { cfg.liab_usdc } else if from.mint == cfg.skr_mint { cfg.liab_skr } else { return err!(ChipError::CurrencyNotAccepted) };
        let free = from.amount.saturating_sub(liab);
        if free > 0 {
            let seeds: &[&[u8]] = &[b"vault", &[cfg.vault_bump]];
            token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), token::Transfer {
                from: from.to_account_info(), to: to.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
            }, &[seeds]), free)?;
        }
    }
    Ok(())
}

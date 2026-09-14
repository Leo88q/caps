//! GUTTERCAPS — chip_core
//!
//! Registry of the 10 district collections (Metaplex Core), VRF pack sales
//! with pity, fusion, and the ChipState PDA that market/staking/arena rely
//! on. See docs/03-architecture.md §2 for the design and threat model.
//!
//! Program IDs below are placeholders until first deploy (`anchor keys sync`).

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod economy;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q");

#[program]
pub mod chip_core {
    use super::*;

    // ----- admin -----
    pub fn initialize(ctx: Context<Initialize>, args: InitArgs) -> Result<()> { instructions::initialize(ctx, args) }
    pub fn create_collection(ctx: Context<CreateCollection>, idx: u8, symbol: String, name: String, uri: String, element: u8) -> Result<()> {
        instructions::create_collection(ctx, idx, symbol, name, uri, element)
    }
    pub fn set_params(ctx: Context<AdminOnly>, patch: ParamsPatch) -> Result<()> { instructions::set_params(ctx, patch) }
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> { instructions::set_paused(ctx, paused) }
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> { instructions::propose_admin(ctx, new_admin) }
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> { instructions::accept_admin(ctx) }
    pub fn sweep_vault(ctx: Context<SweepVault>) -> Result<()> { instructions::sweep_vault(ctx) }
    pub fn grant_booster(ctx: Context<GrantBooster>, count: u16) -> Result<()> { instructions::grant_booster(ctx, count) }

    // ----- packs -----
    /// currency: 0 SOL (needs price_update SOL/USD), 1 USDC, 2 $CG, 3 SKR (needs price_update SKR/USD).
    /// `max_lamports` = slippage guard for volatile currencies (max lamports / max micro-SKR).
    pub fn buy_pack(ctx: Context<BuyPack>, sku: u8, qty: u8, currency: u8, nonce: u64, max_lamports: u64) -> Result<()> {
        instructions::buy_pack(ctx, sku, qty, currency, nonce, max_lamports)
    }
    pub fn open_pack<'info>(ctx: Context<'_, '_, 'info, 'info, OpenPack<'info>>, nonce: u64, pack_no: u8) -> Result<()> {
        instructions::open_pack(ctx, nonce, pack_no)
    }
    pub fn cancel_stale_pack(ctx: Context<CancelStalePack>, nonce: u64) -> Result<()> { instructions::cancel_stale_pack(ctx, nonce) }

    // ----- paid services (handles, cosmetics, boosters, season pass) -----
    /// kind: economy::ServiceKind; currency as in buy_pack; $CG is burned, everything else → treasury.
    pub fn pay_service(ctx: Context<PayService>, kind: u8, currency: u8, max_units: u64, ref_hash: [u8; 32]) -> Result<()> {
        instructions::pay_service(ctx, kind, currency, max_units, ref_hash)
    }

    // ----- fusion -----
    pub fn fuse<'info>(ctx: Context<'_, '_, 'info, 'info, Fuse<'info>>, nonce: u64, use_booster: bool) -> Result<()> {
        instructions::fuse(ctx, nonce, use_booster)
    }
    pub fn fuse_reveal<'info>(ctx: Context<'_, '_, 'info, 'info, FuseReveal<'info>>, nonce: u64) -> Result<()> {
        instructions::fuse_reveal(ctx, nonce)
    }
    pub fn cancel_stale_fusion<'info>(ctx: Context<'_, '_, 'info, 'info, CancelStaleFusion<'info>>, nonce: u64) -> Result<()> {
        instructions::cancel_stale_fusion(ctx, nonce)
    }

    // ----- chip state (CPI from market/staking/arena + player thaw) -----
    pub fn set_chip_flag(ctx: Context<SetChipFlag>, flag: u8, set: bool, expected_owner: Pubkey) -> Result<()> {
        instructions::set_chip_flag(ctx, flag, set, expected_owner)
    }
    pub fn deliver_sold(ctx: Context<DeliverSold>, expected_seller: Pubkey) -> Result<()> { instructions::deliver_sold(ctx, expected_seller) }
    pub fn thaw_chip(ctx: Context<ThawChip>) -> Result<()> { instructions::thaw_chip(ctx) }
    pub fn level_up(ctx: Context<LevelUp>, levels: u8) -> Result<()> { instructions::level_up(ctx, levels) }
}

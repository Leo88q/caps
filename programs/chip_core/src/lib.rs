//! GUTTERCAPS — chip_core
//!
//! Registry of the 10 district collections (Metaplex Core), VRF pack sales
//! with pity, fusion, and the ChipState PDA that market/staking/arena rely
//! on. See docs/03-architecture.md §2 for the design and threat model.
//!
//! Program IDs below are placeholders until first deploy (`anchor keys sync`).

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod bubblegum;
pub mod economy;
pub mod errors;
pub mod instructions;
pub mod pyth;
pub mod randomness;
pub mod state;

use bubblegum::LeafProofArgs;
use instructions::*;

declare_id!("GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q");

/// Metaplex Bubblegum V2 program id. Kept explicit instead of accepting an
/// arbitrary CPI target; all tree configuration and later leaf mutations use
/// this address.
pub const BUBBLEGUM_V2_ID: Pubkey = pubkey!("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");

#[program]
pub mod chip_core {
    use super::*;

    // ----- admin -----
    pub fn initialize(ctx: Context<Initialize>, args: InitArgs) -> Result<()> {
        instructions::initialize(ctx, args)
    }
    pub fn create_collection(
        ctx: Context<CreateCollection>,
        idx: u8,
        symbol: String,
        name: String,
        uri: String,
        element: u8,
    ) -> Result<()> {
        instructions::create_collection(ctx, idx, symbol, name, uri, element)
    }
    /// Create a Bubblegum V2 tree config with the collection PDA as the tree
    /// creator/delegate and store the immutable deployment binding.
    pub fn create_bubblegum_tree(
        ctx: Context<CreateBubblegumTree>,
        idx: u8,
        max_depth: u8,
        canopy: u8,
        max_buffer_size: u32,
    ) -> Result<()> {
        instructions::create_bubblegum_tree(ctx, idx, max_depth, canopy, max_buffer_size)
    }
    /// Bind an externally-created Bubblegum V2 tree and its Bubblegum-owned
    /// tree config to a registered MPL-Core collection.
    pub fn configure_bubblegum_tree(
        ctx: Context<ConfigureBubblegumTree>,
        idx: u8,
        max_depth: u8,
        canopy: u8,
    ) -> Result<()> {
        instructions::configure_bubblegum_tree(ctx, idx, max_depth, canopy)
    }
    pub fn set_params(ctx: Context<AdminOnly>, patch: ParamsPatch) -> Result<()> {
        instructions::set_params(ctx, patch)
    }
    /// Admin-authorized staging record for one compressed mint result. The
    /// production pack path will create this claim atomically with its roll.
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
        instructions::stage_compressed_chip(
            ctx,
            buyer,
            collection_idx,
            claim_nonce,
            rarity,
            level,
            game_index,
            expires_at,
        )
    }
    /// Stage one deterministic result from a paid PendingPack. Payment remains
    /// escrowed until every Bubblegum claim is registered from DAS.
    pub fn stage_compressed_chip_from_pack(
        ctx: Context<StageCompressedChipFromPack>,
        nonce: u64,
        pack_no: u8,
        chip_no: u8,
        claim_nonce: u64,
        collection_idx: u8,
    ) -> Result<()> {
        instructions::stage_compressed_chip_from_pack(
            ctx,
            nonce,
            pack_no,
            chip_no,
            claim_nonce,
            collection_idx,
        )
    }
    /// Bubblegum V2 mint CPI for a staged claim. The leaf index is intentionally
    /// resolved from the finalized DAS event after this instruction.
    pub fn mint_compressed_chip(
        ctx: Context<MintCompressedChip>,
        buyer: Pubkey,
        collection_idx: u8,
        claim_nonce: u64,
    ) -> Result<()> {
        instructions::mint_compressed_chip(ctx, buyer, collection_idx, claim_nonce)
    }
    /// Permissionless, proof-backed registration of a Bubblegum V2 leaf into
    /// Core's game-state projection. The remaining accounts are the bounded
    /// Account Compression proof nodes and the one-time claim is closed only
    /// after successful verification.
    pub fn finalize_compressed_pack(
        ctx: Context<FinalizeCompressedPack>,
        nonce: u64,
    ) -> Result<()> {
        instructions::finalize_compressed_pack(ctx, nonce)
    }
    /// Refund a migrated purchase that never reached the first staging claim
    /// after the permissionless long timeout.
    pub fn cancel_unstaged_compressed_pack(
        ctx: Context<CancelUnstagedCompressedPack>,
        nonce: u64,
    ) -> Result<()> {
        instructions::cancel_unstaged_compressed_pack(ctx, nonce)
    }
    /// Refund a Bubblegum pack after every staged claim expired without a
    /// successful mint. Claims with any minted leaf are deliberately ineligible;
    /// they must complete proof-backed registration instead.
    pub fn cancel_compressed_pack(ctx: Context<CancelCompressedPack>, nonce: u64) -> Result<()> {
        instructions::cancel_compressed_pack(ctx, nonce)
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
        instructions::register_compressed_chip(
            ctx,
            asset_id,
            collection_idx,
            owner,
            delegate,
            buyer,
            claim_nonce,
            proof,
            rarity,
            level,
            game_index,
        )
    }
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::set_paused(ctx, paused)
    }
    pub fn set_pauser(ctx: Context<AdminOnly>, pauser: Pubkey) -> Result<()> {
        instructions::set_pauser(ctx, pauser)
    }
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause(ctx)
    }
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::propose_admin(ctx, new_admin)
    }
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin(ctx)
    }
    /// remaining_accounts = the LEDGER_SHARDS `VaultLedger` PDAs in order (#12)
    pub fn sweep_vault<'info>(ctx: Context<'_, '_, 'info, 'info, SweepVault<'info>>) -> Result<()> {
        instructions::sweep_vault(ctx)
    }
    /// Permissionless: creates ledger shard `shard` (< LEDGER_SHARDS) once (#12).
    pub fn init_ledger(ctx: Context<InitLedger>, shard: u8) -> Result<()> {
        instructions::init_ledger(ctx, shard)
    }
    pub fn grant_booster(ctx: Context<GrantBooster>, count: u16) -> Result<()> {
        instructions::grant_booster(ctx, count)
    }

    // ----- packs -----
    /// currency: 0 SOL (needs price_update SOL/USD), 1 USDC, 2 $CG, 3 SKR (needs price_update SKR/USD).
    /// `max_lamports` = slippage guard for volatile currencies (max lamports / max micro-SKR).
    pub fn buy_pack(
        ctx: Context<BuyPack>,
        sku: u8,
        qty: u8,
        currency: u8,
        nonce: u64,
        max_lamports: u64,
    ) -> Result<()> {
        instructions::buy_pack(ctx, sku, qty, currency, nonce, max_lamports)
    }
    pub fn open_pack<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenPack<'info>>,
        nonce: u64,
        pack_no: u8,
    ) -> Result<()> {
        instructions::open_pack(ctx, nonce, pack_no)
    }
    pub fn cancel_stale_pack(ctx: Context<CancelStalePack>, nonce: u64) -> Result<()> {
        instructions::cancel_stale_pack(ctx, nonce)
    }
    /// (#28) Quest chip voucher: a free 1-chip PendingPack (`template` = economy::VOUCHER_DEFS index) for
    /// `beneficiary`, issued only by the staking program's `["rewarder"]` PDA (CPI from `claim_chip_root`).
    /// Same tx as `init_randomness(0, nonce)`; opened by the regular `open_pack` crank.
    pub fn open_voucher(ctx: Context<OpenVoucher>, nonce: u64, template: u8) -> Result<()> {
        instructions::open_voucher(ctx, nonce, template)
    }

    // ----- program-owned Switchboard randomness (SEC-C3 part 2) -----
    /// kind: 0 pack, 1 fusion. Creates PDA `["rng", kind, owner, nonce]` with authority `["rng_auth"]`
    /// via CPI `randomness_init`; must be in the same tx as `buy_pack` / `fuse` (they commit).
    pub fn init_randomness(
        ctx: Context<InitRandomness>,
        kind: u8,
        nonce: u64,
        recent_slot: u64,
    ) -> Result<()> {
        instructions::init_randomness(ctx, kind, nonce, recent_slot)
    }
    /// Permissionless relay of the oracle's reveal (gateway response) — CPI `randomness_reveal` signed by `rng_auth`.
    pub fn reveal_randomness(
        ctx: Context<RevealRandomness>,
        signature: [u8; 64],
        recovery_id: u8,
        value: [u8; 32],
    ) -> Result<()> {
        instructions::reveal_randomness(ctx, signature, recovery_id, value)
    }
    /// Permissionless; only after the pending pack/fusion is gone. Rent → player (SEC-M7).
    pub fn close_randomness(ctx: Context<CloseRandomness>, kind: u8, nonce: u64) -> Result<()> {
        instructions::close_randomness(ctx, kind, nonce)
    }

    // ----- paid services (handles, cosmetics, boosters, season pass) -----
    /// kind: economy::ServiceKind; currency as in buy_pack; $CG is burned, everything else → treasury.
    pub fn pay_service(
        ctx: Context<PayService>,
        kind: u8,
        currency: u8,
        max_units: u64,
        ref_hash: [u8; 32],
    ) -> Result<()> {
        instructions::pay_service(ctx, kind, currency, max_units, ref_hash)
    }

    // ----- fusion -----
    pub fn fuse<'info>(
        ctx: Context<'_, '_, 'info, 'info, Fuse<'info>>,
        nonce: u64,
        use_booster: bool,
    ) -> Result<()> {
        instructions::fuse(ctx, nonce, use_booster)
    }
    pub fn fuse_reveal<'info>(
        ctx: Context<'_, '_, 'info, 'info, FuseReveal<'info>>,
        nonce: u64,
    ) -> Result<()> {
        instructions::fuse_reveal(ctx, nonce)
    }
    pub fn cancel_stale_fusion<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelStaleFusion<'info>>,
        nonce: u64,
    ) -> Result<()> {
        instructions::cancel_stale_fusion(ctx, nonce)
    }

    // ----- chip state (CPI from market/staking/arena + player thaw) -----
    pub fn set_chip_flag(
        ctx: Context<SetChipFlag>,
        flag: u8,
        set: bool,
        expected_owner: Pubkey,
    ) -> Result<()> {
        instructions::set_chip_flag(ctx, flag, set, expected_owner)
    }
    pub fn deliver_sold(ctx: Context<DeliverSold>, expected_seller: Pubkey) -> Result<()> {
        instructions::deliver_sold(ctx, expected_seller)
    }
    pub fn thaw_chip(ctx: Context<ThawChip>) -> Result<()> {
        instructions::thaw_chip(ctx)
    }
    pub fn level_up(ctx: Context<LevelUp>, levels: u8) -> Result<()> {
        instructions::level_up(ctx, levels)
    }
}

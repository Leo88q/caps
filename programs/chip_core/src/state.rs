use anchor_lang::prelude::*;
use crate::economy::{PackDef, Rarity, RARITY_COUNT, MAX_CHIPS_PER_PACK, MATERIALS_PER_FUSION};

/// Global config. Single PDA `["config"]`. Admin is expected to be a Squads
/// multisig; every tunable is validated by `set_params` against the
/// guard-rails in `economy.rs` so a compromised admin key can't turn a pack
/// into a Legend faucet or set a 90 % fee.
#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,        // 2-step admin transfer
    pub treasury: Pubkey,             // SOL/USDC destination (Squads vault)
    pub buyback_wallet: Pubkey,       // receives the "burn" half of SOL/USDC fees → weekly $CG buyback+burn
    pub cg_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub skr_mint: Pubkey,             // Seeker (Solana Mobile) — SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3 on mainnet
    pub staking_program: Pubkey,      // for report_burn CPI
    pub pyth_sol_usd_feed: Pubkey,
    pub pyth_skr_usd_feed: Pubkey,
    pub featured_collection: u8,      // for Limited packs
    pub paused: bool,
    pub packs: [PackDef; 4],
    pub market_fee_bps: u16,
    pub skr_discount_bps: u16,        // promo discount for packs paid in SKR (≤ MAX_SKR_DISCOUNT_BPS)
    pub collections_created: u8,
    /// outstanding refund liabilities held in the vault (pending, unrevealed packs)
    pub liab_lamports: u64,
    pub liab_usdc: u64,
    pub liab_cg: u64,
    pub liab_skr: u64,
    /// running total of $CG burned by this program (packs + fusion), for analytics/guards
    pub burned_total: u64,
    pub params_version: u32,
    pub vault_bump: u8,
    pub bump: u8,
    /// SEC-H2: hot key (Squads 1/3, no timelock) allowed to call `pause` only — it can stop the
    /// game within minutes of an alert; lifting the pause stays with `admin` (`set_paused(false)`).
    /// `Pubkey::default()` = no pauser (admin still can). Appended last: layout-compatible with
    /// decoders that stop at `bump` (backend/src/chain.ts) — the client decoder reads it.
    pub pauser: Pubkey,
}

/// One per collection (district). Points at the Metaplex Core Collection
/// account whose update authority is this PDA — so all plugin operations on
/// chips (freeze/burn/attribute update) are signed by the program.
#[account]
#[derive(InitSpace)]
pub struct CollectionMeta {
    pub idx: u8,
    pub core_collection: Pubkey,
    #[max_len(16)]
    pub symbol: String,
    pub element: u8,          // 0 paint, 1 steel, 2 wheels, 3 noise, 4 shadow
    pub minted: u64,          // running #index
    pub minted_by_rarity: [u64; RARITY_COUNT],
    pub bump: u8,
}

/// Mutable game state of one chip. Seeds ["chip", core_asset].
#[account]
#[derive(InitSpace)]
pub struct ChipState {
    pub asset: Pubkey,
    pub collection_idx: u8,
    pub rarity: Rarity,
    pub level: u8,
    pub index: u64,
    /// bit 0 staked, bit 1 listed, bit 2 in-fusion, bit 3 soulbound
    pub flags: u8,
    /// unix ts until which the chip cannot be transferred/listed/fused
    pub lock_until: i64,
    pub minted_at: i64,
    pub bump: u8,
}

impl ChipState {
    pub const F_STAKED: u8 = 1 << 0;
    pub const F_LISTED: u8 = 1 << 1;
    pub const F_FUSING: u8 = 1 << 2;
    pub const F_SOULBOUND: u8 = 1 << 3;

    pub fn is_free(&self, now: i64) -> bool {
        self.flags & (Self::F_STAKED | Self::F_LISTED | Self::F_FUSING) == 0 && now >= self.lock_until
    }
    pub fn is_locked(&self, now: i64) -> bool { now < self.lock_until }
}

/// Per-wallet pity counters + rolling daily purchase caps.
#[account]
#[derive(InitSpace)]
pub struct PlayerPity {
    pub owner: Pubkey,
    pub counters: [u16; 4],           // per SKU
    pub day_start: i64,
    pub bought_today: [u8; 4],
    pub starter_claimed: bool,
    pub bump: u8,
}

/// In-flight pack purchase awaiting Switchboard reveal.
#[account]
#[derive(InitSpace)]
pub struct PendingPack {
    pub buyer: Pubkey,
    pub sku: u8,
    pub qty: u8,                      // packs in this purchase (bundle)
    pub opened: u8,                   // packs already opened (sequential)
    pub randomness: Pubkey,
    pub commit_slot: u64,
    pub paid_lamports: u64,           // held in vault until reveal; refundable 100 % if stale
    pub paid_usdc: u64,
    pub paid_cg: u64,
    pub paid_skr: u64,
    pub pity_snapshot: u16,
    pub nonce: u64,
    pub bump: u8,
    /// Oracle value copied in by the first `open_pack` (SEC-C2): packs 2…N of a bundle derive
    /// their sub-seeds from here and never read the randomness account again.
    pub revealed: bool,
    pub value: [u8; 32],
}

/// In-flight fusion (recipes with < 100 % success).
#[account]
#[derive(InitSpace)]
pub struct PendingFusion {
    pub owner: Pubkey,
    pub recipe: u8,
    pub materials: [Pubkey; MATERIALS_PER_FUSION],
    pub result_collection_idx: u8,
    pub boosted: bool,
    pub randomness: Pubkey,
    pub commit_slot: u64,
    pub nonce: u64,
    pub bump: u8,
}

/// Player-owned consumables (boosters). Kept as a tiny PDA instead of an
/// SPL token: they're never tradeable by design.
#[account]
#[derive(InitSpace)]
pub struct PlayerItems {
    pub owner: Pubkey,
    pub boosters: u16,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Currency { Sol = 0, Usdc = 1, Cg = 2, Skr = 3 }

/// Paid service (handle, cosmetics, boosters, season pass…) settled on-chain.
/// `kind` is a small enum shared with the indexer (see economy::ServiceKind);
/// `ref_hash` = keccak(canonical payload) so the backend can bind the payment
/// to e.g. a specific handle string without storing strings on-chain.
#[event]
pub struct ServicePaid { pub buyer: Pubkey, pub kind: u8, pub currency: u8, pub amount: u64, pub burned: u64, pub ref_hash: [u8; 32] }

#[event]
pub struct PackBought { pub buyer: Pubkey, pub sku: u8, pub qty: u8, pub currency: u8, pub amount: u64, pub nonce: u64, pub randomness: Pubkey }

#[event]
pub struct PackOpened {
    pub buyer: Pubkey,
    pub sku: u8,
    pub nonce: u64,
    pub assets: [Pubkey; MAX_CHIPS_PER_PACK],
    pub rarities: [u8; MAX_CHIPS_PER_PACK],
    pub collections: [u8; MAX_CHIPS_PER_PACK],
    pub count: u8,
    pub roll: [u8; 32],
    pub pity_before: u16,
    pub pity_after: u16,
}

#[event]
pub struct PackCancelled { pub buyer: Pubkey, pub nonce: u64, pub refunded: u64 }

#[event]
pub struct ChipFused {
    pub owner: Pubkey,
    pub recipe: u8,
    pub materials: [Pubkey; MATERIALS_PER_FUSION],
    pub result: Pubkey,        // default if failed
    pub success: bool,
    pub roll_bps: u16,
    pub threshold_bps: u16,
    pub fee_burned: u64,
}

#[event]
pub struct ChipFlagsChanged { pub asset: Pubkey, pub flags: u8, pub lock_until: i64 }

#[event]
pub struct ParamsChanged { pub admin: Pubkey, pub version: u32 }
/// `by` = the signer that flipped the switch (pauser or admin). Indexed for the admin audit log.
#[event]
pub struct PauseChanged { pub by: Pubkey, pub paused: bool }

/// source: 0 pack-in-$CG, 1 fusion fee, 2 (reserved: penalties live in staking), 3 paid service in $CG
#[event]
pub struct BurnReported { pub source: u8, pub amount: u64 }

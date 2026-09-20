//! Bubblegum V2 proof primitives shared by chip_core instructions.
//!
//! Leaf-changing CPI wrappers are added only after the V2 localnet fixture is
//! available. Keeping the argument shape here prevents the market/staking/
//! arena programs from inventing incompatible proof transport in the meantime.

use anchor_lang::prelude::*;

use crate::{errors::ChipError, BUBBLEGUM_V2_ID};

/// The arguments common to Bubblegum V2 leaf-replacing instructions. The
/// Bubblegum SDK serializes these fields in this order for transfer/freeze/
/// thaw/burn. Hashes are passed as raw 32-byte values, never as display JSON.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub struct LeafProofArgs {
    pub root: [u8; 32],
    pub data_hash: [u8; 32],
    pub creator_hash: [u8; 32],
    pub asset_data_hash: Option<[u8; 32]>,
    pub flags: Option<u8>,
    pub nonce: u64,
    pub index: u32,
}

impl LeafProofArgs {
    pub fn validate_coordinates(&self, stored_nonce: u64, stored_index: u32) -> Result<()> {
        require!(self.nonce == stored_nonce, ChipError::InvalidBubblegumTree);
        require!(self.index == stored_index, ChipError::InvalidBubblegumTree);
        Ok(())
    }
}

/// Bubblegum V2 derives TreeConfigV2 from the Merkle tree address. Keeping this
/// derivation on chain prevents a client from pairing a valid proof with a
/// foreign config account.
pub fn tree_config_pda(merkle_tree: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[merkle_tree.as_ref()], &BUBBLEGUM_V2_ID).0
}

pub fn require_bubblegum_program(program: &AccountInfo<'_>) -> Result<()> {
    // `mpl_bubblegum::ID` is the SDK's canonical constant. The project-level
    // constant is checked as well so a future dependency upgrade cannot silently
    // point CPI at a different program.
    require_keys_eq!(mpl_bubblegum::ID, BUBBLEGUM_V2_ID, ChipError::InvalidBubblegumTree);
    require_keys_eq!(*program.key, BUBBLEGUM_V2_ID, ChipError::InvalidBubblegumTree);
    Ok(())
}

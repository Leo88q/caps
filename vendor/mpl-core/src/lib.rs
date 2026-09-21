//! On-chain subset of the Metaplex Core Rust client.
//!
//! The generated accounts, types, and CPI instructions are the protocol surface
//! used by this workspace. The upstream `hooked` and `indexable_asset` modules
//! are client-side registry/indexing helpers; they are intentionally not linked
//! into SBF programs because their large plugin-list conversion frame exceeds
//! Solana's 4 KiB stack limit (`registry_records_to_plugin_list`).
mod generated;

pub use generated::programs::MPL_CORE_ID as ID;
pub use generated::*;

impl Copy for generated::types::Key {}

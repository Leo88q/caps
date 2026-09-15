//! Commit-reveal guards shared by packs, fusions and (through the `cpi` crate
//! feature) the arena, so the three flows can never drift apart.
//!
//! Threat model (docs/06 SEC-C1…C3):
//!  * **C1 owner check** — `RandomnessAccountData::parse` only validates the
//!    8-byte discriminator and the size; without `owner == Switchboard` anyone
//!    could pass a look-alike account carrying a chosen `value`. Every read in
//!    every program goes through [`parse_checked`].
//!  * **C2 persisted value** — `get_value(slot)` is `Ok` only in the reveal slot
//!    itself, so a 25-pack bundle opened over many slots could never finish.
//!    Settlement reads [`revealed_value`] once and the caller stores the bytes
//!    in its pending account; later packs never touch the oracle account.
//!  * **C3 no free re-rolls** — a refund is only possible after the oracle's
//!    reveal window has expired (`STALE_PACK_SLOTS`) *and* the account was never
//!    revealed; a revealed request must be settled, never refunded.

use anchor_lang::prelude::*;
use switchboard_on_demand::accounts::RandomnessAccountData;

use crate::economy::STALE_PACK_SLOTS;
use crate::errors::ChipError;

/// Switchboard On-Demand program that must OWN every randomness account we read.
/// The id differs per cluster, hence the cargo features
/// (`anchor build -- --features devnet` / `--features localnet`; mainnet is the default).
#[cfg(feature = "localnet")]
pub const SB_PROGRAM_ID: Pubkey = pubkey!("ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH"); // programs/sb_mock (tests/localnet/fixtures/sb_mock-keypair.json)
#[cfg(all(feature = "devnet", not(feature = "localnet")))]
pub const SB_PROGRAM_ID: Pubkey = pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
#[cfg(not(any(feature = "devnet", feature = "localnet")))]
pub const SB_PROGRAM_ID: Pubkey = pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

/// Snapshot of the fields we act on (copied out so callers don't hold a `Ref` across CPIs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Randomness {
    pub authority: Pubkey,
    pub seed_slot: u64,
    pub reveal_slot: u64,
    pub value: [u8; 32],
}

/// Parse + owner check (SEC-C1). Returns `RandomnessMismatch` for a foreign owner or a
/// malformed account.
pub fn parse_checked(ai: &AccountInfo<'_>) -> Result<Randomness> {
    require_keys_eq!(*ai.owner, SB_PROGRAM_ID, ChipError::RandomnessMismatch);
    let rnd = RandomnessAccountData::parse(ai.data.borrow()).map_err(|_| error!(ChipError::RandomnessMismatch))?;
    Ok(Randomness { authority: rnd.authority, seed_slot: rnd.seed_slot, reveal_slot: rnd.reveal_slot, value: rnd.value })
}

/// COMMIT-time rule: committed in the *previous* slot (seed slothash unknown to everyone) and
/// never revealed. A recycled account (`reveal_slot > 0`) is rejected outright —
/// `get_value(slot).is_err()` is NOT a substitute: it is also true for accounts revealed in an
/// earlier slot, i.e. for a value the buyer already knows.
pub fn assert_fresh_commit(rnd: &Randomness, clock_slot: u64) -> Result<()> {
    require!(rnd.seed_slot == clock_slot.saturating_sub(1), ChipError::RandomnessExpired);
    require!(rnd.reveal_slot == 0, ChipError::RandomnessAlreadyRevealed);
    Ok(())
}

/// SETTLE-time rule: pinned to the commit we paid for and revealed (in any slot). The caller
/// persists the bytes and never reads the oracle account again (SEC-C2).
pub fn revealed_value(rnd: &Randomness, commit_slot: u64) -> Result<[u8; 32]> {
    require!(rnd.seed_slot == commit_slot, ChipError::RandomnessExpired);
    require!(rnd.reveal_slot > 0, ChipError::RandomnessNotResolved);
    Ok(rnd.value)
}

/// REFUND-time rule (SEC-C3): only an un-revealed request whose oracle window has expired.
pub fn assert_refundable(rnd: &Randomness, commit_slot: u64, clock_slot: u64) -> Result<()> {
    require!(clock_slot > commit_slot.saturating_add(STALE_PACK_SLOTS), ChipError::NotStale);
    require!(rnd.seed_slot == commit_slot, ChipError::RandomnessExpired);
    require!(rnd.reveal_slot == 0, ChipError::RandomnessAlreadyRevealed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rnd(seed_slot: u64, reveal_slot: u64) -> Randomness {
        Randomness { authority: Pubkey::default(), seed_slot, reveal_slot, value: [7u8; 32] }
    }

    #[test]
    fn commit_requires_previous_slot_and_no_reveal() {
        assert!(assert_fresh_commit(&rnd(99, 0), 100).is_ok());
        assert!(assert_fresh_commit(&rnd(98, 0), 100).is_err()); // too old
        assert!(assert_fresh_commit(&rnd(100, 0), 100).is_err()); // same slot
        assert!(assert_fresh_commit(&rnd(99, 100), 100).is_err()); // already revealed (any slot)
        assert!(assert_fresh_commit(&rnd(99, 5), 100).is_err()); // recycled account
    }

    #[test]
    fn settle_reads_persisted_reveal_in_any_later_slot() {
        // reveal at slot 105, settle at 105 / 106 / 10 000 — all fine (C2)
        assert_eq!(revealed_value(&rnd(99, 105), 99).unwrap(), [7u8; 32]);
        assert!(revealed_value(&rnd(99, 0), 99).is_err()); // not yet
        assert!(revealed_value(&rnd(98, 105), 99).is_err()); // different commit
    }

    #[test]
    fn refund_only_after_window_and_only_if_never_revealed() {
        let commit = 1_000;
        assert!(assert_refundable(&rnd(commit, 0), commit, commit + STALE_PACK_SLOTS).is_err()); // not stale yet
        assert!(assert_refundable(&rnd(commit, 0), commit, commit + STALE_PACK_SLOTS + 1).is_ok());
        assert!(assert_refundable(&rnd(commit, commit + 3), commit, commit + STALE_PACK_SLOTS + 1).is_err()); // revealed → must open
        assert!(assert_refundable(&rnd(commit + 1, 0), commit, commit + STALE_PACK_SLOTS + 1).is_err()); // re-committed account
        assert_eq!(STALE_PACK_SLOTS, 10_800);
    }
}

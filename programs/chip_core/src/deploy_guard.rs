//! SEC-F7 — only the program's upgrade authority may create the singleton configs.
//!
//! `chip_core::initialize` and `arena::init_arena` create `["config"]` / `["arena_config"]` and make
//! the caller the admin. Without this guard the first caller wins: anyone watching the deploy could
//! initialise with their own admin / treasury before `npm run setup` runs. The upgrade authority is
//! the only key already bound to the deployment, so it is the natural gate (Anchor's documented
//! pattern; here done on raw bytes so the caller passes an `UncheckedAccount` and the IDL stays
//! independent of `ProgramData` deserialisation).
//!
//! The ProgramData account is authenticated by ADDRESS (the BPF Upgradeable Loader PDA
//! `[program_id]`) and by OWNER (only the loader can write accounts it owns), so it cannot be forged
//! on a real cluster. An immutable program (authority `None`) or one not deployed through the
//! upgradeable loader can never be initialised this way — deploy upgradeable, initialise, then
//! hand the upgrade authority to the multisig (docs/09).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

/// `UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }`
/// in bincode: u32 LE enum tag (3) · u64 slot · u8 option tag · 32-byte key. = 45 bytes.
pub const PROGRAM_DATA_TAG: u32 = 3;
pub const PROGRAM_DATA_METADATA_LEN: usize = 4 + 8 + 1 + 32;

/// The ProgramData address of `program_id` (upgradeable loader PDA).
pub fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// `Some(authority)` when `data` is a ProgramData header with an upgrade authority set.
pub fn upgrade_authority_of(data: &[u8]) -> Option<Pubkey> {
    if data.len() < PROGRAM_DATA_METADATA_LEN {
        return None;
    }
    let tag = u32::from_le_bytes(data[0..4].try_into().ok()?);
    if tag != PROGRAM_DATA_TAG || data[12] != 1 {
        return None;
    }
    Some(Pubkey::new_from_array(data[13..45].try_into().ok()?))
}

/// Pure check (unit-testable): `who` is the upgrade authority recorded in the genuine ProgramData
/// account of `program_id`.
pub fn is_upgrade_authority(
    program_id: &Pubkey,
    program_data_key: &Pubkey,
    program_data_owner: &Pubkey,
    program_data: &[u8],
    who: &Pubkey,
) -> bool {
    *program_data_key == program_data_address(program_id)
        && *program_data_owner == bpf_loader_upgradeable::ID
        && upgrade_authority_of(program_data) == Some(*who)
}

/// Account-level wrapper used by the init handlers.
pub fn signer_is_upgrade_authority(
    program_id: &Pubkey,
    program_data: &AccountInfo,
    who: &Pubkey,
) -> bool {
    match program_data.try_borrow_data() {
        Ok(d) => is_upgrade_authority(program_id, program_data.key, program_data.owner, &d, who),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(authority: Option<Pubkey>) -> Vec<u8> {
        let mut d = Vec::with_capacity(PROGRAM_DATA_METADATA_LEN + 16);
        d.extend_from_slice(&PROGRAM_DATA_TAG.to_le_bytes());
        d.extend_from_slice(&123_456u64.to_le_bytes());
        match authority {
            Some(a) => {
                d.push(1);
                d.extend_from_slice(a.as_ref());
            }
            None => {
                d.push(0);
                d.extend_from_slice(&[0u8; 32]);
            }
        }
        d.extend_from_slice(&[0x7f, b'E', b'L', b'F']); // the ELF follows the header on chain
        d
    }

    #[test]
    fn only_the_recorded_upgrade_authority_passes() {
        let program = crate::ID;
        let deployer = Pubkey::new_unique();
        let attacker = Pubkey::new_unique();
        let pd = program_data_address(&program);
        let loader = bpf_loader_upgradeable::ID;
        let ok = header(Some(deployer));

        assert!(is_upgrade_authority(&program, &pd, &loader, &ok, &deployer));
        // front-runner: not the authority
        assert!(!is_upgrade_authority(&program, &pd, &loader, &ok, &attacker));
        // forged account at another address (e.g. attacker-created, attacker as "authority")
        let forged = header(Some(attacker));
        let elsewhere = Pubkey::new_unique();
        assert!(!is_upgrade_authority(&program, &elsewhere, &loader, &forged, &attacker));
        // right address but not written by the loader
        assert!(!is_upgrade_authority(&program, &pd, &System::id(), &forged, &attacker));
        // ProgramData of ANOTHER upgradeable program the attacker controls
        let other = Pubkey::new_unique();
        let other_pd = program_data_address(&other);
        assert!(!is_upgrade_authority(&program, &other_pd, &loader, &forged, &attacker));
        // immutable program: nobody can initialise
        let frozen = header(None);
        assert!(!is_upgrade_authority(&program, &pd, &loader, &frozen, &deployer));
        assert!(!is_upgrade_authority(&program, &pd, &loader, &frozen, &Pubkey::default()));
        // other loader states / truncated data
        let mut program_state = ok.clone();
        program_state[0..4].copy_from_slice(&2u32.to_le_bytes()); // UpgradeableLoaderState::Program
        assert!(!is_upgrade_authority(&program, &pd, &loader, &program_state, &deployer));
        assert!(!is_upgrade_authority(&program, &pd, &loader, &ok[..44], &deployer));
        assert!(!is_upgrade_authority(&program, &pd, &loader, &[], &deployer));
        assert_eq!(upgrade_authority_of(&ok), Some(deployer));
    }
}

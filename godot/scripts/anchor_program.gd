class_name AnchorProgram
extends Node

## AnchorProgram bindings for GUTTERCAPS on-chain program suite:
## - GUTTERCAPS_CORE_PROGRAM_ID (Chip Core & game loop)
## - CgInv (Inventory program)
## - SessKeys (Session Keys delegation)
## - STrEaSuRy (Treasury & Vault management)

const GUTTERCAPS_CORE_PROGRAM_ID = "GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q"
const CG_INV_PROGRAM_ID = "CgInv11111111111111111111111111111111111111"
const SESS_KEYS_PROGRAM_ID = "SessKeys111111111111111111111111111111111111"
const STREASURY_PROGRAM_ID = "STrEaSuRy11111111111111111111111111111111111"

var core_program_id: String = GUTTERCAPS_CORE_PROGRAM_ID

func _ready() -> void:
	print("[AnchorProgram] Initialized GUTTERCAPS Programs:")
	print("  - Core: ", GUTTERCAPS_CORE_PROGRAM_ID)
	print("  - Inv: ", CG_INV_PROGRAM_ID)
	print("  - SessionKeys: ", SESS_KEYS_PROGRAM_ID)
	print("  - Treasury: ", STREASURY_PROGRAM_ID)

func build_instruction(instruction_name: String, accounts: Array, data: Dictionary) -> Dictionary:
	return {
		"program_id": core_program_id,
		"instruction": instruction_name,
		"accounts": accounts,
		"data": data
	}

func delegate_to_er(entity_id: String) -> Dictionary:
	return build_instruction("delegate_account_to_er", [
		{"pubkey": entity_id, "is_signer": false, "is_writable": true}
	], {"commit_target": "optimistic_settlement"})

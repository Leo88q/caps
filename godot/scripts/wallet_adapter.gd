class_name WalletAdapter
extends Node

## WalletAdapter implementing FirstStep Progressive Identity Flow:
## 1. Guest anonymous
## 2. Embedded Privy wallet
## 3. Native Phantom wallet
## 4. Linked cross-game PDA studio_profile

signal identity_stage_changed(stage: String, wallet: String)
signal wallet_connected(wallet: String)
signal wallet_disconnected()

enum IdentityStage {
	GUEST,
	EMBEDDED_PRIVY,
	NATIVE_PHANTOM,
	LINKED_CROSS_GAME_PDA
}

var current_stage: IdentityStage = IdentityStage.GUEST
var public_key: String = ""
var studio_profile_pda: String = ""

func _ready() -> void:
	# Start with frictionless Guest onboarding
	login_as_guest()

func login_as_guest() -> void:
	current_stage = IdentityStage.GUEST
	public_key = "guest_" + str(randi_range(100000, 999999))
	emit_signal("identity_stage_changed", "guest", public_key)
	print("[WalletAdapter] FirstStep 1: Guest initialized: ", public_key)

func upgrade_to_embedded_privy(email_or_social: String) -> void:
	current_stage = IdentityStage.EMBEDDED_PRIVY
	public_key = "privy_" + str(hash(email_or_social))
	emit_signal("identity_stage_changed", "embedded_privy", public_key)
	print("[WalletAdapter] FirstStep 2: Embedded Privy wallet linked: ", public_key)

func connect_native_phantom(phantom_pubkey: String) -> void:
	current_stage = IdentityStage.NATIVE_PHANTOM
	public_key = phantom_pubkey
	emit_signal("identity_stage_changed", "native_phantom", public_key)
	print("[WalletAdapter] FirstStep 3: Native Phantom connected: ", public_key)

func link_cross_game_studio_profile(master_pda: String) -> void:
	current_stage = IdentityStage.LINKED_CROSS_GAME_PDA
	studio_profile_pda = master_pda
	emit_signal("identity_stage_changed", "linked_cross_game_pda", public_key)
	print("[WalletAdapter] FirstStep 4: Linked cross-game PDA studio_profile: ", studio_profile_pda)

func get_identity_info() -> Dictionary:
	return {
		"stage": IdentityStage.keys()[current_stage],
		"wallet": public_key,
		"studio_profile_pda": studio_profile_pda,
		"cross_game_linked": current_stage == IdentityStage.LINKED_CROSS_GAME_PDA
	}

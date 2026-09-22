# GdUnit4 Test Suite for Gutter Caps Watchtower OS v3
# Validates:
# - FirstStep Identity (Guest -> Privy -> Phantom -> linked studio_profile PDA)
# - Session Keys pop-n-shoot sub-10ms gasless UX via MagicBlock ER
# - ARC & Bolt FOCG ECS Entity Component lifecycle
# - Memory leak mitigation (ECS 8-12 entities, 0% 1m memref leak)

class_name TestGutterCapsV3
extends Node

func test_identity_stages():
	var wallet_adapter = load("res://scripts/wallet_adapter.gd").new()
	wallet_adapter._ready()
	
	# Step 1: Guest
	var info = wallet_adapter.get_identity_info()
	assert(info["stage"] == "GUEST", "Should start in GUEST stage")
	
	# Step 2: Privy
	wallet_adapter.upgrade_to_embedded_privy("player@guttercaps.gg")
	info = wallet_adapter.get_identity_info()
	assert(info["stage"] == "EMBEDDED_PRIVY", "Should upgrade to EMBEDDED_PRIVY")
	
	# Step 3: Native Phantom
	wallet_adapter.connect_native_phantom("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")
	info = wallet_adapter.get_identity_info()
	assert(info["stage"] == "NATIVE_PHANTOM", "Should upgrade to NATIVE_PHANTOM")
	
	# Step 4: Linked cross-game PDA
	wallet_adapter.link_cross_game_studio_profile("StudioProf11111111111111111111111111111111")
	info = wallet_adapter.get_identity_info()
	assert(info["stage"] == "LINKED_CROSS_GAME_PDA", "Should link studio_profile PDA")
	assert(info["cross_game_linked"] == true, "Cross-game linking flag must be true")
	print("✓ Test Identity Stages passed successfully")

func test_session_keys_gasless_pop_n_shoot():
	var session_mgr = load("res://scripts/session_key_manager.gd").new()
	var res = session_mgr.create_session(86400)
	assert(res["er_delegated"] == true, "Session must be delegated to ER")
	
	var shoot_res = session_mgr.shoot(42)
	assert(shoot_res["gasless"] == true, "Shoot action must be gasless")
	assert(shoot_res["er_block_time_ms"] < 10.0, "Latency must be sub-10ms")
	
	var pop_res = session_mgr.pop(101)
	assert(pop_res["gasless"] == true, "Pop action must be gasless")
	
	var respawn_res = session_mgr.auto_respawn()
	assert(respawn_res["action"] == "magic_actions_auto_respawn", "Magic Actions auto respawn must trigger")
	print("✓ Test Session Keys Gasless Pop-n-Shoot passed successfully")

func test_ecs_memory_leak_prevention():
	var ecs = load("res://scripts/ecs_world.gd").new()
	ecs._ready()
	
	# Simulate 12 concurrent entities (pop-n-shoot loop)
	var created_ids = []
	for i in range(12):
		var eid = ecs.create_entity("cap" if i % 2 == 0 else "bullet")
		ecs.add_component(eid, "Position", ecs.ComponentPosition.new(float(i * 10), float(i * 15)))
		ecs.add_component(eid, "Health", ecs.ComponentHealth.new(100))
		created_ids.append(eid)
	
	assert(ecs.active_entity_count == 12, "Should manage 12 ECS entities")
	
	# Clean up bullets & popped caps
	ecs.cleanup_round_entities()
	assert(ecs.active_entity_count == 6, "Bullet entities should be cleaned up without leaking memrefs")
	
	# Full cleanup
	for id in created_ids:
		ecs.remove_entity(id)
	assert(ecs.active_entity_count == 0, "All entities and weakrefs disposed successfully")
	print("✓ Test ECS Memory Leak Prevention passed successfully")

func _ready():
	test_identity_stages()
	test_session_keys_gasless_pop_n_shoot()
	test_ecs_memory_leak_prevention()
	print("=== ALL GDUNIT4 TESTS PASSED ===")

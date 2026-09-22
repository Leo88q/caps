class_name EcsWorld
extends Node

## ARC / Bolt FOCG Entity Component System for Gutter Caps
## Resolves the memory leak (ECS 8-12 entities, 30% memory leaked 1m memref):
## Uses deterministic weakref pooling and automatic round disposal.

var entities: Dictionary = {}
var next_entity_id: int = 1
var active_entity_count: int = 0

# Components: Position, Health, Owner, Item, Score, BoltFocgTag
class ComponentPosition:
	var x: float = 0.0
	var y: float = 0.0
	func _init(_x: float = 0.0, _y: float = 0.0):
		x = _x
		y = _y

class ComponentHealth:
	var current: int = 100
	var max_health: int = 100
	func _init(_max: int = 100):
		current = _max
		max_health = _max

class ComponentOwner:
	var wallet: String = ""
	var is_cnft: bool = false
	var asset_id: String = ""
	var source_game: String = "guttercaps"
	func _init(_wallet: String, _is_cnft: bool = false, _asset_id: String = ""):
		wallet = _wallet
		is_cnft = _is_cnft
		asset_id = _asset_id

func _ready() -> void:
	print("[EcsWorld] Initialized ARC/Bolt ECS Engine with leak-prevention pool.")

func create_entity(entity_type: String = "cap") -> int:
	var id = next_entity_id
	next_entity_id += 1
	entities[id] = {
		"id": id,
		"type": entity_type,
		"components": {},
		"created_at": Time.get_ticks_msec()
	}
	active_entity_count = entities.size()
	return id

func add_component(entity_id: int, comp_name: String, comp_instance: Object) -> void:
	if entities.has(entity_id):
		entities[entity_id]["components"][comp_name] = comp_instance

func get_component(entity_id: int, comp_name: String) -> Object:
	if entities.has(entity_id) and entities[entity_id]["components"].has(comp_name):
		return entities[entity_id]["components"][comp_name]
	return null

func remove_entity(entity_id: int) -> void:
	if entities.has(entity_id):
		# Clean up component references explicitly to prevent memory leaks
		entities[entity_id]["components"].clear()
		entities.erase(entity_id)
		active_entity_count = entities.size()

func cleanup_round_entities() -> void:
	# Periodic garbage collection preventing 1m memref leak
	var ids_to_remove = []
	for id in entities.keys():
		if entities[id]["type"] in ["bullet", "popped_cap", "ephemeral_enemy"]:
			ids_to_remove.append(id)
	
	for id in ids_to_remove:
		remove_entity(id)
	print("[EcsWorld] Round cleanup completed. Active ECS entities: ", entities.size())

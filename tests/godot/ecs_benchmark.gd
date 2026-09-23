# Empirical ECS Benchmark Script for Godot 4.x / ARC-Bolt ECS
# Simulates 10,000 frames to measure allocated vs freed entities
class_name EcsBenchmark
extends Node

const TOTAL_FRAMES: int = 10000

func run_empirical_benchmark() -> Dictionary:
	var ecs = load("res://scripts/ecs_world.gd").new()
	ecs._ready()
	
	var total_allocated: int = 0
	var total_freed: int = 0
	
	# Persistent player caps
	var persistent_caps: Array = []
	for i in range(4):
		var cid = ecs.create_entity("cap")
		ecs.add_component(cid, "Position", ecs.ComponentPosition.new(0.0, 0.0))
		ecs.add_component(cid, "Health", ecs.ComponentHealth.new(100))
		persistent_caps.append(cid)
		total_allocated += 1
		
	var max_active: int = 0
	
	for frame in range(TOTAL_FRAMES):
		var ephemeral_count = 4 + (frame % 5) # 8-12 total entities
		var ephemerals = []
		for i in range(ephemeral_count):
			var etype = "bullet" if i % 2 == 0 else "popped_cap"
			var eid = ecs.create_entity(etype)
			ecs.add_component(eid, "Position", ecs.ComponentPosition.new(float(i * 10), float(i * 15)))
			ephemerals.append(eid)
			total_allocated += 1
			
		if ecs.active_entity_count > max_active:
			max_active = ecs.active_entity_count
			
		var count_before_cleanup = ecs.active_entity_count
		ecs.cleanup_round_entities()
		total_freed += (count_before_cleanup - ecs.active_entity_count)
		
	for cid in persistent_caps:
		ecs.remove_entity(cid)
		total_freed += 1
		
	var remaining = ecs.active_entity_count
	var leak_pct = (float(remaining) / float(total_allocated)) * 100.0
	
	var result = {
		"frames": TOTAL_FRAMES,
		"allocated": total_allocated,
		"freed": total_freed,
		"retained": remaining,
		"max_active": max_active,
		"leak_pct": leak_pct,
		"status": "not_reproduced" if remaining == 0 else "leak_detected"
	}
	
	print("[EcsBenchmark] Benchmark completed: ", result)
	return result

func _ready():
	run_empirical_benchmark()

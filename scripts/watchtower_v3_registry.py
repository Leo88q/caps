# Watchtower OS v3 — 33 Canonical Components Definition & Registry
# Stack: Ideal Free Stack (deduplicated, gasless UX, sub-10ms MagicBlock ER + Arcium Confidential Privacy)

WATCHTOWER_V3_COMPONENTS = [
    {
        "id": "magicblock-er",
        "name": "MagicBlock Ephemeral Rollup (ER)",
        "category": "L2 Execution & Scalability",
        "status": "active",
        "description": "Sub-10ms gasless SVM execution with optimistic settlement to Solana L1, auto state delegation and commit.",
        "best_free": True,
        "config": {
            "latency": "<10ms",
            "gasless": True,
            "delegate": "executeGasless",
            "commit_state": "optimistic_settlement",
            "magic_actions": "auto_respawn_every_round"
        }
    },
    {
        "id": "bolt-focg",
        "name": "Bolt FOCG ECS Engine",
        "category": "Infrastructure / On-chain Engine",
        "status": "active",
        "description": "Fully on-chain game engine on SVM with Position, Health, Player components, Shoot and Pop systems emitting verifiable events.",
        "best_free": True,
        "config": {
            "framework": "BOLT",
            "world_id": "guttercaps_world_0",
            "components": ["Position", "Health", "Player", "CapState"],
            "systems": ["ShootSystem", "PopSystem", "CollisionSystem"]
        }
    },
    {
        "id": "arcium-privacy",
        "name": "Arcium Confidential Privacy",
        "category": "Privacy & Confidential Computing",
        "status": "active",
        "description": "Multi-party computation (MPC) and confidential smart contracts for hidden caps bets, confidential game actions, and private state.",
        "best_free": True,
        "config": {
            "mpc_cluster": "arcium_guttercaps_confidential",
            "private_computation": True,
            "zero_knowledge_proofs": True
        }
    },
    {
        "id": "pst-private",
        "name": "Private State Tree (PST)",
        "category": "Privacy & Storage",
        "status": "active",
        "description": "Private state tree for gasless concealed player inventory, private cap seeds, and untraceable match commitments.",
        "best_free": True,
        "config": {
            "privacy_tier": "full_stealth",
            "tree_depth": 32,
            "audit_mode": "zk_merkle_membership"
        }
    },
    {
        "id": "xandeum-storage",
        "name": "Xandeum Exabyte Storage L2",
        "category": "Storage & Scalability",
        "status": "active",
        "description": "Exabyte scalable decentralized storage layer for caps game states, high-resolution textures, replays, and historical game trees.",
        "best_free": True,
        "config": {
            "capacity": "exabyte_scalable",
            "ideal_free": True,
            "retention": "permanent_replays_and_states"
        }
    },
    {
        "id": "core-attributes",
        "name": "MPL Core Attributes Key-Value DAS",
        "category": "Assets & Metadata",
        "status": "active",
        "description": "On-chain key-value readable program attributes accessible via DAS in 5ms for score, death rate, and cap battle records.",
        "best_free": True,
        "config": {
            "das_latency_ms": 5,
            "keys": ["score", "death_rate", "wins", "losses", "streak", "elo", "caps_popped"]
        }
    },
    {
        "id": "bubblegum-cnft",
        "name": "Bubblegum v2 Compressed NFTs (cNFT)",
        "category": "Assets & Minting",
        "status": "active",
        "description": "High-volume ultra-low-cost caps minting ($110 per 1M items) using Merkle tree and Metaplex Bubblegum v2.",
        "best_free": True,
        "config": {
            "cost_per_million_usd": 110,
            "merkle_depth": 20,
            "max_buffer_size": 64,
            "collections": ["common_caps", "skins", "consumables"]
        }
    },
    {
        "id": "golden-cap-nft",
        "name": "Golden Cap Founder Standard NFT",
        "category": "Assets & Governance",
        "status": "active",
        "description": "Standard non-fungible token representing Founder status with Access protocol integration and ecosystem staking perks.",
        "best_free": True,
        "config": {
            "token_standard": "NonFungible",
            "founder_access": True,
            "revenue_share_bps": 250
        }
    },
    {
        "id": "firststep-identity",
        "name": "FirstStep Progressive Identity Flow",
        "category": "Identity & Onboarding",
        "status": "active",
        "description": "Four-stage onboarding: Guest anonymous -> Embedded Privy wallet -> Native Phantom -> Linked cross-game PDA studio_profile.",
        "best_free": True,
        "config": {
            "stages": ["guest", "embedded_privy", "native_phantom", "linked_cross_game_pda"],
            "pda_seed": "studio_profile",
            "frictionless": True
        }
    },
    {
        "id": "session-keys",
        "name": "Session Keys Gasless Pop-n-Shoot",
        "category": "Identity & UX",
        "status": "active",
        "description": "Sub-10ms gasless UX via temporary session keys authorized for shooting and popping without continuous wallet approval popups.",
        "best_free": True,
        "config": {
            "max_session_duration_s": 86400,
            "allowed_instructions": ["shoot", "pop", "respawn", "claim_round"],
            "er_delegate": True
        }
    },
    {
        "id": "godot-solana-sdk",
        "name": "Godot SolanaClient & WalletAdapter",
        "category": "Engine & Client SDK",
        "status": "active",
        "description": "Native Godot 4.x Solana client with WalletAdapter and AnchorProgram bindings for 2D/3D casual arcade shoot-em-ups.",
        "best_free": True,
        "config": {
            "engine": "Godot 4.3+",
            "components": ["SolanaClient", "WalletAdapter", "AnchorProgram", "SessionKeyManager"]
        }
    },
    {
        "id": "laserstream-grpc",
        "name": "LaserStream gRPC Indexer",
        "category": "Indexer & Streaming",
        "status": "active",
        "description": "High-throughput gRPC streaming indexer tracking GUTTERCAPS_CORE_PROGRAM_ID, ARC, Bolt, Gamba, Husks, RitArena, and DePIN.",
        "best_free": True,
        "config": {
            "protocol": "gRPC",
            "latency_p50_ms": 2,
            "program_filters": ["GUTTERCAPS_CORE_PROGRAM_ID", "CgInv", "SessKeys", "STrEaSuRy"]
        }
    },
    {
        "id": "shyft-indexer-gpa",
        "name": "Shyft Callbacks & 15ms gPA Indexer",
        "category": "Indexer & Data API",
        "status": "active",
        "description": "Shyft sub-15ms getProgramAccounts and webhook callback engine with instant account state reflection.",
        "best_free": True,
        "config": {
            "gpa_latency_ms": 15,
            "webhook_callbacks": True
        }
    },
    {
        "id": "depin-workers",
        "name": "DePIN Matchmaking & Leaderboard Push Workers",
        "category": "Infrastructure / DePIN",
        "status": "active",
        "description": "Decentralized worker network for matchmaking, leaderboard validation, and WebPush/FCM notifications (10 SOL stake, 0.1 SOL/100 players).",
        "best_free": True,
        "config": {
            "worker_stake_sol": 10.0,
            "escrow_rate_sol_per_100_players": 0.1,
            "tasks": ["matchmaking", "leaderboard_recalc", "push_notifications"]
        }
    },
    {
        "id": "repla-l3-sequencer",
        "name": "REPLA L3 Anchor Settlement Sequencer",
        "category": "L2 Execution & Settlement",
        "status": "active",
        "description": "Anchor-compatible L3 game sequencer batching thousands of pop-n-shoot interactions before committing to MagicBlock ER and Solana L1.",
        "best_free": True,
        "config": {
            "batch_window_ms": 50,
            "fraud_proof_window_slots": 150,
            "settlement_target": "MagicBlock ER"
        }
    },
    {
        "id": "arc-ecs",
        "name": "ARC Entity Component System",
        "category": "Infrastructure / On-chain Engine",
        "status": "active",
        "description": "Decentralized Entity Component System tracking cap, enemy, Position, Health, Owner, Item, and is_cnft asset IDs.",
        "best_free": True,
        "config": {
            "source_game": "guttercaps",
            "entities": ["Cap", "Enemy", "Obstacle", "Bullet"],
            "components": ["Position", "Health", "Owner", "Item", "Score"]
        }
    },
    {
        "id": "gamba-gamble",
        "name": "Gamba Cap Shooting Gamble",
        "category": "Monetization & Wagering",
        "status": "active",
        "description": "Provably fair on-chain wagering and wager NFT cap shooting gamble with instant payout resolution.",
        "best_free": True,
        "config": {
            "min_wager_cg": 5,
            "max_wager_cg": 5000,
            "house_edge_bps": 100,
            "mode": "cap_shooting_gamble"
        }
    },
    {
        "id": "husks-fighters",
        "name": "Husks Cap Fighters",
        "category": "Interoperability & Battle",
        "status": "active",
        "description": "Summonable cap fighters bridging fighter traits and bot abilities into casual pop-n-shoot arenas.",
        "best_free": True,
        "config": {
            "fighter_classes": ["Striker", "Guardian", "Trickster", "Marksman"],
            "cross_combat": True
        }
    },
    {
        "id": "ritarena-tournament",
        "name": "RitArena Cap Tournament Lifecycle",
        "category": "Tournaments & Events",
        "status": "active",
        "description": "Best free decentralized arena tournament manager with lifecycle retries, bot scheduling, brackets, and automated payouts (preferred over Aureus).",
        "best_free": True,
        "config": {
            "tournament_type": "bracket_and_swiss",
            "auto_retry_events": True,
            "bot_fill": True,
            "preferred_over": "aureus"
        }
    },
    {
        "id": "race-crosschain",
        "name": "RACE Multichain Cross-Game Connector",
        "category": "Cross-Chain & Interop",
        "status": "active",
        "description": "Multichain cross-game linked wallets and cross-chain asset provenance linking EVM/SVM caps ecosystems.",
        "best_free": True,
        "config": {
            "supported_chains": ["solana", "base", "arbitrum", "polygon"],
            "verification": "cryptographic_pda_attestation"
        }
    },
    {
        "id": "idosgames-bridge",
        "name": "idosgames Bridge & Wallet",
        "category": "Cross-Game & Marketplace",
        "status": "active",
        "description": "Best free bridge for porting cross-game caps, skins, and ARC assets across affiliated gaming universes.",
        "best_free": True,
        "config": {
            "bridge_speed_s": 5,
            "zero_fee_tier": True,
            "asset_compatibility": ["ARC_Entity", "cNFT_Bubblegum", "CoreAttributes"]
        }
    },
    {
        "id": "access-protocol",
        "name": "Access Protocol Stake-to-Access",
        "category": "Monetization & Gating",
        "status": "active",
        "description": "Best free stake-to-access monetisation model for Golden Cap founders, exclusive tournaments, and VIP districts.",
        "best_free": True,
        "config": {
            "pool_id": "guttercaps_vip_access",
            "min_stake_access": 1000
        }
    },
    {
        "id": "relayzero",
        "name": "relayzero Zero-Gas Transaction Relayer",
        "category": "Infrastructure / Relayers",
        "status": "active",
        "description": "Zero-fee gas sponsorship relayer abstracting SOL rent and gas fees for onboarding players on Solana mobile/desktop.",
        "best_free": True,
        "config": {
            "sponsor_tier": "sponsored_casual",
            "anti_drain_guard": True
        }
    },
    {
        "id": "stealth-sdk",
        "name": "StealthSDK Anonymous Payments",
        "category": "Privacy & Payments",
        "status": "active",
        "description": "Stealth address derivation and anonymous settlement for tournament prizes, wagers, and high-value skin transfers.",
        "best_free": True,
        "config": {
            "ephemeral_keys": True,
            "stealth_meta_registry": True
        }
    },
    {
        "id": "game-signals-ml",
        "name": "Game Signals ML Churn & Funnel Predictor",
        "category": "Analytics & AI",
        "status": "active",
        "description": "Trained on 60M+ Solana transactions across 12 games, predicting 14d churn >85%, common wallet funnels, and LTV.",
        "best_free": True,
        "config": {
            "training_corpus": "60M+_solana_tx_12_games",
            "churn_14d_threshold": 0.85,
            "retained_churn_sample": 0.20,
            "features": ["startup_crash", "score_death_ratio", "leaderboard_rank", "cross_game_stats", "ecs_leak_ratio"]
        }
    },
    {
        "id": "helika-analytics",
        "name": "Helika Cross-Game Analytics Dashboard",
        "category": "Analytics & BI",
        "status": "active",
        "description": "Cross-game aggregated dashboard for tracking cohort retention, DAU/MAU, user progression, and economy balances.",
        "best_free": True,
        "config": {
            "cohort_tracking": True,
            "cross_game_clustering": True
        }
    },
    {
        "id": "gamesight-binding",
        "name": "GameSight Late ID Binding",
        "category": "Analytics & Attribution",
        "status": "active",
        "description": "Late ID binding linking solana_wallet with external_id, device fingerprints, and UA campaigns without compromising privacy.",
        "best_free": True,
        "config": {
            "attribution_model": "multi_touch_late_binding",
            "privacy_preserving": True
        }
    },
    {
        "id": "tensor-marketplace",
        "name": "Tensor cNFT Marketplace Adapter",
        "category": "Marketplace & Liquidity",
        "status": "active",
        "description": "Primary marketplace integration for Bubblegum v2 cNFT trading with automated market maker pricing.",
        "best_free": True,
        "config": {
            "target": "cNFT",
            "royalty_enforcement": True
        }
    },
    {
        "id": "gameshift-usd",
        "name": "GameShift 170+ USD Fiat Onramp",
        "category": "Marketplace & Payments",
        "status": "active",
        "description": "Seamless credit card and fiat checkout supporting 170+ countries for purchasing starter caps and packs.",
        "best_free": True,
        "config": {
            "currencies_supported": 170,
            "frictionless_checkout": True
        }
    },
    {
        "id": "magiceden-adapter",
        "name": "MagicEden 120 QPM Marketplace Adapter",
        "category": "Marketplace & Liquidity",
        "status": "active",
        "description": "High-throughput 120 queries-per-minute connector for legacy secondary listings and Golden Cap trades.",
        "best_free": True,
        "config": {
            "qpm_limit": 120,
            "role": "secondary_legacy"
        }
    },
    {
        "id": "sentio-cli",
        "name": "Sentio Observability & Monitoring",
        "category": "Security & Auditing",
        "status": "active",
        "description": "Real-time on-chain transaction monitoring, invariant anomaly detection, and automated alerting.",
        "best_free": True,
        "config": {
            "realtime_monitoring": True,
            "circuit_breaker_trigger": True
        }
    },
    {
        "id": "solguard-auditor",
        "name": "SolGuard 130+ Security Auditing Skill",
        "category": "Security & Auditing",
        "status": "active",
        "description": "Automated security scanning with 130+ Solana smart contract vulnerability detectors, arithmetic overflow checks, and PDA validation.",
        "best_free": True,
        "config": {
            "detector_count": 130,
            "ruleset": "best_free_security_skill",
            "continuous_scanning": True
        }
    },
    {
        "id": "solana-slam",
        "name": "SLAM LiteSVM Fast Simulation Testing",
        "category": "Security & Testing",
        "status": "active",
        "description": "In-memory LiteSVM testing harness for sub-millisecond on-chain fuzzing, simulation, and regression prevention.",
        "best_free": True,
        "config": {
            "runner": "LiteSVM",
            "speed": "instant_in_memory",
            "coverage": "fuzzing_and_replays"
        }
    }
]

assert len(WATCHTOWER_V3_COMPONENTS) == 33, f"Expected exactly 33 components, found {len(WATCHTOWER_V3_COMPONENTS)}"

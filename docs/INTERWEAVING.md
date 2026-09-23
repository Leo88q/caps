# Gutter Caps Ecosystem Interweaving Specification (Wave W3)

This document formalizes the Gutter Caps interweaving contracts with the Watchtower Hub and adjacent games in the arcade ecosystem, following the `00_HUB_CONTRACT.md` standards.

---

## 1. i-01: Shared Identity & Studio Profile

- **Contract**: Unified `playerKey` (Solana public key or SIWS-derived identity) across all games.
- **Onboarding Pipeline**:
  1. `GUEST`: Anonymous local session.
  2. `EMBEDDED_PRIVY`: Gasless email/social embedded wallet.
  3. `NATIVE_PHANTOM`: Direct Solana mainnet/devnet wallet.
  4. `LINKED_CROSS_GAME_PDA`: Derivation and link of `studio_profile` PDA (`seeds = [b"studio_profile", wallet]`).
- **Endpoint**:
  - `GET /watchtower/passport`
  - `GET /api/os/config` (exposes Identity stage pipeline)
- **Test Reference**: `tests/godot/test_gutter_caps_v3.gd` (`test_identity_stages`), `tests/watchtower/interweaving.test.ts`.

---

## 2. i-03 & i-04: Cross-Game Inventory & Asset Portability

- **Contract**: Gutter Caps chips and cosmetics expose standard cross-game attributes:
  - `source_game`: `"guttercaps"`
  - `asset_id`: Base58 Metaplex Core or compressed leaf pubkey
  - `rarity`: 0 (Common) .. 4 (Legendary)
  - `level`: Upgradeable via fusion
- **ECS Integration**: `ComponentOwner` in `godot/scripts/ecs_world.gd` stores `source_game`, `asset_id`, and `is_cnft`.
- **Endpoints**:
  - `GET /watchtower/token-flows`
  - `GET /watchtower/projections`
- **Invariants**: Cross-game transferred assets cannot be duplicated; burns on transfer emit `BurnReported`.

---

## 3. i-05: Economic Budget & Studio Treasury Solvency

- **Contract**: The game cannot autonomously emit arbitrary tokens.
- **Rules**:
  1. Minting of `$CG` is strictly capped by the emission guard (`programs/staking/src/state.rs`) at 1.25× 7-day average burns, floored at 30% of scheduled emissions.
  2. Wager escrows in Arena require exact 100% collateral locking before battle resolution.
  3. Studio treasury balance and SKR prize pools maintain the double-entry invariant:
     `funded >= paid + reserved + withdrawn`.
- **Endpoints**:
  - `GET /watchtower/treasury-balance`
  - `GET /watchtower/economic-summary`
- **Test Reference**: `tests/localnet/70-property-invariants.spec.ts` (Invariant 5 & Invariant 6).

---

## 4. i-06: Unified Events & Cross-Game Quests

- **Contract**: All on-chain events follow standard taxonomy:
  - `CapShot`, `ChipMinted`, `PackOpened`, `WagerSettled`, `RewardGranted`, `TokenBurned`.
- **Deduplication**: Keyed by `cluster:slot:signature:instructionIndex:innerIndex`.
- **Endpoint**:
  - `GET /watchtower/events?limit=N&cursor=C`
- **Hub Acceptance**: Devnet ingestion tested via `POST /api/ingest/solana` (`accepted: true`, retry `duplicate: true`).

---

## 5. i-07: Cross-Game Profile & Progression

- **Contract**: Level, matches played, chips owned, and win-rate exportable to ecosystem leaderboards.
- **Endpoint**:
  - `GET /watchtower/live-stats`

---

## 6. i-10: Severity Dictionary & Alert Catalog

- **Contract**: Alignment with Watchtower hub alert schema (P1 Critical, P2 High, P3 Medium).
- **Runbooks**: Documented in `docs/ALERT_CATALOG.md`.
- **Endpoint**:
  - `GET /watchtower/dr-status`
  - `GET /watchtower/health`

---

## 7. i-11: Hub Control & Governance Boundaries

- **Contract**: Hub control requests are strictly proposal-only (`writes=false`).
- **Safety**:
  - Automatic slashing is forbidden.
  - Pausing programs requires multisig or timelock proposal.
  - Fraud mitigation sets flags (`rewardsPaused`, `shadowBanned`) without modifying player token balances.
- **Endpoints**:
  - `GET /watchtower/fraud-summary`
  - `GET /watchtower/security`
- **Test Reference**: `tests/watchtower/interweaving.test.ts`, `backend/test/security.test.ts`.

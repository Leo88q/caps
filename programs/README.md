# GUTTERCAPS on-chain programs

Four Anchor 0.31.1 programs. Design rationale and threat model: [`docs/03-architecture.md`](../docs/03-architecture.md).
Economy numbers are mirrored from [`packages/economy`](../packages/economy) and checked by `npm run economy:check` (textual diff of every constant + 64 golden VRF-expansion vectors replayed by `cargo test -p chip_core --test golden`).

| Program | Path | Holds | Upgrade authority |
|---|---|---|---|
| `chip_core` | `programs/chip_core` | 10 Core collections (update authority = `["collection", idx]` PDA), pack sales vault, pity, fusion, `ChipState` | Squads 3/5 + 48 h timelock |
| `market` | `programs/market` | listings (freeze-in-place), USDC offer escrows | Squads 2/5 |
| `staking` | `programs/staking` | **$CG mint authority** (`["emission"]`), token/chip pools, Merkle reward roots ($CG kinds 2–4), **SKR prize pool** (`["skr_pool"]`, SKR kinds 5–7, treasury-funded — never minted) | Squads 3/5 + 48 h timelock |
| `arena` | `programs/arena` | $CG wager escrows, oracle daily-cap breaker | Squads 2/5 |

`programs/_legacy_chip_game` is the v0.1 monolith kept for reference only (excluded from the workspace).

## Status — read this first

**The code has not been compiled.** The authoring environment had no Rust/Solana toolchain and no network access to crates.io, so everything here is written against the documented APIs of:

- `anchor-lang 0.31.1`, `anchor-spl 0.31.1`
- `mpl-core 0.12.1` (`default-features = false, features = ["anchor"]`) — `CreateV2CpiBuilder`, `CreateCollectionV2CpiBuilder`, `UpdatePluginV1CpiBuilder`, `BurnV1CpiBuilder`, `TransferV1CpiBuilder`, `BaseAssetV1::from_bytes`
- `switchboard-on-demand 0.13.0` (`features = ["anchor"]`, chip_core only) — `RandomnessAccountData::parse` wrapped by `chip_core::randomness` (owner check + `seed_slot`/`reveal_slot`/`value` rules shared with arena via the cpi dependency; never `get_value(slot)`)
- `pyth-solana-receiver-sdk =1.0.1` — `PriceUpdateV2::get_price_no_older_than`

**Phase 6 security review (`docs/06-acceptance-security-testing.md` §2) found three critical issues in the commit-reveal path that must be fixed before the first devnet deploy — do not test-drive the flow as-is:**

- **SEC-C1** — *fixed in code, uncompiled*: every randomness read goes through `chip_core::randomness::{parse_checked, assert_fresh_commit, revealed_value, assert_refundable}`; `SB_PROGRAM_ID` is selected by cargo feature — build with `anchor build` (mainnet `SBond…`), `anchor build -- --features devnet` (`Aio4…`) or `anchor build -- --features localnet` (`sb_mock` `ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH`). Never deploy a mainnet-feature build to devnet: the owner check would reject every real randomness account.
- **SEC-C2** — *fixed in code, uncompiled*: `PendingPack` persists `revealed`/`value` (159 bytes) at the first `open_pack`; packs 2…N never read the oracle account.
- **SEC-C3** — a buyer could peek at the reveal off-chain and take a 100 % refund instead → free re-rolls. **Partly fixed:** `STALE_PACK_SLOTS = 10 800` (≈ 72 min, after the oracle's 1 h reveal window) and `cancel_stale_*` now require `reveal_slot == 0` + `seed_slot == commit_slot`. **Still to do:** make the randomness `authority` a program PDA (so only the program can re-commit) and run the backend crank that opens packs for players.

Expect a first `anchor build` to surface: builder method names that drifted between mpl-core minors, lifetime annotations on `remaining_accounts` helpers, and `InitSpace` on `[PackDef; 4]`. None of these change the design; budget ~1 engineer-day for the compile pass, then run the golden test and the localnet suite (`tests/localnet/`, see its README — Switchboard is mocked by `programs/sb_mock`, not cloned).

## Build

```bash
rustup toolchain install 1.89.0            # pinned in rust-toolchain.toml
cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install 0.31.1 && avm use 0.31.1
sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"

anchor build
anchor keys sync                            # rewrites declare_id! + Anchor.toml
# then update the three constants in programs/chip_core/src/instructions/chip.rs
# (MARKET_PROGRAM_ID / STAKING_PROGRAM_ID / ARENA_PROGRAM_ID) and rebuild.

cargo test --workspace                      # host unit tests incl. tests/golden.rs
anchor test                                 # localnet with mpl-core, switchboard, pyth cloned from mainnet (Anchor.toml)
```

## Cross-program contracts

```
market ──set_chip_flag(F_LISTED)──▶ chip_core ──UpdatePluginV1(PermanentFreeze)──▶ mpl-core
market ──deliver_sold()───────────▶ chip_core ──unfreeze + TransferV1(PermanentTransfer)──▶ mpl-core
staking ─set_chip_flag(F_STAKED)──▶ chip_core
arena ───level_up()───────────────▶ chip_core            (arena_auth PDA; XP from season roots)
chip_core / market / arena ──report_burn()──▶ staking    (burn_reporter PDAs; feeds the emission guard)
staking ─grant_booster()──────────▶ chip_core            (rewarder PDA; quest claims)
```

Callers are authenticated by PDA seeds (`["market_auth"]`, `["stake_auth"]`, `["arena_auth"]`, `["burn_reporter"]`, `["rewarder"]`) derived from the hard-coded program IDs — no config-driven allowlists that an admin key could widen.

## Pack flow (commit → reveal), one purchase

1. Client: `sb.Randomness.create()` + `randomness.commitIx(queue)` + `chip_core.buy_pack(sku, qty, currency, nonce, max_lamports)` in **one** tx.
   - Payment + rent reserve go to the `["vault"]` PDA / `PendingPack`; `GameConfig.liab_*` increases.
   - `seed_slot == slot-1` and not-yet-revealed are enforced; the randomness key is pinned.
2. Crank (ours or anyone): `randomness.revealIx()` + `open_pack(nonce, pack_no)` per pack in the bundle.
   - The crank pre-simulates `expand()` with the revealed bytes to know which `CollectionMeta` accounts to pass; the program re-derives and rejects mismatches.
   - Assets are PDAs `["asset", pending, pack_no, i]` → retries can't double-mint.
   - Rent is reimbursed from the reserve; last pack settles $CG burn/split and closes `PendingPack`.
3. If the oracle never reveals: after `STALE_PACK_SLOTS = 10 800` (≈ 72 min — the oracle's 1 h reveal window plus margin) `cancel_stale_pack` refunds 100 % from the vault (any currency, no admin), and only if `reveal_slot == 0` (SEC-C3 part 1, owner decision Q3). Still open from SEC-C3: randomness `authority` = program PDA + the backend crank (see `docs/06` backlog #3).

## Fusion flow

- Recipes 0–3 (100 %): `fuse` burns 3, mints 1 atomically (`PendingFusion` closed in the same ix).
- Recipes 4–7: `fuse` freezes materials (`F_FUSING`), burns the fee, pins randomness → `fuse_reveal` burns/mints (or refunds 1 material deterministically: lowest asset key). `cancel_stale_fusion` only unfreezes; the fee stays burned.
- Booster: `PlayerItems.boosters` (non-transferable), +15 pp, cap 95 %.

## Emission guard (staking)

Daily `tick_day` (permissionless): `budget = min(schedule(year), 0.30·schedule + 1.25·avg(burn_ring[7]))`, further capped by the year's remaining allowance. Pools receive `budget_per_sec` for the next 24 h; quests/PvP/events slices accumulate in `slice_budget` and are only released through `publish_root` (oracle-specific, ≤ slice budget, 1 h timelock, admin-revocable) → `claim_root` (Merkle leaf = `keccak(0x00‖wallet‖amount‖kind‖epoch)`). **All minting goes through `mint_to_user`, which enforces both the yearly cap and the cumulative cap.**

## SKR prize pool (staking, `instructions/skr.rs`)

SKR (Seeker) is the second reward currency. Its mint authority is Solana Mobile's Squads vault, so the game can neither mint nor burn it; rewards are paid from a **treasury-funded pool** instead of an emission schedule:

- `SkrPool` (`["skr_pool"]`): `skr_mint`, `vault` (token account owned by the PDA), `budget`, `reserved`, `funded_total`, `paid_total`, `max_root_budget` (default 100 000 SKR), `paused`. Invariant: **`vault.amount ≥ budget + reserved`**.
- `init_skr_pool` (admin, once) · `fund_skr` (anyone; the treasury wallet `HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho` runs it weekly with 15 % of realised SKR pack revenue, 10 % of the treasury part of SKR market fees, 5 % of SKR services revenue — owner policy, `packages/economy/src/skrRewards.ts`; `npm run skr-pool -- plan` computes the amount) · `sync_skr_pool` (absorb direct transfers) · `withdraw_skr` / `set_skr_pool` (admin; only unreserved `budget` can leave).
- `publish_skr_root(kind 5|6|7, epoch, root, budget)` — quest oracle for 5, season oracle for 6/7; `budget ≤ min(pool.budget, max_root_budget)`; moves `budget → reserved`. Same `["root", kind, epoch]` PDA family and the same leaf format as $CG roots (the `kind` byte in the leaf prevents cross-currency replay). `revoke_skr_root` returns the unclaimed remainder to `budget`.
- `claim_skr_root(amount, proof)` — after the shared 1 h `ROOT_TIMELOCK`; `token::transfer` from the vault signed by the pool PDA; `reserved −= amount`. `claim_root` rejects kinds ≥ 5 and `claim_skr_root` rejects kinds < 5 (`WrongRootCurrency`), so neither path can ever reach the other currency.
- Events: `SkrFunded{funder, amount, budget, reserved}`, `SkrWithdrawn{to, amount, budget}`, `SkrPoolChanged{max_root_budget, paused}`; `RootPublished/RootRevoked/RootClaimed` are shared (kind ≥ 5 ⇒ SKR). The backend exposes the ledger at `GET /v1/rewards/skr-pool`.
- Ops: `npm run skr-pool -- init | fund <skr> | sync | status | test-mint` (`scripts/skr-pool.ts`, IDL-free, `DRY_RUN=1` prints the instruction). `init` runs after `init_emission` (pool admin = `emission.admin`); `test-mint` refuses to run on mainnet.


## Phase 4 review notes (client integration)

While writing the TypeScript instruction builders two issues in `chip_core` were fixed:

* `open_pack` — `PermanentTransferDelegate` plugin was pushed **twice** into the asset's plugin list (a Core `CreateV2` with duplicate plugin types fails). Now once.
* `OpenPack.buyer` was not `mut` although `open_pack` credits it with the leftover rent reserve when the last pack of a bundle closes `PendingPack` (`try_borrow_mut_lamports` on a read-only account fails at runtime). Now `#[account(mut, address = pending.buyer)]`.

Client account order (`client/src/chain/ix/*.ts`) mirrors the `#[derive(Accounts)]` structs 1:1; if you reorder fields here, update the builders and `client/src/chain/chain.test.ts`.

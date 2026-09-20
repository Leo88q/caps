# Security audit and production gate — 2026-09-20

## Scope and conclusion

This pass reviewed the on-chain programs (`chip_core`, `market`, `staking`, `arena`), the backend API/indexer/crank/oracle paths, the wallet transaction builders, and the economy package. The review was source-based because this checkout does not contain the Rust/Anchor toolchain or installed Node dependencies.

**Conclusion: the code is not yet approved as production-ready.** The fixes below are applied, but an Anchor build, localnet security suite, devnet oracle/randomness run, and independent audit are release gates, not optional evidence. The backend's production data layer is still `node:sqlite`; the Prisma schema is a target description, not a running adapter. Do not deploy multiple API/indexer instances until the data-layer decision is implemented and tested.

## Findings fixed in this pass

| ID | Severity | Area | Finding | Fix |
|---|---:|---|---|---|
| GC-01 | High | `chip_core` | `thaw_chip` accepted a signer called `owner` without checking that the signer owned the Metaplex Core asset. An attacker could clear the soulbound bit and unfreeze another wallet's unlocked chip. | `thaw_chip` now loads the Core asset, verifies the MPL Core account owner, and requires `base.owner == owner`. |
| GC-02 | High | Pyth / settlement | The backend selected Pyth accounts from environment defaults while `GameConfig` could point to another account. The resulting quote and transaction could disagree. On-chain handlers also accepted any valid account carrying the feed. | Backend quotes and the cache now read the authoritative `GameConfig.pyth_*` accounts. `buy_pack` and `pay_service` require the supplied account to equal the configured account for the selected currency. |
| GC-03 | High | randomness close | Close paths relied mainly on helper parsing for Switchboard ownership. | `chip_core::close_randomness` and `arena::close_battle_randomness` now enforce both the PDA seeds and `SB_PROGRAM_ID` at the account layer. The CPI helper remains a second check. |
| GC-04 | Medium | Core asset parsing | Manual `BaseAssetV1` parsing in chip, fusion, market, arena, and staking paths did not consistently assert that the account was owned by MPL Core before decoding it. | All current manual Core parsers now check the account owner before parsing. |
| GC-05 | Medium | SIWS | Nonce validation used select-then-delete semantics. Concurrent requests could verify the same signed message before either delete completed. | Nonce consumption is now a conditional atomic delete; a second redemption must observe zero deleted rows and fails. A replay regression test was added. |
| GC-06 | Medium | arithmetic | Market basis-point multiplication and staking pending-reward conversion contained avoidable narrow casts/overflow or truncation risks. | Market fee/royalty products use `u128`; staking `Pool::pending` uses checked multiplication and `u64::try_from`, returning an error on overflow. Boundary tests cover `u64::MAX` market prices. |
| GC-07 | Low / cost | NFT minting | Core `Attributes` plugins were written for every pack/fusion asset but no on-chain or frontend consumer was found. The same fields are already in `ChipState` and the metadata URI. | The redundant Attributes plugin was removed from both mint paths. Freeze, burn, and transfer delegates remain because they enforce the game/market lifecycle. This reduces asset account rent and CPI payload; exact lamport savings still require a built localnet measurement. |
| GC-08 | Low | nonce generation | Quote and fusion nonces used `Math.random()` in a PDA namespace. | Both now use a cryptographically random full `u64` nonce from `node:crypto`. |

## Controls confirmed during review

- SPL settlement accounts are constrained by mint and authority in market, arena, and service flows; arena winner destinations are checked against the selected winner.
- Marketplace offers bind the offer to both the asset and bidder; escrow mints and authorities are checked.
- Pending pack/fusion/battle and randomness PDAs include the user and nonce. Stale-close paths require the pending object to be absent or the battle to be terminal.
- Pack/fusion material ownership, chip-state PDAs, duplicate materials, lock flags, and collection/rarity rules are checked on chain.
- Emission/root claims enforce proof, timelock/revocation, root kind, claim budget, and emission caps.
- Backend already has production checks for explicit CORS, secure cookies, SIWS domain/issuedAt, session secret length, finality shortcuts, security response headers, body limits, and rate limiting.
- Frontend API and WebSocket paths use same-origin/relative routing; transaction builders carry quote account and slippage data rather than trusting display prices.

## Remaining release blockers

1. **Build and tests:** run `anchor build`, `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, backend/client tests, and the localnet suite with real program artifacts. This pass could not run them because `cargo`, `anchor`, `node_modules`, and `vitest` are absent.
2. **Oracle/randomness:** exercise the configured Pyth accounts and Switchboard implementation on devnet; validate account IDs, full verification, age/confidence boundaries, reveal/close rent flow, and the production cluster program IDs. Existing documentation still requires the devnet T-D-04 run.
3. **Data layer:** implement and migrate the Postgres adapter or formally select a single-instance SQLite/LVM deployment with documented RPO, backups, restore drills, and a hard deployment topology limit. Prisma currently does not back the running `db.ts` code.
4. **Arena trust boundary:** wagered battle winner/result generation remains server-authoritative. VRF makes the seed auditable, but an independent battle oracle can still submit a permitted participant as winner. Before meaningful wagers, either independently attest/verify the fight result on chain or use a documented, monitored, multisig-controlled oracle policy with an explicit loss limit and incident procedure.
5. **Shared infrastructure:** production must use Redis for cross-instance rate limits and event fan-out, keep crank/oracle keys in a secrets manager/HSM-equivalent workflow, enforce balance ceilings, and test failover/backpressure.
6. **External review:** commission an independent Solana/Anchor and Metaplex Core review, with economic/tokenomics review, before mainnet funds or valuable NFT inventory are enabled.

## Required acceptance evidence

- Reproducible build artifacts and IDL/account-layout checksum recorded for the deployed commit.
- Localnet adversarial tests for unauthorized thaw, forged Core accounts, foreign Pyth accounts, stale close, wrong refund destination, duplicate/replayed SIWS nonce, offer escrow mismatch, root-budget exhaustion, and integer boundaries.
- Devnet evidence for real Pyth/Switchboard accounts, including a deliberate stale/uncertain price and a reveal/close retry.
- Cost report comparing old/new Core asset rent and transaction compute units for pack and fusion minting.
- Restore drill from backup; indexer rebuild hash equals the expected projection hash; metrics/alerts and pause runbook exercised.
- External audit report with all Critical/High findings closed or explicitly accepted by the multisig governance process.

## Bubblegum V2 migration gate (full_closed policy)

The full migration is now explicitly a **closed/custom marketplace** migration. The previous MPL Core ownership paths are not considered compatible with the target design and must not be mixed with the V2 authority model. The migration plan, normalized DAS transport, and proof negative tests are in `docs/11-bubblegum-v2-migration.md`, `backend/src/das.ts`, and `backend/test/das.test.ts`.

The following remain hard release blockers until the V2 path replaces the current paths and is built/tested:

- `BaseAssetV1` parsing and Core transfer/freeze/burn CPI still exist in `chip_core`, `market`, `staking`, and `arena`;
- the current marketplace assumes atomic Core unfreeze + transfer, whereas V2 settlement must be a two-phase payment/transfer/finalization state machine;
- `mpl-bubblegum 2.1.1` is pinned in `chip_core` and must still compile against the pinned Anchor 0.31/Solana 2 dependency graph; the current latest 3.x line is not a drop-in upgrade;
- V2 tree creation, collection plugins, DAS proof transport, fresh-proof enforcement, client builders, indexer convergence, localnet fixtures, and devnet smoke tests are not complete;
- no release may claim cNFT ownership or market finality from DAS JSON alone: Bubblegum CPI verification and finalized reconciliation are required.

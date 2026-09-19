# tests/localnet — on-chain acceptance suite (docs/06 §3.5, backlog #14)

77 scenarios (T-L-G/C/F/M/A/S/X) that drive the **real** client builders from `client/src/chain/*`
against the compiled programs. One set of specs, two back-ends behind the `Chain` interface
(`helpers/chain.ts`):

| back-end | command | needs | clock / forged accounts |
|---|---|---|---|
| **LiteSVM** (in-process SVM, default) | `npm test` | `target/deploy/*.so` + `fixtures/mpl_core.so` | yes — `warpSlots`, `warpSeconds`, `setAccount` |
| **validator** (`solana-test-validator`) | `npm run test:validator` (= `anchor test`) | Solana CLI + Anchor, RPC access to clone mpl-core / Pyth receiver | no — the 8 `svmOnly` scenarios are skipped |

Without binaries `npm test` prints the missing paths and reports every spec as skipped (exit 0), so
the root `npm run verify` stays green on machines without a Rust toolchain.

## When the suite refuses to boot

`Failed to add program: Offset or value is out of bounds` from litesvm is **not** a broken scenario: that
binding says it for a **0-byte `.so`** (a missing file says `No such file or directory`, garbage says
`Detected sbpf_version required by the executable which are not enabled`). Usual cause is a truncated
`tests/localnet/fixtures/mpl_core.so` restored from the CI cache or a half-finished `--force` fetch. The
guard in `helpers/env.ts` checks the ELF header rather than mere existence, so you get this instead:

```
[tests/localnet] 1 program binary/binaries missing — refusing to skip in CI/strict mode:
  …/tests/localnet/fixtures/mpl_core.so — empty or truncated (0 bytes)
```

Fix: `rm -f tests/localnet/fixtures/*.so && npm run localnet:fixtures`.

2026-09-19 (update): the same litesvm message returned TWICE, and the two rounds had different causes.

1. A cache entry whose ELF magic was intact but whose body was truncated — the magic-only check passed
   it. `checkProgramBinary` now validates the program-header table and every segment's
   `p_offset + p_filesz` against the real file size, so a partial download fails loudly at boot
   ("… — truncated dump") instead of dying mid-suite as eight scenario failures.
2. With a structurally valid, freshly dumped `mpl_core.so` the suite STILL failed the same way:
   Metaplex deployed `core@0.15.2` to mainnet (2026-09-17/18) and **litesvm 1.4.1 cannot load that ELF
   at all** — the "truncated file" message is also what the binding answers for an ELF it simply cannot
   parse. A live-mainnet fixture is a moving target, so `mpl_core.so` is now **pinned to a Metaplex
   GitHub release asset** (`release/core@0.12.0` — the program release of the era `docs/03-architecture.md`
   declares as the dependency target, mpl-core 0.12.1; the Rust crate itself sits on the 0.11.1
   anchor-feature fallback chosen in docs/09 §1.2), not the newest release. Version skew breaks the
   suite at runtime: 0.15.1 loaded fine but answered with «Not a Core AssetV1» and shifted error codes;
   0.11.0 skewed error codes and PDA state the other way (ConstraintSeeds expected, system error 0
   arrived). The CI cache key carries the version (`mpl-core-release-0.12.0-v1`).
   To move to a newer core: bump the crate pin in `programs/…/Cargo.toml`, `MPL_CORE_VERSION`, and the
   cache key together — and expect to also need a litesvm upgrade for ≥0.15.2 (its ELF cannot be added
   to litesvm 1.4.1, the latest published). `--from-chain` forces the old mainnet dump.
   `chain.ts` now also names the exact program and file on an `addProgramFromFile` failure.

## Layout

```
tests/localnet/
  vitest.config.mts     runner: aliases @/… + @guttercaps/economy, VITE_CLUSTER=localnet, one fork, file-name order
  tsconfig.json         `npx tsc -p tests/localnet --noEmit`
  run-validator.ts      build (--features localnet) → solana-test-validator → vitest with LOCALNET_RPC
  fetch-fixtures.ts     mpl_core.so ← pinned Metaplex release asset (core@0.12.0 = suite dependency era); pyth_receiver.so ← RPC dump
  fixtures/
    sb_mock-keypair.json  program keypair of programs/sb_mock (id ApDh35…, pinned in chip_core::randomness)
    pyth_sol_usd.json     PriceUpdateV2 genesis dumps for the validator back-end (owner rec5…, publish_time 2100-01-01,
    pyth_skr_usd.json     addresses 2pJU… / 9AMC… derived from a fixed seed — also listed in Anchor.toml)
    mpl_core.so           git-ignored, `npm run localnet:fixtures`
  helpers/
    chain.ts   Chain interface, LiteSvmChain (litesvm 1.4.1 through a web3.js → kit tx shim), RpcChain, TxFailure/parseFailure
    env.ts     getEnv(): boots the chain once per run — mints, $CG faucet stash, initialize, 10 × create_collection
               from lore, vault/treasury ATAs, init_emission, init_skr_pool, init_arena; admin ix builders; player()/fund()
    pyth.ts    PriceUpdateV2 fixtures (SOL $150, SKR $0.0174, expo −8): setAccount on LiteSVM, genesis dumps on RPC
    sbmock.ts  sb_mock client: decodeRandomness, revealIx(value), setRawIx, forgeRandomness, deterministic valueOf(label)
    flows.ts   buyPack / revealPack / openPack / revealAndOpenAll / mintChips / cancelStale / quoteUnits
    expect.ts  Err.chip|market|staking|arena|mock|anchor|token tables (name → 6000 + index), expectFail / expectAnyFail
  00-admin.spec.ts    G01–G06   initialize, create_collection, set_params guard rails, pause, admin hand-over, sweep_vault, grant_booster
  10-packs.spec.ts    C01–C20   starter/soulbound, Pyth SOL & SKR quotes, USDC/$CG, bundles, limited cap, pause, open ×3 in one tx,
                                ×5 across slots (SEC-C2), ×25 CU budget, fake randomness (SEC-C1), stale/refund (C3), crank race,
                                remaining_accounts, pity, rng PDA authority/reuse (SEC-C3 part 2), reveal by stranger, close_randomness
  20-fusion.spec.ts   F01–F11   atomic + randomized recipes, same-collection rule, locks, failure refund, fake randomness, cancel_stale, boosters, busy materials
  30-market.spec.ts   M01–M09   list (fee burn, freeze), locked chips, buy split 7.5 % ⅓/⅔ + 2.5 % royalty, PriceChanged, SelfTrade, update/cancel, offers, fee guard, paused
  40-arena.spec.ts    A01–A09   create/accept/resolve, rake 40/40/20, oracle-only, fake randomness, cancel_stale, daily cap, squad checks, battle rng lifecycle
  50-staking.spec.ts  S01–S21   emission/tick_day, $CG tiers, split guard, burn oracle, chip staking + set bonus, Merkle roots, SKR prize pool (S14–S20), fund_slice season-rake recycling (S21, SEC-L5)
  60-cross.spec.ts    X01–X04   stake ↔ list ↔ buy loop across programs; set_chip_flag / deliver_sold / level_up are CPI-only
```

Scenario IDs in the `it(...)` titles match docs/06 §3.5 so a CI junit report (`target/localnet-junit.xml`
when `CI=1`) can be cross-referenced with the acceptance table in §1.1.

## Running

```bash
# one-time: third-party program binaries for the in-process back-end
npm run localnet:fixtures                       # mpl_core.so ← pinned Metaplex release core@0.12.0; pyth_receiver.so ← mainnet RPC (optional)
# or offline: download https://github.com/metaplex-foundation/mpl-core/releases/download/release/core%400.11.0/mpl_core_program.so
#             → tests/localnet/fixtures/mpl_core.so   (or: solana program dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d … -u m)

# build our programs with the localnet feature (SB_PROGRAM_ID = sb_mock) — sb_mock must be built from its pinned keypair
cp tests/localnet/fixtures/sb_mock-keypair.json target/deploy/
anchor build -- --features localnet

npm test                                        # LiteSVM, ~1–2 min, all 77 scenarios
npm test -- -t "C07"                            # one scenario (the env still boots)
npm run test:validator                          # real validator; KEEP_VALIDATOR=1 to leave it running, SKIP_BUILD=1 to reuse target/deploy
LOCALNET_RPC=http://127.0.0.1:8899 npm test     # against an already running validator (see run-validator.ts output for the Pyth env vars)
npx tsc -p tests/localnet --noEmit              # typecheck only (works without binaries)
```

## How the hard parts are handled

**Switchboard.** Nothing is cloned. `programs/sb_mock` (feature-gated program id
`ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH`) implements the four instructions our programs
invoke by CPI — `randomness_init / commit / reveal / close` — with the **real discriminators, account
metas and the 480-byte `RandomnessAccountData` layout**, plus a test-only `set_raw`. `reveal` takes any
64-byte "signature" and stores `value` with `reveal_slot = slot`, so a spec plays the oracle:
`revealIx({ kind, payer, randomness, value })`. Values are deterministic per scenario (`valueOf('C07')`)
and the expected chips are computed with `expandRandomness` from `@guttercaps/economy`, so
`PackOpened` is asserted byte-for-byte.

**Pyth.** `PriceUpdateV2` accounts are written directly under the receiver's owner (`rec5…`). The SDK
checks owner + discriminator + verification level + feed id + `publish_time` age — never a signature —
so a forged account is indistinguishable from a posted one. LiteSVM refreshes `publish_time` before
every SOL/SKR purchase (`refreshPyth`); the validator flow loads `fixtures/pyth_*.json` at genesis
with `publish_time` = 2100-01-01, which the age check (`publish_time + 60 ≥ now`) never rejects.

**Clock.** LiteSVM starts with `unix_timestamp = 0`; `LiteSvmChain.create` sets it to wall-clock and
advances one slot (0.4 s) per transaction, so commit / reveal / settle land in distinct slots exactly
like the crank sees them. `warpSlots(10_801)` and `warpSeconds(7 d)` drive the stale-refund, lock and
timelock scenarios; SlotHashes is refreshed after every warp because `randomness_init` and the Address
Lookup Table program read it.

**Errors.** `expectFail(promise, Err.chip('RandomnessMismatch'))` asserts both the custom code (name →
`6000 + index` from the Rust enum order mirrored in `helpers/expect.ts`) and the program that raised it
(parsed from `Program X failed` logs), so a CPI failure inside chip_core is not mistaken for a market
error. Anchor framework errors are asserted by name (`Err.anchor('ConstraintSeeds')`). Signature
failures (an unsigned PDA passed from a wallet) have no custom code — on LiteSVM the shim submits a
zero signature so the SVM rejects the tx, on RPC the transaction is sent raw without client-side
verification; both surface as a `TxFailure` with `code === undefined`.

**Isolation.** Every scenario uses fresh wallets (`env.player()`), so order only matters for global
state (pause, params, emission day) and those specs restore what they change. The whole run shares one
booted environment (`getEnv()`), which is why the runner is pinned to a single fork and file-name order.

## Adding a scenario

1. Pick the next ID from docs/06 §3.5 (or add a row there first).
2. Use the client builder for the player-facing instruction; add admin-only builders to `helpers/env.ts`
   (account order mirrors the `#[derive(Accounts)]` struct — keep the comment pointing at it).
3. Mark LiteSVM-only steps with `svmOnly(...)` (whole test) or `if (!env.chain.canWarp) return;` (tail
   of a test) so the validator run stays green.
4. New error variants: extend the arrays in `helpers/expect.ts` **and** `client/src/chain/errors.ts`
   (both are enum-order sensitive; `packages/economy/scripts/sync-check.ts` pins the Rust side).

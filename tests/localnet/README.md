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
binding says it for any bytes that are **not a complete ELF** — a 0-byte `.so`, garbage, or a file whose
declared structures run past its end (a missing path says `No such file or directory` instead, and a
complete-but-wrong ELF says `Failed to parse ELF file: <what is wrong>`). The full measured table is the
header of `helpers/elf.ts`, and `npm run selftest:elf` keeps it measured by driving the installed binding.

Run 81 (docs/09 §G-2) was this class, and its cause is now known: `fetch-fixtures.ts` trimmed trailing
zero bytes out of a `solana program dump` and cut into the ELF's own section header table (its last entry
ends in zeros), so every dump it wrote was unloadable. The trim now stops at the structure end and the
guard in `helpers/env.ts` checks the structure rather than mere existence, so a damaged artifact reads
like this instead:

```
[tests/localnet] 1 of 6 program binaries are not loadable:
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d ← …/tests/localnet/fixtures/mpl_core.so — section header table [784, 848) runs past the end of the file (840 bytes) — the artifact is cut short (840 bytes)
```

Fix: `rm -f tests/localnet/fixtures/*.so && npm run localnet:fixtures` (or just run `npm run localnet:fixtures`:
a file that fails this check is refetched instead of trusted).

## Layout

```
tests/localnet/
  vitest.config.mts     runner: aliases @/… + @guttercaps/economy, VITE_CLUSTER=localnet, one fork, file-name order
  tsconfig.json         `npx tsc -p tests/localnet --noEmit`
  run-validator.ts      build (--features localnet) → solana-test-validator → vitest with LOCALNET_RPC
  fetch-fixtures.ts     `solana program dump` over JSON-RPC → fixtures/mpl_core.so (+ pyth_receiver.so)
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
npm run localnet:fixtures                       # mpl_core.so (+ pyth_receiver.so, optional) from mainnet RPC
# or offline: solana program dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/localnet/fixtures/mpl_core.so -u m

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

# tests/localnet — Anchor localnet suite (planned, docs/06 §3.5)

This directory replaces the legacy `tests/chip-game.ts` (moved to
`programs/_legacy_chip_game/tests/`, monolith with program id `ChpGame111…`).
`anchor test` and `npm test` already point here.

## Layout

```
tests/localnet/
  README.md            this file
  fixtures/
    pyth_sol_usd.json  PriceUpdateV2 account dump (solana account --output json), publish_time patched per test
    bundle_seed.json   golden vectors for keccak(value ‖ pack_no) sub-seeds (shared with Rust + client)
  helpers/
    env.ts             provider, program clients (client/src/chain/* builders are imported directly)
    sbmock.ts          reveal(value) / setRaw against programs/sb_mock (init/commit/close go through our programs)
    clock.ts           bankrun warpToSlot / setClock wrappers
  00-admin.spec.ts     T-L-G01..G06
  10-packs.spec.ts     T-L-C01..C16
  20-fusion.spec.ts    T-L-F01..F11
  30-market.spec.ts    T-L-M01..M09
  40-arena.spec.ts     T-L-A01..A09
  50-staking.spec.ts   T-L-S01..S20   (S14..S20 = SKR prize pool: fund/publish/claim/revoke/withdraw/pause/cross-currency)
  60-cross.spec.ts     T-L-X01..X04
```

## Prerequisites (G-0)

1. `anchor build -- --features localnet` — the `localnet` feature of `chip_core` (forwarded by
   `arena`) points `chip_core::randomness::SB_PROGRAM_ID` at the mock program id
   `ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH` (keypair: `fixtures/sb_mock-keypair.json`;
   deploy `sb_mock` with exactly this keypair), see SEC-C1 / SEC-H1 in docs/06.
2. `programs/sb_mock` — ~120-line program: account with the Switchboard `RandomnessAccountData`
   discriminator `[10,66,229,135,220,239,217,114]` and layout (480 B:
   `authority, queue, seed_slothash, seed_slot, oracle, reveal_slot, value, lut_slot, ebuf…`).
   Since SEC-C3 part 2 our programs call Switchboard **by CPI**, so the mock must expose the
   real instruction names / discriminators / account metas (see
   `chip_core::randomness::SB_IX_RANDOMNESS_*` and the `Sb*Accounts` structs):
   `randomness_init(recent_slot)` (`randomness` + `authority` signers — both PDAs of the caller),
   `randomness_commit` (**authority signer == data.authority**, `seed_slot = slot - 1`),
   `randomness_reveal(signature, recovery_id, value)` (authority signer; no secp check;
   `reveal_slot = slot`), `randomness_close` (authority signer; lamports → authority), plus
   `set_raw(bytes)` for negative tests. Loaded via `[[test.genesis]]` in `Anchor.toml`.
3. Pyth `PriceUpdateV2` fixture under `fixtures/`, wired through `[[test.validator.account]]`.
4. `anchor keys sync`, then update `chip_core::instructions::chip::{MARKET,STAKING,ARENA}_PROGRAM_ID`
   (guarded by unit test T-R-24).

Scenario-by-scenario expectations are in `docs/06-acceptance-security-testing.md` §3.5;
IDs in spec files must match (`T-L-C07`, …) so the CI report can be cross-referenced with
the acceptance table in §1.1.

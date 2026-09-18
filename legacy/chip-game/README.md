# `chip-game` v0.1 — reference only

Anchor 0.30.1 monolith: packs, rarity, upgrades, marketplace and staking in one program. Split into the
four programs under `../programs` (`chip_core`, `market`, `staking`, `arena`) for upgrade blast radius and
CU limits — rationale in [`docs/03-architecture.md`](../../docs/03-architecture.md).

Nothing here is built, tested, audited or deployed. It is kept so that the migration of each instruction can
be diffed against what v0.1 did, until the 4-program suite is on devnet (`docs/09-production-readiness.md` §2).

## Why it is not in `programs/`

`anchor build` does not ask `[workspace]` what to compile — it takes the program list from the directories
under `programs/`. While this crate lived at `programs/_legacy_chip_game` with `exclude = [...]` in
`Cargo.toml`, cargo correctly ignored it and anchor correctly did not: the build ran `cargo build-sbf` here
anyway, and the monolith's own dependencies cannot be resolved —

```
anchor-lang = "0.30.1"   →  solana-program ^1.17.3
switchboard-v2 = "0.4.0" →  solana-program >=1.16, <1.17
```

one `1.x` version cannot be both, so `cargo metadata` fails with "failed to select a version for
`solana-program`" and takes the whole `programs` job down (ci.yml run 75, 2026-09-18). Moving the directory
out of `programs/` is the fix; adding another `exclude` is not, and neither is patching this manifest to
something resolvable — a build of code nothing runs would be a build we would have to keep passing.

If it ever moves, it moves *further* from `programs/`, not back into it.

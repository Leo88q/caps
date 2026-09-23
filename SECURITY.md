# Security policy

GUTTERCAPS holds user funds (pack vault, market escrows, wager escrow, staking). Treat anything
touching those paths as a security issue.

## Reporting

Open a **private GitHub Security Advisory** in `Leo88q/caps`
(Security → Report a vulnerability). Never post an exploit in a public issue.
Format we would like (but any working PoC is fine):

`ID · Severity · Program/file:line · PoC (tx log or a tests/localnet spec) · Impact · Recommendation`

## Response SLA (same numbers the external auditor works to — `docs/08-audit-handoff.md` §6)

| Severity | Acknowledged | Triage + plan | Fix + test |
|---|---|---|---|
| Critical / High | ≤ 1 business day | ≤ 2 business days | ≤ 5 business days, then a patched deploy |
| Medium | ≤ 1 business day | ≤ 2 business days | before the next gate (G-2) |
| Low / Info | ≤ 3 business days | — | fixed or accepted in writing |

Every accepted finding gets: a commit with the fix, a test (`tests/localnet/*` or a `#[test]`), and a
row in `docs/06-acceptance-security-testing.md` §2.2 and `docs/08-audit-handoff.md` §3.1.

## Bug bounty

Runs from mainnet launch (Immunefi-style, up to 10 % of the value at risk, capped at $50 k) — the
number the auditor's report is scoped against: total value at risk = pack vault + market/wager
escrows + staking budget.

## Known accepted risks (read before filing)

Recorded decisions, not oversights — see `docs/06` §2.2 and `docs/08` §4.4:

- Arena does not freeze chips during a wager battle (`SEC-L2`); squads are snapshotted.
- Pyth SKR/USD feed is thin: ±2 % confidence guard, 1 % slippage, charge at `price − conf`; no EMA yet.
- The treasury SKR wallet is currently a single-signer hardware key (migration to Squads before launch).
- `randomness_close_lut` rent reclaim (`#23`) is unimplemented: ~0.0015 SOL of rent leaks per bundle.

## Current exposure of this repository (from `docs/09-production-readiness.md`)

`npm audit --omit=dev` reports one advisory chain in the production tree: `bigint-buffer`
(GHSA-3gc7-fjrx-p6mg, high, no upstream fix) through `@solana/buffer-layout-utils` → `@solana/spl-token`
→ `@switchboard-xyz/on-demand`. It is accepted with a reason and an expiry date in
`scripts/audit-gate.ts` (the only caller passes fixed-length layout blobs, and the vulnerable code is the
optional native addon our images do not build). The other 19 advisories that used to be here were
transitive through `jayson` (`uuid`, `stream-json`) and `toml` and are gone via `overrides` in the root
`package.json` (`jayson ^5`, `toml ^5`). The `security` CI job runs `npm run audit:gate`, which **fails**
on any high/critical advisory outside that dated list — acceptance is re-decided when the entry expires,
not forgotten.

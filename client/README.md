# @guttercaps/client

React 18 + TypeScript (strict) + Vite 5 front-end for GUTTERCAPS. Architecture and decisions: [`docs/04-frontend.md`](../docs/04-frontend.md).

```bash
# from the repo root (npm workspaces)
npm install                           # no native modules anywhere in the workspace
cd client
cp .env.example .env.local            # set RPC / program ids / flags
npm run dev                           # http://localhost:5173 — proxies /v1 and /ws to VITE_DEV_API_TARGET
npm run typecheck && npm test         # tsc --noEmit + vitest (codecs, PDAs, golden vectors, route smoke tests)
npm run build                         # dist/
npm run api:types                     # regenerate src/api/schema.d.ts from ../backend/openapi.yaml
```

Without a backend the app falls back to a deterministic **mock API** (`src/api/mock`) — set `VITE_API_MOCK=true` to force it. In mock mode transactions are simulated (no wallet signature), so every screen and the reveal flow can be reviewed end-to-end.

## Layout

| dir | what |
|---|---|
| `src/app` | config (env), providers (Connection → Wallet → Query → Session), router, shell, zustand stores (`ui`, `session`, `txs`) |
| `src/api` | typed fetch over the OpenAPI schema, TanStack Query hooks, WS invalidation, mock |
| `src/chain` | hand-written Anchor codecs (no IDL needed), PDAs, account decoders, per-program instruction builders (`ix/`), Switchboard + Pyth helpers, tx pipeline, commit-reveal flows |
| `src/features` | one folder per screen: home, collection (10×9 grid), shop + opening, reveal, fusion, arena, market, staking, quests, leaderboard, profile, codex, verify |
| `src/shared` | design tokens (`theme.css`), layout utilities, primitives, procedural `ChipArt`, lore, formatting |

The instruction builders mirror `programs/*/src` account order exactly; `src/chain/chain.test.ts` asserts account sizes against `INIT_SPACE` and replays `packages/economy/golden/pack_expand.json` (shared with the Rust tests) through the same `expandRandomness` the verifier UI uses.

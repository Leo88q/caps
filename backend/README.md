# @guttercaps/backend

The off-chain half of GUTTERCAPS. It replaces the legacy `indexer/` (single
program, Anchor IDL, better-sqlite3) with one package that understands all
four programs and serves the client API described in `openapi.yaml`.

```
backend/
├─ openapi.yaml            # API contract (client/src/api/schema.d.ts is generated from it)
├─ prisma/schema.prisma    # production Postgres schema (same shapes as db.ts)
├─ src/
│  ├─ config.ts            # program ids, RPC, DB path, cookie/handle rules (env-driven)
│  ├─ events.ts            # Anchor-free event codec: 27 events × 4 programs, decode + encode + log walker
│  ├─ borsh.ts             # tiny Borsh reader/writer
│  ├─ db.ts                # node:sqlite store (events_raw + projections + api state)
│  ├─ projections.ts       # event → chips / listings / sales / battles / stakes / burns / service_payments
│  ├─ ingest.ts            # tx logs → events_raw → projections, cursors, bounded-concurrency fetch
│  ├─ backfill.ts          # historical walk (getSignaturesForAddress) per program
│  ├─ listen.ts            # onLogs websocket per program + periodic gap healer
│  ├─ rebuild.ts           # truncate projections and replay events_raw
│  ├─ auth.ts              # SIWS nonce/verify, HttpOnly session cookie + CSRF
│  ├─ services.ts          # paid services: ref_hash verification, handle claim, entitlements
│  ├─ queries.ts           # read models behind the routes
│  ├─ server.ts            # express app (createApp)
│  └─ serve.ts             # entry point
└─ test/                   # vitest: codec round-trips, projections, HTTP API (SIWS + services)
```

## Run

```bash
# from the repo root (workspace install; no native modules → no --ignore-scripts needed)
npm install

cd backend
export SOLANA_RPC_URL=https://api.devnet.solana.com   # default
npm run backfill          # catch up on history for all 4 programs (or: npm run backfill -- market)
npm run dev               # listener (backfills on start, then live) + API on :8787
```

The Vite dev server proxies `/v1` to `http://127.0.0.1:8787`, so the client
uses the real API whenever it is up and falls back to its in-browser mock
per request when it is not (`501` for endpoints owned by other services).

Environment: `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `PROGRAM_{CHIP_CORE,MARKET,STAKING,ARENA}`,
`DB_PATH` (default `backend/guttercaps.sqlite`), `PORT` (8787), `CORS_ORIGINS`,
`SESSION_SECRET`, `COOKIE_SECURE=1` behind https, `SOL_USD_FALLBACK`, `SKR_USD_FALLBACK`.

## How indexing works

1. **Decode without an IDL.** Anchor logs `Program data: base64(sha256("event:Name")[..8] ‖ borsh)`.
   `events.ts` declares each event's fields in Rust order and derives the
   discriminator table; the log walker keeps an invoke/success stack so an event
   emitted by `chip_core` during a `market` CPI is attributed to `chip_core` with
   the outer instruction index. Failed transactions are skipped entirely.
2. **`events_raw` is the truth.** Unique on `(signature, ix_index, event_index)`.
   Backfill and the live listener both insert with `ON CONFLICT DO NOTHING`; a
   projection is applied only when the insert actually happened, inside the same
   SQLite transaction. Rows first seen over websocket have `block_time = NULL`
   until the healer/backfill fills it.
3. **Projections are rebuildable.** `chips`, `listings`, `sales`, `battles`,
   `stakes`, `burns`, `service_payments`, … are pure functions of the log.
   `npm run rebuild` truncates and replays. `wallets` (handles, referrer, risk)
   is *not* derived from chain and is kept.
4. **Gaps heal themselves.** `listen.ts` re-scans the newest 200 signatures per
   program every minute; because ingestion is idempotent this is cheap and
   closes any websocket drop without an operator.

Cursor per program lives in `indexer_cursor`; backfill stops when it meets
`newest_signature` and only advances it after a complete walk.

## Paid services (handles, skins, passes)

Payment is proven on-chain by `chip_core::pay_service` → `ServicePaid { buyer, kind, currency, amount, burned, ref_hash }`.
The backend proves *what* was bought by recomputing

```
ref_hash = keccak256(0x00 ‖ kind:u8 ‖ wallet:32 ‖ payload)
payload  = lowercase(handle)          for kinds 0/1
         = canonical JSON (sorted keys, no whitespace) otherwise
```

* `GET /me/handle/check?handle=` — validity, blocklist, case-insensitive uniqueness,
  90-day quarantine of released handles, 30-day change cooldown; reserves the
  name 120 s for the caller and returns the `refHash` to commit.
* `PUT /me/handle {handle, signature}` — finds the unconsumed `ServicePaid` of the
  right `kind` from the caller in that transaction, checks `ref_hash`, assigns the
  handle and marks the payment consumed — atomically. Old handle → `handle_history`.
* `POST /services/claim {signature, kind, payload}` — same for cosmetics; cap skins
  additionally require current ownership of the cap. Season pass expires after 42 days.
* `GET /me/services` — entitlements + `dailyLeft` per kind (mirrors the on-chain
  `ServiceLedger` caps: 1/day handles, 3/day boosters, 10/day others).

Every receipt is single-use (`service_payments.consumed_by`); mismatches return
`402 {code: payment_not_found | payment_kind_mismatch | payment_consumed | ref_hash_mismatch}`.

## Auth

SIWS: `POST /auth/siws/nonce` → sign → `POST /auth/siws/verify` (ed25519 over the
exact message; nonce single-use, 5 min). Session id is an HttpOnly cookie
(`gc_session`, HMAC-signed); mutating requests must echo `X-CSRF-Token`.

## Endpoints served here

`/health`, `/stats`, `/wallet/:address/events` (legacy, also at the root for the landing page),
`/auth/siws/*`, `/me`, `/me/chips`, `/me/grid`, `/me/activity`, `/me/pending`, `/me/handle/check`,
`/me/handle`, `/me/services`, `/services`, `/services/claim`, `/packs`, `/packs/opens/:sig`,
`/packs/verify`, `/collections`, `/chips/:asset`, `/market/listings|floor|history|offers`,
`/leaderboard/:board` (rating | collection | staking | fusion).

`501 not_implemented`: `/packs/quote` (needs Pyth), `/fusion/*`, `/arena/*`, `/staking/*`,
`/quests*`, `/admin/*` — owned by the arena/oracle/quote workers in
`docs/03-architecture.md` §3.1; wire them into `createApp` when they land.

## Production notes

* Swap `db.ts` for Postgres (`prisma/schema.prisma` — `EventRaw`, `IndexerCursor`,
  `Wallet`, `ServicePayment`, `Entitlement`, …). Keep the `(signature, ix_index, event_index)`
  uniqueness and the "apply projection only when inserted" rule.
* Feed Helius enhanced webhooks into `ingestTx` (same `TxLike` shape) and keep
  `listen.ts` as the fallback path.
* Prices: write `oracle_prices` (SOL, SKR) from Pyth Hermes every 10 s; until then
  the `*_USD_FALLBACK` env values are used for USD normalisation only (never for
  on-chain amounts — those are re-priced by the program).

## Tests

```bash
npm test          # vitest: 22 tests — codec round-trips for all 27 events, CPI attribution,
                  # idempotent ingest, rebuild equivalence, failed-fusion refunds, floors,
                  # SIWS (bad signature, nonce reuse, CSRF), handle lifecycle, service claims
npm run typecheck
```

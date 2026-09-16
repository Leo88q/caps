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
│  ├─ events.ts            # Anchor-free event codec: 30 events × 4 programs, decode + encode + log walker
│  ├─ borsh.ts             # tiny Borsh reader/writer
│  ├─ db.ts                # node:sqlite store (events_raw + projections + api state)
│  ├─ projections.ts       # event → chips / listings / sales / battles / stakes / burns / service_payments
│  ├─ ingest.ts            # tx logs → events_raw → projections, cursors, bounded-concurrency fetch
│  ├─ backfill.ts          # historical walk (getSignaturesForAddress) per program
│  ├─ listen.ts            # onLogs websocket per program + periodic gap healer
│  ├─ rebuild.ts           # truncate projections and replay events_raw
│  ├─ auth.ts              # SIWS nonce/verify, HttpOnly session cookie + CSRF
│  ├─ services.ts          # paid services: ref_hash verification, handle claim, entitlements
│  ├─ pyth.ts              # PriceUpdateV2 decoder + push-oracle PDAs (our shard 0xCA75), validation 1:1 with the program
│  ├─ pyth-cache.ts        # worker: mirrors our two Pyth accounts into oracle_prices every 10 s
│  ├─ quote.ts             # POST /packs/quote — integer pricing (units_for_cents), slippage guard, pity/caps
│  ├─ chain.ts             # PDAs, account decoders (PendingPack/Fusion, WagerBattle, GameConfig, raw Switchboard) + ix builders for the crank
│  ├─ tx.ts                # keypair tx pipeline: CU budget, priority-fee policy, LUT, size check, decoded program errors
│  ├─ crank.ts             # worker: oracle reveal → open_pack / fuse_reveal / battle reveal → Switchboard rent reclaim (SEC-C3 part 3)
│  ├─ queries.ts           # read models behind the routes (+ crankStatus for /health)
│  ├─ server.ts            # express app (createApp)
│  └─ serve.ts             # entry point
└─ test/                   # vitest: codec round-trips, projections, HTTP API (SIWS + services), Pyth reader + /packs/quote, crank (fake chain + fake oracle gateway)
```

## Run

```bash
# from the repo root (workspace install; no native modules → no --ignore-scripts needed)
npm install

cd backend
export SOLANA_RPC_URL=https://api.devnet.solana.com   # default
npm run backfill          # catch up on history for all 4 programs (or: npm run backfill -- market)
npm run dev               # listener (backfills on start, then live) + API on :8787 + pyth-cache
CRANK_KEYPAIR=~/.config/solana/crank.json npm run crank   # separate process: the crank (needs a funded hot key)
```

### The crank (`src/crank.ts`, docs/06 §4.3)

Every randomised action in the programs is two-phase: the player's transaction *commits* a
program-owned Switchboard randomness account, and a **permissionless** second instruction
(`open_pack`, `fuse_reveal`, `resolve_battle` after `reveal_battle_randomness`) settles it. The
app does the second half itself; the crank does it for everyone who closed the app, so that a
paid pack is opened within seconds, a losing fusion can never be withheld (SEC-C3), and
Switchboard rent goes back to the player (SEC-M7).

* **Discovery** — two tiers: `pack_purchases` with `status = 'pending'` (≈ 1 s after the buy is
  indexed) and every `CRANK_SWEEP_MS` a `getProgramAccounts` sweep by Anchor discriminator over
  `PendingPack`, `PendingFusion`, `WagerBattle` (fusions have no commit event; the DB may lag).
  Jobs live in `crank_jobs` keyed `kind:owner:nonce` — several workers on one DB and restarts
  are safe.
* **Reveal** — `POST {oracle.gateway_uri}/gateway/api/v1/randomness_reveal` (the same call the
  Switchboard SDK makes; the URI is read from the oracle account named in the randomness
  account) → signed payload → *our* `reveal_randomness` instruction (the account's authority is
  the program PDA, so the reveal must go through the program CPI). Value source order:
  `PendingPack.value` (bundles, SEC-C2) → `RandomnessAccountData.value` when `reveal_slot > 0`
  → gateway.
* **Settle** — `open_pack` per `pack_no` with the pre-simulated collection accounts
  (`expandRandomness(packSeed(value, qty, pack_no), livePackDef, pity, pool)` — the pity counter
  is re-read between packs), `$CG` treasury ATA on the last pack; `fuse_reveal` with the
  materials' collections read from their `ChipState`s; wagers get the reveal only (the battle
  oracle resolves). Reveal and settle share one transaction when they fit (our static lookup
  table, `LOOKUP_TABLE`); otherwise the reveal lands first on its own.
* **Idempotency / races** — the pinned account is re-read before every send; a lost race
  (`InvalidQuantity`, `opened > pack_no`, reveal already there) resumes from chain state, never
  counts as an error. The crank **never** calls `cancel_stale_*` — refunds are the player's
  decision; past the refund window (10 800 slots) with the oracle still silent the job goes
  `stale` and is re-checked every `CRANK_STALE_RECHECK_MS` so the rent reclaim still happens.
* **Close** — once the pinned account is gone (battle `Resolved`/`Cancelled`),
  `close_randomness` / `close_battle_randomness` returns the Switchboard rent (randomness
  account, wSOL escrow, LUT) to the owner.
* **Backoff / alerts** — 1 s → 60 s exponential, `CRANK_MAX_ATTEMPTS` (60) → `abandoned` + ALERT
  line (retried hourly). `/health.crank` reports queue depth, head age, abandoned count and
  `healthy` (≤ 200 pending, head ≤ 60 s, 0 abandoned). Every minute a summary line is logged.
* **Fees / key hygiene** — priority fee = median recent fee on the writable accounts, floor
  `CRANK_CU_PRICE_FLOOR`, cap `CRANK_CU_PRICE_CAP` and ≤ `CRANK_MAX_FEE_LAMPORTS` per tx
  (0.001 SOL). The hot key only pays fees and fronts rent that the programs reimburse; keep it
  between `CRANK_MIN_BALANCE_SOL` (alert) and `CRANK_MAX_BALANCE_SOL` (warning), refill from a
  cold wallet. Below `CRANK_HARD_FLOOR_SOL` nothing is sent.

Env: `CRANK_KEYPAIR` (required), `CRANK_POLL_MS` 2000, `CRANK_SWEEP_MS` 30000,
`CRANK_CONCURRENCY` 4, `CRANK_MIN_BALANCE_SOL` 0.5, `CRANK_HARD_FLOOR_SOL` 0.05,
`CRANK_MAX_BALANCE_SOL` 2, `CRANK_GATEWAY_TIMEOUT_MS` 10000, `CRANK_MAX_ATTEMPTS` 60,
`CRANK_CU_PRICE_FLOOR` 1000, `CRANK_CU_PRICE_CAP` 200000, `CRANK_MAX_FEE_LAMPORTS` 1000000,
`CRANK_STALE_RECHECK_MS` 600000, `CRANK_GATEWAY_RPC` (public RPC of the cluster — it is sent
to the oracle, never our keyed endpoint), `SWITCHBOARD_PROGRAM_ID` / `SWITCHBOARD_QUEUE`
(per cluster; `sb_mock` id on localnet), `LOOKUP_TABLE` (from `npm run create-lut`).

Prices for the SOL/SKR rails come from the studio's own Pyth push-oracle accounts (owner
decision Q7 — `ops/pyth-pusher/` runs the pusher; this service only *reads*):
`PYTH_SHARD_ID` (default `51829` = 0xCA75) or explicit `PYTH_SOL_ACCOUNT` / `PYTH_SKR_ACCOUNT`,
`PYTH_CACHE_EVERY_MS` (10 000), `QUOTE_CACHE_MS` (2 000), `SWITCHBOARD_QUEUE` (per cluster).
`GET /prices` shows what the pusher last posted and how old it is.

The Vite dev server proxies `/v1` to `http://127.0.0.1:8787`, so the client
uses the real API whenever it is up and falls back to its in-browser mock
per request when it is not (`501` for endpoints owned by other services).

Environment: `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `PROGRAM_{CHIP_CORE,MARKET,STAKING,ARENA}`,
`DB_PATH` (default `backend/guttercaps.sqlite`), `PORT` (8787), `CORS_ORIGINS`,
`SESSION_SECRET`, `COOKIE_SECURE=1` behind https, `SOL_USD_FALLBACK`, `SKR_USD_FALLBACK`.

Security knobs (docs/06 SEC-H3 / SEC-M4): `SIWS_DOMAINS` — hosts a sign-in message may name
(defaults to the hosts of `CORS_ORIGINS`; unrestricted only while CORS is `*` in dev);
`SIWS_MAX_DRIFT_S` (300) for `Issued At`; `RATE_LIMIT=0` disables the limiter for local load
scripts. Policies live in `src/ratelimit.ts` (nonce 10/min/IP + 30/h/wallet, reads 600/min/IP,
mutations 60/min/session, quotes 30/min, claims 10/min; `429` + `Retry-After` + `RateLimit-*`;
bodies ≤ 16 KB). With `NODE_ENV=production` the API refuses to start unless `CORS_ORIGINS` is an
explicit list, `COOKIE_SECURE=1`, `SESSION_SECRET` is ≥ 32 chars and a SIWS domain is known.

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
`/leaderboard/:board` (rating | collection | staking | fusion), `/prices`,
`POST /packs/quote` (auth; SOL/SKR priced from our Pyth accounts with the program's integer
formula, `maxLamports` = ×1.01, `priceUpdateAccount`, `expiresAt`; **503 price_unavailable**
when the on-chain update is older than 45 s or missing — the client then hides that rail).

`501 not_implemented`: `/fusion/*`, `/arena/*`, `/staking/*`,
`/quests*`, `/admin/*` — owned by the arena/oracle/quote workers in
`docs/03-architecture.md` §3.1; wire them into `createApp` when they land.

## Production notes

* Swap `db.ts` for Postgres (`prisma/schema.prisma` — `EventRaw`, `IndexerCursor`,
  `Wallet`, `ServicePayment`, `Entitlement`, …). Keep the `(signature, ix_index, event_index)`
  uniqueness and the "apply projection only when inserted" rule.
* Feed Helius enhanced webhooks into `ingestTx` (same `TxLike` shape) and keep
  `listen.ts` as the fallback path.
* Prices: `pyth-cache` writes `oracle_prices` (SOL, SKR) from **our on-chain Pyth accounts**
  every 10 s (the pusher in `ops/pyth-pusher/` posts them); the `*_USD_FALLBACK` env values
  only cover a fresh dev database and are used for USD display, never for on-chain amounts —
  `/packs/quote` refuses (503) instead of guessing.
* Crank: run **two** replicas against the same DB (jobs are keyed and every send re-reads the
  chain, so duplicates only cost a failed simulation); one of them may live in another region.
  Alert on `/health.crank.healthy == false`, on the `ALERT` log lines (payer balance, abandoned
  job, SLA), and on `stale > 0` for more than an hour (oracle outage). Create the lookup table
  (`npm run create-lut -- create`) before enabling 5-chip SKUs — without it a 5-chip `$CG` open
  does not fit in one transaction and the crank parks the job with a `configure LOOKUP_TABLE`
  error instead of guessing.

## Tests

```bash
npm test          # vitest: 61 tests — codec round-trips for all 30 events, CPI attribution,
                  # idempotent ingest, rebuild equivalence, failed-fusion refunds, floors,
                  # SIWS (bad signature, nonce reuse, CSRF), handle lifecycle, service claims,
                  # Pyth PriceUpdateV2 decode/validate (owner, feed, verification, age),
                  # /packs/quote (integer pricing, 503 on stale, starter/daily caps, pity → odds)
                  # and the crank against a fake chain + fake oracle gateway (instruction
                  # layouts, gateway payload, reveal→open→close, bundles, resume from
                  # PendingPack.value, backoff, stale, lost races, abandoned, low balance,
                  # sweep discovery, fusions, wagers, LUT fit vs. split)
npm run typecheck
```

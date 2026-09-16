// Storage. Dev/CI: SQLite via the Node 22 built-in `node:sqlite` (no native
// build step — this is what made the legacy indexer's `npm install` fail).
// Production: Postgres with the same shapes (backend/prisma/schema.prisma);
// every table here has a 1:1 model there. All amounts are stored as decimal
// strings (u64/u128 don't fit in SQLite's i64 nor in JS numbers).
import type { DatabaseSync as DatabaseSyncT, StatementSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { DB_PATH } from './config.ts';

// `import { DatabaseSync } from 'node:sqlite'` breaks under vitest's module
// resolver (it does not know the builtin yet); getBuiltinModule is the
// officially supported way to load builtins without going through it.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type Row = Record<string, SQLOutputValue>;

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------ source of truth
CREATE TABLE IF NOT EXISTS events_raw (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signature   TEXT    NOT NULL,
  ix_index    INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  program     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  data        TEXT    NOT NULL,              -- JSON (pubkeys base58, u64/u128 decimal strings, bytes hex)
  slot        INTEGER NOT NULL,
  block_time  INTEGER,                       -- unix seconds; NULL when first seen via websocket
  processed   INTEGER NOT NULL DEFAULT 0,    -- projections applied
  UNIQUE (signature, ix_index, event_index)
);
CREATE INDEX IF NOT EXISTS idx_events_name  ON events_raw(program, name);
CREATE INDEX IF NOT EXISTS idx_events_slot  ON events_raw(slot, id);
CREATE INDEX IF NOT EXISTS idx_events_time  ON events_raw(block_time);

CREATE TABLE IF NOT EXISTS indexer_cursor (
  program          TEXT PRIMARY KEY,
  newest_signature TEXT,                     -- everything at/after this signature (chronologically) is indexed
  newest_slot      INTEGER,
  history_complete INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER
);

-- ------------------------------------------------------------ projections (rebuildable: npm run rebuild)
CREATE TABLE IF NOT EXISTS wallets (
  address       TEXT PRIMARY KEY,
  handle        TEXT UNIQUE COLLATE NOCASE,
  handle_set_at INTEGER,
  first_seen    INTEGER,
  referrer      TEXT,
  country       TEXT,
  risk_score    INTEGER NOT NULL DEFAULT 0,
  flags         TEXT    NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS handle_history (
  handle      TEXT NOT NULL COLLATE NOCASE,
  wallet      TEXT NOT NULL,
  released_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handle_history ON handle_history(handle, released_at);
CREATE TABLE IF NOT EXISTS handle_reservations (
  handle     TEXT PRIMARY KEY COLLATE NOCASE,
  wallet     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chips (
  asset            TEXT PRIMARY KEY,
  owner            TEXT    NOT NULL,
  collection_idx   INTEGER NOT NULL,
  rarity           INTEGER NOT NULL,
  level            INTEGER NOT NULL DEFAULT 1,
  flags            INTEGER NOT NULL DEFAULT 0,   -- bit0 staked, bit1 listed, bit2 fusing, bit3 soulbound
  lock_until       INTEGER NOT NULL DEFAULT 0,
  origin           TEXT    NOT NULL,             -- pack | fusion
  origin_signature TEXT,
  minted_at        INTEGER,
  burned_at        INTEGER,                      -- consumed by a fusion
  updated_slot     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chips_owner ON chips(owner, burned_at);
CREATE INDEX IF NOT EXISTS idx_chips_arch  ON chips(collection_idx, rarity, burned_at);

CREATE TABLE IF NOT EXISTS pack_purchases (
  buyer       TEXT    NOT NULL,
  nonce       TEXT    NOT NULL,
  sku         INTEGER NOT NULL,
  qty         INTEGER NOT NULL,
  currency    INTEGER NOT NULL,
  amount      TEXT    NOT NULL,
  randomness  TEXT    NOT NULL,
  signature   TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  opened      INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'pending',   -- pending | opened | cancelled
  PRIMARY KEY (buyer, nonce)
);
CREATE TABLE IF NOT EXISTS pack_opens (
  signature   TEXT PRIMARY KEY,
  buyer       TEXT    NOT NULL,
  sku         INTEGER NOT NULL,
  nonce       TEXT    NOT NULL,
  count       INTEGER NOT NULL,
  assets      TEXT    NOT NULL,   -- JSON string[]
  rarities    TEXT    NOT NULL,   -- JSON number[]
  collections TEXT    NOT NULL,   -- JSON number[]
  roll_hex    TEXT    NOT NULL,
  pity_before INTEGER NOT NULL,
  pity_after  INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pack_opens_buyer ON pack_opens(buyer, slot);

CREATE TABLE IF NOT EXISTS fusions (
  signature     TEXT    NOT NULL,
  event_index   INTEGER NOT NULL,
  owner         TEXT    NOT NULL,
  recipe        INTEGER NOT NULL,
  materials     TEXT    NOT NULL,   -- JSON string[]
  result        TEXT,
  success       INTEGER NOT NULL,
  roll_bps      INTEGER NOT NULL,
  threshold_bps INTEGER NOT NULL,
  fee_burned    TEXT    NOT NULL,
  slot          INTEGER NOT NULL,
  block_time    INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_fusions_owner ON fusions(owner, slot);

CREATE TABLE IF NOT EXISTS listings (
  asset      TEXT PRIMARY KEY,
  seller     TEXT    NOT NULL,
  price      TEXT    NOT NULL,
  currency   INTEGER NOT NULL,
  created_at INTEGER,
  slot       INTEGER NOT NULL,
  signature  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller);
CREATE TABLE IF NOT EXISTS sales (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  asset       TEXT    NOT NULL,
  seller      TEXT    NOT NULL,
  buyer       TEXT    NOT NULL,
  price       TEXT    NOT NULL,
  currency    INTEGER NOT NULL,
  fee         TEXT    NOT NULL,
  royalty     TEXT    NOT NULL,
  via_offer   INTEGER NOT NULL,
  collection_idx INTEGER,
  rarity      INTEGER,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_sales_asset ON sales(asset, slot);
CREATE INDEX IF NOT EXISTS idx_sales_arch  ON sales(collection_idx, rarity, slot);
CREATE TABLE IF NOT EXISTS offers (
  asset      TEXT    NOT NULL,
  bidder     TEXT    NOT NULL,
  amount     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  slot       INTEGER NOT NULL,
  PRIMARY KEY (asset, bidder)
);

CREATE TABLE IF NOT EXISTS battles (
  battle        TEXT PRIMARY KEY,
  challenger    TEXT    NOT NULL,
  opponent      TEXT,
  wager         TEXT    NOT NULL,
  power_a       INTEGER NOT NULL,
  power_b       INTEGER,
  randomness    TEXT    NOT NULL,
  winner        TEXT,
  pot           TEXT,
  rake_burn     TEXT,
  rake_pool     TEXT,
  rake_treasury TEXT,
  result_hash   TEXT,
  roll          TEXT,
  status        TEXT    NOT NULL DEFAULT 'open',   -- open | accepted | resolved | cancelled
  created_sig   TEXT    NOT NULL,
  resolved_sig  TEXT,
  created_at    INTEGER,
  resolved_at   INTEGER,
  slot          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_battles_winner ON battles(winner);
CREATE INDEX IF NOT EXISTS idx_battles_players ON battles(challenger, opponent);

CREATE TABLE IF NOT EXISTS stakes (
  key        TEXT PRIMARY KEY,   -- token: stake PDA; chip: asset
  owner      TEXT    NOT NULL,
  kind       INTEGER NOT NULL,   -- 0 token, 1 chip
  amount     TEXT    NOT NULL,
  weight     TEXT    NOT NULL,
  unlock_at  INTEGER NOT NULL,
  since      INTEGER,
  slot       INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_stakes_owner ON stakes(owner, active);
CREATE TABLE IF NOT EXISTS claims (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  owner       TEXT    NOT NULL,
  kind        INTEGER NOT NULL,
  amount      TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE TABLE IF NOT EXISTS reward_roots (
  kind      INTEGER NOT NULL,             -- 2..4 $CG (emission slices), 5..7 SKR (prize pool)
  epoch     INTEGER NOT NULL,
  currency  TEXT    NOT NULL DEFAULT 'CG',
  root      TEXT    NOT NULL,
  budget    TEXT    NOT NULL,
  revoked   INTEGER NOT NULL DEFAULT 0,
  signature TEXT    NOT NULL,
  slot      INTEGER NOT NULL,
  PRIMARY KEY (kind, epoch)
);
CREATE TABLE IF NOT EXISTS reward_claims (
  kind      INTEGER NOT NULL,
  epoch     INTEGER NOT NULL,
  currency  TEXT    NOT NULL DEFAULT 'CG',
  wallet    TEXT    NOT NULL,
  amount    TEXT    NOT NULL,
  signature TEXT    NOT NULL,
  slot      INTEGER NOT NULL,
  PRIMARY KEY (kind, epoch, wallet)
);
-- SKR prize pool ledger: every funding / withdrawal / config change (treasury liability, not supply)
CREATE TABLE IF NOT EXISTS skr_pool_events (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  kind        TEXT    NOT NULL,            -- funded | withdrawn | changed
  counterparty TEXT,
  amount      TEXT    NOT NULL DEFAULT '0',
  budget      TEXT,
  reserved    TEXT,
  max_root_budget TEXT,
  paused      INTEGER,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE TABLE IF NOT EXISTS set_bonus (
  owner TEXT PRIMARY KEY,
  sets  INTEGER NOT NULL,
  slot  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS burns (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  program     TEXT    NOT NULL,   -- chip_core (BurnReported) | market (listing fee) | arena (rake burn) | staking (BurnRecorded / early_exit, already on-chain)
  source      TEXT    NOT NULL,
  amount      TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE TABLE IF NOT EXISTS emission_days (
  day_index    INTEGER PRIMARY KEY,
  year         INTEGER NOT NULL,
  schedule_cap TEXT    NOT NULL,
  guarded      TEXT    NOT NULL,
  burn_7d_avg  TEXT    NOT NULL,
  slice_budget TEXT    NOT NULL,   -- JSON string[5]
  signature    TEXT    NOT NULL,
  block_time   INTEGER
);
CREATE TABLE IF NOT EXISTS params_changes (
  signature TEXT PRIMARY KEY,
  admin     TEXT    NOT NULL,
  version   INTEGER NOT NULL,
  slot      INTEGER NOT NULL,
  block_time INTEGER
);
-- SEC-H2: pause / un-pause audit log across chip_core, staking, arena (PauseChanged{by, paused}).
CREATE TABLE IF NOT EXISTS pause_changes (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  program     TEXT    NOT NULL,
  by_wallet   TEXT    NOT NULL,
  paused      INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);

-- paid services: on-chain payment ↔ off-chain fulfilment
CREATE TABLE IF NOT EXISTS service_payments (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  buyer       TEXT    NOT NULL,
  kind        INTEGER NOT NULL,
  currency    INTEGER NOT NULL,
  amount      TEXT    NOT NULL,
  burned      TEXT    NOT NULL,
  ref_hash    TEXT    NOT NULL,   -- hex
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  consumed_by TEXT,               -- entitlement id / 'handle:<name>'
  consumed_at INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_service_payments_buyer ON service_payments(buyer, kind, slot);
CREATE TABLE IF NOT EXISTS entitlements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet     TEXT    NOT NULL,
  kind       INTEGER NOT NULL,
  payload    TEXT    NOT NULL,   -- canonical JSON
  signature  TEXT    NOT NULL,
  currency   INTEGER NOT NULL,
  amount     TEXT    NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entitlements_wallet ON entitlements(wallet);

-- ------------------------------------------------------------ api state (not derived from chain)
CREATE TABLE IF NOT EXISTS siws_nonces (
  nonce      TEXT PRIMARY KEY,
  wallet     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  wallet     TEXT    NOT NULL,
  csrf       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- crank worker state (backend/src/crank.ts): one row per randomness account we shepherd.
-- key = kind:owner:nonce; phase pending → settled (pinned account gone) → closed (rent reclaimed); stale = refund window open; abandoned = alert.
CREATE TABLE IF NOT EXISTS crank_jobs (
  key         TEXT PRIMARY KEY,
  kind        INTEGER NOT NULL,             -- 0 pack | 1 fusion | 2 battle
  owner       TEXT    NOT NULL,
  nonce       TEXT    NOT NULL,
  randomness  TEXT    NOT NULL,
  pinned      TEXT    NOT NULL,             -- PendingPack / PendingFusion / WagerBattle PDA
  phase       TEXT    NOT NULL DEFAULT 'pending',
  commit_slot INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL DEFAULT 0,   -- unix ms; backoff / stale re-check
  last_error  TEXT,
  reveal_sig  TEXT,
  settle_sigs TEXT    NOT NULL DEFAULT '[]',
  close_sig   TEXT,
  created_at  INTEGER NOT NULL,             -- unix ms
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crank_due ON crank_jobs(phase, next_at);
CREATE TABLE IF NOT EXISTS oracle_prices (
  symbol       TEXT PRIMARY KEY,           -- SOL | SKR
  usd          REAL    NOT NULL,
  updated_at   INTEGER NOT NULL,           -- when the cache row was written (unix s)
  publish_time INTEGER,                    -- Pyth publish_time of the on-chain update
  account      TEXT,                       -- PriceUpdateV2 account it was read from (our shard)
  conf_bps     INTEGER                     -- conf / price in bps at that time
);
`;

/** Tables that are pure functions of events_raw (dropped + replayed by `rebuild`). */
export const PROJECTION_TABLES = [
  'chips', 'pack_purchases', 'pack_opens', 'fusions', 'listings', 'sales', 'offers', 'battles', 'stakes', 'claims',
  'reward_roots', 'reward_claims', 'skr_pool_events', 'set_bonus', 'burns', 'emission_days', 'params_changes', 'pause_changes', 'service_payments',
] as const;

export class Db {
  readonly raw: DatabaseSyncT;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string = DB_PATH) {
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /** Additive, idempotent column migrations for dev SQLite files created by older builds. */
  private migrate() {
    const cols = new Set((this.raw.prepare(`PRAGMA table_info(oracle_prices)`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [['publish_time', 'INTEGER'], ['account', 'TEXT'], ['conf_bps', 'INTEGER']] as const) {
      if (!cols.has(name)) this.raw.exec(`ALTER TABLE oracle_prices ADD COLUMN ${name} ${type}`);
    }
  }

  /** Prepared-statement cache — SQL text is the key. */
  prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }
  run(sql: string, ...params: SQLInputValue[]) { return this.prep(sql).run(...params); }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.prep(sql).get(...params) as T | undefined; }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] { return this.prep(sql).all(...params) as T[]; }
  /** Scalar helper: first column of the first row (0 when no row). */
  scalar(sql: string, ...params: SQLInputValue[]): number {
    const row = this.prep(sql).get(...params);
    if (!row) return 0;
    const v = Object.values(row)[0];
    return v === null || v === undefined ? 0 : Number(v);
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  close() { this.raw.close(); }
}

let shared: Db | undefined;
/** Process-wide handle (one connection per process; SQLite WAL allows concurrent readers). */
export function db(): Db {
  if (!shared) shared = new Db();
  return shared;
}
export function useDb(instance: Db) { shared = instance; }

export const now = () => Math.floor(Date.now() / 1000);

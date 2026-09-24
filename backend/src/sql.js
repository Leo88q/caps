"use strict";
// The SQL dialect seam.
//
// `docs/09` §4.1 and `ops/deploy/data-layer.md` counted 67 places where a SQLite *dialect* construct was
// written inline in a query: 30 `INSERT OR IGNORE`, 23 `ON CONFLICT` upserts, 7 `COLLATE NOCASE`, 9
// `json_extract`, 4 `AUTOINCREMENT` (+ 3 `COLLATE NOCASE` inside the DDL). Porting that by search-and-replace
// is how a project ends up with a half-migrated read path: the queries nobody converted do not fail, they
// answer differently. So every one of those constructs is now built here, and `backend/test/sql.test.ts`
// fails the suite if one reappears anywhere else in `backend/src`.
//
// Two things are deliberately **not** here, because pretending otherwise would be the false-green this repo
// keeps removing:
//   * The schema. `AUTOINCREMENT` and column-level `COLLATE NOCASE` belong to the DDL in `db.ts` and to
//     `backend/prisma/schema.prisma`, i.e. they move with `prisma migrate deploy`, not with a code helper.
//     The Postgres forms are `generated always as identity` and `citext` (or `LOWER(x)` plus an expression
//     index), listed as steps 1–2 of the memo.
//   * Placeholders and the sync→async wrapper. Call sites keep `?`; a Postgres driver wants `$1`, and
//     `node:sqlite` is synchronous while `pg` is not. Both belong to the adapter (one file: `prep/run/all/
//     get`), which is why `insertIgnore(…)` returns text and never a promise. Making 241 `db.*` calls `await`
//     is the expensive part of that migration — this file exists so it is not *also* the part where the SQL
//     was wrong in sixty places.
//
// `LIKE 'bot:%'` is not in the list on purpose: `LIKE` exists in both dialects and the pattern is matched
// against synthetic `bot:`-prefixed ids, so folding it would change behaviour rather than port it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.jsonFlagEq = exports.jsonAt = exports.foldEq = exports.upsert = exports.insertIfAbsent = exports.insertIgnore = exports.placeholders = exports.setDialect = exports.getDialect = void 0;
let dialect = 'sqlite';
/** Which dialect is emitted today. Only the future Postgres adapter and the tests touch this. */
const getDialect = () => dialect;
exports.getDialect = getDialect;
/**
 * Not a feature switch. There is no `pg` driver in this repo, so setting `postgres` here would produce SQL
 * that nothing can execute — the function exists so the builders are testable in both dialects, which is
 * the only way a seam like this earns the right to be called one.
 */
const setDialect = (d) => {
    dialect = d;
};
exports.setDialect = setDialect;
/** `?, ?, ?` — one per column, the only placeholder syntax call sites are allowed to contain. */
const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');
exports.placeholders = placeholders;
const colList = (columns) => columns.join(', ');
/**
 * Insert that ignores a conflict on any unique constraint.
 *
 * SQLite `INSERT OR IGNORE` ⇄ Postgres `INSERT … ON CONFLICT DO NOTHING`: a different clause for the same
 * meaning, and the most common construct in the indexer — an event already seen must not be applied twice
 * (`docs/03` §3.2, and the reason a rescan and a live listener can overlap safely).
 */
const insertIgnore = (table, columns) => dialect === 'postgres'
    ? `INSERT INTO ${table} (${colList(columns)}) VALUES (${(0, exports.placeholders)(columns.length)}) ON CONFLICT DO NOTHING`
    : `INSERT OR IGNORE INTO ${table} (${colList(columns)}) VALUES (${(0, exports.placeholders)(columns.length)})`;
exports.insertIgnore = insertIgnore;
/** Skip-if-present with an explicit key, for tables whose update branch is a separate statement. */
const insertIfAbsent = (table, columns, conflict) => `INSERT INTO ${table} (${colList(columns)}) VALUES (${(0, exports.placeholders)(columns.length)}) ON CONFLICT (${colList(conflict)}) DO NOTHING`;
exports.insertIfAbsent = insertIfAbsent;
/**
 * Upsert. `update` takes assignment text (`'opened = pack_purchases.opened + 1'`, `'root = excluded.root'`)
 * instead of a column list because that is where the projections really do differ per row — arithmetic,
 * `COALESCE`, `CASE`, `excluded`. Flattening those into a generic `upsertFromObject` would either lie about
 * some of them or grow a flag per call site.
 *
 * The clause text is standard SQL and identical in both dialects, which is *why* 23 upserts need a builder
 * only for the `INSERT … VALUES (…)` half: the placeholder count is what a mechanical conversion gets wrong.
 */
const upsert = (table, columns, conflict, update, where) => `INSERT INTO ${table} (${colList(columns)}) VALUES (${(0, exports.placeholders)(columns.length)}) ` +
    `ON CONFLICT (${colList(conflict)}) DO UPDATE SET ${update.join(', ')}` +
    (where ? ` WHERE ${where}` : '');
exports.upsert = upsert;
/**
 * Case-insensitive equality. On SQLite this is `COLLATE NOCASE` on the comparison — the same collation the
 * `handle` columns are declared with, so handle lookups already depend on it. Postgres has no equivalent
 * per-comparison collation: fold both sides, and give it a `LOWER(handle)` expression index (or `citext`)
 * or every handle lookup becomes a sequential scan.
 */
const foldEq = (column, param) => dialect === 'postgres' ? `LOWER(${column}) = LOWER(${param})` : `${column} = ${param} COLLATE NOCASE`;
exports.foldEq = foldEq;
/**
 * Read a key out of a text column holding JSON. `events_raw.data` is JSON *text* (the decoded payload, not
 * borsh — `docs/03` §3.2), and the activity feed matches a wallet against the addresses inside it.
 * Postgres: `col->>'key'`, plus `jsonb_path_ops` GIN if it stays hot — the part of the memo that says the
 * read model gets faster on Postgres, not merely portable.
 */
const jsonAt = (column, key) => dialect === 'postgres'
    // the cast is load-bearing: the columns holding JSON are TEXT in both schemas (Prisma maps them to
    // `String`), and Postgres refuses `->>` on text
    ? `(${column})::jsonb->>'${key.replace(/'/g, "''")}'`
    : `json_extract(${column}, '$.${key}')`;
exports.jsonAt = jsonAt;
/**
 * A boolean flag inside that JSON text (`wallets.flags` carries `shadowBanned` / `rewardsPaused`).
 *
 * Worth its own builder because this is where a naive port quietly changes the answer: SQLite's
 * `json_extract` yields an integer, so `= 1` works, while Postgres' `->>` yields **text** and `= 1` is a type
 * error an admin screen would only meet in production. Both dialects therefore compare against everything
 * JSON may have written for "true", and the "absent" case is folded to false instead of null.
 */
const jsonFlagEq = (column, key, want) => dialect === 'postgres'
    ? `COALESCE((${column})::jsonb->>'${key}', 'false') IN ('true', '1') = ${want ? 'TRUE' : 'FALSE'}`
    : `COALESCE(json_extract(${column}, '$.${key}'), 0) = ${want ? 1 : 0}`;
exports.jsonFlagEq = jsonFlagEq;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// The Postgres half of the deployment story is a Prisma schema with no Prisma client behind it
// (docs/09 §4.1): `backend/prisma/schema.prisma` is *documentation* of the target shape, while
// `backend/src/db.ts` is what actually runs. Two descriptions of one database, edited by different people
// in different PRs, drift — and the day someone writes the adapter, drift turns into "the migration
// recreates a column the indexer is writing to".
//
// This check compares them offline (no Postgres, no prisma CLI, no engine download — all absent in CI and
// in this repo's dependency set, and a schema check that needs a database is a schema check nobody runs).
//
//   --check   fail on a divergence that is not in backend/prisma/drift.json, or on a baseline entry whose
//             divergence has been fixed (the list may only shrink, so "we'll reconcile later" cannot rot)
//   --write   regenerate the baseline
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const ROOT = node_path_1.default.resolve(import.meta.dirname, '..');
const DDL_FILE = 'backend/src/db.ts';
const PRISMA_FILE = 'backend/prisma/schema.prisma';
const BASELINE_FILE = 'backend/prisma/drift.json';
/** `CREATE TABLE IF NOT EXISTS name ( col …, CONSTRAINT … )` — top-level commas only, so a
 *  `CHECK (json_valid(flags))` or a decimal type with a comma cannot split a column into two. */
function parseSqlite(src, label) {
    // SQL comments go first: a `-- JSON { a, b } (x), delivered by …` line inside a CREATE TABLE carries
    // both a comma and a paren, and splitting the column list without removing it invents columns named
    // after words in the prose. (Checked against this file: no string literal in the DDL contains `--`.)
    const blank = (m) => ' '.repeat(m.length);
    const clean = src.replace(/--[^\n]*/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
    // The `-- ---- <title>` rules in db.ts are the file's own grouping of "what is chain truth, what is a
    // rebuildable projection, what is API state" — a baseline entry that repeats it is a clue, and one that
    // says "divergence found" is not.
    const sections = [...src.matchAll(/^-- -{4,} ?(.+)$/gm)].map((m) => [m.index ?? 0, m[1].trim()]);
    const sectionAt = (pos) => [...sections].reverse().find(([p]) => p < pos)?.[1] ?? '(no section header)';
    const tables = new Map();
    const sect = new Map();
    const fts = [];
    const re = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s*\(/gi;
    for (let m = re.exec(clean); m; m = re.exec(clean)) {
        const name = m[1];
        sect.set(name, sectionAt(m.index ?? 0) === '(no section header)' ? label : `${label} §${sectionAt(m.index ?? 0)}`);
        let i = (m.index ?? 0) + m[0].length;
        let depth = 1;
        let body = '';
        for (; i < src.length && depth > 0; i++) {
            const ch = clean[i];
            if (ch === '(')
                depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0)
                    break;
            }
            body += ch;
        }
        if (/VIRTUAL/.test(m[0])) {
            fts.push(name);
            continue;
        }
        if (tables.has(name))
            throw new Error(`duplicate CREATE TABLE ${name} (db.ts and a worker both declare it — pick one owner)`);
        const cols = new Set();
        for (const part of splitTopLevel(body)) {
            const line = part.trim();
            if (!line)
                continue;
            if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(line))
                continue;
            const col = line.match(/^"?([a-z_][a-z0-9_]*)"?\s+\S+/i);
            if (col?.[1])
                cols.add(col[1].toLowerCase());
        }
        tables.set(name, cols);
    }
    return { tables, fts, sections: sect };
}
function splitTopLevel(body) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of body) {
        if (ch === '(')
            depth++;
        else if (ch === ')')
            depth--;
        if (ch === ',' && depth === 0) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out;
}
/** Prisma models: table from `@@map`, column from `@map`, relation and composite blocks excluded. */
function parsePrisma(src) {
    const models = new Map();
    const re = /^model\s+([A-Za-z0-9_]+)\s*\{/gm;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        const start = (m.index ?? 0) + m[0].length;
        let depth = 1, i = start, body = '';
        for (; i < src.length && depth > 0; i++) {
            const ch = src[i];
            if (ch === '{')
                depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0)
                    break;
            }
            body += ch;
        }
        const table = body.match(/@@map\(\s*"([^"]+)"\s*\)/)?.[1] ?? m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        models.set(m[1], { table, body });
    }
    const modelNames = new Set(models.keys());
    const enums = new Set([...src.matchAll(/^enum\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]));
    const tables = new Map();
    for (const { table, body } of models.values()) {
        const cols = new Set();
        for (const rawLine of body.split('\n')) {
            const line = rawLine.replace(/\/\/.*$/, '').trim();
            if (!line || line.startsWith('@@') || line === '{' || line === '}')
                continue;
            if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(line))
                continue;
            const f = line.match(/^([A-Za-z0-9_]+)\s+([A-Za-z0-9_"?.\[\]]+)\b(.*)$/);
            if (!f)
                continue;
            const [, field, type, rest = ''] = f;
            // a field whose type is another model, or that carries @relation, is a join, not a column.
            // Enum/Unsupported/`@db.X` fields *are* columns, so they must not be filtered out with the joins.
            const base = type.replace(/\?$/, '').replace(/\[\]$/, '');
            if (rest.includes('@relation') || modelNames.has(base) || !(SCALARS.has(base) || enums.has(base)))
                continue;
            const col = rest.match(/@map\(\s*"([^"]+)"\s*\)/)?.[1] ?? field;
            cols.add(col.toLowerCase());
        }
        tables.set(table, cols);
    }
    return tables;
}
const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Bytes', 'Json', 'Unsupported']);
function diff(sqlite, prisma, fts, sections) {
    const out = [];
    for (const [t, cols] of sqlite) {
        if (!prisma.has(t)) {
            out.push({ key: `table:${t}:absent-in-prisma`, kind: 'table', table: t, note: `no model maps to a table the API writes (${sec(t)}) — the adapter needs a CREATE TABLE plus a model` });
            continue;
        }
        for (const c of cols) {
            if (!prisma.get(t).has(c))
                out.push({ key: `column:${t}.${c}:absent-in-prisma`, kind: 'column', table: t, column: c, note: `${sec(t)} writes ${t}.${c} and the target table has no such column` });
        }
    }
    for (const [t, cols] of prisma) {
        if (!sqlite.has(t)) {
            out.push({ key: `table:${t}:absent-in-sqlite`, kind: 'table', table: t, note: 'model with no DDL anywhere in backend/src: the running code keeps this state elsewhere (a flags blob, an env var) or does not keep it at all — the adapter PR either creates the table or deletes the model' });
            continue;
        }
        for (const c of cols) {
            if (!sqlite.get(t).has(c))
                out.push({ key: `column:${t}.${c}:absent-in-sqlite`, kind: 'column', table: t, column: c, note: `${t}.${c} exists only in the target: SQLite derives it at read time, or the model is stale` });
        }
    }
    for (const t of fts)
        out.push({ key: `fts:${t}`, kind: 'fts', table: t, note: 'FTS5 is SQLite-only by definition; the Postgres equivalent is tsvector + GIN, so this is a porting task, not a schema to mirror' });
    return out.sort((a, b) => a.key.localeCompare(b.key));
}
const mode = process.argv.includes('--write') ? 'write' : 'check';
const ddlFiles = (0, node_fs_1.readdirSync)(node_path_1.default.join(ROOT, 'backend/src'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ label: f === 'db.ts' ? 'db.ts' : `src/${f}`, abs: node_path_1.default.join(ROOT, 'backend/src', f) }))
    .filter((f) => /CREATE TABLE/i.test((0, node_fs_1.readFileSync)(f.abs, 'utf8')))
    .sort((a, b) => (a.label === 'db.ts' ? -1 : b.label === 'db.ts' ? 1 : a.label.localeCompare(b.label)));
if (!ddlFiles.some((f) => f.label === 'db.ts')) {
    console.error(`::error::${DDL_FILE} declares no CREATE TABLE`);
    process.exit(2);
}
const prismaSrc = (0, node_fs_1.readFileSync)(node_path_1.default.join(ROOT, PRISMA_FILE), 'utf8');
const sqlite = new Map();
const fts = [];
const sections = new Map();
for (const f of ddlFiles) {
    const parsed = parseSqlite((0, node_fs_1.readFileSync)(f.abs, 'utf8'), f.label);
    for (const [k, v] of parsed.tables)
        sqlite.set(k, v);
    for (const [k, v] of parsed.sections)
        sections.set(k, v);
    fts.push(...parsed.fts);
}
const sec = (t) => sections.get(t) ?? 'unknown';
const prisma = parsePrisma(prismaSrc);
if (sqlite.size === 0 || prisma.size === 0) {
    // a parser that silently matches nothing is worse than no parser: it reports "0 drift" on a repo where
    // nobody can read either file. Fail loudly instead.
    console.error(`::error::parser found ${sqlite.size} sqlite tables / ${prisma.size} prisma models — one of the two files changed shape`);
    process.exit(2);
}
const found = diff(sqlite, prisma, fts, sections);
const baselinePath = node_path_1.default.join(ROOT, BASELINE_FILE);
if (mode === 'write') {
    const payload = {
        comment: 'Documented divergence between backend/src/db.ts (what runs) and backend/prisma/schema.prisma (the Postgres target). Regenerate with: npm run schema:drift -- --write. `npm run schema:check` fails if a key appears that is not listed here, or if a listed key stops being true — so the list only ever shrinks.',
        generatedFrom: { [DDL_FILE]: sqlite.size, [PRISMA_FILE]: prisma.size },
        allow: found.map((d) => ({ key: d.key, note: d.note })),
    };
    (0, node_fs_1.writeFileSync)(baselinePath, JSON.stringify(payload, null, 2) + '\n');
    console.log(`✓ baseline written: ${found.length} documented divergence(s) across ${sqlite.size} sqlite tables / ${prisma.size} prisma models`);
    for (const d of found)
        console.log(`  · ${d.key} — ${d.note}`);
    process.exit(0);
}
const baseline = (0, node_fs_1.existsSync)(baselinePath)
    ? JSON.parse((0, node_fs_1.readFileSync)(baselinePath, 'utf8'))
    : { allow: [] };
const allowed = new Set(baseline.allow.map((a) => a.key));
const fresh = found.filter((d) => !allowed.has(d.key));
const stale = [...allowed].filter((k) => !found.some((d) => d.key === k));
if (fresh.length || stale.length) {
    for (const d of fresh)
        console.log(`✗ new divergence: ${d.key} — ${d.note}`);
    for (const k of stale)
        console.log(`✗ stale baseline entry (the divergence is gone; delete it): ${k}`);
    console.log(`\n${fresh.length} new, ${stale.length} stale. If a new divergence is intended (e.g. you added a column that Postgres will not need for a while), edit schema.prisma in the same PR; only run \`npm run schema:drift -- --write\` when the divergence is genuinely deliberate.`);
    process.exit(1);
}
console.log(`✓ prisma ⇄ ddl in sync — ${sqlite.size} tables, ${prisma.size} models, ${found.length} documented divergence(s), 0 new`);

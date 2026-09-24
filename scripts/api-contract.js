"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// REST contract guard (docs/09-production-readiness.md §4.7).
//
// `npm run verify` already proves the generated client types match openapi.yaml (the CI `client`
// job regenerates src/api/schema.d.ts and diffs it). That check cannot see the other half of the
// drift: a path documented in the spec with no Express route behind it (the client then gets a 404
// at runtime) or a route that exists but is undocumented. Both were true in this repo when
// docs/09 was written — `/collections/{idx}/chips/{rarity}` was in the spec + the client mock and
// returned 404, while `/stats` and `/wallet/{address}/events` were live but undocumented.
//
//   node --experimental-strip-types scripts/api-contract.ts
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const root = (0, node_path_1.resolve)(import.meta.dirname, '..');
const spec = (0, node_fs_1.readFileSync)((0, node_path_1.resolve)(root, 'backend/openapi.yaml'), 'utf8');
const server = (0, node_fs_1.readFileSync)((0, node_path_1.resolve)(root, 'backend/src/server.ts'), 'utf8');
/** `paths:` block of the spec → `get /collections/{idx}/chips/{rarity}` style keys. */
function specOperations() {
    const out = new Set();
    let current = null;
    let inPaths = false;
    for (const line of spec.split('\n')) {
        if (/^paths:\s*$/.test(line)) {
            inPaths = true;
            continue;
        }
        if (inPaths && /^[a-zA-Z]/.test(line))
            break; // next top-level key (components:)
        if (!inPaths)
            continue;
        const p = /^  (\/[^:]*):\s*$/.exec(line);
        if (p) {
            current = p[1];
            continue;
        }
        const m = /^    (get|post|put|patch|delete):(\s*\{|$)/.exec(line);
        if (m && current)
            out.add(`${m[1]} ${current}`);
    }
    return out;
}
/** Express routes → the same key shape (`:param` normalised to `{param}`). */
function implementedOperations() {
    const out = new Set();
    for (const m of server.matchAll(/v1\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
        out.add(`${m[1]} ${m[2].replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')}`);
    }
    return out;
}
const want = specOperations();
const have = implementedOperations();
const missing = [...want].filter((k) => !have.has(k));
const undocumented = [...have].filter((k) => !want.has(k));
let failed = 0;
const report = (label, items) => {
    if (!items.length) {
        console.log(`✓ ${label} — ${label === 'undocumented routes' ? have.size : want.size} operations in sync`);
        return;
    }
    failed += 1;
    console.error(`✗ ${label}:\n  ${items.join('\n  ')}`);
};
console.log(`api contract: ${want.size} operations in backend/openapi.yaml, ${have.size} routes in backend/src/server.ts`);
report('every documented operation has a route', missing);
report('undocumented routes', undocumented);
if (missing.length)
    console.error('  → implement the route in backend/src/server.ts or drop it from the spec');
if (undocumented.length)
    console.error('  → document it in backend/openapi.yaml (then: cd client && npx openapi-typescript ../backend/openapi.yaml -o src/api/schema.d.ts)');
if (failed)
    process.exit(1);

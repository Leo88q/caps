"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Every optional dependency a package declares must have a node in the lock — otherwise `npm ci` is
// only installable on the machine that generated the lock, and the next person's install either fails
// outright or rewrites the file.
//
// This is not hypothetical. `package-lock.json` in this repo carried the platform packages for exactly one
// OS/CPU (linux-x64: `@esbuild/linux-x64`, `@rollup/rollup-linux-x64-gnu`), because it was last written by
// an install that resolved against a Linux tree. On macOS the same file made `npm ci` fail with 70 lines of
//
//   npm error Missing: @esbuild/darwin-arm64@0.21.5 from lock file
//   npm error Missing: @rollup/rollup-darwin-arm64@4.63.2 from lock file
//   ... and every other platform npm knows about ...
//
// and made a bare `npm install` *rewrite* the lock — which is how a checkout ends up with an uncommitted
// `package-lock.json` that blocks the next `git pull` with "Your local changes would be overwritten by
// merge". Two symptoms, one cause: a lock that is only true on one host.
//
// The invariant is per-parent, not per-name, because npm nests on conflict: `esbuild` under `tsx` has its
// own copy of the platform packages, and a hoisted-only check would pass a lock that is still missing them.
//
//   node --experimental-strip-types scripts/npm-lock-matrix.ts                 # package-lock.json
//   node --experimental-strip-types scripts/npm-lock-matrix.ts --lock <path>   # another lock (selftest)
//   node --experimental-strip-types scripts/npm-lock-matrix.ts --selftest
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const root = (0, node_path_1.resolve)(import.meta.dirname, '..');
/**
 * Return every declared optional dependency that has no node in the lock.
 *
 * Two candidate placements, and the second one is the trap: npm nests a dependency as a *sibling* in the
 * nearest `node_modules` directory of its parent, not inside the parent. `node_modules/tsx/node_modules/esbuild`
 * (tsx pins esbuild 0.28.2 while the root has 0.21.5, so the platform packages nest with it) resolves its
 * `@esbuild/linux-x64` at `node_modules/tsx/node_modules/@esbuild/linux-x64` — the naive
 * `<parent>/node_modules/<name>` path would call that missing, and a checker that cries wolf is worse than no
 * checker. So: the parent's own `node_modules` prefix, plus the hoisted root.
 *
 * Presence only, deliberately: whether the found node satisfies the declared range is npm's question, and
 * `npm ci` asks it on every install ("Invalid: … does not satisfy …"). This gate answers the one npm answers
 * per-host and therefore cannot answer for a teammate: does the file describe a tree that exists on this OS?
 */
function missingOptional(packages) {
    const NM = 'node_modules/';
    const findings = [];
    for (const [parent, entry] of Object.entries(packages)) {
        for (const [name, range] of Object.entries(entry.optionalDependencies ?? {})) {
            const prefix = parent ? parent.slice(0, parent.lastIndexOf(NM) + NM.length) : NM;
            const candidates = [`${NM}${name}`, `${prefix}${name}`];
            if (!candidates.some((c) => c in packages))
                findings.push({ parent: parent || '(root)', name, range });
        }
    }
    return findings;
}
function report(findings, lockPath, checked) {
    if (!findings.length) {
        console.log(`lock matrix ok: ${checked} optional dep(s) declared, every one has a node in ${lockPath}`);
        return 0;
    }
    console.error(`✗ ${findings.length} optional dep(s) in ${lockPath} have no node — this lock installs on one OS/CPU only:\n`);
    for (const f of findings.slice(0, 12))
        console.error(`    ${f.parent} declares ${f.name}@${f.range}`);
    if (findings.length > 12)
        console.error(`    … and ${findings.length - 12} more`);
    console.error([
        '',
        '  `npm ci` fails with "Missing: … from lock file" for the platforms listed above, and a bare',
        '  `npm install` rewrites the lock instead of installing from it. Regenerate the full matrix with',
        '  npm 11 (it writes every platform it can see in the registry metadata):',
        '',
        '      rm -rf node_modules && npx -y npm@11 install --package-lock-only',
        '',
        '  Commit the resulting additions (plus the entries npm 10 needs — verify with both:',
        '  `npm ci` and `npx -y npm@11 ci`), and do not commit a lock written by an install that only',
        '  saw one host: that is how this file got broken.',
    ].join('\n'));
    return 1;
}
function load(path) {
    return JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8'));
}
function check(path) {
    const lock = load(path);
    if (lock.lockfileVersion !== 3) {
        console.error(`✗ ${path}: lockfileVersion ${lock.lockfileVersion} — this checker reads the v3 "packages" map`);
        return 1;
    }
    const packages = lock.packages ?? {};
    const checked = Object.values(packages).reduce((n, e) => n + Object.keys(e.optionalDependencies ?? {}).length, 0);
    if (!checked) {
        // A lock with no optionalDependencies at all is not "fine", it is a lock this check cannot say anything
        // about (the root manifest is missing, or the file is a stub). Reporting success on it would be the
        // false green this whole script exists to prevent.
        console.error(`✗ ${path}: no optionalDependencies anywhere — the packages map looks empty or truncated`);
        return 1;
    }
    return report(missingOptional(packages), path, checked);
}
/**
 * The gate's own cases, run against fixtures in this process: a lock missing a platform node must fail, a
 * complete one must pass, and the nested layout (parent-scoped node, no hoisted copy) must pass too.
 * A checker that has only ever said "ok" is a checker nobody can trust on the day it says "not ok".
 */
function selftest() {
    const cases = [
        ['missing platform node', { 'node_modules/esbuild': { optionalDependencies: { '@esbuild/darwin-arm64': '0.21.5' } } }, 1],
        ['hoisted node present', { 'node_modules/esbuild': { optionalDependencies: { '@esbuild/darwin-arm64': '0.21.5' } }, 'node_modules/@esbuild/darwin-arm64': {} }, 0],
        ['nested sibling present (the real layout under tsx)', { 'node_modules/tsx/node_modules/esbuild': { optionalDependencies: { '@esbuild/linux-x64': '0.28.2' } }, 'node_modules/tsx/node_modules/@esbuild/linux-x64': {} }, 0],
        ['nested parent, only hoisted node present', { 'node_modules/tsx/node_modules/esbuild': { optionalDependencies: { '@esbuild/linux-x64': '0.28.2' } }, 'node_modules/@esbuild/linux-x64': {} }, 0],
        ['nested parent, neither placement present', { 'node_modules/tsx/node_modules/esbuild': { optionalDependencies: { '@esbuild/linux-x64': '0.28.2' } }, 'node_modules/@esbuild/darwin-arm64': {} }, 1],
        ['scoped optional dep', { 'node_modules/esbuild': { optionalDependencies: { '@rollup/rollup-linux-arm64-gnu': '4.63.2' } }, 'node_modules/@rollup/rollup-linux-arm64-gnu': {} }, 0],
    ];
    let failures = 0;
    for (const [name, packages, want] of cases) {
        const got = missingOptional(packages).length;
        const ok = got === want;
        if (!ok)
            failures++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} [selftest] ${name}: ${got} finding(s), expected ${want}`);
    }
    // and the file-level guard: a lock that declares nothing is an error, not a pass
    const empty = missingOptional({});
    console.log(`  ${empty.length === 0 ? 'ok  ' : 'FAIL'} [selftest] an empty packages map yields no findings (the file-level guard is what rejects it)`);
    if (failures) {
        console.error(`\nselftest FAILED: ${failures} case(s)`);
        process.exit(1);
    }
    console.log(`selftest ok: ${cases.length + 1} case(s)`);
}
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
    selftest();
}
else {
    const lockArg = argv.indexOf('--lock');
    process.exit(check(lockArg >= 0 ? (0, node_path_1.resolve)(argv[lockArg + 1] ?? '') : (0, node_path_1.resolve)(root, 'package-lock.json')));
}

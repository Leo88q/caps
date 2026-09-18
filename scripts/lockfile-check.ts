// `npm run lockfile:check` — every `optionalDependencies` entry a lock lists must be resolvable *in that lock*.
//
// Why this exists (measured, not theoretical): npm's own writers disagree about platform-specific optional
// deps. npm 10 (Node 22, what CI uses) prunes the lock to the machine that wrote it, npm 12 (Node 26) requires
// the entry for the *installing* platform to be present:
//
//   $ npm ci                                   # npm 12 on macOS arm64, lock written on linux-x64
//   npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.
//   npm error Missing: @esbuild/darwin-arm64@0.21.5 from lock file        (70 such lines)
//
// CI runs linux-x64, so it stayed green while a checkout on a Mac could not install at all — the one class of
// failure a CI gate cannot see for you. Regenerating with npm 12 restores the full matrix
// (`npx npm@12 install --package-lock-only`), and this check is what keeps the next `npm install` on an
// npm 10 machine from quietly pruning it away again.
//
// The rule is exact rather than a list of package names: for every entry in the lock, each of its
// `optionalDependencies` must exist either beside it (nested `node_modules`) or at the root `node_modules`.
// That is the same resolution npm performs before it agrees to `npm ci`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Entry { version?: string; optionalDependencies?: Record<string, string>; link?: boolean; resolved?: string }
export interface Lock { lockfileVersion?: number; packages?: Record<string, Entry> }

export interface Gap { from: string; dep: string; want: string }

/** Bare name of a lock key: `node_modules/a/node_modules/@x/y` → `a/@x/y` (npm keys are install paths). */
function keyPath(key: string): string {
  return key.split('node_modules/').filter(Boolean).join('/');
}

/**
 * Where a dependency may live: Node resolution walks *up* from the dependent, so the entry can sit in any
 * ancestor's `node_modules` — not only right next to its declarer or at the root. (Measured: a real lock
 * hoists `@react-native-async-storage/async-storage` one level up from the two wallets that declare it as
 * optional, and npm 12 accepts that lock — a two-candidate rule called it 2 false gaps.)
 */
function candidates(from: string, dep: string): string[] {
  const parts = from === '' ? [] : from.split('/node_modules/');
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(`${parts.slice(0, i).join('/node_modules/')}/node_modules/${dep}`);
  out.push(`node_modules/${dep}`);
  return out;
}

export function findGaps(lock: Lock): Gap[] {
  const pkgs = lock.packages ?? {};
  const gaps: Gap[] = [];
  for (const [from, entry] of Object.entries(pkgs)) {
    if (entry.link) continue; // workspace symlinks resolve to their own entry, not to node_modules
    for (const [dep, want] of Object.entries(entry.optionalDependencies ?? {})) {
      if (candidates(from, dep).some((p) => p in pkgs)) continue;
      gaps.push({ from, dep, want });
    }
  }
  return gaps;
}

/** Grouped for the message: `@esbuild/*` on linux-x64 is 23 lines of one problem, and one line is a diagnosis. */
export function summarize(gaps: Gap[]): string[] {
  const byDep = new Map<string, number>();
  for (const g of gaps) byDep.set(g.dep, (byDep.get(g.dep) ?? 0) + 1);
  const families = new Map<string, string[]>();
  for (const dep of byDep.keys()) {
    const scope = dep.startsWith('@') ? dep.split('/')[0] : dep.split('/')[0];
    families.set(scope, [...(families.get(scope) ?? []), dep]);
  }
  return [...families.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([scope, deps]) => `${scope}: ${deps.length} package(s) listed as optional but absent — e.g. ${deps.sort()[0]}`);
}

function fail(gaps: Gap[]): never {
  console.error(`lockfile:check FAILED — ${gaps.length} optional dependency(ies) are referenced by the lock but not in it.`);
  for (const line of summarize(gaps)) console.error(`  ${line}`);
  console.error(
    '\n  This is what makes `npm ci` fail on another platform ("can only install packages when your\n' +
      '  package.json and package-lock.json are in sync … Missing: <pkg> from lock file"): npm 10 writes a\n' +
      '  lock pruned to the machine that ran it, npm 12 needs the entries for the machine that installs.\n' +
      '  Fix (works on any platform, keeps every resolved version):\n\n' +
      '    npx npm@12 install --package-lock-only\n' +
      '    npm run lockfile:check\n\n' +
      '  Then commit package-lock.json — the diff should be additions only.',
  );
  process.exit(1);
}

function main() {
  const path = resolve(process.env.LOCKFILE_PATH ?? 'package-lock.json');
  const lock = JSON.parse(readFileSync(path, 'utf8')) as Lock;
  const gaps = findGaps(lock);
  if (gaps.length) fail(gaps);
  const pkgs = Object.keys(lock.packages ?? {}).length;
  const optional = Object.values(lock.packages ?? {}).reduce((n, e) => n + Object.keys(e.optionalDependencies ?? {}).length, 0);
  console.log(`lockfile v${lock.lockfileVersion}: ${pkgs} entries, ${optional} optional dependencies declared, all resolvable ✓`);
}

// `--selftest` drives the same function with two synthetic locks, so the checker is known to *detect* the
// failure it is about (and not only to pass on the real file). Same idea as the other `selftest:*` scripts.
function selftest() {
  const complete: Lock = {
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/esbuild': { optionalDependencies: { '@esbuild/darwin-arm64': '0.21.5' } }, 'node_modules/@esbuild/darwin-arm64': { version: '0.21.5' } },
  };
  const pruned: Lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/esbuild': { optionalDependencies: { '@esbuild/darwin-arm64': '0.21.5' } } } };
  const hoisted: Lock = {
    lockfileVersion: 3,
    packages: { '': { optionalDependencies: { fsevents: '2' } }, 'node_modules/fsevents': { version: '2.3.3' }, 'node_modules/a': { optionalDependencies: { fsevents: '2' } } },
  };
  // measured shape: `@solana/wallet-adapter-react/node_modules/<mobile wallet>` declares the optional
  // `@react-native-async-storage/async-storage`, whose entry sits one level up — npm resolves it, a
  // next-to-the-declarer-or-root rule calls it a gap
  const upOne: Lock = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/a/node_modules/@react-native-async-storage/async-storage': { version: '1.24.0' },
      'node_modules/a/node_modules/b': { optionalDependencies: { '@react-native-async-storage/async-storage': '^1.17.7' } },
    },
  };
  const cases: Array<[string, Lock, number]> = [
    ['complete lock — no gaps', complete, 0],
    ['pruned lock — the darwin entry is gone', pruned, 1],
    ['hoisted optional — resolved at the root, not nested', hoisted, 0],
    ['hoisted optional — resolved one level up (the real shapes)', upOne, 0],
  ];
  let bad = 0;
  for (const [name, lock, want] of cases) {
    const got = findGaps(lock).length;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (gaps=${got}, want=${want})`);
  }
  if (bad) process.exit(1);
  console.log(`selftest: ${cases.length}/${cases.length}`);
}

if (process.argv.includes('--selftest')) selftest();
else main();

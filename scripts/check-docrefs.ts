// Every `§N` in this repo is a promise that something exists at that number, and the only way a promise like
// that rots quietly is for nothing to check it. It already happened: commit `2053944` rewrote one row of
// `docs/09` and, by truncating the file while doing it, deleted §1.5–§1.6 and §2–§8 — 261 lines, including
// the plan the document's own header points its reader to ("что именно из плана §4–§5 лежит в репозитории").
// `npm run verify` stayed green, because no check asked whether the sections that are cited still exist.
//
// So this is that check: resolve every section reference to something in the target file — a heading, a
// numbered table row (this repo's §1/§4/§5 findings are `| 4.2 |` rows, not headings, and refs to them are
// just as binding), or a bold list label. Deliberately does NOT try to verify that the *content* matches:
// a section can be misnumbered by a human and stay meaningful; what cannot be allowed is a pointer into
// nothing, because a reader who follows one concludes the document is a lie and stops reading it.
//
//   node --experimental-strip-types scripts/check-docrefs.ts          # human output
//   ... --json                                                       # one line per unresolved ref
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const asJson = process.argv.includes('--json');

/** Markdown files whose references are checked, and whose headings/rows are the anchors. */
function mdFiles(dir: string): string[] {
  const abs = resolve(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const e of readdirSync(abs)) {
    const rel = join(dir, e);
    if (statSync(resolve(root, rel)).isDirectory()) out.push(...mdFiles(rel));
    else if (e.endsWith('.md')) out.push(rel);
  }
  return out;
}

const files = [...mdFiles('docs'), ...mdFiles('ops')];
if (!files.length) {
  console.error('check-docrefs: no markdown found — nothing was checked, which is not a pass');
  process.exit(1);
}

/**
 * Self-check, run before any file is read. The tree itself is the fixture, so this cannot drift from it: it
 * asserts that a handful of references *do* resolve and that deliberately broken ones *do not*. The second
 * half is what makes the first half meaningful — a regex whose group indices are off by one resolves
 * everything, because it resolves nothing, and reports that as a pass.
 */
function selftest(): void {
  const doc = anchorsOf('# t\n## 0. a\n### 0.1 b\n## 2. c\n| 4.1 | x |\n**3.1** y\n');
  const ref = (s: string) => {
    OWNER.lastIndex = 0;
    const m = OWNER.exec(s);
    return m ? [m[OWNER_FILE], m[OWNER_SEC] ?? null] : [null, null];
  };
  const cases: Array<[string, string | null]> = [
    ['docs/09` §0.1', '0.1'],
    ['docs/09 §2', '2'],
    ['ops/deploy/runbook.md` §1.2/§1.5/§7', '1.2/§1.5/§7'],
    ['§4.2 docs/06', null], // reversed form: the § is not part of this match, the bare pass owns it
  ];
  for (const [s, want] of cases) {
    const got = ref(s)[1] ?? null;
    if (got !== want) {
      console.error(`selftest: OWNER на "${s}" вернул секцию ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)}`);
      process.exit(1);
    }
  }
  for (const good of ['0', '0.1', '2', '4.1', '3.1']) {
    if (!doc.has(good)) {
      console.error(`selftest: якорь "${good}" не извлечён из синтетического документа — anchorsOf сломан`);
      process.exit(1);
    }
  }
  for (const bad of ['0.2', '11', '6.4']) {
    if (doc.has(bad)) {
      console.error(`selftest: несуществующий якорь "${bad}" найден — правила извлечения слишком широки`);
      process.exit(1);
    }
  }
  if (!/^§\s*1\.2\/§?1\.5$/.test('§1.2/§1.5') && !BARE.test('§1.2/§1.5')) {
    console.error('selftest: список ссылок §A/§B больше не разбирается');
    process.exit(1);
  }
}

/**
 * Anchors: what a `§N` may point at. Three shapes, all of them used in these documents:
 *   `## 4. Title` / `### 0.1 Title`        — real headings
 *   `| 4.2 | …`                            — a finding row in the §1/§4/§5 tables
 *   `**2.9** …` / `- **3.1** …`             — bold labels inside long sections
 * The number is taken verbatim (`1.4` and `4` are different anchors), and `docs/09` §1 rows are cited both
 * ways in prose (`§1.4`, `§1`), which the two entries above cover.
 */
function anchorsOf(text: string): Set<string> {
  const set = new Set<string>();
  const add = (n: string) => {
    set.add(n.replace(/\.+$/, ''));
    // `## 4.` and a ref to `§4` must meet: strip a trailing dot AND allow a whole-number ref to a dotted
    // anchor's section (refs like `§4` pointing at a file whose only mark is `| 4.1 |` are the file-level
    // case the doc style uses for "see section 4").
    const head = n.split('.')[0].replace(/\.+$/, '');
    if (head && head !== n) set.add(head);
  };
  for (const line of text.split('\n')) {
    let m: RegExpExecArray | null;
    const h = /^#{1,6}\s*\**\s*(\d+(?:\.\d+)*)/.exec(line);
    if (h) add(h[1]);
    const r = /^\|\s*(\d+(?:\.\d+)*)\s*\|/.exec(line);
    if (r) add(r[1]);
    const b = /^\s*[-*]?\s*\*\*(\d+(?:\.\d+)+)\**/.exec(line);
    if (b) add(b[1]);
    const l = /^\s*(\d+(?:\.\d+)*)[.)]\s+\S/.exec(line);
    if (l) add(l[1]);
    void m;
  }
  return set;
}

/**
 * Owner mentions: what a `§X` may belong to. Two shapes, both used here:
 *   `docs/09-production-readiness.md §2`, `docs/06` §1.4, `ops/deploy/runbook.md` §1.2/§1.5/§7
 *   and the reversed `§4.2 docs/06` (docs/03 writes it that way)
 * A `docs/NN` prefix is resolved by number, a path must exist as a scanned .md. Filenames wrap in these
 * long lines, so a separator of up to 6 punctuation/whitespace characters is allowed between the name and
 * the `§` — that is what makes `…docs/06-acceptance-`+newline+`security-testing.md §2.3` one reference.
 */
const OWNER = /(docs\/(\d{2})(?:-[A-Za-z0-9._-]+)?(?:\.md)?|[\w./-]+(?:\n[\w./-]+)?\.md)`?([\s.,;:()\u00A0]{0,6})(?:§\s*(\d+(?:\.\d+)*(?:\s*\/\s*§?\s*\d+(?:\.\d+)*)*))?/g;
/** Bare section refs: `§2`, `см. §4.9`, `(§1.1)`, `§1.2/§1.5/§7`. */
const BARE = /§\s*(\d+(?:\.\d+)*(?:\s*\/\s*§?\s*\d+(?:\.\d+)*)*)/g;

/**
 * Group indices of OWNER, named once on purpose. Every finding this tool can produce flows through
 * `o[SEC]`, and an off-by-one there is *silent*: the loop sees "no section cited", skips the check, and the
 * run stays green while checking nothing — which is the exact defect this whole file exists to catch in other
 * people's gates, and which the first version of this file had itself (`o[5]` for a four-group pattern).
 * So the indices are asserted at startup against a synthetic document, below, rather than trusted.
 */
const OWNER_FILE = 1;
const OWNER_SEC = 4;

const anchors = new Map<string, Set<string>>();
for (const f of files) anchors.set(f, anchorsOf(readFileSync(resolve(root, f), 'utf8')));

/** Longest matching docs/NN-*.md for a number — a ref to `docs/09` must find the file even without its name. */
function docFileByNumber(num: string): string | null {
  const hits = files.filter((f) => new RegExp(`^docs/${num}(-|$)`).test(f));
  return hits.length ? hits.sort()[0] : null;
}

function resolveOwner(raw0: string): string | null {
  // These documents wrap at ~120 columns, so a long filename can break across a newline *inside* the
  // backticks — `docs/06-acceptance-`+newline+`security-testing.md §2.3`. Joined first, because the wrapped
  // form is a formatting artifact, not a reference to a different file, and a checker that only reads joined
  // paths would report every hard-wrapped link in the tree as dangling.
  const raw = raw0.replace(/\n/g, '');
  const m = /^docs\/(\d{2})/.exec(raw);
  if (m) return docFileByNumber(m[1]);
  if (raw.startsWith('docs/')) return null; // a docs/NN that does not exist is a miss, reported below
  const clean = raw.replace(/^\.\//, '');
  if (files.includes(clean)) return clean;
  const base = clean.split('/').pop()!;
  const byName = files.filter((f) => f.endsWith('/' + base) || f === base);
  return byName.length ? byName.sort()[0]! : null;
}

const lineOf = (text: string, idx: number) => text.slice(0, idx).split('\n').length;
const numsOf = (s: string) => (s.match(/\d+(?:\.\d+)*/g) ?? []);

type Miss = { file: string; line: number; ref: string; owner: string; detail: string };
const misses: Miss[] = [];
let checked = 0;

/**
 * A bare `§X` must exist in the file it is written in, or in a document named *nearby* on the same
 * sentence — but when the name sits immediately before (or after) the `§`, that file is mandatory: that is
 * the difference between "this reference is ambiguous but harmless" and "this reference names docs/09 and
 * docs/09 has no such section". Collapsing the two would let `docs/09` §0.2 — a pointer into a file that has
 * §0 and §0.1 only — pass because the *citing* doc happened to have a §0.2, which is a green light for the
 * exact rot this check exists to catch.
 */
function scan(f: string, text: string, lookForBare: boolean) {
  const owners: Array<{ start: number; end: number; file: string | null; raw: string }> = [];
  OWNER.lastIndex = 0;
  let o: RegExpExecArray | null;
  while ((o = OWNER.exec(text))) {
    const file = resolveOwner(o[OWNER_FILE]);
    // Only a mention that *carries a section number* is a reference. "`ops/deploy/runbook.md` is the runbook"
    // is prose, and reporting every path-shaped word in every source file (including this checker's own
    // regex literals, which read like `…\/.+\.md`) is how a checker gets muted instead of obeyed.
    if (!file && o[OWNER_SEC]) {
      misses.push({
        file: f,
        line: lineOf(text, o.index),
        ref: o[0].trim(),
        owner: o[OWNER_FILE],
        detail: o[OWNER_FILE].startsWith('docs/') ? 'файла с таким номером нет' : 'файл не найден (или не сканируется: .md вне docs/ и ops/)',
      });
    }
    owners.push({ start: o.index, end: o.index + o[0].length, file, raw: o[0] });
    if (o[OWNER_SEC] && file) {
      checked++;
      const a = anchors.get(file)!;
      for (const n of numsOf(o[OWNER_SEC])) if (!a.has(n)) misses.push({ file: f, line: lineOf(text, o.index), ref: `§${n}`, owner: file, detail: `анкора §${n} нет в ${file}` });
    }
  }
  if (!lookForBare) return;
  BARE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE.exec(text))) {
    const at = m.index;
    if (owners.some((x) => at >= x.start && at < x.end)) continue; // counted as part of an owner ref
    const nums = numsOf(m[1]);
    checked++;
    const adj = owners.find((x) => (x.end >= at - 1 && x.end <= at + 1) || (x.start > at && x.start - (at + m[0].length) <= 1));
    // Same line (or the one above, which is where a hard-wrapped filename ends) — not a character window. A
    // 90-char window was tried and is arbitrary: these documents carry 300-column bullets, and a window
    // either invents misses for references whose file is named at the head of the same line or starts
    // excusing dangling ones by searching the whole paragraph, where an unrelated name can vouch for anything.
    const sol = text.lastIndexOf('\n', at - 1) + 1;
    const eol0 = text.indexOf('\n', at);
    const eol = eol0 < 0 ? text.length : eol0;
    const prevSol = text.lastIndexOf('\n', Math.max(0, sol - 2)) + 1;
    const near = owners.filter((x) => x.file && !adj?.file && x.start >= prevSol && x.start < eol);
    const cand = new Set<string>();
    if (adj?.file) cand.add(adj.file);
    else {
      cand.add(f);
      for (const x of near) if (x.file) cand.add(x.file);
    }
    for (const n of nums) {
      const hit = [...cand].find((c) => anchors.get(c)?.has(n));
      if (!hit) {
        misses.push({
          file: f,
          line: lineOf(text, at),
          ref: `§${n}`,
          owner: adj ? adj.file ?? '—' : [...cand].join(' / '),
          detail: adj
            ? `анкора §${n} нет в ${adj.file ?? 'названом файле'}, а ссылка прилегает к имени — переименовано или удалено`
            : `§${n} нет ни в ${f}, ни в названых рядом файлах (${[...cand].filter((c) => c !== f).join(', ') || 'рядом никого нет'}) — напишите имя документа`,
        });
      }
    }
  }
}

// Last, after every const it reads: selftest touches OWNER/BARE, and calling it at the top of the module is
// a "Cannot access 'OWNER' before initialization" crash — loud, but the wrong kind of loud for a gate.
selftest();

for (const f of files) scan(f, readFileSync(resolve(root, f), 'utf8'), true);
// A reference in *code* is as binding as one in a document: `scripts/program-ids.ts` tells the operator to
// read "docs/09 §2" before a ceremony, and a reader who arrives at a file with no §2 loses trust in the whole
// procedure. Only the explicit `<file> §X` form is checked there — a bare `§X` in a comment has no owner, and
// inventing one would produce findings nobody can act on.
// This file is the one path not scanned. Its own comments *quote* the shapes it looks for (a broken example
// is how a regex's intent gets documented), and a checker that reports those has trained its reader to
// ignore it — the trade is deliberate and limited: nothing about the tree's docs goes unchecked, because the
// docs are all in docs/ and ops/, and the code pass only ever looks at `file §N` mentions.
const SELF = 'scripts/check-docrefs.ts';
for (const dir of ['scripts', 'packages/economy/scripts', 'packages/client/scripts']) {
  const abs = resolve(root, dir);
  if (!existsSync(abs)) continue;
  for (const e of readdirSync(abs)) {
    if (!/\.(ts|mjs|js|sh)$/.test(e)) continue;
    const rel = `${dir}/${e}`;
    if (rel === SELF) continue;
    scan(rel, readFileSync(resolve(root, rel), 'utf8'), false);
  }
}

if (asJson) {
  for (const x of misses) console.log(JSON.stringify(x));
  console.log(JSON.stringify({ kind: 'summary', ok: checked - misses.length, total: checked, misses: misses.length }));
  process.exit(misses.length ? 1 : 0);
}

if (misses.length) {
  for (const x of misses) console.error(`✗ ${x.file}:${x.line}: ${x.ref} — ${x.detail}`);
  console.error(
    `\n${misses.length} из ${checked} ссыл(к)а на разделы ведут в никуда. Либо раздел переименован/удалён —` +
      ` тогда правьте ссылку; либо его никогда не было — тогда напишите его или уберите обещание. Править` +
      ` нужно ссылку, а не правило: «разрешаем что угодно» вернёт чеккер к состоянию «зелёно и бесполезно».\n` +
      "Формат, который чеккер считает однозначным: имя документа рядом со ссылкой — docs/09 §4.1, " +
        "а не «§4.1» в чужом файле.\n",
  );
  process.exit(1);
}
console.log(
  `doc refs ok: ${checked} ссылк(а/и) на разделы разрешены в ${files.length} md-файлах docs/ и ops/ ` +
    `плюс явные ссылки из комментариев scripts/ и packages/*/scripts/`,
);

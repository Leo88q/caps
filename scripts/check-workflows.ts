// Checks the GitHub workflow files for the references that fail *silently*: an expression that resolves to
// the empty string. `steps.plan.outputs.base` in a `docker push` line, `vars.PROGRAM_CHIP_CORE` in a job env
// block, `inputs.cluster` in a `run:` — none of these error when the thing they name does not exist. GitHub
// substitutes "" and the step then does something else: pushes `//guttercaps-api:`, builds with an empty id,
// pins nothing. The runner is the only place that would notice, which for the workflow that publishes deploy
// images means: on the release, on the host, at 3 a.m.
//
// A YAML parser is not worth a dependency (the repo hand-parses `openapi.yaml` for the same reason), so this
// reads the two shapes that carry the risk and does it line by line: `id:`/`echo "k=" >> $GITHUB_OUTPUT`
// pairs, and `${{ … }}` expressions. Structure itself is only checked as far as bash can see it — every
// `run:` block is handed to `bash -n`, which catches the far more common failure (a quote or a `\` in a
// folded scalar that breaks the script but not the YAML).
//
// Blocks inside a `container:` job get a second reader, because the runner's shell there is /bin/sh — dash,
// which parses `set -o pipefail` happily and refuses it at run time, so `sh -n` alone is not enough and the
// BASHISMS list below finishes the job. That is the exact failure this repo hit twice: a step whose whole
// purpose was to capture a red build's log died at line 1 and turned `anchor build` into "exit code 2".
// Steps that declare `shell: bash` are exempt: the bashism is then a decision, not an accident.
//
//   npm run workflows:check
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const DIR = '.github/workflows';
const EXAMPLE = 'ops/deploy/.env.example';

const STEP_ID = /^\s*(?:-\s+)?id:\s*([\w-]+)\s*$/;
const OUT_EMIT = /^\s*echo\s+"([A-Za-z][\w-]*)=/;
const OUT_REF = /\bsteps\.([A-Za-z][\w-]*)\.outputs\.([A-Za-z][\w-]*)/g;
const VAR_REF = /\bvars\.([A-Z][A-Z0-9_]*)/g;
const SECRET_REF = /\bsecrets\.([A-Za-z][\w-]*)/g;
const INPUT_REF = /\binputs\.([A-Za-z][\w-]*)/g;
const indent = (l: string) => (l.match(/^\s*/)?.[0].length ?? 0);

/** the block of a job: from its two-space header to the next one */
function jobs(lines: string[]): { name: string; body: string }[] {
  const cut = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (cut < 0) return [];
  const starts: { name: string; i: number }[] = [];
  for (let i = cut; i < lines.length; i++) {
    const m = /^  ([A-Za-z][\w-]*):\s*$/.exec(lines[i]);
    if (m) starts.push({ name: m[1], i });
  }
  return starts.map((s, n) => ({
    name: s.name,
    body: lines.slice(s.i, n + 1 < starts.length ? starts[n + 1].i : lines.length).join('\n'),
  }));
}

/** inputs declared under `on.workflow_dispatch.inputs` (6-space names, per the file's own indentation) */
function dispatchInputs(lines: string[]): Set<string> {
  const out = new Set<string>();
  const at = lines.findIndex((l) => /^  workflow_dispatch:\s*$/.test(l));
  if (at < 0) return out;
  let i = at + 1;
  while (i < lines.length && (lines[i].trim() === '' || indent(lines[i]) > 2)) {
    if (/^    inputs:\s*$/.test(lines[i])) {
      for (i++; i < lines.length && (lines[i].trim() === '' || indent(lines[i]) >= 6); i++) {
        const m = /^      ([a-z][\w-]*):\s*/.exec(lines[i]);
        if (m) out.add(m[1]);
      }
      return out;
    }
    i++;
  }
  return out;
}

/** the `- ` items of a job's `steps:` list, as line blocks */
function steps(jobBody: string): { lines: string[] }[] {
  const body = jobBody.split('\n');
  const stepsAt = body.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (stepsAt < 0) return [];
  const mark = indent(body[stepsAt]) + 2;
  const out: { lines: string[] }[] = [];
  let cur: string[] | null = null;
  for (const l of body.slice(stepsAt + 1)) {
    if (l.trim() === '') continue;
    // A comment at the same indent as the `- ` items belongs to the steps list, not to the job: this file
    // puts a paragraph of prose above most steps, and the first version treated `      # …` as the start of
    // the next job key and stopped parsing there. `programs` reported 3 steps out of 27, and since the same
    // blocks feed the `steps.<id>.outputs.<name>` check, every output reference *below* such a comment was
    // unchecked — a gate that reads as green coverage while measuring the first three steps.
    if (/^\s*#/.test(l)) { if (cur) cur.push(l); continue; }
    if (indent(l) === mark && /^-\s/.test(l.trim())) { if (cur) out.push({ lines: cur }); cur = [l]; continue; }
    if (indent(l) <= mark) break; // the job's next top-level key
    if (cur) cur.push(l);
  }
  if (cur) out.push({ lines: cur });
  return out;
}

/** `run: |` blocks, verbatim (extra indentation is not a bash error, and dedenting is how one gets invented) */
/**
 * Constructs dash parses and then refuses. Deliberately short and specific: `[[`, `${x//y/z}` and process
 * substitution have POSIX spellings, and a step that needs bash should say so rather than be rewritten.
 */
const BASHISMS: [RegExp, string][] = [
  [/\bset\s+-o\s+pipefail\b/, 'an illegal option — dash has no pipefail, and the step dies here before any command runs'],
  [/\[\[/, 'a bash conditional expression'],
  [/\$\{[^}]*\/\//, 'a bash substitution pattern'],
  [/\$\{[^}]*\^\^/, 'a bash case-conversion expansion'],
  [/<<<|<\(|>\(/, 'a bash here-string or process substitution'],
  [/\bfunction\s+\w+\s*\{/, 'a bash function definition'],
];

/** line ranges of jobs that run in a `container:` — where the default shell is /bin/sh (dash), not bash */
function containerRanges(lines: string[]): [number, number][] {
  const cut = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (cut < 0) return [];
  const starts: { name: string; i: number }[] = [];
  for (let i = cut; i < lines.length; i++) {
    const m = /^  ([A-Za-z][\w-]*):\s*$/.exec(lines[i]);
    if (m) starts.push({ name: m[1], i });
  }
  return starts
    .map((s, n) => ({ i: s.i, j: n + 1 < starts.length ? starts[n + 1].i : lines.length }))
    .filter(({ i, j }) => lines.slice(i, j).some((l) => /^\s+container:\s*$/.test(l)))
    .map(({ i, j }) => [i, j] as [number, number]);
}

function runBlocks(lines: string[]): { name: string; body: string; container: boolean; shellBash: boolean }[] {
  const out: { name: string; body: string; container: boolean; shellBash: boolean }[] = [];
  const inContainer = containerRanges(lines);
  let name = '';
  for (let i = 0; i < lines.length; i++) {
    const named = /^\s*-\s+name:\s*(.+)$/.exec(lines[i]);
    if (named) name = named[1].trim();
    const runm = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!runm) continue;
    const base = runm[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && indent(lines[j]) <= base) break;
      body.push(lines[j]);
    }
    // the step's own lines: `- name:`/`shell:` live above the `run:` key, and an explicit `shell: bash` is the
    // only legitimate reason for a container step to use a bashism
    const stepStart = (() => {
      for (let j = i - 1; j >= 0; j--) if (/^\s*-\s/.test(lines[j]) || /^\s{4}\S/.test(lines[j])) return j;
      return i - 1;
    })();
    out.push({
      name: name || `(run at line ${i + 1})`,
      body: body.join('\n'),
      container: inContainer.some(([a, b]) => i >= a && i < b),
      shellBash: /\bshell:\s*\S*bash/.test(lines.slice(stepStart, i).join('\n')),
    });
    i = i + body.length;
  }
  return out;
}

const files = readdirSync(join(root, DIR)).filter((f) => /\.ya?ml$/.test(f)).sort();
const documented = new Set<string>();
for (const line of readFileSync(join(root, EXAMPLE), 'utf8').split('\n')) {
  const m = /^([A-Z][A-Z0-9_]{2,})\s*=/.exec(line);
  if (m) documented.add(m[1]);
}

const problems: string[] = [];
/**
 * The class: annotation text is a shell *argument*, and an unescaped backtick inside double quotes runs a
 * command. Two real findings in this repository, both in text that was meant to be typography — an error
 * message that lost the word between them, and a gate step that fired `gh workflow run lockfile.yml
 * -f refresh=true` from inside its own `::error::` string. Quote-aware because the naive version cried wolf
 * three times on the first run over this repo: backticks in single quotes are literal, and `\`` escapes one.
 */
function annotationBackticks(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    if (!/::(error|warning|notice)/.test(l)) continue;
    let quote: '' | "'" | '"' = '';
    for (let k = 0; k < l.length; k++) {
      const ch = l[k];
      if (quote === "'") { if (ch === "'") quote = ''; continue; }
      if (quote === '"') {
        if (ch === '\\') { k++; continue; }
        if (ch === '`') { out.push(`runs a command from inside annotation text — a backtick in a double-quoted workflow-command string (${l.trim().slice(0, 70)}…); drop the backticks or write the string in single quotes, where they are literal`); break; }
        if (ch === '"') quote = '';
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
    }
  }
  return out;
}

let stepsChecked = 0;
let dashChecked = 0;
let outputsChecked = 0;
const tmp = mkdtempSync(join(tmpdir(), 'workflows-check-'));

for (const sh of readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.sh')).sort()) {
  for (const problem of annotationBackticks(readFileSync(join(root, 'scripts', sh), 'utf8'))) {
    problems.push(`scripts/${sh}: ${problem}`);
  }
}

for (const file of files) {
  const src = readFileSync(join(root, DIR, file), 'utf8');
  const lines = src.split('\n');

  // every `vars.X` a workflow reads must be a documented compose variable — the workflow is not allowed to
  // invent a name, and a name that is not in ops/deploy/.env.example means CI and the deploy host are
  // reading two different lists of what a build needs.
  for (const m of src.matchAll(VAR_REF)) {
    if (!documented.has(m[1])) problems.push(`${file}: reads vars.${m[1]}, which ${EXAMPLE} does not document`);
  }

  const inputs = dispatchInputs(lines);
  const usedInputs = new Set([...src.matchAll(INPUT_REF)].map((m) => m[1]));
  for (const name of usedInputs) if (inputs.size && !inputs.has(name)) problems.push(`${file}: references inputs.${name}, which no workflow_dispatch block declares (an undeclared input is "", never an error)`);
  for (const name of inputs) if (!usedInputs.has(name)) problems.push(`${file}: declares dispatch input "${name}" that no step reads`);

  if (file === 'images.yml') {
    // Publishing images needs the registry token and public config, nothing else. A build-time secret is a
    // different and larger incident: build args reach the layer, and the client image is world-readable.
    for (const m of src.matchAll(SECRET_REF)) problems.push(`${file}: reads secrets.${m[1]} — image publishing must not need one (a build-time secret ends up inside a public layer)`);
  }

  for (const job of jobs(lines)) {
    const emitted = new Map<string, Set<string>>();
    // A step that runs an action can emit anything (`actions/cache` emits `cache-hit`), so its output names
    // are unknowable here and only the *id* is checked. Restricting the check to bash-written outputs would
    // have the gate crying wolf at the most common legitimate case.
    const external = new Set<string>();
    // Steps are parsed as blocks, not line by line: `- uses:` and `id:` arrive in both orders across the
    // files, and attributing an echo to "whichever id I saw last" made every output of the *whole job* look
    // like it came from the one step that had an id — which is how a mutation test caught this gate being
    // vacuous (the last step, `uses: upload-artifact`, marked that id external and silenced all its checks).
    const blocks = steps(job.body);
    for (const block of blocks) {
      const idm = block.lines.map((l) => STEP_ID.exec(l)).find(Boolean);
      const id = idm?.[1] ?? '';
      if (id && !emitted.has(id)) emitted.set(id, new Set());
      if (block.lines.some((l) => /^\s*(?:-\s+)?uses:\s*/.test(l)) && id) external.add(id);
      for (const l of block.lines) {
        // one `echo` per line is the house style, but `{ echo "a=1"; echo "b=2"; }` is the same statement —
        // splitting the line costs nothing and keeps the gate from crying "never emitted"
        for (const part of l.split(/;/)) {
          const em = OUT_EMIT.exec(part);
          if (em && id) emitted.get(id)?.add(em[1]);
        }
      }
    }
    stepsChecked += blocks.length;
    for (const m of job.body.matchAll(OUT_REF)) {
      outputsChecked++;
      const [, sid, out] = m;
      if (!emitted.has(sid)) problems.push(`${file} · job ${job.name}: reads steps.${sid}.outputs.${out} — no step in this job has id "${sid}"`);
      else if (!external.has(sid) && !emitted.get(sid)!.has(out)) problems.push(`${file} · job ${job.name}: steps.${sid}.outputs.${out} is never written to $GITHUB_OUTPUT (that id emits: ${[...emitted.get(sid)!].join(', ') || 'nothing'})`);
    }
  }

  runBlocks(lines).forEach((b, i) => {
    const script = b.body.replace(/\$\{\{[^}]*\}\}/g, 'DUMMY');
    const f = join(tmp, `${file}.${i}.sh`);
    writeFileSync(f, script);
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
      // A workflow-command string is text, and text with backticks inside double quotes is a command. This
      // repo has now been bitten twice (`>=` deleted a word from an error message; `gh workflow run …`
      // actually fired from inside a gate step), so the rule is here rather than in a review comment.
      for (const problem of annotationBackticks(b.body)) problems.push(`${file}: step "${b.name}" ${problem}`);
    if (r.status !== 0) problems.push(`${file}: bash -n rejects step "${b.name}" — ${(r.stderr || '').trim().split('\n')[0] || 'no message'}`);
    // The dash check, and it is the one that has actually cost this repo runs: in a `container:` job the
    // default shell is /bin/sh, so `set -o pipefail` is an illegal option and the step dies at line 1 without
    // ever running the command it was guarding — twice, in two different jobs.
    //
    // `sh -n` alone is not enough, and that is a fact about dash rather than about this check: the option is
    // rejected while the script runs, not while it is parsed, so a syntax-only pass waves `set -o pipefail`
    // through. Hence both halves — the parser for structure, and a name-list of the bashisms whose *syntax*
    // dash accepts and whose *meaning* it refuses. Comments are stripped first: a `# [[ … ]]` in prose is
    // not a shell construct, and a gate that cries wolf here stops being read.
    if (b.container && !b.shellBash) {
      dashChecked++;
      const rs = spawnSync('sh', ['-n', f], { encoding: 'utf8' });
      if (rs.status !== 0) {
        problems.push(
          `${file}: /bin/sh rejects step "${b.name}" — ${(rs.stderr || '').trim().split('\n')[0] || 'no message'}. ` +
          `A container job runs dash by default: write POSIX (or declare shell: bash on that step).`,
        );
      } else {
        const code = b.body
          .split('\n')
          .filter((l) => !/^\s*#/.test(l))
          .join('\n');
        for (const [re, why] of BASHISMS) {
          const m = re.exec(code);
          if (m) problems.push(`${file}: step "${b.name}" runs in a container, where /bin/sh is dash — ${m[0]} is ${why} (write POSIX, or declare shell: bash on the step)`);
        }
      }
    }
  });
}

rmSync(tmp, { recursive: true, force: true });
if (existsSync(join(root, 'ops/deploy/.env.example')) && documented.size < 20) {
  problems.push(`${EXAMPLE} parsed to ${documented.size} variables — the file changed shape and the vars check above is now vacuous`);
}

if (problems.length) {
  for (const p of new Set(problems)) console.error(`✗ ${p}`);
  console.error(`\n${new Set(problems).size} workflow problem(s). An expression that names nothing is substituted with an\nempty string: the step still runs, and it pushes, pins or deploys the empty string.`);
  process.exit(1);
}
console.log(`workflows ok: ${files.length} file(s), ${stepsChecked} steps, ${outputsChecked} step-output refs resolved, ${documented.size} compose vars as the allowlist, every run block parses as bash${dashChecked ? `, and ${dashChecked} container-job block(s) also parse as /bin/sh` : ''}`);

// Static security gates for the four Anchor programs — the Solana/Anchor audit checklist
// (SECURITY-AUDIT-2026-09-25.md, items A1–E30) turned into assertions over the source tree.
//
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
//
// Unlike scripts/sec-scan.py (raw hits for human triage, never a gate) every rule here has zero
// hits at HEAD: each exception is listed next to the rule WITH the reason it is safe, so a new
// hit is either a bug or a conscious, reviewed allowlist entry. The last block self-tests the
// rules against synthetic vulnerable snippets (including the pre-fix SEC-F2 fusion loop) so a
// rule that silently stops matching fails loudly instead of passing vacuously.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AccountsStruct, type Field, type FnItem, type SourceFile,
  constraintValue, coreType, errorVariants, handlersFor, has, loadSources, parseAccountsStructs,
  parseAttributedStructs, parseFns, programInstructionNames, stripComments,
} from './lib/rust-scan.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROGRAMS = ['chip_core', 'market', 'staking', 'arena'] as const;
const files: SourceFile[] = loadSources(REPO, [...PROGRAMS]);
const structs: AccountsStruct[] = files.flatMap(parseAccountsStructs);
const fns: FnItem[] = files.flatMap(parseFns);
const src = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const where = (s: AccountsStruct, f?: Field) => `${s.file}:${f ? f.line : s.line} ${s.name}${f ? '.' + f.name : ''}`;
const isInit = (f: Field) => f.constraints.includes('init') || f.constraints.includes('init_if_needed');
const handlerBody = (s: AccountsStruct) => handlersFor(fns, s.name).map((h) => h.body).join('\n');

test('sanity: the reader sees the whole program surface', () => {
  assert.ok(files.length >= 20, `rust files: ${files.length}`);
  assert.ok(structs.length >= 90, `#[derive(Accounts)] structs: ${structs.length}`);
  assert.ok(structs.reduce((a, s) => a + s.fields.length, 0) >= 800, 'account fields');
  for (const p of PROGRAMS) {
    const ixs = files.filter((f) => f.program === p).flatMap(programInstructionNames);
    assert.ok(ixs.length >= 5, `${p}: #[program] instructions ${ixs.length}`);
  }
});

// ---------------------------------------------------------------- A. identity & accounts

test('A1/A3/D21/D22 every init / init_if_needed: Signer payer, PDA seeds + bump (or ATA), exact INIT_SPACE', () => {
  const bad: string[] = [];
  let n = 0;
  for (const s of structs) for (const f of s.fields) {
    if (!isInit(f)) continue;
    n++;
    const payer = constraintValue(f, 'payer');
    const pf = s.fields.find((x) => x.name === payer);
    if (!payer || !pf) bad.push(`${where(s, f)}: init without a payer field`);
    else if (coreType(pf.type).kind !== 'Signer' || !has(pf, /^mut$/)) bad.push(`${where(s, f)}: payer '${payer}' is not a mut Signer`);
    const t = coreType(f.type);
    const ata = has(f, /^associated_token::mint\s*=/) && has(f, /^associated_token::authority\s*=/);
    const pda = has(f, /^seeds\s*=/) && has(f, /^bump$/);
    if (!ata && !pda) bad.push(`${where(s, f)}: neither canonical PDA (seeds + bump) nor ATA — keypair accounts can be front-run / squatted`);
    if (t.kind === 'Account' && t.inner !== 'TokenAccount' && t.inner !== 'Mint') {
      const space = constraintValue(f, 'space')?.replace(/\s+/g, ' ');
      if (space !== `8 + ${t.inner}::INIT_SPACE`) bad.push(`${where(s, f)}: space '${space}' ≠ '8 + ${t.inner}::INIT_SPACE'`);
    }
  }
  assert.ok(n >= 45, `init sites seen: ${n}`);
  assert.deepEqual(bad, []);
});

// init_if_needed re-initialisation: the handler must adopt a zeroed account (owner/buyer == default)
// and afterwards pin it to the signer; a bare init_if_needed lets a second caller overwrite state.
test('A6 every init_if_needed handler guards re-initialisation (adopt-if-default, then require owner)', () => {
  const bad: string[] = [];
  for (const s of structs) for (const f of s.fields) {
    if (!f.constraints.includes('init_if_needed')) continue;
    const body = handlerBody(s);
    if (!body) { bad.push(`${where(s, f)}: no handler found`); continue; }
    const payer = constraintValue(f, 'payer') ?? '?';
    const adopt = /==\s*Pubkey::default\(\)/.test(body) && /require_keys_eq!|require!\(/.test(body);
    // or: the PDA itself is keyed by the payer (nobody else can reach it) and ownership is re-asserted
    const seededByPayer = (constraintValue(f, 'seeds') ?? '').includes(`${payer}.key()`) && /require_keys_eq!\(\s*\w+\.owner/.test(body);
    const guard = adopt || seededByPayer;
    if (!guard) bad.push(`${where(s, f)}: no default-then-pin guard in ${handlersFor(fns, s.name).map((h) => h.name)}`);
  }
  assert.deepEqual(bad, []);
});

// Passthrough accounts that are validated by the program they are forwarded to.
const PROGRAM_ACCOUNT_ALLOW: Record<string, string> = {
  'ClaimChipRoot.switchboard_program': 'forwarded to chip_core::open_voucher, which pins `address = randomness::SB_PROGRAM_ID`',
  'ClaimChipRoot.recent_slothashes': 'forwarded to chip_core::open_voucher, which pins `address = randomness::SLOT_HASHES_ID`',
};
test('A4 program accounts are typed Program<> or address-pinned (no fake System/Token/Core/Bubblegum/Switchboard)', () => {
  const bad: string[] = [];
  const typed: Record<string, string> = { system_program: 'System', token_program: 'Token', associated_token_program: 'AssociatedToken' };
  for (const s of structs) for (const f of s.fields) {
    const t = coreType(f.type);
    if (typed[f.name]) {
      if (t.kind !== 'Program' || t.inner !== typed[f.name]) bad.push(`${where(s, f)}: ${f.type} (expected Program<'info, ${typed[f.name]}>)`);
      continue;
    }
    const programLike = /_program$/.test(f.name) || ['mpl_core', 'log_wrapper', 'chip_core', 'noop'].includes(f.name);
    if (!programLike || t.kind === 'Program') continue;
    if ((t.kind === 'UncheckedAccount' || t.kind === 'AccountInfo') && !has(f, /^address\s*=/) && !PROGRAM_ACCOUNT_ALLOW[`${s.name}.${f.name}`]) {
      bad.push(`${where(s, f)}: unchecked program account without \`address =\``);
    }
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- C. tokens & economics

test('C12 legacy SPL Token only: no Token-2022 / token_interface anywhere in the programs', () => {
  const bad = files.filter((f) => /token_2022|Token2022|token_interface|InterfaceAccount\s*<|Interface\s*<\s*'info/.test(f.code)).map((f) => f.rel);
  assert.deepEqual(bad, []);
});

test('C2/C16 every TokenAccount is bound to its mint (constraint, or a require_keys_eq on `.mint` in the handler)', () => {
  const bad: string[] = [];
  for (const s of structs) for (const f of s.fields) {
    const t = coreType(f.type);
    if (t.kind !== 'Account' || t.inner !== 'TokenAccount') continue;
    if (has(f, /^(token::mint|associated_token::mint|address)\s*=/) || has(f, new RegExp(`\\b${f.name}\\.mint\\b`))) continue;
    const body = handlerBody(s);
    const mentioned = new RegExp(`\\.${f.name}\\b`).test(body);
    const checked = /require_keys_eq!\(\s*\w+\.mint\b/.test(body);
    if (!(mentioned && checked)) bad.push(`${where(s, f)}: token account with no mint binding`);
  }
  assert.deepEqual(bad, []);
});

test('C13/C14 release profile keeps overflow-checks = true (unchecked `+`/`-` panic instead of wrapping)', () => {
  const toml = src('Cargo.toml');
  const m = /\[profile\.release\]([\s\S]*?)(\n\[|$)/.exec(toml);
  assert.ok(m, '[profile.release] missing');
  assert.match(m[1], /overflow-checks\s*=\s*true/);
});

// admin-gated mutators leave an audit trail; one-time bootstrap / pinned-destination paths are listed.
const ADMIN_NO_EVENT_ALLOW: Record<string, string> = {
  CreateBubblegumTree: 'one-time deploy bootstrap of a tree per collection (init; cannot be replayed)',
  ConfigureBubblegumTree: 'one-time deploy bootstrap (init of the tree meta PDA)',
  SweepVault: 'moves only the surplus above liabilities + rent, and only to the pinned config.treasury (has_one)',
};
test('C20 every admin-gated instruction emits an event (governance audit trail)', () => {
  const bad: string[] = [];
  let n = 0;
  for (const s of structs) {
    const gated = s.fields.some((f) => f.constraints.some((c) => /^has_one\s*=\s*admin\b/.test(c) || /^address\s*=\s*[\w.]+\.admin\b/.test(c)));
    if (!gated) continue;
    n++;
    const hs = handlersFor(fns, s.name);
    if (!hs.length) { bad.push(`${where(s)}: no handler`); continue; }
    if (!hs.some((h) => /\bemit!\s*\(/.test(h.body)) && !ADMIN_NO_EVENT_ALLOW[s.name]) bad.push(`${where(s)}: admin mutation without emit! (${hs.map((h) => h.name)})`);
  }
  assert.ok(n >= 15, `admin-gated structs seen: ${n}`);
  assert.deepEqual(bad, []);
});

test('C18 unbounded inputs: every Vec<> instruction argument is length-capped in its handler', () => {
  const ixNames = new Set(files.flatMap((f) => programInstructionNames(f).map((n) => `${f.program}:${n}`)));
  const bad: string[] = [];
  for (const f of fns) {
    if (!ixNames.has(`${f.program}:${f.name}`) || f.file.endsWith('lib.rs')) continue;
    for (const m of f.params.matchAll(/(\w+)\s*:\s*Vec</g)) {
      if (!new RegExp(`${m[1]}\\.len\\(\\)\\s*<=?`).test(f.body)) bad.push(`${f.file}:${f.line} ${f.name}(${m[1]}: Vec<..>) has no length cap`);
    }
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- B. state / CPI

test('B8 no self-CPI (a program never invokes its own cpi module)', () => {
  const bad = files.filter((f) => new RegExp(`\\b(${f.program}|crate)::cpi::`).test(f.code)).map((f) => f.rel);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- D. Anchor specifics

test('D25 same-named #[event] / #[account] types across programs have identical layouts (discriminator = name hash)', () => {
  for (const attr of ['event', 'account']) {
    const byName = new Map<string, { program: string; fields: string }[]>();
    for (const f of files) for (const it of parseAttributedStructs(f, attr)) {
      const list = byName.get(it.name) ?? [];
      list.push({ program: f.program, fields: it.fields.join('; ') });
      byName.set(it.name, list);
    }
    const bad: string[] = [];
    for (const [name, list] of byName) {
      const programs = new Set(list.map((x) => x.program));
      if (list.length > programs.size) bad.push(`${attr} ${name} declared twice in one program`);
      if (new Set(list.map((x) => x.fields)).size > 1) bad.push(`${attr} ${name}: ${list.map((x) => `${x.program}{${x.fields}}`).join(' vs ')}`);
    }
    assert.ok(byName.size >= (attr === 'event' ? 40 : 15), `${attr} types seen: ${byName.size}`);
    assert.deepEqual(bad, [], attr);
  }
});

const listIn = (ts: string, name: string) => {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(ts);
  assert.ok(m, `${name} table missing`);
  return m[1];
};
test('D26 client + test error tables match every #[error_code] enum (names and order ⇒ 6000+i codes)', () => {
  const rust: Record<string, string[]> = {
    CHIP_CORE: errorVariants(stripComments(src('programs/chip_core/src/errors.rs'))),
    MARKET: errorVariants(stripComments(src('programs/market/src/lib.rs'))),
    STAKING: errorVariants(stripComments(src('programs/staking/src/errors.rs'))),
    ARENA: errorVariants(stripComments(src('programs/arena/src/lib.rs'))),
  };
  const expectTs = src('tests/localnet/helpers/expect.ts');
  const clientTs = src('client/src/chain/errors.ts');
  for (const [name, variants] of Object.entries(rust)) {
    assert.ok(variants.length >= 10, `${name}: ${variants.length} variants`);
    const names = Array.from(listIn(expectTs, name).matchAll(/'(\w+)'/g)).map((m) => m[1]);
    assert.deepEqual(names, variants, `tests/localnet/helpers/expect.ts ${name}`);
    const msgs = Array.from(listIn(clientTs, name).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g));
    assert.equal(msgs.length, variants.length, `client/src/chain/errors.ts ${name}: one message per variant`);
  }
});

const tsFiles = (dir: string): string[] => readdirSync(join(REPO, dir)).flatMap((e) => {
  const rel = join(dir, e);
  if (e === 'node_modules' || e.startsWith('.')) return [];
  return statSync(join(REPO, rel)).isDirectory() ? tsFiles(rel) : /\.tsx?$/.test(e) ? [rel] : [];
});
test('D26 every instruction the client / harness / backend encodes exists in a #[program] module', () => {
  const known = new Set(loadSources(REPO, [...PROGRAMS, 'sb_mock']).flatMap(programInstructionNames));
  const bad: string[] = [];
  let n = 0;
  for (const dir of ['client/src', 'tests/localnet', 'backend/src', 'scripts']) {
    for (const rel of tsFiles(dir)) {
      for (const m of src(rel).matchAll(/\bixData\(\s*'(\w+)'/g)) {
        n++;
        if (!known.has(m[1])) bad.push(`${rel}: ixData('${m[1]}')`);
      }
    }
  }
  assert.ok(n >= 40, `ixData call sites seen: ${n}`);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- E. runtime

test('E28 every `close = X` pays the rent to a bound party (has_one / address / require_keys_eq in the handler)', () => {
  const bad: string[] = [];
  let n = 0;
  for (const s of structs) for (const f of s.fields) {
    const target = constraintValue(f, 'close');
    if (!target) continue;
    n++;
    const tf = s.fields.find((x) => x.name === target);
    if (!tf) { bad.push(`${where(s, f)}: close target '${target}' is not an account of the struct`); continue; }
    const bound = has(f, new RegExp(`^has_one\\s*=\\s*${target}\\b`)) || has(tf, /^address\s*=/)
      || new RegExp(`require_keys_eq!\\([^;]*\\b${f.name}\\b[^;]*\\b${target}\\b|require_keys_eq!\\([^;]*\\b${target}\\b[^;]*\\b${f.name}\\b`).test(handlerBody(s));
    if (!bound) bad.push(`${where(s, f)}: rent goes to '${target}' which is not bound to the closed account`);
    if (coreType(tf.type).kind !== 'Signer' && !has(tf, /^address\s*=/)) bad.push(`${where(s, f)}: close target neither signer nor address-pinned`);
  }
  assert.ok(n >= 14, `close sites seen: ${n}`);
  assert.deepEqual(bad, []);
});

// E29: Anchor 0.31 has no `dup` constraint; remaining_accounts are never deduplicated. Every handler
// that deserialises + writes accounts out of remaining_accounts must reject repeats or bind each key.
const REMAINING_ALLOW: Record<string, string> = {
  open_compressed_pack: 'claim PDAs derived per (nonce, pack_no, slot) ⇒ distinct; collection metas re-read and exit() per slot',
  fuse_claims_reveal: 'key == pending.materials[m] (distinct at commit via ensure_distinct_material)',
  cancel_stale_claim_fusion: 'key == pending.materials[m] (distinct at commit)',
  register_compressed_chip: 'remaining_accounts are read-only Merkle proof nodes (≤ tree max_depth)',
  fuse: 'load_materials() rejects repeats (fusion.rs DuplicateMaterial) before any write',
  fuse_reveal: 'key == pending.materials[m] (distinct at commit)',
  cancel_stale_fusion: 'key == pending.materials[m] (distinct at commit)',
  open_pack: 'legacy Core path, fail-closed (CompressedMigrationRequired); asset/state PDAs derived per slot',
};
export function remainingAccountsViolations(list: FnItem[]): string[] {
  return list
    .filter((f) => /remaining_accounts/.test(f.body) && /try_borrow_mut_data|\.exit\(|\.serialize\(/.test(f.body))
    .filter((f) => !/ensure_distinct_material|Duplicate\w*/.test(f.body) && !REMAINING_ALLOW[f.name])
    .map((f) => `${f.file}:${f.line} ${f.name}`);
}
test('E29 duplicate accounts: every remaining_accounts write loop rejects repeated keys (or binds each key)', () => {
  assert.deepEqual(remainingAccountsViolations(fns), []);
  // allowlist entries must still exist (a renamed fn must not keep a stale exemption alive)
  for (const name of Object.keys(REMAINING_ALLOW)) assert.ok(fns.some((f) => f.name === name), `stale allowlist entry ${name}`);
  // the SEC-F2 fix: both compressed-claim fusion entry points call the shared guard
  for (const name of ['fuse_compressed_claims', 'fuse_claims_commit']) {
    const f = fns.find((x) => x.name === name && x.program === 'chip_core' && /remaining_accounts/.test(x.body));
    assert.ok(f && /ensure_distinct_material\(&material_keys\[\.\.i\]/.test(f.body), `${name} must dedupe materials`);
  }
});

test('E29 fixed-account duplicates: arena squads / sweep shards / market self-trade keep their explicit guards', () => {
  const all = files.map((f) => f.code).join('\n');
  for (const guard of ['ArenaError::DuplicateChip', 'ArenaError::SelfBattle', 'MarketError::SelfTrade', 'ChipError::InvalidShard', 'ChipError::DuplicateMaterial']) {
    assert.ok(all.includes(guard), guard);
  }
});

test('E30 no deprecated sysvars; SlotHashes is address-pinned wherever it is taken', () => {
  const bad = files.filter((f) => /RecentBlockhashes|recent_blockhashes|sysvar::fees|Sysvar<'info,\s*Fees>|sysvar::rewards/.test(f.code)).map((f) => f.rel);
  assert.deepEqual(bad, []);
  for (const s of structs) for (const f of s.fields) {
    if (!/slot_?hashes/.test(f.name) || PROGRAM_ACCOUNT_ALLOW[`${s.name}.${f.name}`]) continue;
    assert.ok(has(f, /^address\s*=\s*[\w:]*SLOT_HASHES_ID\b/) || coreType(f.type).kind === 'Sysvar', `${where(s, f)} not pinned`);
  }
});

test('A5/E27 manual create_account always funds the rent-exempt minimum', () => {
  const bad = fns.filter((f) => /create_account\s*\(/.test(f.body) && !/minimum_balance\s*\(/.test(f.body)).map((f) => `${f.file}:${f.line} ${f.name}`);
  assert.deepEqual(bad, []);
});

test('B10 randomness never derives from the clock (commit-reveal via Switchboard only)', () => {
  for (const rel of ['programs/chip_core/src/randomness.rs', 'programs/chip_core/src/economy.rs']) {
    const code = stripComments(src(rel)).replace(/#\[cfg\(test\)\][\s\S]*$/, '');
    assert.doesNotMatch(code, /unix_timestamp|Clock::get|\.slot\b(?!_)/, rel);
  }
});

// ---------------------------------------------------------------- rule self-tests

const fake = (code: string, rel = 'programs/chip_core/src/instructions/fake.rs'): SourceFile => ({ path: rel, rel, program: 'chip_core', code: stripComments(code) });

test('self-test: E29 rule flags the pre-fix SEC-F2 fusion loop and accepts the fixed one', () => {
  const vulnerable = `
    pub fn fuse_compressed_claims_v0<'info>(ctx: Context<'_, '_, 'info, 'info, FuseCompressedClaims<'info>>) -> Result<()> {
        for (i, claim_ai) in ctx.remaining_accounts.iter().enumerate() {
            let claim: Account<CompressedMintClaim> = Account::try_from(claim_ai)?;
            material_keys[i] = claim_ai.key();
        }
        for claim_ai in ctx.remaining_accounts.iter() {
            let mut data = claim_ai.try_borrow_mut_data()?; // consumed = true
        }
        Ok(())
    }`;
  assert.equal(remainingAccountsViolations(parseFns(fake(vulnerable))).length, 1);
  const fixed = vulnerable.replace('material_keys[i] = claim_ai.key();', 'ensure_distinct_material(&material_keys[..i], &claim_ai.key())?; material_keys[i] = claim_ai.key();');
  assert.equal(remainingAccountsViolations(parseFns(fake(fixed))).length, 0);
});

test('self-test: the account reader extracts constraints, types and close targets', () => {
  const [s] = parseAccountsStructs(fake(`
    #[derive(Accounts)]
    #[instruction(nonce: u64)]
    pub struct Steal<'info> {
        /// CHECK: doc comments are ignored
        pub thief: Signer<'info>, // not mut
        #[account(init, payer = thief, space = 8 + 32, seeds = [b"x", thief.key().as_ref()], bump)]
        pub loot: Box<Account<'info, Loot>>,
        #[account(mut, close = thief, seeds = [b"p", &nonce.to_le_bytes()], bump = pending.bump)]
        pub pending: Account<'info, PendingPack>,
        pub token_program: UncheckedAccount<'info>,
        pub vault_token: Option<Account<'info, TokenAccount>>,
    }`));
  assert.equal(s.name, 'Steal');
  assert.deepEqual(s.fields.map((f) => f.name), ['thief', 'loot', 'pending', 'token_program', 'vault_token']);
  assert.deepEqual(coreType(s.fields[1].type), { kind: 'Account', inner: 'Loot', optional: false });
  assert.deepEqual(coreType(s.fields[4].type), { kind: 'Account', inner: 'TokenAccount', optional: true });
  assert.equal(constraintValue(s.fields[1], 'space'), '8 + 32'); // ← would fail the INIT_SPACE rule
  assert.equal(constraintValue(s.fields[2], 'close'), 'thief'); // ← no has_one ⇒ would fail E28
  assert.ok(!has(s.fields[0], /^mut$/)); // ← payer not mut ⇒ would fail A3
  assert.equal(coreType(s.fields[3].type).kind, 'UncheckedAccount'); // ← would fail A4
});

/**
 * The guard's own cases — `npm run selftest:elf`.
 *
 * `helpers/elf.ts` predicts what litesvm will say about a `.so`, and that prediction is what run 81
 * got wrong (docs/09 §G-2: `Offset or value is out of bounds` was read as "0-byte cached file"). So
 * the two rules under test are the two rules the harness relies on:
 *
 *   1. a structurally incomplete ELF ⇒ the loader's answer is exactly `Offset or value is out of
 *      bounds` (the message that names nothing), while the guard names the file and the offset;
 *   2. a structurally complete ELF ⇒ that message cannot be the loader's answer (the loader may still
 *      refuse the file for a semantic reason, and then say which one).
 *
 * Both are asserted against the *installed binding*, not against a table in a comment. Where litesvm
 * is not importable (a machine without the native binding), the loader half is skipped out loud and
 * the pure half still runs — a silent skip would be the same lie the guard exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProgramBinary, elfFacts, inspectElfBytes, trimTrailingZeroPadding } from './elf.ts';

/** Syntactically complete ELF64-LE: 64-byte header + `shnum` 64-byte section headers, NULL by default. */
function mkElf(opts: { shnum?: number; tailZeros?: number; sections?: { i: number; type?: number; off: number; size: number }[]; cls?: number; data?: number } = {}): Uint8Array {
  const { shnum = 1, tailZeros = 0, sections = [], cls = 2, data = 1 } = opts;
  const shoff = 64;
  const b = Buffer.alloc(shoff + shnum * 64 + tailZeros);
  b.write('\x7fELF', 0, 'latin1');
  b[4] = cls;
  b[5] = data;
  b[6] = 1;
  b.writeUInt16LE(2, 16); // ET_EXEC
  b.writeUInt16LE(247, 18); // EM_BPF
  b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(0n, 0x20); // e_phoff
  b.writeBigUInt64LE(BigInt(shoff), 0x28); // e_shoff
  b.writeUInt32LE(0, 0x30);
  b.writeUInt16LE(64, 0x34); // e_ehsize
  b.writeUInt16LE(56, 0x36); // e_phentsize
  b.writeUInt16LE(0, 0x38); // e_phnum
  b.writeUInt16LE(64, 0x3a); // e_shentsize
  b.writeUInt16LE(shnum, 0x3c);
  b.writeUInt16LE(0, 0x3e);
  for (const s of sections) {
    const o = shoff + s.i * 64;
    b.writeUInt32LE(s.type ?? 1, o + 4);
    b.writeBigUInt64LE(BigInt(s.off), o + 0x18);
    b.writeBigUInt64LE(BigInt(s.size), o + 0x20);
  }
  return b;
}

const OOB = 'Failed to add program: Offset or value is out of bounds';
const PROBE_ID = 'ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH';

/** Ask the installed loader through a file, the way `chain.ts` does. */
async function makeLoader(): Promise<{ load: (bytes: Uint8Array) => string; version: string }> {
  const { LiteSVM } = await import('litesvm');
  const { address } = await import('@solana/kit');
  const { createRequire } = await import('node:module');
  const version = (createRequire(import.meta.url)('litesvm/package.json') as { version: string }).version;
  const path = join(mkdtempSync(join(tmpdir(), 'gc-elf-guard-')), 'probe.so');
  return {
    version,
    load: (bytes) => {
      writeFileSync(path, bytes);
      const svm = new LiteSVM();
      try {
        svm.addProgramFromFile(address(PROBE_ID), path);
        return 'LOADED';
      } catch (e) {
        return String((e as Error).message).replace(/\n/g, ' | ');
      }
    },
  };
}

let loader: Awaited<ReturnType<typeof makeLoader>> | undefined;
let loaderWhy = '';
try {
  loader = await makeLoader();
} catch (e) {
  loaderWhy = (e as Error).message;
}

// ---------------------------------------------------------------------------------------------------
// the guard itself (no loader needed)
// ---------------------------------------------------------------------------------------------------

test('0-byte, 1-byte and 4-byte files are "empty or truncated", not "not an ELF"', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0x7f]), Buffer.from('\x7fELF')]) {
    const c = inspectElfBytes(bytes);
    assert.equal(c.ok, false);
    assert.match(c.reason!, /empty or truncated/, `${bytes.length} bytes: ${c.reason}`);
  }
});

test('bytes that are not an ELF are named by their first four bytes', () => {
  // ≥ 64 bytes so the size rule (which is also the loader's first wall) is not what fires
  const c = inspectElfBytes(Buffer.from(`this is not an elf at all, just ${'x'.repeat(64)} bytes of ascii`));
  assert.equal(c.ok, false);
  assert.match(c.reason!, /not an ELF/);
  // shorter garbage is reported as truncated, and that is the same class for the loader (see the
  // agreement test below: both inputs get `Offset or value is out of bounds`)
  assert.match(inspectElfBytes(Buffer.from('this is not an elf at all')).reason!, /empty or truncated/);
});

test('a complete ELF passes, and its structure end is the section header table', () => {
  const elf = mkElf({ shnum: 2 });
  const c = inspectElfBytes(elf);
  assert.equal(c.ok, true, c.reason);
  assert.equal(c.facts!.structureEnd, elf.length);
  assert.equal(elfFacts(elf)!.shnum, 2);
});

test('a section header table that runs past the file end is named as such', () => {
  const c = inspectElfBytes(mkElf({ shnum: 3 }).subarray(0, 64 + 2 * 64)); // one 64-byte header short
  assert.equal(c.ok, false);
  assert.match(c.reason!, /section header table/);
  assert.match(c.reason!, /cut short/);
});

test('a section whose file bytes run past the end is named by index — except NOBITS, which has none', () => {
  const progbits = inspectElfBytes(mkElf({ shnum: 2, sections: [{ i: 1, type: 1, off: 1024, size: 512 }] }));
  assert.equal(progbits.ok, false);
  assert.match(progbits.reason!, /section #1 \(sh_type 1\)/);
  // measured: the loader accepts an out-of-file NOBITS section, so the guard must not call it broken
  const nobits = inspectElfBytes(mkElf({ shnum: 2, sections: [{ i: 1, type: 8, off: 4096, size: 4096 }] }));
  assert.equal(nobits.ok, true, nobits.reason);
});

test('32-bit and big-endian files are rejected with the reason, not as garbage', () => {
  assert.match(inspectElfBytes(mkElf({ cls: 1 })).reason!, /not 64-bit/);
  assert.match(inspectElfBytes(mkElf({ data: 2 })).reason!, /little-endian/);
});

test('checkProgramBinary reports a missing path as such', () => {
  assert.deepEqual(checkProgramBinary('/nonexistent/does-not-exist.so'), { ok: false, reason: 'missing' });
});

// ---------------------------------------------------------------------------------------------------
// the trim — the actual run-81 bug
// ---------------------------------------------------------------------------------------------------

test('trimTrailingZeroPadding stops at the declared structures; a plain zero-trim does not', () => {
  // What CI loads: a dump whose tail is zero bytes. The last section header's trailing fields are
  // zeros, so "remove trailing zeros" cuts into the table — that is the run-81 failure.
  const elf = mkElf({ shnum: 1, tailZeros: 32 });
  let naive = elf.length;
  while (naive > 0 && elf[naive - 1] === 0) naive--;
  const naiveTrim = elf.subarray(0, naive);
  assert.equal(inspectElfBytes(naiveTrim).ok, false, 'the unbounded trim must stay detectable — it is the bug');
  const bounded = trimTrailingZeroPadding(elf);
  assert.equal(inspectElfBytes(bounded).ok, true, inspectElfBytes(bounded).reason);
  assert.equal(bounded.length, elf.length - 32, 'only the real padding goes');
});

test('trimTrailingZeroPadding leaves a file with no padding exactly as it is', () => {
  const elf = mkElf({ shnum: 2 });
  assert.equal(trimTrailingZeroPadding(elf).length, elf.length);
});

// ---------------------------------------------------------------------------------------------------
// the contract with the loader
// ---------------------------------------------------------------------------------------------------

test('the guard and the loader agree on which bytes are "not a complete ELF"', { skip: !loader && `litesvm not importable here (${loaderWhy})` }, () => {
  const cases: { label: string; bytes: Uint8Array; complete: boolean }[] = [
    { label: '0 bytes', bytes: Buffer.alloc(0), complete: false },
    { label: 'ascii garbage', bytes: Buffer.from('this is not an elf at all, just some bytes'), complete: false },
    { label: 'truncated to 128 bytes', bytes: mkElf({ shnum: 3 }).subarray(0, 128), complete: false },
    { label: 'section data past EOF', bytes: mkElf({ shnum: 2, sections: [{ i: 1, type: 1, off: 1024, size: 512 }] }), complete: false },
    { label: 'complete ELF (no shstrtab)', bytes: mkElf({ shnum: 1 }), complete: true },
    { label: 'complete ELF + padding', bytes: mkElf({ shnum: 1, tailZeros: 32 }), complete: true },
  ];
  const rows: string[] = [];
  for (const c of cases) {
    const guard = inspectElfBytes(c.bytes);
    const said = loader!.load(c.bytes);
    rows.push(`${c.label.padEnd(26)} guard: ${(guard.ok ? 'ok' : 'unusable').padEnd(8)} loader: ${said.slice(0, 72)}`);
    assert.equal(guard.ok, c.complete, `guard verdict for ${c.label}: ${guard.reason ?? 'ok'}`);
    if (c.complete) assert.notEqual(said, OOB, `${c.label}: a complete ELF must not produce the opaque message`);
    else assert.equal(said, OOB, `${c.label}: the incomplete-ELF class is exactly the opaque message`);
  }
  console.log(`\n  guard ⇄ litesvm ${loader!.version} agreement:\n    ${rows.join('\n    ')}\n`);
});

/**
 * Is this `.so` something the loader can actually take?
 *
 * Why this file exists — and why it is longer than "size > 0 and magic is ELF".
 *
 * Run 81 (docs/09-production-readiness.md §G-2) failed all 8 boot-level suites with `Failed to add
 * program: Offset or value is out of bounds`, and that message was read as "the cached fixture is a
 * 0-byte file". The message class was right, the diagnosis was not: **that string is what the napi
 * binding emits whenever the bytes are not a complete ELF**, and the file this repo hands it was
 * incomplete for a much more boring reason — the trailing-zero trim in `fetch-fixtures.ts` cut into
 * the ELF's own last structure. A section header table is the last thing in an ELF file and its final
 * entry typically ends in zero bytes (`sh_addralign`/`sh_entsize` of `.shstrtab`), so "trim zeros"
 * silently removed part of the declared table and every load became a bounds error.
 *
 * Table below is measured, not recalled: `tests/localnet/helpers/elf.test.ts` drives the installed
 * binding (litesvm 1.4.1, napi) with each class of input and asserts these mappings, so this file
 * cannot drift away from the loader it predicts.
 *
 *   input                                              litesvm `addProgramFromFile`
 *   -------------------------------------------------- ------------------------------------------------
 *   path does not exist                                `No such file or directory (os error 2)`
 *   0 B / 1 B / 4 B (`\x7fELF`) / 42 B of ascii         `Offset or value is out of bounds`
 *   truncated ELF (header only, or tables cut short)    `Offset or value is out of bounds`
 *   complete ELF, semantically wrong (x86-64 build)     `Failed to parse ELF file: <what is wrong>`
 *   32-bit class / big-endian / bad e_ehsize            `Failed to parse ELF file: invalid file header`
 *
 * So the guard's job is the first two rows (the ones that say nothing) — plus naming the file, which
 * litesvm never does: it takes a path, and the loop in `chain.ts` is what knows whose path it was.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';

const EI_CLASS = 4;
const EI_DATA = 5;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EHDR_SIZE = 64;
const SHT_NULL = 0;
const SHT_NOBITS = 8;

export interface ElfFacts {
  size: number;
  /** `e_phoff`/`e_phnum`/`e_phentsize` — the program header table */
  phoff: number;
  phnum: number;
  phentsize: number;
  /** `e_shoff`/`e_shnum`/`e_shentsize` — the section header table */
  shoff: number;
  shnum: number;
  shentsize: number;
  /** first byte past every structure the header declares (0 when the header itself is unusable) */
  structureEnd: number;
}

export interface ElfCheck {
  ok: boolean;
  reason?: string;
  facts?: ElfFacts;
}

const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number): number => Number(BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n));
const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const hex = (b: Uint8Array, from: number, to: number): string => Array.from(b.subarray(from, to), (x) => x.toString(16).padStart(2, '0')).join(' ');

/** Facts from the ELF header, without judging them. `structureEnd` is what any zero-trim must not cut. */
export function elfFacts(bytes: Uint8Array): ElfFacts | undefined {
  if (bytes.length < EHDR_SIZE) return undefined;
  const facts: ElfFacts = {
    size: bytes.length,
    phoff: u64(bytes, 0x20),
    phentsize: u16(bytes, 0x36),
    phnum: u16(bytes, 0x38),
    shoff: u64(bytes, 0x28),
    shentsize: u16(bytes, 0x3a),
    shnum: u16(bytes, 0x3c),
    structureEnd: EHDR_SIZE,
  };
  facts.structureEnd = Math.max(EHDR_SIZE, facts.phoff + facts.phnum * facts.phentsize, facts.shoff + facts.shnum * facts.shentsize);
  return facts;
}

/** First byte past every declared structure — what `trimTrailingZeroPadding` protects. 0 when unknown. */
export function elfStructureEnd(bytes: Uint8Array): number {
  return elfFacts(bytes)?.structureEnd ?? 0;
}

/**
 * The same trim `fetch-fixtures.ts` does on a `solana program dump` — with the one rule that was
 * missing: never cut below the end of the structures the header declares. Zero padding in a
 * ProgramData account is indistinguishable from the zero tail of the last section header, so the
 * unbounded version eats a piece of the table and the loader answers "Offset or value is out of
 * bounds" (measured; see the module header).
 */
export function trimTrailingZeroPadding(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, Math.max(end, elfStructureEnd(bytes), 1));
}

/** Structural verdict on raw bytes — no filesystem, so it is testable and usable before writing a file. */
export function inspectElfBytes(bytes: Uint8Array): ElfCheck {
  if (bytes.length < EHDR_SIZE) return { ok: false, reason: `empty or truncated: ${bytes.length} byte(s), shorter than an ELF header (${EHDR_SIZE})` };
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    return { ok: false, reason: `not an ELF: first bytes are ${hex(bytes, 0, 4)}` };
  }
  const facts = elfFacts(bytes)!;
  if (bytes[EI_CLASS] !== ELFCLASS64) return { ok: false, facts, reason: `ELF class ${bytes[EI_CLASS]} is not 64-bit (the SBF loader takes ELFCLASS64 only)` };
  if (bytes[EI_DATA] !== ELFDATA2LSB) return { ok: false, facts, reason: `ELF data encoding ${bytes[EI_DATA]} is not little-endian` };
  const past = (what: string, from: number, to: number) => `${what} [${from}, ${to}) runs past the end of the file (${bytes.length} bytes) — the artifact is cut short`;
  if (facts.phnum > 0 && facts.phoff + facts.phnum * facts.phentsize > bytes.length) {
    return { ok: false, facts, reason: past('program header table', facts.phoff, facts.phoff + facts.phnum * facts.phentsize) };
  }
  if (facts.shnum > 0 && facts.shoff + facts.shnum * facts.shentsize > bytes.length) {
    // the class that produced the opaque `Offset or value is out of bounds`: the last section headers
    // (or their zero tail) were trimmed away by a "remove trailing zeros" pass
    return { ok: false, facts, reason: past('section header table', facts.shoff, facts.shoff + facts.shnum * facts.shentsize) };
  }
  for (let i = 0; i < facts.shnum; i++) {
    const o = facts.shoff + i * facts.shentsize;
    const type = u32(bytes, o + 4);
    if (type === SHT_NULL || type === SHT_NOBITS) continue; // NOBITS (`.bss`) has no file bytes by definition
    const offset = u64(bytes, o + 0x18);
    const size = u64(bytes, o + 0x20);
    if (offset + size > bytes.length) return { ok: false, facts, reason: past(`section #${i} (sh_type ${type})`, offset, offset + size) };
  }
  return { ok: true, facts, reason: undefined };
}

/** Read through the file system: `inspectElfBytes` plus the reasons only a path can have. */
export function checkProgramBinary(path: string): ElfCheck {
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    return { ok: false, reason: `unreadable: ${(e as Error).message}` };
  }
  return inspectElfBytes(bytes);
}

/** `path` is present and loadable. */
export function isProgramBinaryUsable(path: string): boolean {
  return checkProgramBinary(path).ok;
}

/** One line for an error message: why this path is unusable, with the size that makes "0-byte" visible. */
export function describeProgramBinary(path: string, check: ElfCheck): string {
  let size = 'missing';
  try {
    size = statSync(path).size.toString();
  } catch {
    /* the path is the missing part; `check.reason` already says so */
  }
  return `${path} — ${check.reason ?? 'unusable'} (${size} bytes)`;
}

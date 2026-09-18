/**
 * A `.so` the harness can actually load: exists, non-trivial size, ELF magic.
 *
 * Why this exists at all: run 81 (docs/09-production-readiness.md §G-2) failed 8/8 boot-level tests with
 * `Failed to add program: Offset or value is out of bounds` from litesvm. Measured against the installed
 * binding, that message is what a **0-byte file** produces — a missing file says `No such file or directory`,
 * a garbage one says `Detected sbpf_version required by the executable which are not enabled`. So a
 * truncated/empty artifact or a poisoned `tests/localnet/fixtures` cache entry (the file is cached under a
 * fixed key, and `existsSync` treated it as "already present") looks like a *test failure* to everyone
 * reading the run. Anything that decides "can the suite run" must ask more than "is the path there".
 */
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';

export interface ElfCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Cheap structural check — no ELF parsing, no dependency on the loader. */
export function checkProgramBinary(path: string): ElfCheck {
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    return { ok: false, reason: `unreadable: ${(e as Error).message}` };
  }
  if (size < 64) return { ok: false, reason: `empty or truncated (${size} bytes)` };
  const head = Buffer.alloc(4);
  try {
    const fd = openSync(path, 'r');
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return { ok: false, reason: `unreadable: ${(e as Error).message}` };
  }
  if (head.toString('latin1') !== '\x7fELF') return { ok: false, reason: `not an ELF (first bytes ${head.toString('hex')})` };
  return { ok: true };
}

/** `path` is present and loadable. */
export function isProgramBinaryUsable(path: string): boolean {
  return checkProgramBinary(path).ok;
}

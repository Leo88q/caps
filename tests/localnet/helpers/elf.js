"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkProgramBinary = checkProgramBinary;
exports.isProgramBinaryUsable = isProgramBinaryUsable;
/**
 * A `.so` the harness can actually load: exists, non-trivial size, ELF magic, and an internally consistent
 * program-header table that fits inside the file.
 *
 * Why this exists at all: run 81 (docs/09-production-readiness.md §G-2) failed 8/8 boot-level tests with
 * `Failed to add program: Offset or value is out of bounds` from litesvm. Measured against the installed
 * binding, that message is what a **0-byte file** produces — a missing file says `No such file or directory`,
 * a garbage one says `Detected sbpf_version required by the executable which are not enabled`. So a
 * truncated/empty artifact or a poisoned `tests/localnet/fixtures` cache entry (the file is cached under a
 * fixed key, and `existsSync` treated it as "already present") looks like a *test failure* to everyone
 * reading the run. Anything that decides "can the suite run" must ask more than "is the path there".
 *
 * 2026-09-19, the sequel: the same litesvm message came back with a cache entry whose first 4 bytes were a
 * perfectly good ELF magic — a header-intact, body-truncated dump. The magic-only check waved it through,
 * eight tests died mid-suite again (PR #19 run). The program-header table is what the loader maps first, so
 * a phdr (or any segment it describes) sticking out past EOF now fails the check with a reason that names
 * the truncation, before litesvm gets to translate it into a mystery.
 */
const node_fs_1 = require("node:fs");
/** Structural check — ELF header + program-header bounds; no loader involved. */
function checkProgramBinary(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return { ok: false, reason: 'missing' };
    let size;
    try {
        size = (0, node_fs_1.statSync)(path).size;
    }
    catch (e) {
        return { ok: false, reason: `unreadable: ${e.message}` };
    }
    if (size < 64)
        return { ok: false, reason: `empty or truncated (${size} bytes)` };
    let buf;
    try {
        buf = readHead(path, Math.min(size, 4096));
    }
    catch (e) {
        return { ok: false, reason: `unreadable: ${e.message}` };
    }
    if (buf.subarray(0, 4).toString('latin1') !== '\x7fELF')
        return { ok: false, reason: `not an ELF (first bytes ${buf.subarray(0, 4).toString('hex')})` };
    if (buf[4] !== 2)
        return { ok: true }; // not ELF64 — not our toolchain's output; let the loader judge
    const phoff = Number(buf.readBigUInt64LE(0x20));
    const phentsize = buf.readUInt16LE(0x36);
    const phnum = buf.readUInt16LE(0x38);
    if (phnum === 0)
        return { ok: true }; // headerless blob — nothing structural to check
    if (phentsize < 56)
        return { ok: false, reason: `bad e_phentsize ${phentsize}` };
    const tableEnd = phoff + phnum * phentsize;
    if (tableEnd > size)
        return { ok: false, reason: `phdr table (off ${phoff}, ${phnum} x ${phentsize}) exceeds file size ${size} — truncated dump` };
    if (tableEnd > buf.length) {
        try {
            buf = readHead(path, tableEnd);
        }
        catch (e) {
            return { ok: false, reason: `unreadable: ${e.message}` };
        }
    }
    for (let i = 0; i < phnum; i++) {
        const o = phoff + i * phentsize;
        const p_offset = Number(buf.readBigUInt64LE(o + 0x08));
        const p_filesz = Number(buf.readBigUInt64LE(o + 0x20));
        if (p_filesz > 0 && p_offset + p_filesz > size) {
            return { ok: false, reason: `segment ${i} (off ${p_offset}, filesz ${p_filesz}) exceeds file size ${size} — truncated dump` };
        }
    }
    return { ok: true };
}
function readHead(path, length) {
    const buf = Buffer.alloc(length);
    const fd = (0, node_fs_1.openSync)(path, 'r');
    try {
        (0, node_fs_1.readSync)(fd, buf, 0, length, 0);
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
    return buf;
}
/** `path` is present and loadable. */
function isProgramBinaryUsable(path) {
    return checkProgramBinary(path).ok;
}

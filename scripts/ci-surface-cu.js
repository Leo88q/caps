"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Aggregate the localnet CU census (`target/cu-log.jsonl`, one row per successful send(),
// written by `tests/localnet/helpers/cu.ts`) into max-CU-per-tx-shape tables: a human-readable
// stdout table plus ONE capped `::notice` annotation per backend (CI surfaces it on the run),
// and the full table as JSON for the `cu-summary` artifact (G-6 table fuel).
// Always exits 0 — the census must never fail CI.
const node_fs_1 = require("node:fs");
const ROW_CAP = 60; // notice bodies over ~64KB get rejected; 60 rows ≈ 6KB
const OUT_JSON = 'target/cu-summary.json';
function load(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return [];
    const rows = [];
    for (const line of (0, node_fs_1.readFileSync)(path, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            const r = JSON.parse(t);
            if (typeof r.key === 'string' && typeof r.cu === 'number' && typeof r.be === 'string')
                rows.push(r);
        }
        catch {
            // corrupt line: skip
        }
    }
    return rows;
}
function main() {
    const rows = load(process.argv[2] ?? 'target/cu-log.jsonl');
    if (rows.length === 0) {
        console.log('CU census: no transactions recorded (missing log or all lines corrupt).');
        return;
    }
    const byBe = new Map();
    const out = [];
    for (const be of [...new Set(rows.map((r) => r.be))].sort()) {
        const acc = new Map();
        for (const r of rows.filter((x) => x.be === be)) {
            const s = acc.get(r.key) ?? { key: r.key, max: 0, n: 0, label: r.label ?? '' };
            if (r.cu > s.max)
                s.max = r.cu;
            s.n += 1;
            if (!s.label && r.label)
                s.label = r.label;
            acc.set(r.key, s);
        }
        const shapes = [...acc.values()].sort((a, b) => b.max - a.max || b.n - a.n);
        byBe.set(be, shapes);
        out.push({ backend: be, txs: rows.filter((x) => x.be === be).length, shapes });
    }
    for (const [be, shapes] of byBe) {
        const txs = rows.filter((x) => x.be === be).length;
        const head = `CU census max-per-tx-shape (${be}, ${txs} txs, ${shapes.length} shapes):`;
        const lines = shapes.slice(0, ROW_CAP).map((s) => `${String(s.max).padStart(7)}  x${String(s.n).padStart(3)}  ${s.key}`);
        if (shapes.length > ROW_CAP)
            lines.push(`... ${shapes.length - ROW_CAP} more shapes in the cu-summary artifact`);
        console.log([head, ...lines].join('\n'));
        // One annotation per backend; GitHub folds newlines, the artifact JSON keeps the full table.
        console.log(`::notice file=tests/localnet/helpers/cu.ts::${head} ${lines.join(' / ')}`);
    }
    (0, node_fs_1.mkdirSync)('target', { recursive: true });
    (0, node_fs_1.writeFileSync)(OUT_JSON, JSON.stringify(out.length === 1 ? out[0] : out, null, 2) + '\n');
    console.log(`wrote ${OUT_JSON}`);
}
main();

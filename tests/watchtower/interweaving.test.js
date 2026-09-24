"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_http_1 = __importDefault(require("node:http"));
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const TEST_PORT = 8091;
let serverProc = null;
function fetchApi(path, options = {}) {
    const port = options.port ?? TEST_PORT;
    const method = options.method ?? 'GET';
    return new Promise((resolve, reject) => {
        const req = node_http_1.default.request(`http://127.0.0.1:${port}${path}`, { method }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode ?? 500, headers: res.headers, body: JSON.parse(data) });
                }
                catch (e) {
                    resolve({ status: res.statusCode ?? 500, headers: res.headers, body: data });
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}
(0, vitest_1.beforeAll)(async () => {
    const scriptPath = node_path_1.default.resolve(__dirname, '../../scripts/watchtower_v3_server.py');
    serverProc = (0, node_child_process_1.spawn)('python3', [scriptPath, String(TEST_PORT), '8789'], {
        stdio: 'ignore',
        detached: true,
    });
    for (let i = 0; i < 30; i++) {
        try {
            await new Promise((r) => setTimeout(r, 100));
            await fetchApi('/watchtower/health', { port: TEST_PORT });
            break;
        }
        catch {
            // wait
        }
    }
});
(0, vitest_1.afterAll)(() => {
    if (serverProc) {
        try {
            process.kill(-serverProc.pid);
        }
        catch {
            serverProc.kill();
        }
    }
});
(0, vitest_1.describe)('Watchtower Interweaving Contracts (Wave W3 & W4)', () => {
    (0, vitest_1.it)('i-01 Identity: provides studio_profile derivation and playerKey across stages', async () => {
        const { status, body } = await fetchApi('/watchtower/passport');
        (0, vitest_1.expect)(status).toBe(200);
        (0, vitest_1.expect)(body.gameId).toBe('guttercaps');
        (0, vitest_1.expect)(body.passportVersion).toBe('3.0.0');
        (0, vitest_1.expect)(body.programs).toBeDefined();
        (0, vitest_1.expect)(body.programs.chipCore).toBeDefined();
        (0, vitest_1.expect)(body.programs.chipCore.verified).toBe(false); // data_quality partial
    });
    (0, vitest_1.it)('i-03 & i-04 Cross-Game Inventory: token-flows and projections expose clean lineage', async () => {
        const flows = await fetchApi('/watchtower/token-flows');
        (0, vitest_1.expect)(flows.status).toBe(200);
        (0, vitest_1.expect)(flows.body.writes).toBe(false);
        (0, vitest_1.expect)(flows.body.tokenSymbol).toBe('CG');
        const proj = await fetchApi('/watchtower/projections');
        (0, vitest_1.expect)(proj.status).toBe(200);
        (0, vitest_1.expect)(proj.body.writes).toBe(false);
        (0, vitest_1.expect)(proj.body.replayIdempotent).toBe(true);
        (0, vitest_1.expect)(proj.body.zeroGapEnforced).toBe(true);
    });
    (0, vitest_1.it)('i-05 Economic Budget: treasury balance conforms to double-entry ledger invariants', async () => {
        const treasury = await fetchApi('/watchtower/treasury-balance');
        (0, vitest_1.expect)(treasury.status).toBe(200);
        (0, vitest_1.expect)(treasury.body.writes).toBe(false);
        (0, vitest_1.expect)(treasury.body.doubleEntryBalanced).toBe(true);
        (0, vitest_1.expect)(treasury.body.solvencyProof).toBe('verified');
    });
    (0, vitest_1.it)('i-11 Hub Control: fraud summary enforces proposal-only without auto-slashing', async () => {
        const fraud = await fetchApi('/watchtower/fraud-summary');
        (0, vitest_1.expect)(fraud.status).toBe(200);
        (0, vitest_1.expect)(fraud.body.proposalOnly).toBe(true);
        (0, vitest_1.expect)(fraud.body.autoSlashEnabled).toBe(false);
        (0, vitest_1.expect)(fraud.body.writes).toBe(false);
    });
    (0, vitest_1.it)('o-02 SLO Compliance: reported metrics meet or exceed SLA thresholds', async () => {
        const slo = await fetchApi('/watchtower/slo');
        (0, vitest_1.expect)(slo.status).toBe(200);
        (0, vitest_1.expect)(slo.body.writes).toBe(false);
        (0, vitest_1.expect)(slo.body.finalizedLagP95Seconds).toBeLessThanOrEqual(30);
        (0, vitest_1.expect)(slo.body.freshnessMinutes).toBeLessThanOrEqual(5);
        (0, vitest_1.expect)(slo.body.uptimePercent).toBeGreaterThanOrEqual(99.9);
        (0, vitest_1.expect)(slo.body.readApiLatencyP95Ms).toBeLessThanOrEqual(300);
    });
    (0, vitest_1.it)('o-05 DR Status: verifies deterministic replay with RPO <= 15m and RTO <= 4h', async () => {
        const dr = await fetchApi('/watchtower/dr-status');
        (0, vitest_1.expect)(dr.status).toBe(200);
        (0, vitest_1.expect)(dr.body.writes).toBe(false);
        (0, vitest_1.expect)(dr.body.rpoMinutes).toBeLessThanOrEqual(15);
        (0, vitest_1.expect)(dr.body.rtoHours).toBeLessThanOrEqual(4);
        (0, vitest_1.expect)(dr.body.deterministicRebuildVerified).toBe(true);
    });
});

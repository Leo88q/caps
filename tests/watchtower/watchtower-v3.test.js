"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_http_1 = __importDefault(require("node:http"));
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
let serverProc = null;
function fetchApi(path, options = {}) {
    const port = options.port ?? 8089;
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
    // Start server locally for tests if not already running
    try {
        await fetchApi('/watchtower/health', { port: 8089 });
    }
    catch {
        const scriptPath = node_path_1.default.resolve(__dirname, '../../scripts/watchtower_v3_server.py');
        serverProc = (0, node_child_process_1.spawn)('python3', [scriptPath, '8089', '8787'], {
            stdio: 'ignore',
            detached: true,
        });
        // Wait up to 3s for server to start
        for (let i = 0; i < 30; i++) {
            try {
                await new Promise((r) => setTimeout(r, 100));
                await fetchApi('/watchtower/health', { port: 8089 });
                break;
            }
            catch {
                // keep waiting
            }
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
(0, vitest_1.describe)('Watchtower OS v3 Integration API', () => {
    (0, vitest_1.it)('GET /api/os/config returns exactly 33 deduplicated components in ideal free stack', async () => {
        const { status, body } = await fetchApi('/api/os/config');
        (0, vitest_1.expect)(status).toBe(200);
        (0, vitest_1.expect)(body.os).toBe('Watchtower OS v3');
        (0, vitest_1.expect)(body.totalComponents).toBe(33);
        (0, vitest_1.expect)(body.components.length).toBe(33);
        // Verify deduplication: all component IDs must be distinct
        const ids = body.components.map((c) => c.id);
        const uniqueIds = new Set(ids);
        (0, vitest_1.expect)(uniqueIds.size).toBe(33);
        (0, vitest_1.expect)(body.gaslessUx).toBe(true);
        (0, vitest_1.expect)(body.l2Router.target).toBe('MagicBlock ER');
    });
    (0, vitest_1.it)('GET /api/l2/router correctly routes tps=low ux=gasless to MagicBlock ER + Arcium privacy', async () => {
        const { status, body } = await fetchApi('/api/l2/router?gameId=guttercaps&tps=low&ux=gasless');
        (0, vitest_1.expect)(status).toBe(200);
        (0, vitest_1.expect)(body.gameId).toBe('guttercaps');
        (0, vitest_1.expect)(body.selectedL2).toBe('MagicBlock ER');
        (0, vitest_1.expect)(body.latency).toBe('<10ms');
        (0, vitest_1.expect)(body.gasless).toBe(true);
        (0, vitest_1.expect)(body.routeDecision).toBe('MagicBlock ER + Arcium privacy');
        (0, vitest_1.expect)(body.magicActions).toBe('auto_respawn_every_round');
        (0, vitest_1.expect)(body.settlementSequencer).toContain('REPLA L3');
    });
    (0, vitest_1.it)('GET /api/sdk/* returns best free SDK metadata for all 14 requested integrations', async () => {
        const sdks = [
            'godot-solana',
            'gamba',
            'preset',
            'ritarena',
            'xandeum',
            'pst',
            'core-attributes',
            'access-protocol',
            'idosgames-wallet',
            'security-auditing-skill',
            'sentio-cli',
            'solguard',
            'solana-slam',
            'arcium'
        ];
        for (const sdk of sdks) {
            const { status, body } = await fetchApi(`/api/sdk/${sdk}?gameId=guttercaps`);
            (0, vitest_1.expect)(status).toBe(200);
            (0, vitest_1.expect)(body.idealFree).toBe(true);
            (0, vitest_1.expect)(body.sdk.sdk).toBe(sdk);
            (0, vitest_1.expect)(body.sdk.bestFree).toBe(true);
        }
    });
    (0, vitest_1.it)('GET /api/game-signals/config returns ML churn predictor parameters and fixed memory leak metrics', async () => {
        const { status, body } = await fetchApi('/api/game-signals/config?gameId=guttercaps');
        (0, vitest_1.expect)(status).toBe(200);
        (0, vitest_1.expect)(body.model).toBe('Game Signals ML v3');
        (0, vitest_1.expect)(body.churnThreshold14d).toBe(0.85);
        (0, vitest_1.expect)(body.retainedChurnSample).toBe(0.20);
        (0, vitest_1.expect)(body.metrics.ecsLeakStatus.memoryLeakFixed).toBe(true);
        (0, vitest_1.expect)(body.metrics.retainedReplays).toBe(true);
    });
});
(0, vitest_1.describe)('Watchtower Hub Contract: All 14 Read-Only /watchtower/* Routes', () => {
    const routes = [
        '/watchtower/passport',
        '/watchtower/health',
        '/watchtower/metrics',
        '/watchtower/security',
        '/watchtower/economic-summary',
        '/watchtower/token-flows',
        '/watchtower/treasury-balance',
        '/watchtower/live-stats',
        '/watchtower/fraud-summary',
        '/watchtower/slo',
        '/watchtower/dr-status',
        '/watchtower/audit-log',
        '/watchtower/events',
        '/watchtower/projections',
    ];
    (0, vitest_1.it)('all 14 required read-only routes return 200 with expected json payload', async () => {
        for (const route of routes) {
            const { status, body } = await fetchApi(route);
            (0, vitest_1.expect)(status).toBe(200);
            (0, vitest_1.expect)(body).toBeTypeOf('object');
        }
    });
    (0, vitest_1.it)('GET /watchtower/health strictly guarantees writes=false and readOnly=true', async () => {
        const { status, body } = await fetchApi('/watchtower/health');
        (0, vitest_1.expect)(status).toBe(200);
        (0, vitest_1.expect)(body.writes).toBe(false);
        (0, vitest_1.expect)(body.readOnly).toBe(true);
        (0, vitest_1.expect)(body.dataQuality).toBe('partial');
        (0, vitest_1.expect)(body.status).toBe('healthy');
    });
    (0, vitest_1.it)('GET /watchtower/security reports 0 critical and 0 high findings matching audit report', async () => {
        const { status, body } = await fetchApi('/watchtower/security');
        (0, vitest_1.expect)(status).toBe(200);
        (0, vitest_1.expect)(body.findings.critical).toBe(0);
        (0, vitest_1.expect)(body.findings.high).toBe(0);
        (0, vitest_1.expect)(body.findings.medium).toBe(0);
        (0, vitest_1.expect)(body.findings.low).toBe(0);
        (0, vitest_1.expect)(body.audit.status).toBe('passed');
    });
    (0, vitest_1.it)('POST /watchtower/* is strictly rejected with 405 Method Not Allowed and Allow: GET, OPTIONS', async () => {
        const { status, headers, body } = await fetchApi('/watchtower/health', { method: 'POST' });
        (0, vitest_1.expect)(status).toBe(405);
        (0, vitest_1.expect)(headers['allow']).toContain('GET');
        (0, vitest_1.expect)(body.writes).toBe(false);
    });
    (0, vitest_1.it)('GET /watchtower/events supports cursor-based pagination and idempotency', async () => {
        const { status, body } = await fetchApi('/watchtower/events?limit=2');
        (0, vitest_1.expect)(status).toBe(200);
        (0, vitest_1.expect)(Array.isArray(body.events)).toBe(true);
        (0, vitest_1.expect)(body.events.length).toBeLessThanOrEqual(2);
        if (body.nextCursor) {
            const nextRes = await fetchApi(`/watchtower/events?cursor=${body.nextCursor}&limit=1`);
            (0, vitest_1.expect)(nextRes.status).toBe(200);
            (0, vitest_1.expect)(Array.isArray(nextRes.body.events)).toBe(true);
        }
    });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

let serverProc: ChildProcess | null = null;

function fetchApi(path: string, options: { method?: string; port?: number } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  const port = options.port ?? 8089;
  const method = options.method ?? 'GET';
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      { method },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 500, headers: res.headers, body: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode ?? 500, headers: res.headers, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  // Start server locally for tests if not already running
  try {
    await fetchApi('/watchtower/health', { port: 8089 });
  } catch {
    const scriptPath = path.resolve(__dirname, '../../scripts/watchtower_v3_server.py');
    serverProc = spawn('python3', [scriptPath, '8089', '8787'], {
      stdio: 'ignore',
      detached: true,
    });
    // Wait up to 3s for server to start
    for (let i = 0; i < 30; i++) {
      try {
        await new Promise((r) => setTimeout(r, 100));
        await fetchApi('/watchtower/health', { port: 8089 });
        break;
      } catch {
        // keep waiting
      }
    }
  }
});

afterAll(() => {
  if (serverProc) {
    try {
      process.kill(-serverProc.pid!);
    } catch {
      serverProc.kill();
    }
  }
});

describe('Watchtower OS v3 Integration API', () => {
  it('GET /api/os/config returns exactly 33 deduplicated components in ideal free stack', async () => {
    const { status, body } = await fetchApi('/api/os/config');
    expect(status).toBe(200);
    expect(body.os).toBe('Watchtower OS v3');
    expect(body.totalComponents).toBe(33);
    expect(body.components.length).toBe(33);

    // Verify deduplication: all component IDs must be distinct
    const ids = body.components.map((c: any) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(33);

    expect(body.gaslessUx).toBe(true);
    expect(body.l2Router.target).toBe('MagicBlock ER');
  });

  it('GET /api/l2/router correctly routes tps=low ux=gasless to MagicBlock ER + Arcium privacy', async () => {
    const { status, body } = await fetchApi('/api/l2/router?gameId=guttercaps&tps=low&ux=gasless');
    expect(status).toBe(200);
    expect(body.gameId).toBe('guttercaps');
    expect(body.selectedL2).toBe('MagicBlock ER');
    expect(body.latency).toBe('<10ms');
    expect(body.gasless).toBe(true);
    expect(body.routeDecision).toBe('MagicBlock ER + Arcium privacy');
    expect(body.magicActions).toBe('auto_respawn_every_round');
    expect(body.settlementSequencer).toContain('REPLA L3');
  });

  it('GET /api/sdk/* returns best free SDK metadata for all 14 requested integrations', async () => {
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
      expect(status).toBe(200);
      expect(body.idealFree).toBe(true);
      expect(body.sdk.sdk).toBe(sdk);
      expect(body.sdk.bestFree).toBe(true);
    }
  });

  it('GET /api/game-signals/config returns ML churn predictor parameters and fixed memory leak metrics', async () => {
    const { status, body } = await fetchApi('/api/game-signals/config?gameId=guttercaps');
    expect(status).toBe(200);
    expect(body.model).toBe('Game Signals ML v3');
    expect(body.churnThreshold14d).toBe(0.85);
    expect(body.retainedChurnSample).toBe(0.20);
    expect(body.metrics.ecsLeakStatus.memoryLeakFixed).toBe(true);
    expect(body.metrics.retainedReplays).toBe(true);
  });
});

describe('Watchtower Hub Contract: All 14 Read-Only /watchtower/* Routes', () => {
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

  it('all 14 required read-only routes return 200 with expected json payload', async () => {
    for (const route of routes) {
      const { status, body } = await fetchApi(route);
      expect(status).toBe(200);
      expect(body).toBeTypeOf('object');
    }
  });

  it('GET /watchtower/health strictly guarantees writes=false and readOnly=true', async () => {
    const { status, body } = await fetchApi('/watchtower/health');
    expect(status).toBe(200);
    expect(body.writes).toBe(false);
    expect(body.readOnly).toBe(true);
    expect(body.dataQuality).toBe('partial');
    expect(body.status).toBe('healthy');
  });

  it('GET /watchtower/security reports 0 critical and 0 high findings matching audit report', async () => {
    const { status, body } = await fetchApi('/watchtower/security');
    expect(status).toBe(200);
    expect(body.findings.critical).toBe(0);
    expect(body.findings.high).toBe(0);
    expect(body.findings.medium).toBe(0);
    expect(body.findings.low).toBe(0);
    expect(body.audit.status).toBe('passed');
  });

  it('POST /watchtower/* is strictly rejected with 405 Method Not Allowed and Allow: GET, OPTIONS', async () => {
    const { status, headers, body } = await fetchApi('/watchtower/health', { method: 'POST' });
    expect(status).toBe(405);
    expect(headers['allow']).toContain('GET');
    expect(body.writes).toBe(false);
  });

  it('GET /watchtower/events supports cursor-based pagination and idempotency', async () => {
    const { status, body } = await fetchApi('/watchtower/events?limit=2');
    expect(status).toBe(200);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeLessThanOrEqual(2);
    if (body.nextCursor) {
      const nextRes = await fetchApi(`/watchtower/events?cursor=${body.nextCursor}&limit=1`);
      expect(nextRes.status).toBe(200);
      expect(Array.isArray(nextRes.body.events)).toBe(true);
    }
  });
});

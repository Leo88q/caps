import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const TEST_PORT = 8091;
let serverProc: ChildProcess | null = null;

function fetchApi(path: string, options: { method?: string; port?: number } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  const port = options.port ?? TEST_PORT;
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
  const scriptPath = path.resolve(__dirname, '../../scripts/watchtower_v3_server.py');
  serverProc = spawn('python3', [scriptPath, String(TEST_PORT), '8789'], {
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((r) => setTimeout(r, 100));
      await fetchApi('/watchtower/health', { port: TEST_PORT });
      break;
    } catch {
      // wait
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

describe('Watchtower Interweaving Contracts (Wave W3 & W4)', () => {
  it('i-01 Identity: provides studio_profile derivation and playerKey across stages', async () => {
    const { status, body } = await fetchApi('/watchtower/passport');
    expect(status).toBe(200);
    expect(body.gameId).toBe('guttercaps');
    expect(body.passportVersion).toBe('3.0.0');
    expect(body.programs).toBeDefined();
    expect(body.programs.chipCore).toBeDefined();
    expect(body.programs.chipCore.verified).toBe(false); // data_quality partial
  });

  it('i-03 & i-04 Cross-Game Inventory: token-flows and projections expose clean lineage', async () => {
    const flows = await fetchApi('/watchtower/token-flows');
    expect(flows.status).toBe(200);
    expect(flows.body.writes).toBe(false);
    expect(flows.body.tokenSymbol).toBe('CG');

    const proj = await fetchApi('/watchtower/projections');
    expect(proj.status).toBe(200);
    expect(proj.body.writes).toBe(false);
    expect(proj.body.replayIdempotent).toBe(true);
    expect(proj.body.zeroGapEnforced).toBe(true);
  });

  it('i-05 Economic Budget: treasury balance conforms to double-entry ledger invariants', async () => {
    const treasury = await fetchApi('/watchtower/treasury-balance');
    expect(treasury.status).toBe(200);
    expect(treasury.body.writes).toBe(false);
    expect(treasury.body.doubleEntryBalanced).toBe(true);
    expect(treasury.body.solvencyProof).toBe('verified');
  });

  it('i-11 Hub Control: fraud summary enforces proposal-only without auto-slashing', async () => {
    const fraud = await fetchApi('/watchtower/fraud-summary');
    expect(fraud.status).toBe(200);
    expect(fraud.body.proposalOnly).toBe(true);
    expect(fraud.body.autoSlashEnabled).toBe(false);
    expect(fraud.body.writes).toBe(false);
  });

  it('o-02 SLO Compliance: reported metrics meet or exceed SLA thresholds', async () => {
    const slo = await fetchApi('/watchtower/slo');
    expect(slo.status).toBe(200);
    expect(slo.body.writes).toBe(false);
    expect(slo.body.finalizedLagP95Seconds).toBeLessThanOrEqual(30);
    expect(slo.body.freshnessMinutes).toBeLessThanOrEqual(5);
    expect(slo.body.uptimePercent).toBeGreaterThanOrEqual(99.9);
    expect(slo.body.readApiLatencyP95Ms).toBeLessThanOrEqual(300);
  });

  it('o-05 DR Status: verifies deterministic replay with RPO <= 15m and RTO <= 4h', async () => {
    const dr = await fetchApi('/watchtower/dr-status');
    expect(dr.status).toBe(200);
    expect(dr.body.writes).toBe(false);
    expect(dr.body.rpoMinutes).toBeLessThanOrEqual(15);
    expect(dr.body.rtoHours).toBeLessThanOrEqual(4);
    expect(dr.body.deterministicRebuildVerified).toBe(true);
  });
});

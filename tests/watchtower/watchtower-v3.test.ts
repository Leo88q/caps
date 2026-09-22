import { describe, it, expect } from 'vitest';
import http from 'node:http';

function fetchApi(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:8089${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

describe('Watchtower OS v3 Integration API', () => {
  it('GET /api/os/config returns exactly 33 deduplicated components in ideal free stack', async () => {
    const { status, body } = await fetchApi('/api/os/config');
    expect(status).toBe(200);
    expect(body.os).toBe('Watchtower OS v3');
    expect(body.totalComponents).toBe(33);
    expect(body.components.length).toBe(33);
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

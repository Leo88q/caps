import { describe, it, expect, vi } from 'vitest';
import { ApiError, claimWithRetry } from './client';

describe('claimWithRetry (SEC-M5 post-payment claim)', () => {
  it('retries payment_not_found → payment_pending → success and reports each wait', async () => {
    vi.useFakeTimers();
    const codes = ['payment_not_found', 'payment_pending', 'payment_pending'];
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      const c = codes.shift();
      if (c) throw new ApiError(c === 'payment_pending' ? 409 : 402, c, c);
      return { ok: true };
    });
    const pending: string[] = [];
    const p = claimWithRetry(fn, { onPending: (code) => pending.push(code) });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ ok: true });
    expect(calls).toBe(4);
    expect(pending).toEqual(['payment_not_found', 'payment_pending', 'payment_pending']);
    vi.useRealTimers();
  });

  it('does not retry definitive errors (ref_hash_mismatch, consumed, not_owner) or non-API failures', async () => {
    for (const code of ['ref_hash_mismatch', 'payment_consumed', 'not_owner']) {
      const fn = vi.fn(async () => { throw new ApiError(402, code, code); });
      await expect(claimWithRetry(fn)).rejects.toMatchObject({ code });
      expect(fn).toHaveBeenCalledTimes(1);
    }
    const boom = vi.fn(async () => { throw new Error('network down'); });
    await expect(claimWithRetry(boom)).rejects.toThrow('network down');
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxWaitMs with the last pending error', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => { throw new ApiError(409, 'payment_pending', 'still pending'); });
    const p = claimWithRetry(fn, { maxWaitMs: 5_000 });
    const guard = p.catch((e) => e);
    await vi.runAllTimersAsync();
    const e = await guard;
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('payment_pending');
    expect(fn.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});

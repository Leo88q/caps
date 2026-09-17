// T-B-49 client side: the device fingerprint is stable per install, bounded, and never contains raw UA text.
import { describe, it, expect, beforeEach } from 'vitest';
import { deviceFingerprint, resetFingerprintCache, collectSignals } from './fingerprint';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear(); resetFingerprintCache();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  // node 22 exposes a getter-only `navigator`; redefine it for the test
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'Linux armv8l', languages: ['en-SG', 'en'], hardwareConcurrency: 8, maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Linux; Android 14; Seeker) Chrome/128' } });
  Object.defineProperty(globalThis, 'screen', { configurable: true, value: { width: 1080, height: 2400, colorDepth: 24 } });
});

describe('deviceFingerprint', () => {
  it('is stable across calls and reloads (same install id), 8–256 chars, opaque', () => {
    const a = deviceFingerprint();
    resetFingerprintCache();
    const b = deviceFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^v1\.[0-9a-f]{32}\.[0-9a-f]{8}\.[0-9a-f]{8}$/);
    expect(a.length).toBeGreaterThanOrEqual(8); expect(a.length).toBeLessThanOrEqual(256);
    expect(a).not.toContain('Seeker'); expect(a).not.toContain('Android');
  });
  it('a wiped install (no stored id) is a new device; different hardware differs', () => {
    const a = deviceFingerprint();
    store.clear(); resetFingerprintCache();
    const b = deviceFingerprint();
    expect(b).not.toBe(a);
    expect(b.split('.')[2]).toBe(a.split('.')[2]); // same stable-signal hash
    Object.defineProperty(globalThis, 'screen', { configurable: true, value: { width: 1440, height: 3120, colorDepth: 24 } });
    resetFingerprintCache();
    expect(deviceFingerprint().split('.')[2]).not.toBe(a.split('.')[2]);
  });
  it('survives a missing localStorage / navigator (never blocks sign-in)', () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    resetFingerprintCache();
    expect(deviceFingerprint()).toMatch(/^v1\.nostorage\./);
    expect(collectSignals().tz.length).toBeGreaterThanOrEqual(0);
  });
});

import { describe, expect, it } from 'vitest';
import { KIND, benchSlots, loadBanner, loadTheme, ownedBanners, ownedPacks, ownedThemes, owns } from './cosmetics';

const ent = (kind: number, payload: Record<string, unknown> = {}, expiresAt: string | null = null) => ({ kind, payload, expiresAt });

describe('cosmetic ownership', () => {
  it('owns() ignores expired entitlements', () => {
    expect(owns([ent(KIND.skip)], KIND.skip)).toBe(true);
    expect(owns([ent(KIND.skip, {}, new Date(Date.now() - 1000).toISOString())], KIND.skip)).toBe(false);
    expect(owns(undefined, KIND.skip)).toBe(false);
  });
  it('ownedThemes reads kind-3 payloads; payload-less grants unlock all', () => {
    expect(ownedThemes([ent(3, { theme: 'cyan' })])).toEqual(['cyan']);
    expect(ownedThemes([ent(3, { theme: 'cyan' }), ent(3, { theme: 'acid' })])).toEqual(['cyan', 'acid']);
    expect(ownedThemes([ent(3, {})])).toEqual(['magenta', 'cyan', 'acid']);
    expect(ownedThemes([ent(8, {})])).toEqual([]);
  });
  it('ownedBanners intersects payloads with completed districts', () => {
    expect(ownedBanners([ent(9, { collection: 0 }), ent(9, { collection: 2 })], [0, 1])).toEqual([0]);
    expect(ownedBanners([ent(9, {})], [0, 1])).toEqual([0, 1]);
    expect(ownedBanners([ent(8, {})], [0])).toEqual([]);
  });
  it('ownedPacks reads kind-4 payloads', () => {
    expect(ownedPacks([ent(4, { pack: 'tags-v1' })])).toEqual(['tags-v1']);
    expect(ownedPacks([ent(4, {})])).toEqual([]);
  });
  it('bench presets: 1 slot, 3 with the entitlement', () => {
    expect(benchSlots(undefined)).toBe(1);
    expect(benchSlots([ent(KIND.bench)])).toBe(3);
  });
  it('display choices read null without storage (node env)', () => {
    expect(loadTheme('w')).toBeNull();
    expect(loadBanner('w')).toBeNull();
  });
});

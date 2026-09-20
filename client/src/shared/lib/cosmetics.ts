// Client-side cosmetics state (v1).
//
// Display-time selection: what the player owns comes from `/me/services`
// entitlements; WHICH variant shows (banner district, theme, preset) is a
// per-wallet localStorage choice — no purchase-flow changes needed.
import { SERVICE_BY_ID } from '@guttercaps/economy';

export const KIND = {
  skin: SERVICE_BY_ID.capSkin.kind,
  theme: SERVICE_BY_ID.profileTheme.kind,
  emotes: SERVICE_BY_ID.arenaEmotePack.kind,
  bench: SERVICE_BY_ID.extraBenchSlots.kind,
  pass: SERVICE_BY_ID.seasonPass.kind,
  skip: SERVICE_BY_ID.packSkipAnim.kind,
  banner: SERVICE_BY_ID.districtBanner.kind,
} as const;

export const owns = (entitlements: { kind?: number }[] | undefined, kind: number) =>
  (entitlements ?? []).some((e) => e.kind === kind);

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* private mode: cosmetics just don't persist */ }
};

/** Fusion bench presets: base 1 slot, +2 with the extraBenchSlots entitlement. */
export interface FusionPreset {
  name: string;
  slots: [string | null, string | null, string | null];
  resultCol: number | null;
}
const presetKey = (wallet: string) => `gc.fusion.presets.${wallet}`;
export function loadPresets(wallet: string): FusionPreset[] {
  try {
    const v: unknown = JSON.parse(read(presetKey(wallet)) ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is FusionPreset => !!p && Array.isArray((p as FusionPreset).slots) && (p as FusionPreset).slots.length === 3).slice(0, 3);
  } catch { return []; }
}
export function savePresets(wallet: string, presets: FusionPreset[]) {
  write(presetKey(wallet), JSON.stringify(presets.slice(0, 3)));
}

/** District banner: a COMPLETED district (9/9) the profile shows off, animated. */
const bannerKey = (wallet: string) => `gc.profile.banner.${wallet}`;
export function loadBanner(wallet: string): number | null {
  const v = Number(read(bannerKey(wallet)));
  return Number.isInteger(v) && v >= 0 ? v : null;
}
export function saveBanner(wallet: string, collectionIdx: number | null) {
  if (collectionIdx === null) { try { localStorage.removeItem(bannerKey(wallet)); } catch { /* ignore */ } } else write(bannerKey(wallet), String(collectionIdx));
}

/** Profile themes: wall lamp colour set (v1: accent + banner frame). */
export interface ProfileTheme { id: string; name: string; lamp: string }
export const PROFILE_THEMES: ProfileTheme[] = [
  { id: 'magenta', name: 'Neon Magenta', lamp: '#FF2E8A' },
  { id: 'cyan', name: 'Drain Cyan', lamp: '#16E5D9' },
  { id: 'acid', name: 'Acid Yard', lamp: '#B6FF3C' },
];
const themeKey = (wallet: string) => `gc.profile.theme.${wallet}`;
export function loadTheme(wallet: string): string {
  const v = read(themeKey(wallet));
  return PROFILE_THEMES.some((t) => t.id === v) ? v! : PROFILE_THEMES[0].id;
}
export function saveTheme(wallet: string, id: string) { write(themeKey(wallet), id); }
export const themeById = (id: string) => PROFILE_THEMES.find((t) => t.id === id) ?? PROFILE_THEMES[0];

// Cosmetic ownership + display-choice helpers. Variants are bound at PURCHASE
// time (the payload hashed into ref_hash): what you own is read from
// entitlement payloads, and the wallet only chooses which owned variant to
// display (persisted per wallet in localStorage).
import { PROFILE_THEMES as ECONOMY_THEMES } from '@guttercaps/economy';

/** economy service kinds for the cosmetic/convenience entitlements. */
export const KIND = { skin: 2, theme: 3, emotePack: 4, bench: 5, pass: 6, skip: 8, banner: 9 } as const;

export interface EntitlementLike { kind?: number; payload?: Record<string, unknown> | null; expiresAt?: string | null }

export function owns(ents: EntitlementLike[] | undefined, kind: number): boolean {
  return (ents ?? []).some((e) => e.kind === kind && (e.expiresAt === null || e.expiresAt === undefined || new Date(e.expiresAt).getTime() > Date.now()));
}

/** Owned theme ids (kind-3 payloads). A payload-less grant (early buyers) unlocks every theme. */
export function ownedThemes(ents: EntitlementLike[] | undefined): string[] {
  const list = (ents ?? []).filter((e) => e.kind === KIND.theme);
  if (list.length === 0) return [];
  const ids = list.map((e) => (e.payload as { theme?: unknown } | null | undefined)?.theme).filter((x): x is string => typeof x === 'string');
  if (ids.length < list.length) return ECONOMY_THEMES.map((t) => t.id);
  return [...new Set(ids)];
}

/** Owned banner districts (kind-9 payloads). Payload-less grants fall back to every completed district. */
export function ownedBanners(ents: EntitlementLike[] | undefined, completed: number[]): number[] {
  const list = (ents ?? []).filter((e) => e.kind === KIND.banner);
  if (list.length === 0) return [];
  const ids = list.map((e) => (e.payload as { collection?: unknown } | null | undefined)?.collection).filter((x): x is number => typeof x === 'number');
  if (ids.length < list.length) return completed;
  return [...new Set(ids)].filter((c) => completed.includes(c));
}

/** Owned emote-pack ids (kind-4 payloads). Payload-less grants unlock nothing (packs are always named at claim). */
export function ownedPacks(ents: EntitlementLike[] | undefined): string[] {
  return [...new Set((ents ?? []).filter((e) => e.kind === KIND.emotePack).map((e) => (e.payload as { pack?: unknown } | null | undefined)?.pack).filter((x): x is string => typeof x === 'string'))];
}

export interface ProfileTheme { id: string; label: string; desc: string; hex: string }
export const PROFILE_THEMES: ProfileTheme[] = ECONOMY_THEMES.map((t) => ({ id: t.id, label: t.name, desc: t.blurb, hex: t.hex }));
export function themeById(id: string | null | undefined): ProfileTheme {
  return PROFILE_THEMES.find((t) => t.id === id) ?? PROFILE_THEMES[0];
}

// ------------------------------------------------------- display choices
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch { /* private mode */ }
}
function remove(key: string) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

export function loadTheme(wallet: string | undefined): string | null {
  return wallet ? read(`caps.theme.${wallet}`) : null;
}
export function saveTheme(wallet: string | undefined, id: string) {
  if (wallet) write(`caps.theme.${wallet}`, id);
}
export function loadBanner(wallet: string | undefined): number | null {
  if (!wallet) return null;
  const v = read(`caps.banner.${wallet}`);
  return v === null ? null : Number(v);
}
export function saveBanner(wallet: string | undefined, collection: number | null) {
  if (!wallet) return;
  if (collection === null) remove(`caps.banner.${wallet}`);
  else write(`caps.banner.${wallet}`, String(collection));
}

// ------------------------------------------------------- fusion bench presets
export interface FusionPreset { name: string; slots: (string | null)[]; resultCol: number | null; savedAt: number }
export function benchSlots(ents: EntitlementLike[] | undefined): number {
  return owns(ents, KIND.bench) ? 3 : 1;
}
export function loadPresets(wallet: string | undefined): FusionPreset[] {
  if (!wallet) return [];
  try {
    const raw = localStorage.getItem(`caps.presets.${wallet}`);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p) => p && Array.isArray(p.slots)) : [];
  } catch { return []; }
}
export function savePresets(wallet: string | undefined, presets: FusionPreset[]) {
  if (wallet) write(`caps.presets.${wallet}`, JSON.stringify(presets));
}
export function deletePreset(wallet: string | undefined, name: string) {
  if (wallet) savePresets(wallet, loadPresets(wallet).filter((p) => p.name !== name));
}

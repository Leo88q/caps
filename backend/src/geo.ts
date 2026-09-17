// =============================================================================
// Legal gating: the shop is a lootbox, and lootboxes are regulated (docs/09 §5.2).
// -----------------------------------------------------------------------------
// Three decisions, all deliberate:
//
//  * The gate blocks the PURCHASE, not the game. Collection, market, staking, arena and every read
//    endpoint keep working; only the pack flow answers 403. That is the shape the BE/NL rules actually
//    describe (a paid randomised item), and it is the difference between "not available here" and
//    "the product is broken for you".
//  * `GEO_GATE=off` is the default. An unreviewed legal posture must not become an outage: the flag
//    exists so the gate can be built, tested and demoed before counsel signs off, and flipping it is
//    an explicit deployment decision (the client's own `VITE_FLAG_GEO_GATE` stays independent — UI
//    copy without an enforced server answer is decoration, so the server flag is the one that matters).
//  * A country is read from ONE header, set by the edge, and only when the operator says the edge is
//    trusted. `cf-ipcountry` is a request header like any other: if `npm run backend:start` exposes
//    8787 directly, "restricted" is whatever the buyer typed. `ops/deploy/nginx.conf` overwrites
//    `X-Geo-Country` from `$http_cf_ipcountry`, so inside the compose topology the value cannot be
//    forged; outside it, `GEO_TRUST_HEADER` stays unset and the gate reports "unknown" instead of
//    pretending. Same shape as `TRUST_REQUEST_ID` in log.ts.
// =============================================================================
import type { IncomingHttpHeaders } from 'node:http';

export type GeoMode = 'off' | 'shop';
export type GeoSource = 'header' | 'absent' | 'untrusted' | 'invalid' | 'gate-off';

export interface GeoOptions {
  mode: GeoMode;
  /** ISO-3166 alpha-2 codes, upper case. */
  restricted: Set<string>;
  header: string;
  /** true only when the request came through an edge that sets `header` itself. */
  trusted: boolean;
  /** What an unknown country means: 'block' is the strict reading of "we must not sell here". */
  unknown: 'allow' | 'block';
}

export interface GeoView {
  mode: GeoMode;
  country: string | null;
  restricted: boolean;
  source: GeoSource;
}

export const GEO_DEFAULT_COUNTRIES = 'BE,NL';

/** Env at call time (a process-wide singleton would make the gate untestable per-case). */
export function geoOptions(): GeoOptions {
  const raw = (process.env.GEO_GATE ?? 'off').trim().toLowerCase();
  const mode: GeoMode = raw === 'shop' ? 'shop' : 'off';
  const list = (process.env.GEO_RESTRICT_COUNTRIES ?? (mode === 'off' ? '' : GEO_DEFAULT_COUNTRIES))
    .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
  return {
    mode,
    restricted: new Set(list),
    header: (process.env.GEO_COUNTRY_HEADER ?? 'x-geo-country').trim().toLowerCase(),
    trusted: process.env.GEO_TRUST_HEADER === '1',
    unknown: process.env.GEO_UNKNOWN === 'block' ? 'block' : 'allow',
  };
}

const UNKNOWN = (o: GeoOptions): Pick<GeoView, 'restricted'> => ({ restricted: o.unknown === 'block' });

/** Only `/me` (for the UI copy) and `/packs/quote` (the actual block) pay for this: 5 string ops. */
export function geoOf(headers: IncomingHttpHeaders | Record<string, unknown>, o: GeoOptions = geoOptions()): GeoView {
  if (o.mode === 'off') return { mode: 'off', country: null, restricted: false, source: 'gate-off' };
  if (!o.trusted) return { mode: o.mode, country: null, restricted: false, source: 'untrusted' };
  const raw = headers[o.header];
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  if (!value) return { mode: o.mode, country: null, source: 'absent', ...UNKNOWN(o) };
  const country = String(value).trim().toUpperCase();
  // A header like `BE, NL` (a chain of proxies) or `unknown` is not a country. Reporting it as "US"
  // would be worse than reporting nothing, so it is invalid and follows the `unknown` policy.
  if (!/^[A-Z]{2}$/.test(country)) return { mode: o.mode, country: null, source: 'invalid', ...UNKNOWN(o) };
  return { mode: o.mode, country, restricted: o.restricted.has(country), source: 'header' };
}

/** For `assertProductionConfig`: a gate that is on but untrusted sells to nobody and blocks nobody. */
export function geoMisconfiguration(): string | null {
  const o = geoOptions();
  if (o.mode === 'off') return null;
  if (!o.trusted) return 'GEO_GATE is on but GEO_TRUST_HEADER≠1 — every buyer looks like an unknown country, so the gate does nothing but log';
  if (o.restricted.size === 0) return 'GEO_GATE is on with an empty GEO_RESTRICT_COUNTRIES — the gate can never fire';
  return null;
}

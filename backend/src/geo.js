"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GEO_DEFAULT_COUNTRIES = void 0;
exports.geoOptions = geoOptions;
exports.geoOf = geoOf;
exports.geoMisconfiguration = geoMisconfiguration;
exports.GEO_DEFAULT_COUNTRIES = 'BE,NL';
/** Env at call time (a process-wide singleton would make the gate untestable per-case). */
function geoOptions() {
    const raw = (process.env.GEO_GATE ?? 'off').trim().toLowerCase();
    const mode = raw === 'shop' ? 'shop' : 'off';
    const list = (process.env.GEO_RESTRICT_COUNTRIES ?? (mode === 'off' ? '' : exports.GEO_DEFAULT_COUNTRIES))
        .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
    return {
        mode,
        restricted: new Set(list),
        header: (process.env.GEO_COUNTRY_HEADER ?? 'x-geo-country').trim().toLowerCase(),
        trusted: process.env.GEO_TRUST_HEADER === '1',
        unknown: process.env.GEO_UNKNOWN === 'block' ? 'block' : 'allow',
    };
}
const UNKNOWN = (o) => ({ restricted: o.unknown === 'block' });
/** Only `/me` (for the UI copy) and `/packs/quote` (the actual block) pay for this: 5 string ops. */
function geoOf(headers, o = geoOptions()) {
    if (o.mode === 'off')
        return { mode: 'off', country: null, restricted: false, source: 'gate-off' };
    if (!o.trusted)
        return { mode: o.mode, country: null, restricted: false, source: 'untrusted' };
    const raw = headers[o.header];
    const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
    if (!value)
        return { mode: o.mode, country: null, source: 'absent', ...UNKNOWN(o) };
    const country = String(value).trim().toUpperCase();
    // A header like `BE, NL` (a chain of proxies) or `unknown` is not a country. Reporting it as "US"
    // would be worse than reporting nothing, so it is invalid and follows the `unknown` policy.
    if (!/^[A-Z]{2}$/.test(country))
        return { mode: o.mode, country: null, source: 'invalid', ...UNKNOWN(o) };
    return { mode: o.mode, country, restricted: o.restricted.has(country), source: 'header' };
}
/** For `assertProductionConfig`: a gate that is on but untrusted sells to nobody and blocks nobody. */
function geoMisconfiguration() {
    const o = geoOptions();
    if (o.mode === 'off')
        return null;
    if (!o.trusted)
        return 'GEO_GATE is on but GEO_TRUST_HEADER≠1 — every buyer looks like an unknown country, so the gate does nothing but log';
    if (o.restricted.size === 0)
        return 'GEO_GATE is on with an empty GEO_RESTRICT_COUNTRIES — the gate can never fire';
    return null;
}

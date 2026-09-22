// Global test setup — loaded by `test.setupFiles` in vite.config.ts.
//
// Both things pinned here are *host-machine leaks*: the suite passed on an
// en-US CI box and failed on a ru-RU laptop, which is the worst kind of
// failure because the diff is empty. Neither belongs in an individual test.

// ---------------------------------------------------------------- locale
// i18n boots from `navigator.languages` on first visit (shared/i18n:detectLocale),
// and the UI assertions are written against the EN bundle ("Pack shop", "Human
// check", "1 cap voucher", …). On a machine whose OS language is not English the
// whole app renders translated and every getByText(/…/) misses — the DOM dump
// shows "Главная / Фишки / Паки / Маркет" instead of the English nav.
//
// Tests that exercise translation (smoke.test.tsx switches to ru and back) call
// setLocale() explicitly, which overrides this — so pinning the *detected*
// default costs nothing and makes the suite machine-independent.
const nav = globalThis.navigator as (Navigator & { languages?: readonly string[] }) | undefined;
if (nav) {
  try { Object.defineProperty(nav, 'languages', { value: ['en-US', 'en'], configurable: true }); } catch { /* frozen navigator: nothing to do */ }
  try { Object.defineProperty(nav, 'language', { value: 'en-US', configurable: true }); } catch { /* idem */ }
}

// ---------------------------------------------------------------- storage
// happy-dom exposes localStorage/sessionStorage, but not in every version and
// not on every environment the files opt into via `@vitest-environment`. The
// legal suite calls `window.localStorage.clear()` in a beforeEach, so a missing
// implementation is a TypeError at collection time rather than a test failure.
// A tiny in-memory Storage keeps the semantics the code under test relies on
// (getItem/setItem/removeItem/clear + string coercion).
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(String(k), String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  } as Storage;
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  let usable = false;
  try {
    const s = (globalThis as unknown as Record<string, Storage | undefined>)[name];
    usable = !!s && typeof s.getItem === 'function' && typeof s.clear === 'function';
  } catch { usable = false; }
  if (!usable) {
    const store = memoryStorage();
    Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true });
    if (typeof window !== 'undefined' && window !== (globalThis as unknown as Window)) {
      Object.defineProperty(window, name, { value: store, configurable: true, writable: true });
    }
  }
}

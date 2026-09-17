// Lighthouse CI for the built client (docs/06 §1.3: TTI ≤ 3.5 s on a Seeker/Pixel-6-class device over 4G;
// critical path ≤ 350 KB gzip).
//
// Which of those two numbers this file may gate on, and which it may not, is not a style preference:
//   * sizes are deterministic — the same bundle scores the same bytes on any machine, so `error` is
//     honest here, and it is the same budget `scripts/bundle-check.ts` measures from dist/index.html
//     (belt and braces: one counts the files, the other counts what an emulated 4G link makes of them);
//   * TTI/LCP on a shared CI runner are not. Lighthouse's simulated throttling is a *model* of a mid-range
//     phone; the acceptance target is a p75 across real devices on real 4G. Asserting that in CI produces a
//     red check nobody can act on, and a red check nobody can act on gets disabled inside a month — so
//     these are `warn`, and the gate stays where it belongs: the staging measurement in docs/06 §4.
const PORT = Number(process.env.LHCI_PORT ?? 4173);
const BASE = `http://127.0.0.1:${PORT}`;

module.exports = {
  ci: {
    collect: {
      // The mock build (VITE_API_MOCK=1) so the run needs no backend and no chain: what is being measured
      // is the shell — the entry graph, the CSS, the router, the fonts. Data-dependent screens are
      // measured on staging. `client/dist` must exist (npm run e2e:build produces it).
      startServerCommand: `npm --prefix client run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
      startServerReadyPattern: 'Local',
      url: [
        `${BASE}/`,
        `${BASE}/shop`,
        `${BASE}/market`,
        `${BASE}/collection`,
        `${BASE}/legal/terms`,
      ],
      numberOfRuns: 3,
      settings: {
        // Mobile + the slow-4G model is the closest CI gets to the stated device class.
        formFactor: 'mobile',
        screenEmulation: { mobile: true, width: 412, height: 915, deviceScaleFactor: 2.625, disabled: false },
        throttlingMethod: 'simulate',
        throttling: {
          rttMs: 150, throughputKbps: 1600, cpuSlowdownMultiplier: 4,
          requestLatencyMs: 150, downloadThroughputKbps: 1600, uploadThroughputKbps: 750,
        },
        // The app is served with a strict CSP in production (ops/deploy/nginx.conf) and without it here;
        // the flags that differ under a preview server must not be reported as product failures.
        disableStorageReset: false,
      },
    },
    assert: {
      assertions: {
        'resource-summary:script:size': ['error', { maxNumericValue: 360_000 }],
        'total-byte-weight': ['error', { maxNumericValue: 900_000 }],
        'render-blocking-resources': ['error', { maxLengthItem: 0 }],
        'unused-css-rules': 'warn',
        'uses-text-compression': 'error',
        'uses-responsive-images': 'warn',
        'modern-image-formats': 'warn',
        'font-display': 'error',
        'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
        interactive: ['warn', { maxNumericValue: 3500 }],
        'first-contentful-paint': ['warn', { maxNumericValue: 1800 }],
        'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
        'accessibility': ['warn', { minScore: 0.9 }],
        'best-practices': ['warn', { minScore: 0.9 }],
        'errors-in-console': 'off',
      },
    },
    upload: {
      // `temporary-public-storage` uploads the report to a Google bucket that is public for a week. For a
      // pre-launch product with unannounced numbers, write it to the workspace instead and let CI keep it
      // as an artifact.
      target: 'filesystem',
      outputDir: 'test-results/lighthouse',
    },
  },
};

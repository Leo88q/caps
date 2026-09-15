// Runner for the localnet suite (`npm test`). Same aliases as client/vite.config.ts so the specs
// import the REAL client builders (`@/chain/*`) and the economy package; VITE_CLUSTER=localnet makes
// `SWITCHBOARD_ON_DEMAND_ID` resolve to programs/sb_mock.
//
//   npm test                          → LiteSVM in-process (needs target/deploy/*.so + fixtures/mpl_core.so)
//   LOCALNET_RPC=http://127.0.0.1:8899 npm test → same specs against a running validator (anchor test)
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../client/src', import.meta.url)),
      '@guttercaps/economy': fileURLToPath(new URL('../../packages/economy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/localnet/**/*.spec.ts'],
    environment: 'node',
    env: { VITE_CLUSTER: 'localnet' },
    // one environment per worker: spec files run one after another and share the booted chain (helpers/env.ts)
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 600_000,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'target/localnet-junit.xml' },
  },
});

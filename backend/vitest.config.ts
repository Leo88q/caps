import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@guttercaps/economy': path.resolve(__dirname, '../packages/economy/src/index.ts') } },
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 20_000 },
});

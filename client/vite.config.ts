import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The client is served from the same origin as the API in production
// (nginx: `/v1 → backend`, everything else → this SPA). In dev, Vite proxies
// `/v1` and `/ws` to the local backend so the browser never talks to
// localhost:8787 directly — that also makes tunnelled / preview hosts work.
const API_TARGET = process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@guttercaps/economy': fileURLToPath(new URL('../packages/economy/src/index.ts', import.meta.url)),
      // Node built-ins pulled in by @switchboard-xyz/* — tiny browser shims (see src/shims)
      https: fileURLToPath(new URL('./src/shims/node-https.ts', import.meta.url)),
      crypto: fileURLToPath(new URL('./src/shims/node-crypto.ts', import.meta.url)),
      util: fileURLToPath(new URL('./src/shims/node-util.ts', import.meta.url)),
    },
  },
  define: {
    // Solana web3.js / Anchor / Switchboard expect Node globals in the browser.
    global: 'globalThis',
    'process.env': {},
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
    include: ['buffer'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          solana: ['@solana/web3.js', '@solana/spl-token'],
          wallet: ['@solana/wallet-adapter-react', '@solana/wallet-adapter-react-ui', '@solana/wallet-adapter-base'],
          switchboard: ['@switchboard-xyz/on-demand'],
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query', 'zustand'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Preview / tunnel hosts (e2b, ngrok, Seeker on-device debugging over adb reverse) are allowed.
    allowedHosts: true,
    proxy: {
      '/v1': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});

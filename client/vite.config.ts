import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    // Solana web3.js expects Buffer/process to exist in the browser.
    global: 'globalThis',
  },
});

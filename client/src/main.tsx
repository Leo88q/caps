import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './theme.css';

// Registers Mobile Wallet Adapter as a standard wallet-standard wallet.
// This is what makes MWA show up in the same WalletMultiButton picker as
// Phantom/Solflare/etc — both inside the Android webshell wrapper (see
// README "Мобильная упаковка") and in plain mobile Chrome. Must run once,
// outside any component, and only in a browser context (never during SSR —
// not a concern for this Vite SPA, but worth remembering if this ever
// moves to a framework with SSR).
import {
  registerMwa,
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
} from '@solana-mobile/wallet-standard-mobile';

registerMwa({
  appIdentity: {
    name: 'Chip Game',
    uri: window.location.origin,
    // Resolves relative to `uri` above — replace with the real icon once
    // one exists; referenced from client/public/icon-512.png (see
    // client/public/manifest.json).
    icon: 'icon-512.png',
  },
  authorizationCache: createDefaultAuthorizationCache(),
  chains: ['solana:devnet', 'solana:mainnet'],
  chainSelector: createDefaultChainSelector(),
  onWalletNotFound: createDefaultWalletNotFoundHandler(),
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

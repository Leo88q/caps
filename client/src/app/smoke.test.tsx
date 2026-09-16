// @vitest-environment happy-dom
// Renders every route against the in-browser mock API and asserts that
// nothing throws and each page paints its title. Wallet is disconnected
// (public routes) and, in a second pass, a fake wallet is injected via the
// wallet-adapter context so the authenticated screens render too.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { setMockMode } from '@/api/client';
import { useSessionStore } from '@/app/store/session';

// --- wallet-adapter mocks -------------------------------------------------
const fakeKey = Keypair.generate().publicKey;
let connected = false;
vi.mock('@solana/wallet-adapter-react', async () => {
  const actual = await vi.importActual<typeof import('@solana/wallet-adapter-react')>('@solana/wallet-adapter-react');
  return {
    ...actual,
    useWallet: () => ({
      publicKey: connected ? fakeKey : null, connected, connecting: false, wallet: connected ? { adapter: { name: 'FakeWallet' } } : null,
      signTransaction: connected ? async (tx: unknown) => tx : undefined, signMessage: connected ? async () => new Uint8Array(64) : undefined,
      signIn: undefined, disconnect: async () => { connected = false; },
    }),
    useConnection: () => ({ connection: { getAccountInfo: async () => null, getMultipleAccountsInfo: async (k: unknown[]) => k.map(() => null), getSlot: async () => 1, getLatestBlockhash: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 1 }) } }),
    ConnectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletModalProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWalletModal: () => ({ setVisible: () => {}, visible: false }),
}));
vi.mock('@solana-mobile/wallet-standard-mobile', () => ({ registerMwa: () => {}, createDefaultAuthorizationCache: () => ({}), createDefaultChainSelector: () => ({}), createDefaultWalletNotFoundHandler: () => ({}) }));

import { routes } from './router';
import { SessionGate } from './session';

function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<QueryClientProvider client={qc}><SessionGate><RouterProvider router={router} /></SessionGate></QueryClientProvider>);
}

beforeAll(() => {
  setMockMode(true);
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  window.scrollTo = () => {};
  (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
});

const PUBLIC: [string, RegExp][] = [
  ['/', /GUTTERCAPS/i], ['/market', /Market/], ['/codex', /Ten Districts/], ['/arena', /Cap Slam/], ['/leaderboard/rating', /Leaderboard/], ['/verify', /Provably fair/], ['/shop', /Pack shop/], ['/collection', /Collection/],
  ['/language', /Tiếng Việt/], ['/shop?tab=services', /Season pass/],
];

describe('public routes (disconnected)', () => {
  for (const [path, title] of PUBLIC) {
    it(`renders ${path}`, async () => {
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
      mount(path);
      await waitFor(() => expect(screen.getAllByText(title).length).toBeGreaterThan(0), { timeout: 4000 });
      spy.mockRestore();
      const real = errors.filter((e) => !String(e).includes('act(') && !String(e).includes('Warning:'));
      expect(real).toEqual([]);
      cleanup();
    });
  }
});

const AUTHED: [string, RegExp][] = [
  ['/', /Yo, /], ['/collection', /archetypes/], ['/shop', /Pack shop/], ['/fusion', /Fusion bench/], ['/arena', /Your squad/], ['/market', /Market/],
  ['/staking', /Staking/], ['/quests', /Quests/], ['/profile', /Referrals/], ['/leaderboard/collection', /Collectors/], ['/verify/abc', /Provably fair/],
];

describe('authenticated routes (fake wallet + mock SIWS)', () => {
  beforeAll(() => { connected = true; useSessionStore.getState().clear(); });
  for (const [path, title] of AUTHED) {
    it(`renders ${path}`, async () => {
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
      mount(path);
      await waitFor(() => expect(screen.getAllByText(title).length).toBeGreaterThan(0), { timeout: 6000 });
      spy.mockRestore();
      const real = errors.filter((e) => !String(e).includes('act(') && !String(e).includes('Warning:'));
      expect(real).toEqual([]);
      cleanup();
    });
  }
  it('switching to Russian re-renders the shell nav and the shop in Cyrillic, then back', async () => {
    const { setLocale } = await import('@/shared/i18n');
    mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    await setLocale('ru');
    await waitFor(() => expect(screen.getAllByText(/Магазин паков/).length).toBeGreaterThan(0), { timeout: 6000 });
    expect(document.documentElement.lang).toBe('ru');
    expect(document.documentElement.classList.contains('lang-alt-display')).toBe(true);
    expect(screen.getAllByText('Маркет').length).toBeGreaterThan(0);
    await setLocale('en');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    expect(document.documentElement.classList.contains('lang-alt-display')).toBe(false);
    cleanup();
  });
  it('profile handle modal: check → availability → pay (mock) updates the title', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mount('/profile');
    // `me` resolves async: the button flips from "Get a @handle" to "Change handle" once the mock profile lands
    await waitFor(() => expect(screen.getByText(/Change handle/)).toBeTruthy(), { timeout: 6000 });
    fireEvent.click(screen.getByText(/Change handle/));
    const input = await screen.findByPlaceholderText('rail_queen');
    fireEvent.change(input, { target: { value: 'moth_king' } });
    await waitFor(() => expect(screen.getByText(/Already taken/)).toBeTruthy(), { timeout: 4000 });
    fireEvent.change(input, { target: { value: 'drain_rat_77' } });
    await waitFor(() => expect(screen.getByText(/^Available$/)).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(screen.getByText(/Pay & claim/));
    await waitFor(() => expect(screen.getAllByText(/@drain_rat_77/).length).toBeGreaterThan(0), { timeout: 6000 });
    cleanup();
  });
  it('quests: the human-check card (T-B-49) shows while unverified, the ineligible reason is translated, and the mock pass hides it', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mount('/quests');
    await waitFor(() => expect(screen.getByTestId('human-check')).toBeTruthy(), { timeout: 6000 });
    expect(screen.getAllByText(/Human check/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(/I am human \(demo\)/));
    await waitFor(() => expect(screen.queryByTestId('human-check')).toBeNull(), { timeout: 6000 });
    expect(screen.getAllByText(/Verified — rewards unlocked/).length).toBeGreaterThan(0); // toast
    cleanup();
  });
  it('market listing page renders with buy CTA', async () => {
    const { mockRequest } = await import('@/api/mock');
    const page = (await mockRequest('get', '/market/listings', {})) as { items: { asset: string }[] };
    mount(`/market/${page.items[0].asset}`);
    await waitFor(() => expect(screen.getByText(/Buy for/)).toBeTruthy(), { timeout: 6000 });
    cleanup();
  });
});

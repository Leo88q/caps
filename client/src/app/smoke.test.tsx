// @vitest-environment happy-dom
// Renders every route against the in-browser mock API and asserts that
// nothing throws and each page paints its title. Wallet is disconnected
// (public routes) and, in a second pass, a fake wallet is injected via the
// wallet-adapter context so the authenticated screens render too.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
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
  ['/staking', /Staking/], ['/quests', /Quests/], ['/profile', /Referrals/], ['/leaderboard/collection', /Collectors/], ['/verify/abc', /Provably fair/], ['/admin', /Ops panel/], ['/admin?tab=kpi', /ARPPU 30d/], ['/admin?tab=fraud', /win_trading/],
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
  it('quests: a kind-9 cap voucher (#28) is listed with its template odds and claimed on its own button, separate from "Claim all"', async () => {
    mount('/quests');
    await waitFor(() => expect(screen.getByTestId('voucher-claim')).toBeTruthy(), { timeout: 6000 });
    expect(screen.getAllByText(/Common 80%, Common\+ 18%, Rare 2%/).length).toBeGreaterThan(0); // QUEST_CHIP_TEMPLATES[0] (7-day streak)
    expect(screen.getAllByText(/1 cap voucher/).length).toBeGreaterThan(0);                     // totals line
    expect(screen.getAllByText(/Claim all \(3\)/).length).toBe(1);                              // $CG + SKR + booster leaves only
    expect(screen.getAllByText(/Claim cap voucher/).length).toBe(1);
    expect(screen.getAllByText(/Soulbound for 3 d/).length).toBe(1);
    cleanup();
  });
  it('profile: the referral dashboard (kind-4 accrual) renders from /me/referrals', async () => {
    mount('/profile');
    await waitFor(() => expect(screen.getAllByText(/@rail_queen/).length).toBeGreaterThan(0), { timeout: 6000 });
    expect(screen.getAllByText(/1 purchase pending/).length).toBe(1);
    expect(screen.getAllByText(/welcome bonus/i).length).toBeGreaterThan(0);
    cleanup();
  });
  it('ops panel: guard-rails reject a bad odds table, a valid patch yields multisig instructions, fraud rows resolve', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mount('/admin');
    // table paints once GET /admin/params lands (the mock wallet is `isAdmin`)
    await waitFor(() => expect(screen.getByText(/Recent set_params/)).toBeTruthy(), { timeout: 6000 });
    // Standard (sku 1) Legend+ = 900 bps → sum ≠ 10000 AND top-2 cap → 422 guard_rail rendered inline, no instructions
    const inputs = screen.getAllByPlaceholderText('18');
    fireEvent.change(inputs[0], { target: { value: '900' } });
    fireEvent.click(screen.getByText(/Check & encode/));
    await waitFor(() => expect(screen.getByTestId('proposal')).toBeTruthy(), { timeout: 6000 });
    expect(screen.getAllByText(/Rejected by the guard-rails/).length).toBe(1);
    expect(screen.getAllByText(/OddsSumInvalid/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Copy instructions JSON/)).toBeNull();
    // clear, then a legal market-fee change → encoded chip_core.set_params for the multisig
    fireEvent.click(screen.getByText(/Clear draft/));
    fireEvent.change(screen.getByPlaceholderText('750'), { target: { value: '800' } });
    fireEvent.click(screen.getByText(/Check & encode/));
    await waitFor(() => expect(screen.getByText(/Copy instructions JSON/)).toBeTruthy(), { timeout: 6000 });
    expect(screen.getAllByText(/chip_core\.set_params/).length).toBe(1);
    expect(screen.getAllByText(/marketFeeBps/).length).toBeGreaterThan(0);
    cleanup();
    // fraud queue: resolving closes the wallet's signals and the row disappears
    mount('/admin?tab=fraud');
    await waitFor(() => expect(screen.getAllByTestId('fraud-row').length).toBe(4), { timeout: 6000 });
    fireEvent.click(screen.getAllByText(/^shadow_ban$/)[0]);
    await waitFor(() => expect(screen.getAllByTestId('fraud-row').length).toBe(3), { timeout: 6000 });
    cleanup();
    // audit log lists the calls we just made
    mount('/admin?tab=audit');
    await waitFor(() => expect(screen.getAllByText(/fraud\.resolve/).length).toBeGreaterThan(0), { timeout: 6000 });
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

describe('shop tab strip (the axe aria-required-children regression, docs/09 §5.5)', () => {
  // CI's first Playwright run failed here for a real reason: a <div role="tablist"> wrapped two plain
  // <button>s — screen-reader semantics without keyboard parity. This pins the *fixed* shape without
  // needing a browser: roles, selection, panels that exist, and arrow keys that move focus.
  it('exposes real tabs and moves them with the keyboard', async () => {
    mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    const list = screen.getByRole('tablist');
    const tabs = within(list).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    // exactly one tab is selected and exactly one is in the tab order
    expect(tabs.map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(tabs.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1']);
    const selected = document.getElementById(tabs[0]!.getAttribute('aria-controls')!);
    expect(selected, 'the selected tab controls nothing').toBeTruthy();
    expect(selected!.getAttribute('role')).toBe('tabpanel');
    expect(selected!.getAttribute('aria-labelledby')).toBe(tabs[0]!.id);
    // and the *un*selected tab does not dangle: its panel is not rendered, so it has no aria-controls at all
    expect(tabs[1]!.hasAttribute('aria-controls'), 'dangling IDREF would fail aria-valid-attr-value').toBe(false);

    // click: the URL carries the tab, so "switch tab" and "link to a tab" stay one operation
    fireEvent.click(tabs[1]!);
    await waitFor(() => expect(tabs[1]!.getAttribute('aria-selected')).toBe('true'), { timeout: 4000 });
    expect(tabs[1]!.getAttribute('aria-controls')).toBe('shop-panel-services');
    expect(document.getElementById('shop-panel-services')).toBeTruthy();
    expect(document.getElementById('shop-panel-packs')).toBeNull();

    // and the keyboard: ArrowRight/End move *selection and focus together*, wrapping at the ends. A tablist
    // that only answers to clicks is the bug axe reported, so this is the part worth pinning.
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' });
    await waitFor(() => expect(tabs[0]!.getAttribute('aria-selected')).toBe('true'), { timeout: 4000 });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: 'End' });
    await waitFor(() => expect(tabs[1]!.getAttribute('aria-selected')).toBe('true'), { timeout: 4000 });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' });
    await waitFor(() => expect(tabs[0]!.getAttribute('aria-selected')).toBe('true'), { timeout: 4000 });
    cleanup();
  });

  it('read-only pills are not focusable buttons', async () => {
    // ×N bundle badges used to be <button>s with no handler: a Tab stop on every SKU that did nothing.
    mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    const bundleRow = Array.from(document.querySelectorAll('.tag-list')).find((el) => /×\d/.test(el.textContent ?? ''));
    expect(bundleRow, 'the bundle row did not render').toBeTruthy();
    expect(bundleRow!.querySelectorAll('button')).toHaveLength(0);
    expect(bundleRow!.querySelectorAll('span.pill').length).toBeGreaterThan(0);
    cleanup();
  });
});

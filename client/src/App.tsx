import { useEffect, useMemo, useState } from 'react';
import { ConnectionProvider, WalletProvider, useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import { getProgram, ensureQuestProgress } from './lib/program';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { clusterApiUrl } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';

import { HomeScreen } from './screens/Home';
import { ChipsScreen } from './screens/Chips';
import { PackShopScreen } from './screens/PackShop';
import { MarketplaceScreen } from './screens/Marketplace';
import { StakingScreen } from './screens/Staking';
import { BattleScreen } from './screens/Battle';
import { QuestsScreen } from './screens/Quests';
import { LeaderboardScreen } from './screens/Leaderboard';
import { SettingsScreen } from './screens/Settings';
import { ProfileScreen } from './screens/Profile';
import { CodexScreen } from './screens/Codex';
import { PaintTrail } from './lib/PaintTrail';
import {
  SignatureTag, HomeIcon, ChipsIcon, ShopIcon, MarketIcon, StakeIcon, BattleIcon,
  SettingsIcon, ProfileIcon, NotificationsIcon,
} from './lib/icons';

// NOTE ON MOBILE WALLETS: this file used to branch between a browser
// wallet-adapter path and a custom `window.ChipGameMWA` bridge injected by
// a hand-rolled Android WebView shell. That bridge is gone — Solana
// Mobile's own `solana-mobile webshell` CLI wraps this exact web build
// into an Android app and handles wallet intents natively, and inside a
// normal mobile browser, Mobile Wallet Adapter is registered as a regular
// Wallet Standard wallet via registerMwa() in main.tsx. Both paths end up
// as one more entry in the same useAnchorWallet()/WalletMultiButton flow
// below — no branching needed. See README "Мобильная упаковка" for the
// wrap/build/publish steps.

type Tab = 'home' | 'chips' | 'shop' | 'market' | 'stake' | 'battle'
  | 'quests' | 'leaderboard' | 'settings' | 'profile' | 'codex';

function AppShell() {
  const [tab, setTab] = useState<Tab>('home');
  const [hasNewNotification, setHasNewNotification] = useState(true); // demo: no real notification backend yet
  const wallet = useAnchorWallet();
  const { connection } = useConnection();

  // Every gameplay instruction that feeds quests needs this account to
  // already exist for the wallet — create it once, right after connect.
  useEffect(() => {
    if (!wallet) return;
    const program = getProgram(connection, wallet);
    ensureQuestProgress(program, connection, wallet.publicKey).catch((e) =>
      console.warn('ensureQuestProgress failed (devnet not reachable / program not deployed?):', e),
    );
  }, [wallet, connection]);

  return (
    <div style={{ maxWidth: 420, margin: '0 auto', fontFamily: 'var(--cg-font-body, sans-serif)', background: 'var(--cg-asphalt, #16151A)', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SignatureTag size={22} opacity={0.9} />
          <strong className="cg-heading" style={{ fontSize: 20 }}>Chip Game</strong>
        </span>
        {wallet && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <NotificationsIcon size={20} hasNew={hasNewNotification} onActivate={() => { setHasNewNotification(false); setTab('profile'); }} />
            <span onClick={() => setTab('profile')} style={{ cursor: 'pointer' }}><ProfileIcon size={20} /></span>
            <span onClick={() => setTab('settings')} style={{ cursor: 'pointer' }}><SettingsIcon size={20} /></span>
          </span>
        )}
        <WalletMultiButton />
      </div>

      {!wallet ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#888' }}>
          <p>Подключите кошелёк, чтобы играть</p>
          <div style={{ marginTop: 12, opacity: 0.4 }}><SignatureTag size={28} opacity={1} /></div>
        </div>
      ) : (
        <>
          {tab === 'home' && <HomeScreen wallet={wallet} onNavigate={setTab} />}
          {tab === 'chips' && <ChipsScreen wallet={wallet} />}
          {tab === 'shop' && <PackShopScreen wallet={wallet} />}
          {tab === 'market' && <MarketplaceScreen wallet={wallet} />}
          {tab === 'stake' && <StakingScreen wallet={wallet} />}
          {tab === 'battle' && <BattleScreen wallet={wallet} />}
          {tab === 'quests' && <QuestsScreen wallet={wallet} />}
          {tab === 'leaderboard' && <LeaderboardScreen />}
          {tab === 'settings' && <SettingsScreen />}
          {tab === 'profile' && <ProfileScreen wallet={wallet} />}
          {tab === 'codex' && <CodexScreen />}
        </>
      )}

      <nav style={{ display: 'flex', justifyContent: 'space-around', borderTop: '1px solid #333', padding: '10px 4px' }}>
        {NAV_TABS.map(({ id, Icon }) => (
          <button
            key={id}
            className={`cg-stencil-tab ${tab === id ? 'cg-tab-active' : ''}`}
            style={{ cursor: 'pointer', background: 'none' }}
          >
            <Icon size={20} onActivate={() => setTab(id)} />
          </button>
        ))}
      </nav>
      <PaintTrail />
    </div>
  );
}

const NAV_TABS: { id: Tab; Icon: typeof HomeIcon }[] = [
  { id: 'home', Icon: HomeIcon },
  { id: 'chips', Icon: ChipsIcon },
  { id: 'shop', Icon: ShopIcon },
  { id: 'market', Icon: MarketIcon },
  { id: 'stake', Icon: StakeIcon },
  { id: 'battle', Icon: BattleIcon },
];

function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl('devnet'), []);
  // PhantomWalletAdapter covers desktop browsers with the extension
  // installed. Mobile Wallet Adapter isn't listed here — it's registered
  // globally as a Wallet Standard wallet in main.tsx (registerMwa), which
  // is how @solana/wallet-adapter-react >= 1.0 expects MWA to show up now
  // (it stopped bundling MWA by default). Both appear as ordinary options
  // in the same WalletMultiButton picker below.
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default function App() {
  return (
    <Providers>
      <AppShell />
    </Providers>
  );
}

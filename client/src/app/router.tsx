import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation, type RouteObject } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { Shell } from './layout/Shell';
import { Skeleton } from '@/shared/ui/primitives';

const Home = lazy(() => import('@/features/home/Home'));
const Collection = lazy(() => import('@/features/collection/Collection'));
const Shop = lazy(() => import('@/features/shop/Shop'));
const Opening = lazy(() => import('@/features/shop/Opening'));
const Fusion = lazy(() => import('@/features/fusion/Fusion'));
const Arena = lazy(() => import('@/features/arena/Arena'));
const MatchReplay = lazy(() => import('@/features/arena/MatchReplay'));
const Market = lazy(() => import('@/features/market/Market'));
const ChipPage = lazy(() => import('@/features/market/ChipPage'));
const Staking = lazy(() => import('@/features/staking/Staking'));
const Quests = lazy(() => import('@/features/quests/Quests'));
const Leaderboard = lazy(() => import('@/features/leaderboard/Leaderboard'));
const Profile = lazy(() => import('@/features/profile/Profile'));
const Codex = lazy(() => import('@/features/codex/Codex'));
const Verify = lazy(() => import('@/features/verify/Verify'));
const Language = lazy(() => import('@/features/language/Language'));

function Fallback() {
  return (
    <div className="page stack">
      <Skeleton h={28} w={220} />
      <Skeleton h={120} />
      <Skeleton h={120} />
    </div>
  );
}

function RequireWallet({ children }: { children: ReactNode }) {
  const { connected, connecting } = useWallet();
  const loc = useLocation();
  if (connecting) return <Fallback />;
  if (!connected) return <Navigate to={`/?connect=1&next=${encodeURIComponent(loc.pathname)}`} replace />;
  return <>{children}</>;
}

const S = (el: ReactNode) => <Suspense fallback={<Fallback />}>{el}</Suspense>;
const W = (el: ReactNode) => <RequireWallet>{S(el)}</RequireWallet>;

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Shell><Outlet /></Shell>,
    children: [
      { index: true, element: S(<Home />) },
      { path: 'collection', element: S(<Collection />) },
      { path: 'shop', element: S(<Shop />) },
      { path: 'shop/opening/:nonce', element: W(<Opening />) },
      { path: 'fusion', element: W(<Fusion />) },
      { path: 'arena', element: S(<Arena />) },
      { path: 'arena/match/:id', element: S(<MatchReplay />) },
      { path: 'market', element: S(<Market />) },
      { path: 'market/:asset', element: S(<ChipPage />) },
      { path: 'staking', element: W(<Staking />) },
      { path: 'quests', element: W(<Quests />) },
      { path: 'leaderboard/:board?', element: S(<Leaderboard />) },
      { path: 'profile', element: W(<Profile />) },
      { path: 'codex', element: S(<Codex />) },
      { path: 'verify/:signature?', element: S(<Verify />) },
      { path: 'language', element: S(<Language />) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

export const router = createBrowserRouter(routes);

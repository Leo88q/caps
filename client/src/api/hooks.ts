// TanStack Query hooks over the typed API client.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { api, type ResponseOf } from './client';
import { qk } from './keys';
import { useSessionStore } from '@/app/store/session';

export type Me = ResponseOf<'/me', 'get'>;
export type Chip = NonNullable<ResponseOf<'/me/chips', 'get'>['items']>[number];
export type Grid = ResponseOf<'/me/grid', 'get'>;
export type PackCatalog = ResponseOf<'/packs', 'get'>;
export type PackSku = NonNullable<PackCatalog['packs']>[number];
export type PackQuote = ResponseOf<'/packs/quote', 'post'>;
export type Collection = ResponseOf<'/collections', 'get'>[number];
export type ListingRow = NonNullable<ResponseOf<'/market/listings', 'get'>['items']>[number];
export type Floor = ResponseOf<'/market/floor', 'get'>;
export type Recipe = ResponseOf<'/fusion/recipes', 'get'>[number];
export type FusionPlan = ResponseOf<'/fusion/plan', 'post'>;
export type ArenaMe = ResponseOf<'/arena/me', 'get'>;
export type Season = ResponseOf<'/arena/seasons/current', 'get'>;
export type Match = ResponseOf<'/arena/matches/{id}', 'get'>;
export type StakingOverview = ResponseOf<'/staking/overview', 'get'>;
export type StakingMe = ResponseOf<'/staking/me', 'get'>;
export type Quest = ResponseOf<'/quests', 'get'>[number];
export type ClaimLeaf = ResponseOf<'/quests/claims', 'get'>[number];
export type LeaderboardPage = ResponseOf<'/leaderboard/{board}', 'get'>;
export type ChipDetail = ResponseOf<'/chips/{asset}', 'get'>;
export type PackVerify = ResponseOf<'/packs/verify', 'post'>;
export type PendingOps = ResponseOf<'/me/pending', 'get'>;

const authed = () => useSessionStore.getState().status === 'authenticated';

export function useMe() {
  const { publicKey } = useWallet();
  const status = useSessionStore((s) => s.status);
  return useQuery({ queryKey: qk.me, queryFn: () => api.get('/me'), enabled: !!publicKey && status === 'authenticated', staleTime: 15_000 });
}

export function useMyChips(filter: { collection?: number; rarity?: number; status?: string } = {}) {
  const status = useSessionStore((s) => s.status);
  return useInfiniteQuery({
    queryKey: qk.myChips(filter),
    enabled: status === 'authenticated',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get('/me/chips', { query: { ...filter, cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
  });
}

export function useGrid() {
  const status = useSessionStore((s) => s.status);
  return useQuery({ queryKey: qk.grid, queryFn: () => api.get('/me/grid'), enabled: status === 'authenticated', staleTime: 15_000 });
}

export function usePendingOps() {
  const status = useSessionStore((s) => s.status);
  return useQuery({ queryKey: qk.pending, queryFn: () => api.get('/me/pending'), enabled: status === 'authenticated', refetchInterval: 5_000 });
}

export function useActivity() {
  const status = useSessionStore((s) => s.status);
  return useInfiniteQuery({
    queryKey: qk.activity, enabled: status === 'authenticated', initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get('/me/activity', { query: { cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const usePackCatalog = () => useQuery({ queryKey: qk.packs, queryFn: () => api.get('/packs'), staleTime: 60_000 });

export function useQuote(sku: number, qty: number, currency: 'SOL' | 'USDC' | 'CG' | 'SKR', enabled = true) {
  return useQuery({
    queryKey: qk.quote(sku, qty, currency),
    enabled: enabled && authed(),
    queryFn: () => api.post('/packs/quote', { sku, qty, currency }),
    staleTime: 20_000,
    refetchInterval: 25_000,
    retry: false,
  });
}

export const useHandleCheck = (handle: string) =>
  useQuery({ queryKey: ['me', 'handle', 'check', handle.toLowerCase()], queryFn: () => api.get('/me/handle/check', { query: { handle } }), enabled: /^[a-zA-Z0-9_]{3,16}$/.test(handle) && authed(), staleTime: 30_000, retry: false });
export const useServices = () => useQuery({ queryKey: ['services'], queryFn: () => api.get('/services'), staleTime: 60_000 });
export const useMyServices = () => useQuery({ queryKey: ['me', 'services'], queryFn: () => api.get('/me/services'), enabled: authed(), staleTime: 15_000 });

export const usePackVerify = (signature: string) =>
  useQuery({ queryKey: qk.packVerify(signature), queryFn: () => api.post('/packs/verify', { signature }), enabled: !!signature, retry: 1 });

export const useCollections = () => useQuery({ queryKey: qk.collections, queryFn: () => api.get('/collections'), staleTime: 5 * 60_000 });
export const useChipDetail = (asset: string) => useQuery({ queryKey: qk.chip(asset), queryFn: () => api.get('/chips/{asset}', { path: { asset } }), enabled: !!asset });

export interface ListingFilter {
  collection?: number; rarity?: number; rarityMin?: number; indexMin?: number; indexMax?: number; levelMin?: number;
  currency?: 'SOL' | 'USDC' | 'SKR'; priceMaxUsd?: number; missingForMySet?: boolean; sort?: 'price_asc' | 'price_desc' | 'newest' | 'rarity_desc' | 'index_asc';
}
export function useListings(filter: ListingFilter = {}) {
  return useInfiniteQuery({
    queryKey: qk.listings(filter as Record<string, unknown>),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get('/market/listings', { query: { ...filter, cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 10_000,
  });
}
export const useFloor = () => useQuery({ queryKey: qk.floor, queryFn: () => api.get('/market/floor'), staleTime: 30_000 });
export const useSales = (f: { asset?: string; collection?: number; rarity?: number } = {}) =>
  useQuery({ queryKey: qk.history(f), queryFn: () => api.get('/market/history', { query: f }), staleTime: 30_000 });
export const useOffers = (direction: 'made' | 'received') =>
  useQuery({ queryKey: qk.offers(direction), queryFn: () => api.get('/market/offers', { query: { direction } }), enabled: authed() });

export const useRecipes = () => useQuery({ queryKey: qk.recipes, queryFn: () => api.get('/fusion/recipes'), staleTime: 10 * 60_000 });
export const useFusionSuggest = (protectSets = true) =>
  useQuery({ queryKey: qk.suggest(protectSets), queryFn: () => api.get('/fusion/suggest', { query: { protectSets } }), enabled: authed(), staleTime: 15_000 });
export const useFusionPlan = () =>
  useMutation({ mutationFn: (b: { materials: string[]; resultCollection?: number; useBooster?: boolean }) => api.post('/fusion/plan', b) });

/** Polls faster while the player is queued or a match awaits a reveal (the WS `match_found` event also invalidates). */
export const useArenaMe = () => useQuery({
  queryKey: qk.arenaMe, queryFn: () => api.get('/arena/me'), enabled: authed(), staleTime: 10_000,
  refetchInterval: (q) => (q.state.data?.queue || q.state.data?.currentMatch ? 3_000 : false),
});
export const useSeason = () => useQuery({ queryKey: qk.season, queryFn: () => api.get('/arena/seasons/current'), staleTime: 60_000 });
export const useMatch = (id: string) => useQuery({ queryKey: qk.match(id), queryFn: () => api.get('/arena/matches/{id}', { path: { id } }), enabled: !!id });
export const useSimulate = () => useMutation({ mutationFn: (b: { squadA: string[]; squadB: string[] }) => api.post('/arena/simulate', b) });
export const useQueueArena = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { squad: string[]; commit: string; wagerCgMicro?: string }) => api.post('/arena/queue', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.arenaMe }),
  });
};
export const useLeaveQueue = () => useMutation({ mutationFn: () => api.del('/arena/queue') });
export const useRevealNonce = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; nonce: string }) => api.post('/arena/matches/{id}/reveal', { nonce: b.nonce }, { path: { id: b.id } }),
    onSuccess: (_r, b) => { void qc.invalidateQueries({ queryKey: qk.arenaMe }); void qc.invalidateQueries({ queryKey: qk.match(b.id) }); },
  });
};

export const useStakingOverview = () => useQuery({ queryKey: qk.stakingOverview, queryFn: () => api.get('/staking/overview'), staleTime: 30_000 });
export const useStakingMe = () => useQuery({ queryKey: qk.stakingMe, queryFn: () => api.get('/staking/me'), enabled: authed(), staleTime: 15_000 });
export const useStakingEstimate = () => useMutation({ mutationFn: (b: { amountCgMicro: string; tier: number }) => api.post('/staking/estimate', b) });

export const useQuests = () => useQuery({ queryKey: qk.quests, queryFn: () => api.get('/quests'), enabled: authed(), staleTime: 30_000 });
export const useClaims = () => useQuery({ queryKey: qk.claims, queryFn: () => api.get('/quests/claims'), enabled: authed(), staleTime: 30_000 });
export const useStreak = () => useQuery({ queryKey: qk.streak, queryFn: () => api.get('/quests/streak'), enabled: authed(), staleTime: 60_000 });

export const useLeaderboard = (board: 'rating' | 'collection' | 'staking' | 'fusion', season?: number) =>
  useQuery({ queryKey: qk.leaderboard(board, season), queryFn: () => api.get('/leaderboard/{board}', { path: { board }, query: { season } }), staleTime: 60_000 });

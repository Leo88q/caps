// Deterministic in-browser backend used when VITE_API_MOCK=true or when the
// real API is unreachable in dev. Data is derived from @guttercaps/economy
// and shared/lib/lore so what you see matches the modelled numbers.
import {
  PACKS, FUSION_RECIPES, BOOSTER, RARITY_PROFILES, LOCK_TIERS, DAILY_QUESTS, WEEKLY_QUESTS, PERMANENT_QUESTS, MATCHMAKING, SEASON, FEES, SERVICES,
  packExpectedValueMult, probabilityAtLeast, effectiveOdds, bundlePriceCents, impliedApy, type PackId,
} from '@guttercaps/economy';
import { COLLECTIONS } from '@/shared/lib/lore';
import type { RequestOpts } from '../client';

// ------------------------------------------------------------- utilities
let seed = 0x1234_5678;
function rnd(): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1_000_000) / 1_000_000; }
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeKey(prefix = ''): string {
  let s = prefix;
  while (s.length < 44) s += B58[Math.floor(rnd() * B58.length)];
  return s.slice(0, 44);
}
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const SKUS: PackId[] = ['starter', 'standard', 'premium', 'limited'];
const ME = 'GCmockWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
let mockHandle = 'gutter_rat';

// ------------------------------------------------------------- state
interface MockChip {
  asset: string; owner: string; collection: number; rarity: number; level: number; index: number;
  flags: { staked: boolean; listed: boolean; fusing: boolean; soulbound: boolean };
  lockUntil: string | null; power: number; stakeWeight: string;
  art: { image: string; video?: string; vfxTier: number };
  listing?: { asset: string; seller: string; price: string; currency: 'SOL' | 'USDC'; priceUsd: number; createdAt: string };
}

const SOL_USD = 152.3;
const SKR_USD = 0.0174;
const floorUsd = (r: number) => Number((3.5 * RARITY_PROFILES[r].valueMult * 0.62).toFixed(2));

function makeChip(collection: number, rarity: number, owner = ME, opts: Partial<MockChip> = {}): MockChip {
  const level = 1 + Math.floor(rnd() * Math.min(6, RARITY_PROFILES[rarity].maxLevel - 1));
  const power = Math.round(RARITY_PROFILES[rarity].basePower * (1 + 0.025 * (level - 1)));
  return {
    asset: fakeKey('As'), owner, collection, rarity, level, index: 1 + Math.floor(rnd() * 5000),
    flags: { staked: false, listed: false, fusing: false, soulbound: false }, lockUntil: null, power,
    stakeWeight: String(RARITY_PROFILES[rarity].stakeWeight), art: { image: '', vfxTier: RARITY_PROFILES[rarity].vfxTier },
    ...opts,
  };
}

const chips: MockChip[] = [];
// a believable mid-game inventory: lots of commons, a few epics, one legend
const inventoryPlan: [number, number][] = [[0, 14], [1, 9], [2, 7], [3, 4], [4, 3], [5, 1], [6, 1]];
for (const [r, n] of inventoryPlan) for (let i = 0; i < n; i++) chips.push(makeChip(Math.floor(rnd() * 10), r));
// one nearly-complete set for NIGHTMOTH (missing Legend+ and Diamond)
for (let r = 0; r <= 6; r++) if (!chips.some((c) => c.collection === 0 && c.rarity === r)) chips.push(makeChip(0, r));
chips[0].flags.staked = true; chips[1].flags.staked = true; chips[2].flags.staked = true;
chips[5].flags.soulbound = true; chips[5].lockUntil = iso(3 * 86_400_000);

const listings: MockChip[] = [];
for (let i = 0; i < 60; i++) {
  const r = pick([0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7]);
  const c = makeChip(Math.floor(rnd() * 10), r, fakeKey('Se'));
  const usd = floorUsd(r) * (0.9 + rnd() * 0.6);
  const currency = rnd() < 0.6 ? 'SOL' : 'USDC';
  c.flags.listed = true;
  c.listing = {
    asset: c.asset, seller: c.owner, currency, priceUsd: Number(usd.toFixed(2)),
    price: currency === 'SOL' ? String(Math.round((usd / SOL_USD) * 1e9)) : String(Math.round(usd * 1e6)),
    createdAt: iso(-Math.floor(rnd() * 3 * 86_400_000)),
  };
  listings.push(c);
}

const questState = new Map<string, { value: number; claimed: boolean }>();
const seasonEnd = Date.now() + 23 * 86_400_000;

// ------------------------------------------------------------- handlers
type Handler = (opts: RequestOpts, params: Record<string, string>) => unknown;
const routes: { method: string; pattern: RegExp; keys: string[]; h: Handler }[] = [];
function on(method: string, path: string, h: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/\{(\w+)\}/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, keys, h });
}

const me = () => ({
  address: ME, handle: mockHandle, firstSeen: iso(-40 * 86_400_000), country: 'NL',
  balances: { lamports: '2314500000', usdc: '48250000', cg: '1875400000', skr: '1240000000' },
  pity: { counters: [0, 23, 4, 0], toGuarantee: [0, 37, 36, 25], boughtToday: [0, 1, 0, 0], starterClaimed: true },
  boosters: 2,
  flags: { rewardsPaused: false, geoRestricted: false, accountAgeH: 960, hasPaidPack: true },
  completedSets: 0,
});

on('get', '/health', () => ({ ok: true }));
on('post', '/auth/siws/nonce', () => ({ nonce: fakeKey(), statement: 'Sign in to GUTTERCAPS', expiresAt: iso(5 * 60_000) }));
on('post', '/auth/siws/verify', () => ({ csrf: 'mock-csrf', wallet: { address: ME, handle: 'gutter_rat' } }));
on('post', '/auth/logout', () => undefined);
on('get', '/me', me);
on('get', '/me/chips', (o) => {
  const q = o.query ?? {};
  let items = chips.filter((c) => (q.collection === undefined || c.collection === Number(q.collection)) && (q.rarity === undefined || c.rarity === Number(q.rarity)));
  if (q.status === 'free') items = items.filter((c) => !c.flags.staked && !c.flags.listed && !c.flags.fusing && !c.lockUntil);
  if (q.status === 'staked') items = items.filter((c) => c.flags.staked);
  if (q.status === 'listed') items = items.filter((c) => c.flags.listed);
  items = [...items].sort((a, b) => b.rarity - a.rarity || b.level - a.level);
  return { items, nextCursor: null, total: items.length };
});
on('get', '/me/grid', () => {
  const cells = Array.from({ length: 10 }, () => Array<number>(9).fill(0));
  for (const c of chips) cells[c.collection][c.rarity]++;
  const missingForSet = cells.map((row, collection) => ({ collection, rarities: row.map((n, r) => (n === 0 ? r : -1)).filter((r) => r >= 0) })).filter((m) => m.rarities.length > 0 && m.rarities.length <= 3);
  return { cells, completedSets: 0, missingForSet };
});
on('get', '/me/pending', () => ({ packs: [], fusions: [] }));
on('get', '/me/activity', () => ({
  items: [
    { kind: 'pack_opened', signature: fakeKey(), blockTime: iso(-3_600_000), payload: { sku: 1, best: 4 } },
    { kind: 'fused', signature: fakeKey(), blockTime: iso(-7_200_000), payload: { recipe: 1, success: true } },
    { kind: 'listed', signature: fakeKey(), blockTime: iso(-86_400_000), payload: { priceUsd: 12.5 } },
    { kind: 'match_won', signature: '', blockTime: iso(-90_000_000), payload: { rating: '+18' } },
  ],
  nextCursor: null,
}));
const TAKEN = new Set(['admin', 'guttercaps', 'moth_king', 'railqueen']);
on('get', '/me/handle/check', (o) => {
  const h = String(o.query?.handle ?? '').toLowerCase();
  const taken = TAKEN.has(h);
  return { available: !taken && /^[a-z0-9_]{3,16}$/.test(h), reason: taken ? 'taken' : undefined, kind: mockHandle ? 1 : 0, refHash: '00'.repeat(32), priceUsdCents: mockHandle ? 99 : 199, reservedUntil: iso(120_000) };
});
on('put', '/me/handle', (o) => { mockHandle = String((o.body as { handle: string }).handle); return { address: ME, handle: mockHandle }; });
const entitlements: { id: string; kind: number; payload: Record<string, unknown>; signature: string; currency: string; amount: string; grantedAt: string; expiresAt: string | null }[] = [
  { id: 'e1', kind: 8, payload: {}, signature: 'mock', currency: 'CG', amount: '99000000', grantedAt: iso(-3 * 86_400_000), expiresAt: null },
];
on('get', '/me/services', () => ({ entitlements, dailyLeft: { '7': 3, '0': 1, '1': 1 } }));
on('get', '/services', () => ({
  services: SERVICES.map((sv) => ({ id: sv.id, kind: sv.kind, name: sv.name, priceUsdCents: sv.priceUsdCents, dailyCap: sv.dailyCap, recurring: sv.recurring, quotes: {
    SOL: String(Math.round((sv.priceUsdCents / 100 / SOL_USD) * 1e9 * 1.01)), USDC: String(sv.priceUsdCents * 10_000), CG: String(sv.priceUsdCents * 1_000_000), SKR: String(Math.round((sv.priceUsdCents / 100 / SKR_USD) * 1e6 * 1.01)),
  } })),
  solUsd: SOL_USD, skrUsd: SKR_USD,
}));
on('post', '/services/claim', (o) => {
  const b = o.body as { signature: string; kind: number; payload: Record<string, unknown> };
  const e = { id: `e${entitlements.length + 1}`, kind: b.kind, payload: b.payload, signature: b.signature, currency: 'CG', amount: '0', grantedAt: iso(), expiresAt: b.kind === 6 ? iso(42 * 86_400_000) : null };
  entitlements.push(e);
  return e;
});

on('get', '/packs', () => ({
  packs: SKUS.map((id, sku) => {
    const p = PACKS[id];
    const ev = ((packExpectedValueMult(p) * 3.5 * 0.62) / (p.priceUsdCents / 100)) * 100;
    return {
      sku, name: p.name, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: p.priceCgMicro === null ? null : String(p.priceCgMicro),
      currencies: p.priceCgMicro ? ['SOL', 'USDC', 'CG'] : ['SOL', 'USDC'], oddsBps: [...p.oddsBps], floor: p.floor, dailyCap: p.dailyCap,
      pity: p.pity ? { ...p.pity } : null, pool: p.pool, enabled: id !== 'limited', pAtLeastLegend: probabilityAtLeast(p, 6), evPct: Number(ev.toFixed(1)),
    };
  }),
  featuredCollection: 4,
  bundles: [{ qty: 1, discountBps: 0 }, { qty: 5, discountBps: 700 }, { qty: 10, discountBps: 1200 }, { qty: 25, discountBps: 1800 }],
}));
on('post', '/packs/quote', (o) => {
  const b = o.body as { sku: number; qty: number; currency: 'SOL' | 'USDC' | 'CG' | 'SKR' };
  const p = PACKS[SKUS[b.sku]];
  const baseCents = bundlePriceCents(p, b.qty);
  // SKR promo (5 %) stacks with the bundle discount, capped at 30 % — same integer math as buy_pack
  const bundleBps = 10_000 - Math.floor((baseCents * 10_000) / Math.max(1, p.priceUsdCents * b.qty));
  const discountBps = b.currency === 'SKR' ? Math.min(bundleBps + FEES.skrPackDiscountBps, 3_000) : bundleBps;
  const cents = b.currency === 'SKR' ? Math.floor((p.priceUsdCents * b.qty * (10_000 - discountBps)) / 10_000) : baseCents;
  const pity = me().pity.counters[b.sku];
  const amount = b.currency === 'SOL' ? Math.round((cents / 100 / SOL_USD) * 1e9)
    : b.currency === 'USDC' ? cents * 10_000
    : b.currency === 'SKR' ? Math.round((cents / 100 / SKR_USD) * 1e6)
    : Math.round((p.priceCgMicro ?? 0) * b.qty * (cents / (p.priceUsdCents * b.qty)));
  return {
    sku: b.sku, qty: b.qty, currency: b.currency, amount: String(amount), maxLamports: String(Math.round(amount * 1.01)), discountBps,
    rentReserveLamports: String(6_000_000 * p.chips * b.qty), solUsd: SOL_USD, skrUsd: SKR_USD, priceUpdateAccount: fakeKey('Py'), pythUpdateData: [],
    effectiveOddsBps: effectiveOdds(p, pity), pityCounter: pity, hardPityIn: p.pity ? Math.max(0, p.pity.hardAt - pity) : 0,
    nonce: String(Date.now()), accounts: {}, switchboardQueue: 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7', expiresAt: iso(30_000),
  };
});
on('post', '/packs/verify', (o) => {
  const { signature } = o.body as { signature: string };
  const roll = Array.from({ length: 32 }, () => Math.floor(rnd() * 256));
  const recomputed = [{ rarity: 0, collection: 3 }, { rarity: 2, collection: 7 }, { rarity: 1, collection: 1 }];
  return { signature, randomnessAccount: fakeKey('Rn'), rollHex: roll.map((b) => b.toString(16).padStart(2, '0')).join(''), pityBefore: 22, effectiveOddsBps: effectiveOdds(PACKS.standard, 22), recomputed, onChain: recomputed, matches: true };
});
on('get', '/packs/opens/{signature}', (_o, p) => ({ signature: p.signature, sku: 1, chips: chips.slice(0, 3), rollHex: '00'.repeat(32), pityBefore: 22, pityAfter: 23, highlights: { bestRarity: 2, newForSet: [7], completedSet: null } }));

on('get', '/collections', () => COLLECTIONS.map((c, idx) => ({
  idx, symbol: c.symbol, name: c.name, element: ['shadow', 'wheels', 'steel', 'wheels', 'noise', 'shadow', 'noise', 'wheels', 'paint', 'paint'][idx],
  palette: [c.color], lore: c.history, minted: 1200 + Math.floor(rnd() * 4000),
  mintedByRarity: [2600, 1500, 900, 480, 260, 100, 28, 9, 1].map((n) => Math.round(n * (0.6 + rnd() * 0.8))),
  floors: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => (r >= 7 ? null : floorUsd(r))), featured: idx === 4,
})));
on('get', '/collections/{idx}/chips/{rarity}', (_o, p) => {
  const c = COLLECTIONS[Number(p.idx)]; const r = Number(p.rarity);
  return { collection: Number(p.idx), rarity: r, name: c.caps[r].name, lore: c.caps[r].desc, rim: RARITY_PROFILES[r].rim, supply: 300 - r * 30, floorUsd: r >= 7 ? null : floorUsd(r), listed: 3, basePower: RARITY_PROFILES[r].basePower, maxLevel: RARITY_PROFILES[r].maxLevel };
});
on('get', '/chips/{asset}', (_o, p) => {
  const c = chips.find((x) => x.asset === p.asset) ?? listings.find((x) => x.asset === p.asset) ?? chips[0];
  const arche = COLLECTIONS[c.collection].caps[c.rarity];
  return {
    ...c,
    provenance: { origin: c.rarity >= 3 ? 'fusion' : 'pack', signature: fakeKey(), rollHex: '9f'.repeat(32), recipe: c.rarity - 1 },
    sales: [{ asset: c.asset, seller: fakeKey(), buyer: fakeKey(), price: '120000000', currency: 'SOL', priceUsd: 18.3, fee: '6000000', royalty: '3000000', signature: fakeKey(), blockTime: iso(-5 * 86_400_000) }],
    archetype: { collection: c.collection, rarity: c.rarity, name: arche.name, lore: arche.desc, rim: RARITY_PROFILES[c.rarity].rim, supply: 420, floorUsd: floorUsd(c.rarity), listed: 4, basePower: RARITY_PROFILES[c.rarity].basePower, maxLevel: RARITY_PROFILES[c.rarity].maxLevel },
  };
});

on('get', '/market/listings', (o) => {
  const q = o.query ?? {};
  let items = listings.filter((c) =>
    (q.collection === undefined || c.collection === Number(q.collection)) &&
    (q.rarity === undefined || c.rarity === Number(q.rarity)) &&
    (q.rarityMin === undefined || c.rarity >= Number(q.rarityMin)) &&
    (q.currency === undefined || c.listing!.currency === q.currency) &&
    (q.levelMin === undefined || c.level >= Number(q.levelMin)) &&
    (q.priceMaxUsd === undefined || c.listing!.priceUsd <= Number(q.priceMaxUsd)),
  );
  if (q.missingForMySet) items = items.filter((c) => !chips.some((m) => m.collection === c.collection && m.rarity === c.rarity));
  const sort = String(q.sort ?? 'price_asc');
  items = [...items].sort((a, b) =>
    sort === 'price_desc' ? b.listing!.priceUsd - a.listing!.priceUsd : sort === 'rarity_desc' ? b.rarity - a.rarity || a.listing!.priceUsd - b.listing!.priceUsd : sort === 'newest' ? b.listing!.createdAt.localeCompare(a.listing!.createdAt) : sort === 'index_asc' ? a.index - b.index : a.listing!.priceUsd - b.listing!.priceUsd,
  );
  return { items: items.map((c) => ({ ...c.listing!, chip: c })), nextCursor: null, total: items.length };
});
on('get', '/market/floor', () => ({
  asOf: iso(), solUsd: SOL_USD, skrUsd: SKR_USD,
  floors: COLLECTIONS.map(() => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => (r >= 7 ? null : Number((floorUsd(r) * (0.85 + rnd() * 0.3)).toFixed(2))))),
  listedCount: COLLECTIONS.map(() => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => Math.max(0, 8 - r))),
  volume24hUsd: 4180.5,
}));
on('get', '/market/history', () => ({
  items: Array.from({ length: 12 }, (_, i) => { const r = pick([0, 1, 1, 2, 2, 3, 4]); const usd = floorUsd(r) * (0.9 + rnd() * 0.4); return { asset: fakeKey('As'), seller: fakeKey(), buyer: fakeKey(), price: String(Math.round((usd / SOL_USD) * 1e9)), currency: 'SOL', priceUsd: Number(usd.toFixed(2)), fee: '0', royalty: '0', signature: fakeKey(), blockTime: iso(-i * 3_600_000), rarity: r }; }),
  nextCursor: null,
}));
on('get', '/market/offers', () => []);

on('get', '/fusion/recipes', () => FUSION_RECIPES.map((r) => ({ from: r.from, to: r.to, rule: r.rule, successBps: r.successBps, refundOnFail: r.refundOnFail, feeCgMicro: String(r.feeCgMicro), resultLockSeconds: r.resultLockSeconds, boosterBonusBps: BOOSTER.bonusBps, boosterCapBps: BOOSTER.capBps })));
on('get', '/fusion/suggest', () => {
  const byR = new Map<number, MockChip[]>();
  for (const c of chips) if (!c.flags.staked && !c.flags.listed && !c.flags.soulbound) byR.set(c.rarity, [...(byR.get(c.rarity) ?? []), c]);
  const out: unknown[] = [];
  for (const [r, list] of byR) if (list.length >= 3 && r < 8) out.push({ materials: list.slice(0, 3), recipe: r, resultCollection: list[0].collection, breaksSet: false });
  return out;
});
on('post', '/fusion/plan', (o) => {
  const b = o.body as { materials: string[]; resultCollection?: number; useBooster?: boolean };
  const mats = b.materials.map((a) => chips.find((c) => c.asset === a)!).filter(Boolean);
  const r = FUSION_RECIPES[mats[0]?.rarity ?? 0];
  const successBps = b.useBooster && r.successBps < 10_000 ? Math.min(BOOSTER.capBps, r.successBps + BOOSTER.bonusBps) : r.successBps;
  return { materials: mats, recipe: { ...r, feeCgMicro: String(r.feeCgMicro), boosterBonusBps: BOOSTER.bonusBps, boosterCapBps: BOOSTER.capBps }, resultCollection: b.resultCollection ?? mats[0]?.collection ?? 0, resultRarity: r.to, successBps, feeCgMicro: String(r.feeCgMicro), breaksSet: false, warnings: [], nonce: String(Date.now()), accounts: {}, needsRandomness: r.successBps < 10_000 };
});

on('get', '/arena/me', () => ({ rating: 1184, rd: 62, league: 2, games: 41, wins: 24, streak: 3, rewardedMatchesLeft: 5, seasonRank: 412, projectedBracket: 'top 20%', openBattles: [] }));
on('get', '/arena/seasons/current', () => ({ id: 3, startsAt: iso(-19 * 86_400_000), endsAt: new Date(seasonEnd).toISOString(), poolCgMicro: '412500000000', brackets: SEASON.payoutBrackets, serverSecretHash: 'a1'.repeat(32), serverSecret: null }));
on('post', '/arena/queue', () => ({ ticket: fakeKey(), league: 2, squadPower: 1210, estimatedWaitSec: 12, wsChannel: 'arena:mock' }));
on('delete', '/arena/queue', () => undefined);
on('post', '/arena/simulate', (o) => {
  const b = o.body as { squadA: string[]; squadB: string[] };
  const pa = b.squadA.reduce((s, a) => s + (chips.find((c) => c.asset === a)?.power ?? 0), 0);
  const pb = b.squadB.reduce((s, a) => s + (listings.find((c) => c.asset === a)?.power ?? chips.find((c) => c.asset === a)?.power ?? 0), 0);
  return { powerA: pa, powerB: pb, winProbA: pa / Math.max(1, pa + pb), elementEdgeA: 0.02, synergyA: 1.08, synergyB: 1.0 };
});
on('get', '/arena/matches/{id}', (_o, p) => {
  const a = chips.filter((c) => !c.flags.listed).slice(0, 3); const b = listings.slice(0, 3);
  return {
    id: p.id, season: 3, a: ME, b: b[0].owner, squadA: a, squadB: b, commitA: 'c'.repeat(64), commitB: 'd'.repeat(64), nonceA: 'n1', nonceB: 'n2', seed: 'e'.repeat(64),
    rounds: [0, 1, 2].map((i) => ({ attacker: a[i].asset, defender: b[i].asset, elementEdge: i === 1 ? 0.15 : 0, luckA: 0.5 + rnd(), luckB: 0.5 + rnd(), winner: i === 1 ? b[0].owner : ME })),
    winner: ME, wagerCgMicro: '0', rewarded: true,
  };
});
on('post', '/arena/matches/{id}/reveal', () => ({ ok: true }));

on('get', '/staking/overview', () => ({
  emission: { dayIndex: 143, year: 0, scheduleCapMicro: '271232876712', guardedMicro: '198000000000', burn7dAvgMicro: '93000000000', mintedTotalMicro: '28900000000000', splitBps: [3000, 1500, 1700, 2300, 1500] },
  tokenPool: { tvlMicro: '38200000000000', totalWeight: '68760000000000', budgetTodayMicro: '29700000000', apyByTier: (['flex', 'd30', 'd90', 'd180'] as const).map((t) => Number(impliedApy(10_000, t, 68_760_000, 29_700).toFixed(1))) },
  chipPool: { stakedChips: 18420, totalWeight: '1420000', budgetTodayMicro: '59400000000', dailyPerWeightUnit: '41830' },
}));
on('get', '/staking/me', () => ({
  tokenStakes: [{ tier: 1, amount: '500000000', weight: '750000000', pending: '3120000', unlockAt: iso(11 * 86_400_000), earlyExitPenalty: '25000000' }],
  chipStakes: chips.filter((c) => c.flags.staked).map((c) => ({ chip: c, weight: String(Number(c.stakeWeight) * 1000), pending: String(Math.round(rnd() * 900_000)), since: iso(-9 * 86_400_000) })),
  setBonus: { onChainSets: 0, computedSets: 0, multBps: 10_000, syncPending: false },
  totalPendingMicro: '4870000',
}));
on('post', '/staking/estimate', (o) => {
  const b = o.body as { amountCgMicro: string; tier: number };
  const tier = (['flex', 'd30', 'd90', 'd180'] as const)[b.tier];
  const amt = Number(b.amountCgMicro) / 1e6;
  const apy = impliedApy(Math.max(1, amt), tier, 68_760_000, 29_700);
  return { apyPct: Number(apy.toFixed(1)), dailyCgMicro: String(Math.round((amt * apy) / 100 / 365 * 1e6)), unlockAt: iso(LOCK_TIERS[tier].lockSeconds * 1000), earlyExitPenaltyBps: LOCK_TIERS[tier].earlyExitPenaltyBps };
});

on('get', '/quests', () => {
  const all = [...DAILY_QUESTS, ...WEEKLY_QUESTS, ...PERMANENT_QUESTS];
  return all.map((q) => {
    const st = questState.get(q.id) ?? { value: Math.floor(rnd() * (q.target + 1)), claimed: false };
    questState.set(q.id, st);
    const done = st.value >= q.target;
    return {
      id: q.id, cadence: q.period, title: q.title, description: '', metric: q.metric, target: q.target, value: st.value, rewardCgMicro: String(q.rewardCgMicro),
      rewardChip: q.rewardChip ?? null, rewardBooster: q.rewardItem === 'booster' ? 1 : 0, completedAt: done ? iso(-3_600_000) : null, claimable: done && !st.claimed,
      ineligibleReason: null, resetsAt: iso(q.period === 'daily' ? 6 * 3_600_000 : q.period === 'weekly' ? 3 * 86_400_000 : 365 * 86_400_000),
    };
  });
});
on('get', '/quests/claims', () => [{ kind: 2, epoch: 143, rootPda: fakeKey('Rt'), amountMicro: '9000000', proof: ['aa'.repeat(32), 'bb'.repeat(32)], claimableAt: iso(-60_000), claimed: false }]);
on('get', '/quests/streak', () => ({ days: 4, nextChipAt: 7, resetsAt: iso(9 * 3_600_000) }));

on('get', '/leaderboard/{board}', (_o, p) => ({
  board: p.board, season: 3,
  me: { rank: p.board === 'rating' ? 412 : 1287, value: p.board === 'rating' ? 1184 : 41 },
  items: Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, wallet: fakeKey(), handle: pick(['moth_king', 'railqueen', 'drain0', 'sk8_or_die', 'noise_boy', 'inkslinger', 'brakeless99', 'pixelbsmt', 'gutterbeast', 'citymyth']) + (i > 9 ? `_${i}` : ''), value: p.board === 'rating' ? 2400 - i * 21 : p.board === 'collection' ? 90 - i : p.board === 'staking' ? 900_000 - i * 12_000 : 300 - i * 4, league: Math.max(0, 5 - Math.floor(i / 10)), avatar: '' })),
  nextCursor: null,
}));

// ------------------------------------------------------------- dispatcher
export async function mockRequest(method: string, path: string, opts: RequestOpts): Promise<unknown> {
  await new Promise((f) => setTimeout(f, 80 + Math.random() * 160));
  let p = path;
  if (opts.path) for (const [k, v] of Object.entries(opts.path)) p = p.replace(`{${k}}`, String(v));
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(p);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return r.h(opts, params);
  }
  throw Object.assign(new Error(`mock: no route ${method.toUpperCase()} ${p}`), { status: 404 });
}

/** Used by the mock pack flow to fabricate a believable result. */
export function mockRoll(sku: number, qty: number) {
  const p = PACKS[SKUS[sku]];
  const out: { rarity: number; collection: number }[][] = [];
  for (let n = 0; n < qty; n++) {
    const pack: { rarity: number; collection: number }[] = [];
    for (let i = 0; i < p.chips; i++) {
      let x = rnd() * 10_000; let r = 0;
      for (let k = 0; k < 9; k++) { x -= p.oddsBps[k]; if (x < 0) { r = k; break; } }
      if (i === p.chips - 1 && r < p.floor) r = p.floor;
      pack.push({ rarity: r, collection: Math.floor(rnd() * 10) });
    }
    out.push(pack);
  }
  return out;
}

export const MOCK_WALLET = ME;
export { MATCHMAKING };

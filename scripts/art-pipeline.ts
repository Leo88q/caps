// GUTTERCAPS art pipeline — docs/07-art-spec.md §4/§5.
//
// Reads the 72 masters (art_drafts/master/{d}-{r}.png) and produces the CDN
// export tree under exports/cdn/ (gitignored build artifact):
//   game/{d}-{r}-{256,512,1024}.webp   client derivatives (budgets §4)
//   nft/{d}-{r}.png                    2048² opaque collector card
//   og/{d}-{r}.jpg                     1200×630 social preview
//   m/{d}/{r}.json                     Metaplex Core metadata, one per chip type
//
// All chip names/symbols/descriptions come from `packages/economy/src/lore.ts`
// (the single source of truth — same file the client, backend and landing read),
// rim/vfxTier from `packages/economy/src/rarity.ts`.
//
// Imaging runs on Pillow (scripts/art_pipeline_render.py) — same toolchain as
// scripts/asset-inventory.py / scripts/landing/build.py; no new native deps.
// (docs/07 sketched this file on `sharp`; the Python renderer keeps the repo's
// dependency tree untouched — the outputs and budgets are what the spec pins.)
//
// Usage:
//   npm run assets:pipeline                         # full 72-chip run
//   npm run assets:pipeline -- --only "01-*"        # one district
//   npm run assets:pipeline -- --only "01-2"        # the §6 calibration chip
//   npm run assets:pipeline -- --animation          # point tiers 6–8 at mp4
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { COLLECTIONS, RARITY_ORDER } from '../packages/economy/src/lore.ts';
import { RARITY_PROFILES } from '../packages/economy/src/rarity.ts';

const root = resolve(import.meta.dirname, '..');
const CDN = 'https://cdn.guttercaps.gg';
const SITE = 'https://guttercaps.gg';

// District colour tokens (client COLLECTION_HEX / site palette) — var name -> hex.
const VAR_HEX: Record<string, string> = {
  'var(--cyan)': '#16E5D9',
  'var(--orange)': '#FF7A1A',
  'var(--magenta)': '#FF2E8A',
  'var(--trust)': '#9AD9FF',
  'var(--acid)': '#B6FF3C',
};

// Glow per tier — mirror of client RARITY_COLOR (incl. the Rare+ override:
// trust blue is money-only, never for chips).
const RARITY_HEX = [
  '#8A8A8A', '#16E5D9', '#16E5D9', '#9AD9FF',
  '#FF2E8A', '#FF7A1A', '#FF7A1A', '#B6FF3C', '#D8D8DC',
];

// Gameplay element per collection — mirror of client ELEMENT_OF_COLLECTION[0..7].
const ELEMENTS = ['Shadow', 'Wheels', 'Steel', 'Wheels', 'Noise', 'Shadow', 'Noise', 'Wheels'];

// Rim material attribute: first token of RARITY_PROFILES.rim, capitalised
// ('enamel-crackle' -> 'Enamel' — matches the §5 example).
const rimAttr = (rim: string) => rim.split('-')[0][0].toUpperCase() + rim.split('-')[0].slice(1);

const argv = process.argv.slice(2);
const animation = argv.includes('--animation');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] ?? '').split(',') : [];

// ── 1. metadata JSON (§5) ────────────────────────────────────────────────────
const mRoot = join(root, 'exports', 'cdn', 'm');
const metaFiles: string[] = [];
for (const col of COLLECTIONS) {
  mkdirSync(join(mRoot, col.num), { recursive: true });
  col.caps.forEach((cap, r) => {
    const tier6plus = RARITY_PROFILES[r].vfxTier >= 3;
    const meta = {
      name: `${col.name} — ${cap.name}`,
      symbol: col.symbol,
      description: `${cap.desc} District ${col.num} · ${RARITY_ORDER[r]} (tier ${r} of 9).`,
      image: `${CDN}/nft/${col.num}-${r}.png`,
      animation_url: animation && tier6plus ? `${CDN}/nft/${col.num}-${r}.mp4` : null,
      external_url: `${SITE}/chip/${Number(col.num)}/${r}`,
      attributes: [
        { trait_type: 'District', value: col.name },
        { trait_type: 'Rarity', value: RARITY_ORDER[r] },
        { trait_type: 'Tier', value: r, max_value: 8 },
        { trait_type: 'Element', value: ELEMENTS[Number(col.num) - 1] ?? 'Shadow' },
        { trait_type: 'Rim', value: rimAttr(RARITY_PROFILES[r].rim) },
      ],
      properties: {
        category: animation && tier6plus ? 'video' : 'image',
        files: [
          { uri: `${CDN}/nft/${col.num}-${r}.png`, type: 'image/png' },
          { uri: `${CDN}/game/${col.num}-${r}-1024.webp`, type: 'image/webp' },
        ],
      },
    };
    const fp = join(mRoot, col.num, `${r}.json`);
    writeFileSync(fp, JSON.stringify(meta, null, 2) + '\n');
    metaFiles.push(fp);
  });
}
console.log(`metadata: ${metaFiles.length} JSON -> exports/cdn/m/{district}/{rarity}.json`);

// ── 2. imaging via the Pillow renderer ───────────────────────────────────────
const paramsPath = join(root, 'exports', '.pipeline-params.json');
writeFileSync(paramsPath, JSON.stringify({
  root,
  only,
  out: {
    game: join(root, 'exports', 'cdn', 'game'),
    nft: join(root, 'exports', 'cdn', 'nft'),
    og: join(root, 'exports', 'cdn', 'og'),
  },
  districts: COLLECTIONS.map((c) => ({
    num: c.num, name: c.name, symbol: c.symbol,
    hex: VAR_HEX[c.color] ?? '#D8D8DC',
  })),
  rarities: RARITY_PROFILES.map((p, r) => ({
    tier: r, name: RARITY_ORDER[r], rim: p.rim, vfx: p.vfxTier, hex: RARITY_HEX[r],
  })),
  caps: COLLECTIONS.map((c) => c.caps.map((cap) => cap.name)),
}), null, 1);

const py = process.env.ASSETS_PYTHON || 'python3';
const render = spawnSync(py, [join(root, 'scripts', 'art_pipeline_render.py'), '--params', paramsPath], {
  stdio: 'inherit',
});
if (render.status !== 0) {
  console.error(`render failed (exit ${render.status}) — is Pillow installed? run: pip install pillow`);
  process.exit(render.status ?? 1);
}

// ── 3. post-conditions: the full game set + budgets (§4) ─────────────────────
const gameDir = join(root, 'exports', 'cdn', 'game');
const BUDGET = { 256: 40, 512: 120, 1024: 350 } as const;
let missing = 0, over = 0, made = 0;
for (const col of COLLECTIONS) {
  for (let r = 0; r < 9; r++) {
    for (const s of [256, 512, 1024] as const) {
      const fp = join(gameDir, `${col.num}-${r}-${s}.webp`);
      if (only.length && !only.some((p) => `${col.num}-${r}`.startsWith(p.replace(/\*$/, '')))) continue;
      if (!existsSync(fp)) { console.error(`MISSING ${fp}`); missing++; continue; }
      made++;
      const kb = statSync(fp).size / 1024;
      if (kb > BUDGET[s]) { console.error(`OVER BUDGET ${fp}: ${kb.toFixed(1)} KB > ${BUDGET[s]} KB`); over++; }
    }
  }
}
console.log(`game exports: ${made} files checked, ${missing} missing, ${over} over budget`);
if (missing || over) process.exit(2);
console.log('art pipeline: ok (exports/cdn/{game,nft,og,m})');

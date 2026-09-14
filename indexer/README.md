# chip-game-indexer

The off-chain half that was missing: this listens to the program's on-chain
events (defined in `programs/chip-game/src/state.rs` — `PackOpened`,
`ChipUpgraded`, `ChipSold`, `RewardsClaimed`, `BattleResolved`, `ChipStaked`,
`ChipUnstaked`, `QuestClaimed`) and serves aggregates over them: a
leaderboard and basic stats. This is what `Leaderboard.tsx` and the stats
row on `Home.tsx` actually need — you can't compute "who has the most wins"
or "how many chips exist" by asking the chain directly without scanning
every account, which doesn't scale.

## What this is NOT

- Not a general-purpose blockchain indexer — it only understands this one
  program's events.
- Not horizontally scalable — SQLite + a single Node process is fine for a
  devnet-scale game, not for mainnet volume. Swap `db.ts` for Postgres and
  `listen.ts` for a queue-backed worker before that matters.
- Not resilient to the listener process dying — if `listen.ts` crashes and
  restarts, it misses whatever happened while it was down. Re-run
  `npm run backfill` after any downtime to catch up; it's safe to re-run
  any time since inserts are deduplicated by (signature, event_index).

## Setup

```bash
cd indexer
npm install

# Same IDL the client needs — copy it here too after `anchor build`:
cp ../target/idl/chip_game.json ./chip_game.idl.json

# Point at your cluster (defaults to devnet):
export SOLANA_RPC_URL=https://api.devnet.solana.com

# Catch up on everything that happened before this indexer existed:
npm run backfill

# Run the real-time listener and the API together:
npm run dev
# — or separately, e.g. to run the listener on a server and the API
#   elsewhere:
npm run listen
npm run serve
```

## API

- `GET /leaderboard?limit=20` → `{ leaderboard: [{ rank, wallet, wins }] }`
  — computed by grouping stored `BattleResolved` events by winner.
- `GET /stats` → `{ chipsMinted, activeWallets, chipsCurrentlyStaked, totalBattlesResolved }`
  — note there's no "SOL staked" metric here; staking locks a chip, not
  SOL, so that number the site/demo screens used to show was never real.
  `chipsCurrentlyStaked` (net of `ChipStaked` minus `ChipUnstaked`) is the
  honest equivalent.
- `GET /wallet/:address/events?limit=50` → recent events mentioning that
  address anywhere in their payload. The match is a crude substring search
  over the stored JSON, not a proper indexed column — fine for a wallet's
  own activity feed at this scale, not for anything performance-sensitive.

## Client wiring

`client/src/screens/Leaderboard.tsx` and `Home.tsx` read
`import.meta.env.VITE_INDEXER_URL` (default `http://localhost:8787`) and
fall back to a visible "indexer unreachable" state rather than silently
showing stale demo numbers if the fetch fails.

import express from 'express';
import cors from 'cors';
import { db } from './db.js';

const app = express();
app.use(cors());

const PORT = process.env.INDEXER_PORT ? Number(process.env.INDEXER_PORT) : 8787;

/**
 * Leaderboard: wins per wallet, computed straight from stored
 * BattleResolved events. No separate leaderboard table — it's a
 * GROUP BY over the event log, which is cheap enough at this scale and
 * always consistent with the raw data (no separate aggregate to drift
 * out of sync).
 */
app.get('/leaderboard', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = db
    .prepare(
      `SELECT json_extract(data, '$.winner') AS wallet, COUNT(*) AS wins
       FROM events
       WHERE event_name = 'BattleResolved'
       GROUP BY wallet
       ORDER BY wins DESC
       LIMIT ?`,
    )
    .all(limit) as { wallet: string; wins: number }[];

  res.json({
    leaderboard: rows.map((r, i) => ({ rank: i + 1, wallet: r.wallet, wins: r.wins })),
  });
});

/**
 * Stats: only metrics that are actually derivable from the events this
 * program emits. Notably this does NOT include "SOL staked" — staking
 * locks a chip, not SOL, so that number was never real; "chips currently
 * staked" (net of ChipStaked minus ChipUnstaked) is the honest equivalent.
 */
app.get('/stats', (_req, res) => {
  const chipsMinted = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_name = 'PackOpened'`).get() as { n: number }
  ).n;

  const activeWallets = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT json_extract(data, '$.buyer')) AS n
         FROM events WHERE event_name = 'PackOpened'`,
      )
      .get() as { n: number }
  ).n;

  const staked = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_name = 'ChipStaked'`).get() as { n: number }
  ).n;
  const unstaked = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_name = 'ChipUnstaked'`).get() as { n: number }
  ).n;

  const totalBattles = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_name = 'BattleResolved'`).get() as { n: number }
  ).n;

  res.json({
    chipsMinted,
    activeWallets,
    chipsCurrentlyStaked: Math.max(0, staked - unstaked),
    totalBattlesResolved: totalBattles,
  });
});

/** Raw event feed for a single wallet — handy for a future activity tab. */
app.get('/wallet/:address/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db
    .prepare(
      `SELECT event_name, data, block_time, signature FROM events
       WHERE data LIKE '%' || ? || '%'
       ORDER BY block_time DESC
       LIMIT ?`,
    )
    .all(req.params.address, limit);
  res.json({ events: rows });
});

app.listen(PORT, () => {
  console.log(`Indexer API listening on http://localhost:${PORT}`);
});

// Reward oracle — the keeper that turns off-chain earnings into on-chain Merkle roots.
//
//   kind 2 (quests)      ← quest_completions with amount > 0 and no root yet   (signer = quest_oracle)
//   kind 3 (pvp season)  ← pvp_rewards (per-match 2 / 0.5 $CG) + season_payouts (ladder, after a
//                          season ends: arena.settleSeason) with no root yet     (signer = season_oracle)
//
// Once per REWARD_ORACLE_INTERVAL_MS (default 6 h) and per kind:
//   1. settle: recompute quest completions for every recently active wallet (quests.ts settleWallet);
//   2. batch: sum the unrooted amounts per wallet, sort wallets, build the tree (merkle.ts —
//      byte-identical to staking::verify_proof), store leaves + proofs in reward_leaves and the batch
//      in reward_batches with epoch = next unused epoch for that kind;
//   3. publish: `publish_root(kind, epoch, root, budget = Σ amounts)` signed by the oracle key; the
//      program checks `budget ≤ slice_budget[kind]` (the unminted slice accumulated by tick_day) and
//      opens the 1 h timelock; the indexer's RootPublished projection is what /quests/claims keys on;
//   4. mark the source rows with (root_kind, root_epoch) only after the tx confirmed — a crash between
//      3 and 4 re-publishes the same (kind, epoch) which fails on the PDA `init` → the sweep notices the
//      root exists (RootPublished indexed) and just marks the rows.
//
// Safety: the oracle key can only reserve budget from a slice that tick_day already accrued (never
// mint beyond the schedule), one root per epoch, and the admin can `revoke_root` inside the timelock
// (backend keeps the unclaimed remainder accounted). Both keys should be distinct hardware/KMS keys
// in production; a leaked key's blast radius is one slice budget per epoch × the revoke window.
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { db as sharedDb, type Db, now } from './db.ts';
import { BorshWriter } from './borsh.ts';
import { PROGRAMS } from './config.ts';
import { ixData, ro, rw, signer, SYSTEM_PROGRAM_ID } from './chain.ts';
import { getConnection, sleep } from './ingest.ts';
import { loadKeypair } from './crank.ts';
import { sendAndConfirm } from './tx.ts';
import { buildRewardTree, toHex } from './merkle.ts';
import { activeWallets, settleWallet } from './quests.ts';
import { settleSeason, unsettledSeasons } from './arena.ts';
import { emissionPda } from './burn-oracle.ts';

const env = process.env;
export const QUEST_ORACLE_KEYPAIR = env.QUEST_ORACLE_KEYPAIR ?? '';
export const SEASON_ORACLE_KEYPAIR = env.SEASON_ORACLE_KEYPAIR ?? '';
export const REWARD_ORACLE_INTERVAL_MS = Number(env.REWARD_ORACLE_INTERVAL_MS ?? 6 * 60 * 60_000);
/** Skip a batch below this total (micro-$CG) — a root costs rent + a tx; small dust waits for the next epoch. */
export const REWARD_ORACLE_MIN_BATCH_MICRO = BigInt(env.REWARD_ORACLE_MIN_BATCH_MICRO ?? 5_000_000); // 5 $CG
/** Off-chain sanity cap per root (micro-$CG); anything above is a bug → alert, no tx. */
export const REWARD_ORACLE_MAX_BATCH_MICRO = BigInt(env.REWARD_ORACLE_MAX_BATCH_MICRO ?? 2_000_000n * 1_000_000n); // 2 M $CG
export const CU_PUBLISH_ROOT = 60_000;
export const KIND_QUESTS = 2, KIND_PVP = 3;

export const rewardRootPda = (kind: number, epoch: number) => {
  const e = Buffer.alloc(4); e.writeUInt32LE(epoch);
  return PublicKey.findProgramAddressSync([Buffer.from('root'), Buffer.from([kind]), e], PROGRAMS.staking);
};

/** `publish_root(kind: u8, epoch: u32, root: [u8; 32], budget: u64)` — accounts: oracle (signer, mut), emission (mut), root (init), system. */
export function publishRootIx(oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint): TransactionInstruction {
  if (root.length !== 32) throw new Error('root must be 32 bytes');
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [signer(oracle, true), rw(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)],
    data: ixData('publish_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes()),
  });
}

// ---------------------------------------------------------------- batching (pure DB)
export interface Batch { kind: number; epoch: number; root: string; budget: bigint; leaves: number }

/** Unrooted amounts per wallet for a kind (quests: completions; pvp: match rewards). */
export function pendingByWallet(db: Db, kind: number): Map<string, { amount: bigint; memo: string[] }> {
  const out = new Map<string, { amount: bigint; memo: string[] }>();
  const rows = kind === KIND_QUESTS
    ? db.all<{ wallet: string; amount: string; ref: string }>(`SELECT wallet, amount, quest_id || '@' || period_key ref FROM quest_completions WHERE root_kind IS NULL AND CAST(amount AS INTEGER) > 0`)
    : [
      ...db.all<{ wallet: string; amount: string; ref: string }>(`SELECT wallet, amount, match_id ref FROM pvp_rewards WHERE root_kind IS NULL`),
      ...db.all<{ wallet: string; amount: string; ref: string }>(`SELECT wallet, amount, 'season:' || season || '#' || rank ref FROM season_payouts WHERE root_kind IS NULL`),
    ];
  for (const r of rows) {
    const cur = out.get(r.wallet) ?? { amount: 0n, memo: [] };
    cur.amount += BigInt(r.amount); cur.memo.push(r.ref);
    out.set(r.wallet, cur);
  }
  return out;
}

export function nextEpoch(db: Db, kind: number): number {
  const a = db.get<{ m: number | null }>(`SELECT MAX(epoch) m FROM reward_batches WHERE kind = ?`, kind)?.m ?? -1;
  const b = db.get<{ m: number | null }>(`SELECT MAX(epoch) m FROM reward_roots WHERE kind = ?`, kind)?.m ?? -1;
  return Math.max(a, b) + 1;
}

/**
 * Build (but do not publish) the next batch for a kind. Returns undefined when nothing is pending or
 * the total is below the minimum. Marks the source rows immediately with the (kind, epoch) so they
 * cannot be double-counted by a concurrent build; a batch that fails to publish is retried by
 * `publishPending`, never rebuilt.
 */
export function buildBatch(db: Db, kind: number, t = now(), min = REWARD_ORACLE_MIN_BATCH_MICRO, max = REWARD_ORACLE_MAX_BATCH_MICRO): Batch | undefined {
  if (db.get(`SELECT 1 FROM reward_batches WHERE kind = ? AND status = 'pending'`, kind)) return undefined; // publish that one first
  const pending = pendingByWallet(db, kind);
  if (pending.size === 0) return undefined;
  const wallets = [...pending.keys()].sort();
  const budget = wallets.reduce((s, w) => s + pending.get(w)!.amount, 0n);
  if (budget < min) return undefined;
  if (budget > max) throw new Error(`reward batch kind ${kind} = ${budget} micro-$CG exceeds REWARD_ORACLE_MAX_BATCH_MICRO — refusing`);
  const epoch = nextEpoch(db, kind);
  const tree = buildRewardTree(wallets.map((w) => ({ wallet: w, amountMicro: pending.get(w)!.amount, kind, epoch })));
  const root = toHex(tree.root);
  db.tx(() => {
    db.run(`INSERT INTO reward_batches (kind, epoch, root, budget, leaves, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`, kind, epoch, root, budget.toString(), wallets.length, t);
    wallets.forEach((w, i) => {
      db.run(`INSERT INTO reward_leaves (kind, epoch, wallet, amount, proof, memo) VALUES (?, ?, ?, ?, ?, ?)`, kind, epoch, w, pending.get(w)!.amount.toString(), JSON.stringify(tree.proofs[i].map(toHex)), JSON.stringify(pending.get(w)!.memo));
    });
    if (kind === KIND_QUESTS) db.run(`UPDATE quest_completions SET root_kind = ?, root_epoch = ? WHERE root_kind IS NULL AND CAST(amount AS INTEGER) > 0`, kind, epoch);
    else { db.run(`UPDATE pvp_rewards SET root_kind = ?, root_epoch = ? WHERE root_kind IS NULL`, kind, epoch); db.run(`UPDATE season_payouts SET root_kind = ?, root_epoch = ? WHERE root_kind IS NULL`, kind, epoch); }
  });
  return { kind, epoch, root, budget, leaves: wallets.length };
}

export interface OracleDeps { connection: Connection; db: Db; questOracle?: Keypair; seasonOracle?: Keypair; log?: (s: string) => void; minBatchMicro?: bigint }

/** Publish every pending batch whose signer we hold; already-indexed roots are just marked published. */
export async function publishPending(d: OracleDeps): Promise<{ published: number; failed: number; skipped: number }> {
  const log = d.log ?? (() => {});
  let published = 0, failed = 0, skipped = 0;
  for (const b of d.db.all<{ kind: number; epoch: number; root: string; budget: string }>(`SELECT kind, epoch, root, budget FROM reward_batches WHERE status = 'pending' ORDER BY kind, epoch`)) {
    const indexed = d.db.get<{ root: string }>(`SELECT root FROM reward_roots WHERE kind = ? AND epoch = ?`, b.kind, b.epoch);
    if (indexed) {
      if (indexed.root !== b.root) { d.db.run(`UPDATE reward_batches SET status = 'failed', last_error = ? WHERE kind = ? AND epoch = ?`, `on-chain root ${indexed.root} != ours`, b.kind, b.epoch); failed++; continue; }
      d.db.run(`UPDATE reward_batches SET status = 'published', published_at = ? WHERE kind = ? AND epoch = ?`, now(), b.kind, b.epoch); published++; continue;
    }
    const key = b.kind === KIND_QUESTS ? d.questOracle : d.seasonOracle;
    if (!key) { skipped++; continue; }
    try {
      const { signature } = await sendAndConfirm(d.connection, key, [publishRootIx(key.publicKey, b.kind, b.epoch, Buffer.from(b.root, 'hex'), BigInt(b.budget))], { cuLimit: CU_PUBLISH_ROOT });
      d.db.run(`UPDATE reward_batches SET status = 'published', signature = ?, published_at = ? WHERE kind = ? AND epoch = ?`, signature, now(), b.kind, b.epoch);
      log(`[reward-oracle] publish_root kind ${b.kind} epoch ${b.epoch} budget ${b.budget} → ${signature}`);
      published++;
    } catch (e) {
      const msg = (e as Error).message;
      d.db.run(`UPDATE reward_batches SET last_error = ? WHERE kind = ? AND epoch = ?`, msg, b.kind, b.epoch);
      log(`[reward-oracle] publish_root kind ${b.kind} epoch ${b.epoch} failed: ${msg}`);
      failed++;
    }
  }
  return { published, failed, skipped };
}

/** One full cycle: settle quests for active wallets + finished seasons → build both batches → publish. */
export async function runOnce(d: OracleDeps, t = now()): Promise<{ settled: number; seasons: number[]; built: Batch[]; published: number; failed: number; skipped: number }> {
  let settled = 0;
  for (const w of activeWallets(d.db, t - 8 * 86_400)) settled += settleWallet(d.db, w, t);
  const seasons: number[] = [];
  for (const id of unsettledSeasons(d.db, t)) { const r = settleSeason(d.db, id, t); if (r) { seasons.push(id); d.log?.(`[reward-oracle] season ${id} settled: ${r.participants} qualified, ${r.paidMicro} µ$CG over ${r.rows} wallets`); } }
  const built: Batch[] = [];
  for (const kind of [KIND_QUESTS, KIND_PVP]) { const b = buildBatch(d.db, kind, t, d.minBatchMicro ?? REWARD_ORACLE_MIN_BATCH_MICRO); if (b) built.push(b); }
  const r = await publishPending(d);
  return { settled, seasons, built, ...r };
}

/** `/health.rewardOracle` */
export function rewardOracleStatus(db: Db) {
  const pendingBatches = db.all<{ kind: number; epoch: number; budget: string; leaves: number; last_error: string | null; created_at: number }>(`SELECT kind, epoch, budget, leaves, last_error, created_at FROM reward_batches WHERE status = 'pending'`);
  const last = db.get<{ published_at: number | null }>(`SELECT MAX(published_at) published_at FROM reward_batches WHERE status = 'published'`);
  const unrooted = { quests: pendingByWallet(db, KIND_QUESTS), pvp: pendingByWallet(db, KIND_PVP) };
  const sum = (m: Map<string, { amount: bigint }>) => [...m.values()].reduce((s, v) => s + v.amount, 0n).toString();
  return {
    lastPublishedAt: last?.published_at ?? null,
    pendingBatches: pendingBatches.map((b) => ({ ...b, ageS: now() - b.created_at })),
    unrootedMicro: { quests: sum(unrooted.quests), pvp: sum(unrooted.pvp) },
    healthy: pendingBatches.every((b) => now() - b.created_at < 3 * REWARD_ORACLE_INTERVAL_MS / 1000),
  };
}

export async function rewardOracle(log: (s: string) => void = console.log) {
  const questOracle = QUEST_ORACLE_KEYPAIR ? loadKeypair(QUEST_ORACLE_KEYPAIR) : undefined;
  const seasonOracle = SEASON_ORACLE_KEYPAIR ? loadKeypair(SEASON_ORACLE_KEYPAIR) : undefined;
  if (!questOracle && !seasonOracle) throw new Error('set QUEST_ORACLE_KEYPAIR and/or SEASON_ORACLE_KEYPAIR');
  const connection = getConnection();
  const db = sharedDb();
  log(`[reward-oracle] quests ${questOracle?.publicKey.toBase58() ?? '—'} · season ${seasonOracle?.publicKey.toBase58() ?? '—'} · every ${REWARD_ORACLE_INTERVAL_MS / 60_000} min · min ${REWARD_ORACLE_MIN_BATCH_MICRO} µ$CG`);
  while (true) {
    try {
      const r = await runOnce({ connection, db, questOracle, seasonOracle, log });
      log(`[reward-oracle] settled ${r.settled} completions${r.seasons.length ? ` · seasons ${r.seasons.join(',')}` : ''} · built ${r.built.map((b) => `k${b.kind}e${b.epoch}=${b.budget}`).join(',') || 'nothing'} · published ${r.published} failed ${r.failed} skipped ${r.skipped}`);
    } catch (e) {
      log(`[reward-oracle] cycle failed: ${(e as Error).message}`);
    }
    await sleep(REWARD_ORACLE_INTERVAL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  rewardOracle().catch((err) => { console.error('reward-oracle crashed:', err); process.exit(1); });
}

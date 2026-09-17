// Event → projection tables. Pure functions of events_raw: `npm run rebuild`
// truncates every projection table and replays the log in (slot, id) order,
// so any bug here is fixed by a replay, never by a migration.
//
// Idempotency: callers only apply events that were newly inserted into
// events_raw (INSERT … ON CONFLICT DO NOTHING + changes() check), so a
// projection sees each event exactly once even when backfill and the live
// listener overlap.
import { PublicKey } from '@solana/web3.js';
import { FEES, QUEST_CHIP_TEMPLATES } from '@guttercaps/economy';
import type { Db } from './db.ts';
import { rootCurrency, type EventData, type RawEvent } from './events.ts';

export interface EventCtx {
  signature: string;
  slot: number;
  blockTime: number | null;
}

type Handler = (db: Db, e: RawEvent, c: EventCtx) => void;

const str = (v: unknown) => String(v);
const num = (v: unknown) => Number(v);
const j = (v: unknown) => JSON.stringify(v);

const CHIP_FLAG_STAKED = 1;
const CHIP_FLAG_LISTED = 2;
const CHIP_FLAG_FUSING = 4;

function touchWallet(db: Db, address: string, c: EventCtx) {
  db.run(
    `INSERT INTO wallets (address, first_seen) VALUES (?, ?)
     ON CONFLICT(address) DO UPDATE SET first_seen = COALESCE(MIN(first_seen, excluded.first_seen), excluded.first_seen)`,
    address, c.blockTime,
  );
}

function setChipFlag(db: Db, asset: string, flag: number, on: boolean, slot: number) {
  db.run(
    on ? `UPDATE chips SET flags = flags | ?, updated_slot = ? WHERE asset = ?` : `UPDATE chips SET flags = flags & ~?, updated_slot = ? WHERE asset = ?`,
    flag, slot, asset,
  );
}

const HANDLERS: Record<string, Handler> = {
  // ------------------------------------------------------------ chip_core
  ServicePaid(db, e, c) {
    const d = e.data;
    touchWallet(db, str(d.buyer), c);
    db.run(
      `INSERT OR IGNORE INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, slot, block_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.signature, e.eventIndex, str(d.buyer), num(d.kind), num(d.currency), str(d.amount), str(d.burned), str(d.refHash), c.slot, c.blockTime,
    );
  },
  PackBought(db, e, c) {
    const d = e.data;
    touchWallet(db, str(d.buyer), c);
    db.run(
      `INSERT OR IGNORE INTO pack_purchases (buyer, nonce, sku, qty, currency, amount, randomness, signature, slot, block_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      str(d.buyer), str(d.nonce), num(d.sku), num(d.qty), num(d.currency), str(d.amount), str(d.randomness), c.signature, c.slot, c.blockTime,
    );
  },
  /** (#28) A free quest-chip PendingPack — tracked apart from purchases; its `PackOpened` arrives with `sku = 0`. */
  VoucherIssued(db, e, c) {
    const d = e.data;
    touchWallet(db, str(d.wallet), c);
    db.run(
      `INSERT OR IGNORE INTO vouchers (wallet, nonce, template, randomness, signature, slot, block_time) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      str(d.wallet), str(d.nonce), num(d.template), str(d.randomness), c.signature, c.slot, c.blockTime,
    );
  },
  PackOpened(db, e, c) {
    const d = e.data;
    const count = num(d.count);
    const assets = (d.assets as string[]).slice(0, count);
    const rarities = (d.rarities as number[]).slice(0, count);
    const collections = (d.collections as number[]).slice(0, count);
    const buyer = str(d.buyer);
    touchWallet(db, buyer, c);
    db.run(
      `INSERT OR IGNORE INTO pack_opens (signature, buyer, sku, nonce, count, assets, rarities, collections, roll_hex, pity_before, pity_after, slot, block_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.signature, buyer, num(d.sku), str(d.nonce), count, j(assets), j(rarities), j(collections), str(d.roll), num(d.pityBefore), num(d.pityAfter), c.slot, c.blockTime,
    );
    // (#28) a voucher open carries sku 0 too — the (wallet, nonce) tells them apart; its lock comes from the template
    const voucher = num(d.sku) === 0 ? db.get<{ template: number }>(`SELECT template FROM vouchers WHERE wallet = ? AND nonce = ?`, buyer, str(d.nonce)) : undefined;
    const soulboundDays = voucher ? (QUEST_CHIP_TEMPLATES[voucher.template]?.soulboundDays ?? 0) : num(d.sku) === 0 ? 7 : 0; // Starter: 7 days (chip_core packs.rs)
    const soulbound = soulboundDays > 0;
    const origin = voucher ? 'voucher' : 'pack';
    for (let i = 0; i < count; i++) {
      db.run(
        `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, origin_signature, minted_at, updated_slot)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset) DO UPDATE SET owner = excluded.owner, collection_idx = excluded.collection_idx, rarity = excluded.rarity, updated_slot = excluded.updated_slot`,
        assets[i], buyer, collections[i], rarities[i], soulbound ? 8 : 0, soulbound && c.blockTime ? c.blockTime + soulboundDays * 86_400 : 0, origin, c.signature, c.blockTime, c.slot,
      );
    }
    if (voucher) db.run(`UPDATE vouchers SET status = 'opened' WHERE wallet = ? AND nonce = ?`, buyer, str(d.nonce));
    else db.run(`UPDATE pack_purchases SET opened = opened + 1, status = CASE WHEN opened + 1 >= qty THEN 'opened' ELSE status END WHERE buyer = ? AND nonce = ?`, buyer, str(d.nonce));
  },
  PackCancelled(db, e) {
    const d = e.data;
    db.run(`UPDATE pack_purchases SET status = 'cancelled' WHERE buyer = ? AND nonce = ?`, str(d.buyer), str(d.nonce));
    db.run(`UPDATE vouchers SET status = 'cancelled' WHERE wallet = ? AND nonce = ?`, str(d.buyer), str(d.nonce));
  },
  ChipFused(db, e, c) {
    const d = e.data;
    const owner = str(d.owner);
    const materials = d.materials as string[];
    const success = Boolean(d.success);
    const result = str(d.result);
    const hasResult = success && result !== '11111111111111111111111111111111';
    touchWallet(db, owner, c);
    db.run(
      `INSERT OR IGNORE INTO fusions (signature, event_index, owner, recipe, materials, result, success, roll_bps, threshold_bps, fee_burned, slot, block_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.signature, e.eventIndex, owner, num(d.recipe), j(materials), hasResult ? result : null, success ? 1 : 0, num(d.rollBps), num(d.thresholdBps), str(d.feeBurned), c.slot, c.blockTime,
    );
    // The commit half sets F_FUSING (ChipFlagsChanged is not emitted for it), the settle half clears it here.
    if (success) {
      for (const m of materials) db.run(`UPDATE chips SET burned_at = ?, flags = flags & ~?, updated_slot = ? WHERE asset = ?`, c.blockTime ?? 0, CHIP_FLAG_FUSING, c.slot, m);
    } else {
      // Failure: the `refund_on_fail` lowest asset keys (byte order) survive — mirrors fusion.rs.
      const recipe = num(d.recipe);
      const refund = recipe >= 4 ? 1 : 0; // recipes 4..7 (<100 % success) refund one material
      const sorted = [...materials].sort((a, b) => cmpBase58Bytes(a, b));
      const survivors = new Set(sorted.slice(0, refund));
      for (const m of materials) {
        if (survivors.has(m)) db.run(`UPDATE chips SET flags = flags & ~?, updated_slot = ? WHERE asset = ?`, CHIP_FLAG_FUSING, c.slot, m);
        else db.run(`UPDATE chips SET burned_at = ?, flags = flags & ~?, updated_slot = ? WHERE asset = ?`, c.blockTime ?? 0, CHIP_FLAG_FUSING, c.slot, m);
      }
    }
    if (hasResult) {
      const mat = db.get<{ collection_idx: number; rarity: number }>(`SELECT collection_idx, rarity FROM chips WHERE asset = ?`, materials[0]);
      const rarity = mat ? mat.rarity + 1 : num(d.recipe) + 1;
      const collection = mat?.collection_idx ?? 0;
      db.run(
        `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, origin_signature, minted_at, updated_slot)
         VALUES (?, ?, ?, ?, 1, 0, 0, 'fusion', ?, ?, ?)
         ON CONFLICT(asset) DO UPDATE SET owner = excluded.owner, updated_slot = excluded.updated_slot`,
        result, owner, collection, rarity, c.signature, c.blockTime, c.slot,
      );
    }
  },
  ChipFlagsChanged(db, e, c) {
    const d = e.data;
    db.run(`UPDATE chips SET flags = ?, lock_until = ?, updated_slot = ? WHERE asset = ?`, num(d.flags), Number(d.lockUntil), c.slot, str(d.asset));
  },
  ParamsChanged(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO params_changes (signature, admin, version, slot, block_time) VALUES (?, ?, ?, ?, ?)`, c.signature, str(d.admin), num(d.version), c.slot, c.blockTime);
  },
  /** SEC-H2 audit trail: who paused/un-paused which program and when (`e.program` = chip_core | staking | arena). */
  PauseChanged(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO pause_changes (signature, event_index, program, by_wallet, paused, slot, block_time) VALUES (?, ?, ?, ?, ?, ?, ?)`, c.signature, e.eventIndex, e.program, str(d.by), d.paused ? 1 : 0, c.slot, c.blockTime);
  },
  BurnReported(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO burns (signature, event_index, program, source, amount, slot, block_time) VALUES (?, ?, 'chip_core', ?, ?, ?, ?)`, c.signature, e.eventIndex, str(d.source), str(d.amount), c.slot, c.blockTime);
  },

  // ------------------------------------------------------------ market
  ChipListed(db, e, c) {
    const d = e.data;
    touchWallet(db, str(d.seller), c);
    db.run(
      `INSERT INTO listings (asset, seller, price, currency, created_at, slot, signature) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset) DO UPDATE SET seller = excluded.seller, price = excluded.price, currency = excluded.currency, created_at = excluded.created_at, slot = excluded.slot, signature = excluded.signature`,
      str(d.asset), str(d.seller), str(d.price), num(d.currency), c.blockTime, c.slot, c.signature,
    );
    setChipFlag(db, str(d.asset), CHIP_FLAG_LISTED, true, c.slot);
    // `list` burns the fixed 0.5 $CG listing fee (market/src/lib.rs LISTING_FEE_CG, no event of its own) —
    // counted here so the burn oracle (SEC-M1) and /stats see it
    db.run(`INSERT OR IGNORE INTO burns (signature, event_index, program, source, amount, slot, block_time) VALUES (?, ?, 'market', 'listing_fee', ?, ?, ?)`, c.signature, e.eventIndex, String(FEES.listingFeeCgMicro), c.slot, c.blockTime);
  },
  ListingUpdated(db, e, c) {
    const d = e.data;
    db.run(`UPDATE listings SET price = ?, slot = ? WHERE asset = ?`, str(d.price), c.slot, str(d.asset));
  },
  ListingCancelled(db, e, c) {
    const d = e.data;
    db.run(`DELETE FROM listings WHERE asset = ?`, str(d.asset));
    setChipFlag(db, str(d.asset), CHIP_FLAG_LISTED, false, c.slot);
  },
  ChipSold(db, e, c) {
    const d = e.data;
    const asset = str(d.asset);
    const chip = db.get<{ collection_idx: number; rarity: number }>(`SELECT collection_idx, rarity FROM chips WHERE asset = ?`, asset);
    touchWallet(db, str(d.buyer), c);
    db.run(
      `INSERT OR IGNORE INTO sales (signature, event_index, asset, seller, buyer, price, currency, fee, royalty, via_offer, collection_idx, rarity, slot, block_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.signature, e.eventIndex, asset, str(d.seller), str(d.buyer), str(d.price), num(d.currency), str(d.fee), str(d.royalty), d.viaOffer ? 1 : 0, chip?.collection_idx ?? null, chip?.rarity ?? null, c.slot, c.blockTime,
    );
    db.run(`DELETE FROM listings WHERE asset = ?`, asset);
    db.run(`DELETE FROM offers WHERE asset = ? AND bidder = ?`, asset, str(d.buyer));
    db.run(`UPDATE chips SET owner = ?, flags = flags & ~?, updated_slot = ? WHERE asset = ?`, str(d.buyer), CHIP_FLAG_LISTED, c.slot, asset);
  },
  OfferMade(db, e, c) {
    const d = e.data;
    touchWallet(db, str(d.bidder), c);
    db.run(
      `INSERT INTO offers (asset, bidder, amount, expires_at, slot) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(asset, bidder) DO UPDATE SET amount = excluded.amount, expires_at = excluded.expires_at, slot = excluded.slot`,
      str(d.asset), str(d.bidder), str(d.amount), Number(d.expiresAt), c.slot,
    );
  },
  OfferCancelled(db, e) {
    const d = e.data;
    db.run(`DELETE FROM offers WHERE asset = ? AND bidder = ?`, str(d.asset), str(d.bidder));
  },

  // ------------------------------------------------------------ arena
  BattleCreated(db, e, c) {
    const d = e.data;
    touchWallet(db, str(d.challenger), c);
    db.run(
      `INSERT OR IGNORE INTO battles (battle, challenger, wager, power_a, randomness, created_sig, created_at, slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      str(d.battle), str(d.challenger), str(d.wager), num(d.powerA), str(d.randomness), c.signature, c.blockTime, c.slot,
    );
  },
  BattleAccepted(db, e, c) {
    const d = e.data;
    touchWallet(db, str(d.opponent), c);
    db.run(`UPDATE battles SET opponent = ?, power_b = ?, status = 'accepted', slot = ? WHERE battle = ?`, str(d.opponent), num(d.powerB), c.slot, str(d.battle));
  },
  BattleResolved(db, e, c) {
    const d = e.data;
    db.run(
      `UPDATE battles SET winner = ?, pot = ?, rake_burn = ?, rake_pool = ?, rake_treasury = ?, result_hash = ?, roll = ?, status = 'resolved', resolved_sig = ?, resolved_at = ?, slot = ? WHERE battle = ?`,
      str(d.winner), str(d.pot), str(d.rakeBurn), str(d.rakePool), str(d.rakeTreasury), str(d.resultHash), str(d.roll), c.signature, c.blockTime, c.slot, str(d.battle),
    );
    // A resolved battle we never saw created (backfill gap) still counts for the leaderboard.
    db.run(
      `INSERT OR IGNORE INTO battles (battle, challenger, wager, power_a, randomness, winner, pot, rake_burn, rake_pool, rake_treasury, result_hash, roll, status, created_sig, resolved_sig, resolved_at, slot)
       VALUES (?, ?, '0', 0, '', ?, ?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?, ?)`,
      str(d.battle), str(d.winner), str(d.winner), str(d.pot), str(d.rakeBurn), str(d.rakePool), str(d.rakeTreasury), str(d.resultHash), str(d.roll), c.signature, c.signature, c.blockTime, c.slot,
    );
    // the burned rake slice (40 % of 5 %) feeds the emission guard through the burn oracle (SEC-M1)
    if (BigInt(str(d.rakeBurn)) > 0n) {
      db.run(`INSERT OR IGNORE INTO burns (signature, event_index, program, source, amount, slot, block_time) VALUES (?, ?, 'arena', 'rake_burn', ?, ?, ?)`, c.signature, e.eventIndex, str(d.rakeBurn), c.slot, c.blockTime);
    }
  },
  BattleCancelled(db, e, c) {
    const d = e.data;
    db.run(`UPDATE battles SET status = 'cancelled', slot = ? WHERE battle = ?`, c.slot, str(d.battle));
  },

  // ------------------------------------------------------------ staking
  DayClosed(db, e, c) {
    const d = e.data;
    db.run(
      `INSERT OR IGNORE INTO emission_days (day_index, year, schedule_cap, guarded, burn_7d_avg, slice_budget, signature, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      num(d.dayIndex), num(d.year), str(d.scheduleCap), str(d.guarded), str(d.burn7dAvg), j(d.sliceBudget), c.signature, c.blockTime,
    );
  },
  Staked(db, e, c) {
    const d = e.data;
    const owner = str(d.owner);
    touchWallet(db, owner, c);
    db.run(
      `INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET amount = excluded.amount, weight = excluded.weight, unlock_at = excluded.unlock_at, since = COALESCE(stakes.since, excluded.since), slot = excluded.slot, active = 1`,
      str(d.key), owner, num(d.kind), str(d.amount), str(d.weight), Number(d.unlockAt), c.blockTime, c.slot,
    );
    if (num(d.kind) === 1) setChipFlag(db, str(d.key), CHIP_FLAG_STAKED, true, c.slot);
  },
  Unstaked(db, e, c) {
    const d = e.data;
    if (num(d.kind) === 1) {
      db.run(`UPDATE stakes SET active = 0, slot = ? WHERE key = ?`, c.slot, str(d.key));
      setChipFlag(db, str(d.key), CHIP_FLAG_STAKED, false, c.slot);
    } else {
      // token stake: partial unstake keeps the position; amounts are decimal strings → do the math in JS
      const row = db.get<{ amount: string }>(`SELECT amount FROM stakes WHERE key = ?`, str(d.key));
      const left = row ? BigInt(row.amount) - BigInt(str(d.amount)) : 0n;
      if (left <= 0n) db.run(`UPDATE stakes SET amount = '0', active = 0, slot = ? WHERE key = ?`, c.slot, str(d.key));
      else db.run(`UPDATE stakes SET amount = ?, slot = ? WHERE key = ?`, left.toString(), c.slot, str(d.key));
    }
    if (BigInt(str(d.penaltyBurned)) > 0n) {
      db.run(`INSERT OR IGNORE INTO burns (signature, event_index, program, source, amount, slot, block_time) VALUES (?, ?, 'staking', 'early_exit', ?, ?, ?)`, c.signature, e.eventIndex, str(d.penaltyBurned), c.slot, c.blockTime);
    }
  },
  Claimed(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO claims (signature, event_index, owner, kind, amount, slot, block_time) VALUES (?, ?, ?, ?, ?, ?, ?)`, c.signature, e.eventIndex, str(d.owner), num(d.kind), str(d.amount), c.slot, c.blockTime);
  },
  RootPublished(db, e, c) {
    const d = e.data;
    db.run(
      `INSERT INTO reward_roots (kind, epoch, currency, root, budget, revoked, signature, slot) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(kind, epoch) DO UPDATE SET root = excluded.root, budget = excluded.budget, revoked = 0, signature = excluded.signature, slot = excluded.slot`,
      num(d.kind), num(d.epoch), rootCurrency(num(d.kind)), str(d.root), str(d.budget), c.signature, c.slot,
    );
  },
  RootRevoked(db, e, c) {
    const d = e.data;
    db.run(`UPDATE reward_roots SET revoked = 1, slot = ? WHERE kind = ? AND epoch = ?`, c.slot, num(d.kind), num(d.epoch));
  },
  RootClaimed(db, e, c) {
    const d = e.data;
    touchWallet(db, str(d.wallet), c);
    db.run(`INSERT OR IGNORE INTO reward_claims (kind, epoch, currency, wallet, amount, signature, slot) VALUES (?, ?, ?, ?, ?, ?, ?)`, num(d.kind), num(d.epoch), rootCurrency(num(d.kind)), str(d.wallet), str(d.amount), c.signature, c.slot);
  },
  SliceFunded(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO slice_fundings (signature, event_index, by_wallet, kind, amount, slice_budget, recycled_total, slot, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.signature, e.eventIndex, str(d.by), num(d.kind), str(d.amount), j(d.sliceBudget), str(d.recycledTotal), c.slot, c.blockTime);
    // not a `burns` row on purpose: the tokens come back at claim (recycled), so the guard ring must not see demand here
  },
  SkrFunded(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO skr_pool_events (signature, event_index, kind, counterparty, amount, budget, reserved, slot, block_time) VALUES (?, ?, 'funded', ?, ?, ?, ?, ?, ?)`,
      c.signature, e.eventIndex, str(d.funder), str(d.amount), str(d.budget), str(d.reserved), c.slot, c.blockTime);
  },
  SkrWithdrawn(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO skr_pool_events (signature, event_index, kind, counterparty, amount, budget, slot, block_time) VALUES (?, ?, 'withdrawn', ?, ?, ?, ?, ?)`,
      c.signature, e.eventIndex, str(d.to), str(d.amount), str(d.budget), c.slot, c.blockTime);
  },
  SkrPoolChanged(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO skr_pool_events (signature, event_index, kind, max_root_budget, paused, slot, block_time) VALUES (?, ?, 'changed', ?, ?, ?, ?)`,
      c.signature, e.eventIndex, str(d.maxRootBudget), d.paused ? 1 : 0, c.slot, c.blockTime);
  },
  BurnRecorded(db, e, c) {
    const d = e.data;
    db.run(`INSERT OR IGNORE INTO burns (signature, event_index, program, source, amount, slot, block_time) VALUES (?, ?, 'staking', ?, ?, ?, ?)`, c.signature, e.eventIndex, str(d.source), str(d.amount), c.slot, c.blockTime);
  },
  SetBonusSynced(db, e, c) {
    const d = e.data;
    db.run(`INSERT INTO set_bonus (owner, sets, slot) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET sets = excluded.sets, slot = excluded.slot`, str(d.owner), num(d.sets), c.slot);
  },
};

/** Compare two base58 pubkeys by their byte representation (what fusion.rs sorts on). */
function cmpBase58Bytes(a: string, b: string): number {
  const A = new PublicKey(a).toBytes(), B = new PublicKey(b).toBytes();
  for (let i = 0; i < 32; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

export function applyEvent(db: Db, e: RawEvent, c: EventCtx): boolean {
  const h = HANDLERS[e.name];
  if (!h) return false;
  h(db, e, c);
  return true;
}

export const HANDLED_EVENTS = Object.keys(HANDLERS);
export type { EventData };

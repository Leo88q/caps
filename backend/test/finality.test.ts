// SEC-M5 finality reconciler: finalized_at stamping, dropped-transaction eviction with a full
// projection rebuild, the payment gate, and /health.finality.
import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import * as q from '../src/queries.ts';
import { claimService, findPayment, serviceRefHash, ServiceError } from '../src/services.ts';
import { dropSignatures, finalityStatus, isFinalized, markFinalized, reconcileOnce, requireFinalized, FinalityError, type StatusSource } from '../src/finality.ts';
import { kp, tx, world } from './fixtures.ts';

/** Fake status source: `finalized` for every signature unless overridden; `null` = unknown to the cluster. */
function statuses(tip: number, override: Record<string, 'finalized' | 'confirmed' | null | 'err'> = {}): StatusSource & { asked: string[][] } {
  const src = {
    asked: [] as string[][],
    async getSlot() { return tip; },
    async getSignatureStatuses(sigs: string[]) {
      src.asked.push(sigs);
      return {
        value: sigs.map((s) => {
          const o = override[s];
          if (o === null) return null;
          if (o === 'err') return { confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } };
          return { confirmationStatus: o ?? 'finalized', err: null };
        }),
      };
    },
  };
  return src;
}

describe('finality reconciler (SEC-M5)', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('stamps finalized_at only for signatures old enough and reported finalized; confirmed ones stay pending', async () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const slots = db.all<{ signature: string; slot: number }>(`SELECT signature, MIN(slot) AS slot FROM events_raw GROUP BY signature ORDER BY slot`);
    const newest = slots[slots.length - 1];
    // tip just 10 slots past the newest tx → the newest is too young to be asked about
    const src = statuses(newest.slot + 10, { [slots[0].signature]: 'confirmed' });
    const r = await reconcileOnce(src, db, () => {}, { minSlots: 20 });
    expect(src.asked[0]).not.toContain(newest.signature);
    expect(r.pending).toBe(1); // slots[0] still confirmed-only
    expect(r.finalized).toBeGreaterThan(0);
    expect(isFinalized(db, slots[0].signature)).toBe(false);
    expect(isFinalized(db, slots[1].signature)).toBe(true);
    expect(isFinalized(db, newest.signature)).toBe(false);
    // next pass with a later tip finalizes the rest
    const r2 = await reconcileOnce(statuses(newest.slot + 500), db, () => {}, { minSlots: 20 });
    expect(r2.finalized).toBeGreaterThan(0);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE finalized_at IS NULL`)).toBe(0);
    // idempotent
    expect((await reconcileOnce(statuses(newest.slot + 900), db)).checked).toBe(0);
  });

  it('a transaction the cluster no longer knows is evicted and every projection is rebuilt without it', async () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const before = q.stats(db);
    expect(before.sales).toBe(1);
    // the ChipSold tx vanishes in a fork
    const saleSig = db.get<{ signature: string }>(`SELECT signature FROM events_raw WHERE name = 'ChipSold'`)!.signature;
    const log: string[] = [];
    const r = await reconcileOnce(statuses(1_000_000, { [saleSig]: null }), db, (s) => log.push(s), { minSlots: 0, dropAfterSlots: 0 });
    expect(r.dropped.map((d) => d.signature)).toEqual([saleSig]);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE signature = ?`, saleSig)).toBe(0);
    const after = q.stats(db);
    expect(after.sales).toBe(0);
    expect(after.chipsMinted).toBe(before.chipsMinted); // unrelated projections survive the rebuild
    // the chip is back with alice and still listed (the ChipListed tx was real, the sale was not)
    const chip = db.get<{ owner: string; flags: number }>(`SELECT owner, flags FROM chips WHERE asset = ?`, w.chips[2])!;
    expect(chip.owner).toBe(w.alice);
    expect(chip.flags & 2).toBe(2); // LISTED
    expect(log.some((l) => l.includes('dropped tx') && !l.includes('ALERT'))).toBe(true);
  });

  it('a failed (err) transaction is evicted too; a young unknown one is left pending until FINALITY_DROP_AFTER_SLOTS', async () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const sig = db.get<{ signature: string }>(`SELECT signature FROM events_raw WHERE name = 'BattleResolved'`)!.signature;
    const young = statuses(1_000_000, { [sig]: null });
    const r1 = await reconcileOnce(young, db, () => {}, { minSlots: 0, dropAfterSlots: 10_000_000 });
    expect(r1.dropped).toHaveLength(0);
    expect(r1.pending).toBe(1);
    const r2 = await reconcileOnce(statuses(1_000_000, { [sig]: 'err' }), db, () => {}, { minSlots: 0 });
    expect(r2.dropped.map((d) => d.signature)).toEqual([sig]);
    expect(q.stats(db).totalBattlesResolved).toBe(0);
  });

  it('payment gate: confirmed payment → 409 payment_pending; finalized → granted; a dropped consumed payment is flagged ALERT', async () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    expect(() => requireFinalized(db, w.servicePaySig)).toThrow(FinalityError);
    try { findPayment(db, w.servicePaySig, w.alice, [0]); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).status).toBe(409);
      expect((e as ServiceError).code).toBe('payment_pending');
    }
    expect(markFinalized(db, [w.servicePaySig])).toBe(2); // BurnReported + ServicePaid rows share the signature
    expect(findPayment(db, w.servicePaySig, w.alice, [0]).kind).toBe(0);

    // an entitlement is granted on a finalized skin payment, then the tx "disappears" → ALERT with the consumed id
    const owner = kp(), asset = w.chips[4];
    const sig = 'sigDROPPEDSKIN' + 'q'.repeat(40);
    const payload = { asset, skin: 'chrome-drip' };
    const ref = Buffer.from(serviceRefHash(2, owner, payload)).toString('hex');
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: owner, sku: 1, nonce: '9', assets: [asset, kp(), kp(), '11111111111111111111111111111111', '11111111111111111111111111111111'], rarities: [0, 0, 0, 0, 0], collections: [0, 0, 0, 0, 0], count: 3, roll: '00'.repeat(32), pityBefore: 0, pityAfter: 0 } }]), db);
    ingestTx(tx([{ program: 'chip_core', name: 'ServicePaid', data: { buyer: owner, kind: 2, currency: 1, amount: '1490000', burned: '0', refHash: ref } }], { signature: sig }), db);
    markFinalized(db, [sig]);
    expect(claimService(db, owner, sig, 2, payload).kind).toBe(2);
    // finalized_at is reset so the reconciler asks again (e.g. after an RPC that lied) and now hears "unknown"
    db.run(`UPDATE events_raw SET finalized_at = NULL WHERE signature = ?`, sig);
    const log: string[] = [];
    const r = await reconcileOnce(statuses(1_000_000, { [sig]: null }), db, (s) => log.push(s), { minSlots: 0, dropAfterSlots: 0 });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].signature).toBe(sig);
    expect(r.dropped[0].consumedPayments).toEqual([expect.stringMatching(/^entitlement:\d+$/)]);
    expect(log.some((l) => l.startsWith('[finality] ALERT') && l.includes('manual review'))).toBe(true);
    expect(db.scalar(`SELECT COUNT(*) FROM service_payments WHERE signature = ?`, sig)).toBe(0);
    void dropSignatures;
  });

  it('finalityStatus: healthy with nothing pending or young pending; unhealthy when something waited > 10 min', async () => {
    expect(finalityStatus(db)).toMatchObject({ pendingSignatures: 0, healthy: true });
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const nowS = 1_700_000_000 + 1_000 + 60; // fixtures' block_time ≈ 1_700_000_000 + slot (slot ≈ 1 000..1 050)
    expect(finalityStatus(db, nowS)).toMatchObject({ healthy: true, pendingSignatures: w.txs.length });
    expect(finalityStatus(db, nowS + 700).healthy).toBe(false);
    await reconcileOnce(statuses(10_000_000), db, () => {}, { minSlots: 0 });
    expect(finalityStatus(db, nowS + 700)).toMatchObject({ pendingSignatures: 0, healthy: true });
  });
});

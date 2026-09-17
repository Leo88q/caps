// Synthetic on-chain history used by projection + API tests. Produces the same
// TxLike objects the RPC path produces, so ingestTx is exercised end-to-end.
import { Keypair } from '@solana/web3.js';
import { fakeLogs, type EventData } from '../src/events.ts';
import type { ProgramName } from '../src/config.ts';
import type { TxLike } from '../src/ingest.ts';
import type { Db } from '../src/db.ts';

export const kp = () => Keypair.generate().publicKey.toBase58();
/** Stamp every indexed event finalized (what the SEC-M5 reconciler does ≈ 1 min after confirmation) — settlement only pays from finalized events. */
export const finalizeAll = (db: Db, at = 1_700_000_000) => Number(db.run(`UPDATE events_raw SET finalized_at = ? WHERE finalized_at IS NULL`, at).changes);
export const DEFAULT = '11111111111111111111111111111111';
export const hex32 = (b: number) => b.toString(16).padStart(2, '0').repeat(32);

let slot = 1_000;
let sigN = 0;
export const nextSig = () => `sig${String(++sigN).padStart(6, '0')}${'x'.repeat(40)}`;

export function tx(events: { program: ProgramName; name: string; data: EventData }[], opts: { blockTime?: number | null; signature?: string; cpiFrom?: ProgramName } = {}): TxLike {
  slot += 3;
  return { signature: opts.signature ?? nextSig(), slot, blockTime: opts.blockTime === undefined ? 1_700_000_000 + slot : opts.blockTime, logs: fakeLogs(events, { cpiFrom: opts.cpiFrom }), err: null };
}

export interface World { alice: string; bob: string; chips: string[]; battle: string; txs: TxLike[]; packSig: string; servicePaySig: string; refHash: string }

/** alice opens a standard pack (3 chips), lists one, bob buys it, alice fuses, both battle, alice stakes + pays for a handle. */
export function world(refHashHex: string = hex32(0x11)): World {
  const alice = kp(), bob = kp();
  const chips = [kp(), kp(), kp(), kp(), kp()];
  const battle = kp();
  const txs: TxLike[] = [];
  const packSig = nextSig();
  txs.push(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: alice, sku: 1, qty: 1, currency: 0, amount: '33000000', nonce: '7', randomness: kp() } }]));
  txs.push(tx([{ program: 'chip_core', name: 'PackOpened', data: {
    buyer: alice, sku: 1, nonce: '7', assets: [chips[0], chips[1], chips[2], DEFAULT, DEFAULT], rarities: [0, 0, 2, 0, 0], collections: [3, 3, 7, 0, 0], count: 3, roll: hex32(0x9f), pityBefore: 4, pityAfter: 5,
  } }], { signature: packSig }));
  // list chip 2 for 0.1 SOL, then sell to bob
  txs.push(tx([{ program: 'market', name: 'ChipListed', data: { asset: chips[2], seller: alice, price: '100000000', currency: 0 } }]));
  txs.push(tx([
    { program: 'chip_core', name: 'ChipFlagsChanged', data: { asset: chips[2], flags: 0, lockUntil: '0' } },
    { program: 'market', name: 'ChipSold', data: { asset: chips[2], seller: alice, buyer: bob, price: '100000000', currency: 0, fee: '7500000', royalty: '2500000', viaOffer: false } },
  ], { cpiFrom: 'market' }));
  // alice needs a third common: second pack (2 more commons of collection 3)
  txs.push(tx([{ program: 'chip_core', name: 'PackOpened', data: {
    buyer: alice, sku: 1, nonce: '8', assets: [chips[3], kp(), kp(), DEFAULT, DEFAULT], rarities: [0, 1, 1, 0, 0], collections: [3, 5, 6, 0, 0], count: 3, roll: hex32(0x10), pityBefore: 5, pityAfter: 6,
  } }]));
  // fuse chips 0,1,3 (commons) → chips[4] Common+
  txs.push(tx([
    { program: 'chip_core', name: 'BurnReported', data: { source: 1, amount: '2500000' } },
    { program: 'chip_core', name: 'ChipFused', data: { owner: alice, recipe: 0, materials: [chips[0], chips[1], chips[3]], result: chips[4], success: true, rollBps: 0, thresholdBps: 10000, feeBurned: '2500000' } },
  ]));
  // arena
  txs.push(tx([{ program: 'arena', name: 'BattleCreated', data: { battle, challenger: alice, wager: '50000000', powerA: 610, randomness: kp() } }]));
  txs.push(tx([{ program: 'arena', name: 'BattleAccepted', data: { battle, opponent: bob, powerB: 590 } }]));
  txs.push(tx([{ program: 'arena', name: 'BattleResolved', data: { battle, winner: alice, pot: '100000000', rakeBurn: '2000000', rakePool: '1000000', rakeTreasury: '2000000', resultHash: hex32(0x22), roll: hex32(0x33) } }]));
  // staking: alice stakes the fused chip, bob stakes tokens
  txs.push(tx([{ program: 'staking', name: 'Staked', data: { owner: alice, kind: 1, key: chips[4], amount: '1', weight: '2000', unlockAt: '0' } }]));
  txs.push(tx([{ program: 'staking', name: 'Staked', data: { owner: bob, kind: 0, key: kp(), amount: '500000000', weight: '750000000', unlockAt: '1800000000' } }]));
  // services: alice pays for a handle (kind 0) in $CG
  const servicePaySig = nextSig();
  txs.push(tx([
    { program: 'chip_core', name: 'BurnReported', data: { source: 3, amount: '199000000' } },
    { program: 'chip_core', name: 'ServicePaid', data: { buyer: alice, kind: 0, currency: 2, amount: '199000000', burned: '199000000', refHash: refHashHex } },
  ], { signature: servicePaySig }));
  return { alice, bob, chips, battle, txs, packSig, servicePaySig, refHash: refHashHex };
}

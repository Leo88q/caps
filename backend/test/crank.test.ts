import { describe, it, expect, beforeEach } from 'vitest';
import { AddressLookupTableAccount, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { expandRandomness, PACKS, STALE_PACK_SLOTS } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { crankStatus } from '../src/queries.ts';
import {
  Crank, CU, GatewayError, fetchGatewayReveal, jobKey, toEconPack, voucherEconPack, type FetchLike,
} from '../src/crank.ts';
import {
  ARENA_ID, ASSOCIATED_TOKEN_PROGRAM_ID, CHIP_CORE_ID, MPL_CORE_ID, RNG_KIND, SYSTEM_PROGRAM_ID, SYSVAR_SLOT_HASHES_ID, TOKEN_PROGRAM_ID, WSOL_MINT, assetPda, battlePda,
  chipStatePda, closeRandomnessIx, collectionMetaPda, configPda, decodeOracleGateway, decodeRandomness, fuseRevealIx, ixDiscriminator, openPackIx, packSeed, pendingFusionPda,
  pendingPackPda, pityPda, revealRandomnessIx, rngAuthPda, rngPda, sbLutPda, sbLutSignerPda, sbOracleStatsPda, sbRewardEscrow, sbStatePda, customErrorCode, vaultPda,
  allLedgerPdas, ledgerPdaOf,
} from '../src/chain.ts';
import { clampCuPrice } from '../src/tx.ts';
import {
  DEFAULT_PACK, FakeConnection, ProgramError, SB_OWNER, encodeChipState, encodeCollectionMeta, encodeGameConfig, encodeOracle, encodePendingFusion, encodePendingPack,
  encodePlayerPity, encodeRandomness, encodeWagerBattle, pk,
} from './chainFixtures.ts';
import { tx } from './fixtures.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const asConn = (c: FakeConnection) => c as unknown as Connection;

// ------------------------------------------------------------------ fake oracle gateway
const ORACLE_VALUE = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
const ORACLE_SIG = new Uint8Array(64).map((_, i) => (255 - i) & 0xff);
type Gateway = FetchLike & { calls: number };
function gateway(opts: { fail?: number | 'network'; onCall?: (url: string, body: unknown) => void } = {}): Gateway {
  const f: Gateway = Object.assign(async (url: string, init: { body: string }) => {
    f.calls++;
    opts.onCall?.(url, JSON.parse(init.body));
    if (opts.fail === 'network') throw new Error('ECONNREFUSED');
    if (typeof opts.fail === 'number') return { ok: false, status: opts.fail, text: async () => 'randomness not yet finalized' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ signature: Buffer.from(ORACLE_SIG).toString('base64'), recovery_id: 1, value: Array.from(ORACLE_VALUE) }) };
  }, { calls: 0 });
  return f;
}

// ------------------------------------------------------------------ a world with one pending pack
interface World { conn: FakeConnection; db: Db; payer: Keypair; buyer: PublicKey; nonce: bigint; pending: PublicKey; randomness: PublicKey; oracle: PublicKey; queue: PublicKey; treasury: PublicKey; cgMint: PublicKey; cores: PublicKey[]; commitSlot: bigint }
function world(o: { qty?: number; sku?: number; paidCg?: bigint; revealed?: boolean; withDbRow?: boolean; voucher?: { template: number; odds: number[]; soulboundDays: number } } = {}): World {
  const conn = new FakeConnection();
  const db = new Db(':memory:');
  const payer = Keypair.generate();
  const buyer = pk(), nonce = 7n, oracle = pk(), queue = pk(), treasury = pk(), cgMint = pk();
  const cores = Array.from({ length: 10 }, () => pk());
  conn.set(configPda()[0], encodeGameConfig({ treasury, cgMint, collectionsCreated: 10 }));
  cores.forEach((c, i) => conn.set(collectionMetaPda(i)[0], encodeCollectionMeta(i, c)));
  conn.set(pityPda(buyer)[0], encodePlayerPity(buyer, [0, 4, 0, 0]));
  const [pending] = pendingPackPda(buyer, nonce);
  const [randomness] = rngPda(RNG_KIND.PACK, buyer, nonce);
  const commitSlot = 4_000n;
  conn.set(pending, encodePendingPack({ buyer, sku: o.voucher ? 0 : o.sku ?? 1, qty: o.voucher ? 1 : o.qty ?? 1, opened: 0, randomness, commitSlot, paidCg: o.paidCg, nonce, revealed: o.revealed, value: o.revealed ? ORACLE_VALUE : undefined, voucher: o.voucher }));
  conn.set(randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.PACK)[0], queue, oracle, seedSlot: commitSlot, revealSlot: o.revealed ? commitSlot + 3n : 0n, value: o.revealed ? ORACLE_VALUE : undefined }), SB_OWNER);
  conn.set(oracle, encodeOracle('https://oracle-1.example.com'), SB_OWNER);
  if (o.withDbRow !== false) {
    if (o.voucher) ingestTx(tx([{ program: 'chip_core', name: 'VoucherIssued', data: { wallet: buyer.toBase58(), nonce: nonce.toString(), template: o.voucher.template, randomness: randomness.toBase58() } }]), db);
    else ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: buyer.toBase58(), sku: o.sku ?? 1, qty: o.qty ?? 1, currency: 0, amount: '33000000', nonce: nonce.toString(), randomness: randomness.toBase58() } }]), db);
  }
  return { conn, db, payer, buyer, nonce, pending, randomness, oracle, queue, treasury, cgMint, cores, commitSlot };
}

/** Minimal chip_core/arena "runtime" for the fake chain: reveal writes reveal_slot+value, open_pack bumps `opened` (closes on the last), fuse/close delete. */
function runtime(w: World, opts: { failOpenWith?: number; onOpen?: (packNo: number) => void } = {}) {
  const REVEAL = hex(ixDiscriminator('reveal_randomness')), OPEN = hex(ixDiscriminator('open_pack')), CLOSE = hex(ixDiscriminator('close_randomness')), FUSE = hex(ixDiscriminator('fuse_reveal'));
  const REVEAL_B = hex(ixDiscriminator('reveal_battle_randomness')), CLOSE_B = hex(ixDiscriminator('close_battle_randomness'));
  w.conn.onTx = (ixs) => {
    ixs.forEach((ix, i) => {
      if (!ix.programId.equals(CHIP_CORE_ID) && !ix.programId.equals(ARENA_ID)) return;
      const d = hex(ix.data.subarray(0, 8));
      if (d === REVEAL || d === REVEAL_B) {
        const key = ix.keys[1];
        const cur = decodeRandomness(w.conn.get(key)!);
        w.conn.set(key, encodeRandomness({ authority: cur.authority, queue: cur.queue, oracle: cur.oracle, seedSlot: cur.seedSlot, revealSlot: BigInt(w.conn.slot), value: ix.data.subarray(8 + 64 + 1, 8 + 64 + 1 + 32), lutSlot: cur.lutSlot }), SB_OWNER);
      } else if (d === OPEN) {
        const pendingKey = ix.keys[3]; // #12: [payer, config, ledger, pending, …]
        const cur = w.conn.get(pendingKey);
        if (!cur) throw new ProgramError(0xbc4 /* AccountNotInitialized */, i);
        const p = { buyer: new PublicKey(cur.subarray(8, 40)), sku: cur[40], qty: cur[41], opened: cur[42], randomness: new PublicKey(cur.subarray(43, 75)) };
        const packNo = ix.data[16];
        if (packNo !== p.opened) throw new ProgramError(6005 /* InvalidQuantity */, i);
        const rnd = decodeRandomness(w.conn.get(p.randomness)!);
        if (rnd.revealSlot === 0n) throw new ProgramError(6016 /* RandomnessNotResolved */, i);
        if (opts.failOpenWith) throw new ProgramError(opts.failOpenWith, i);
        opts.onOpen?.(packNo);
        if (p.opened + 1 >= p.qty) w.conn.del(pendingKey);
        else w.conn.set(pendingKey, encodePendingPack({ buyer: p.buyer, sku: p.sku, qty: p.qty, opened: p.opened + 1, randomness: p.randomness, commitSlot: w.commitSlot, nonce: w.nonce, revealed: true, value: rnd.value }));
      } else if (d === FUSE) {
        w.conn.del(ix.keys[3]); // #12: [payer, config, ledger, pending, …]
      } else if (d === CLOSE) {
        if (w.conn.get(ix.keys[4])) throw new ProgramError(6024 /* InvalidChipState */, i); // pinned PendingPack/PendingFusion must be gone
        w.conn.del(ix.keys[2]);
      } else if (d === CLOSE_B) {
        const battle = w.conn.get(ix.keys[4]);
        const status = battle?.[8 + 32 + 32 + 8 + 6 * 32 + 4 + 4 + 32 + 8]; // WagerBattle.status
        if (status !== 2 && status !== 3) throw new ProgramError(6003 /* BadStatus */, i); // battle must be Resolved/Cancelled
        w.conn.del(ix.keys[2]);
      }
    });
  };
}

describe('crank · instruction layouts (mirror programs/chip_core/src/instructions/{rng,packs,fusion}.rs)', () => {
  const payer = pk(), owner = pk(), nonce = 7n, oracle = pk(), queue = pk();
  it('reveal_randomness: 13 accounts in program order, data = disc ‖ sig[64] ‖ recovery_id ‖ value[32]', () => {
    const randomness = rngPda(RNG_KIND.PACK, owner, nonce)[0];
    const ix = revealRandomnessIx({ kind: RNG_KIND.PACK, payer, randomness, oracle, queue, signature: ORACLE_SIG, recoveryId: 1, value: ORACLE_VALUE });
    expect(ix.programId.equals(CHIP_CORE_ID)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      payer, randomness, rngAuthPda(RNG_KIND.PACK)[0], oracle, queue, sbOracleStatsPda(oracle)[0], sbRewardEscrow(randomness), sbStatePda()[0],
      new PublicKey('SysvarS1otHashes111111111111111111111111111'), SB_OWNER, new PublicKey('So11111111111111111111111111111111111111112'),
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), PublicKey.default,
    ].map((k) => k.toBase58()));
    expect(ix.keys.map((k) => (k.isSigner ? 's' : '') + (k.isWritable ? 'w' : 'r')).join(',')).toBe('sw,w,r,r,r,w,w,r,r,r,r,r,r');
    expect(ix.data.length).toBe(8 + 64 + 1 + 32);
    expect(hex(ix.data.subarray(0, 8))).toBe('1e8255dcd0501ca9');
    expect(hex(ix.data.subarray(8, 72))).toBe(hex(ORACLE_SIG));
    expect(ix.data[72]).toBe(1);
    expect(hex(ix.data.subarray(73))).toBe(hex(ORACLE_VALUE));
    // arena twin
    const b = revealRandomnessIx({ kind: RNG_KIND.BATTLE, payer, randomness: rngPda(RNG_KIND.BATTLE, owner, nonce)[0], oracle, queue, signature: ORACLE_SIG, recoveryId: 0, value: ORACLE_VALUE });
    expect(b.programId.equals(ARENA_ID)).toBe(true);
    expect(hex(b.data.subarray(0, 8))).toBe('b74978e7ef0abd5a');
    expect(b.keys[2].pubkey.equals(rngAuthPda(RNG_KIND.BATTLE)[0])).toBe(true);
    expect(() => revealRandomnessIx({ kind: RNG_KIND.PACK, payer, randomness, oracle, queue, signature: ORACLE_SIG.subarray(1), recoveryId: 1, value: ORACLE_VALUE })).toThrow(/64 bytes/);
  });
  it('close_randomness: pinned PDA per kind, LUT from lut_slot, data kind‖nonce (chip_core) / nonce (arena)', () => {
    const ix = closeRandomnessIx({ kind: RNG_KIND.PACK, payer, owner, nonce, lutSlot: 3_990n });
    const randomness = rngPda(RNG_KIND.PACK, owner, nonce)[0];
    const lutSigner = sbLutSignerPda(randomness)[0];
    expect(ix.keys.length).toBe(14);
    expect(ix.keys[1].pubkey.equals(owner)).toBe(true);
    expect(ix.keys[2].pubkey.equals(randomness)).toBe(true);
    expect(ix.keys[3].pubkey.equals(rngAuthPda(RNG_KIND.PACK)[0]) && ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(pendingPackPda(owner, nonce)[0])).toBe(true);
    expect(ix.keys[7].pubkey.equals(sbLutPda(lutSigner, 3_990n)[0])).toBe(true);
    expect(ix.keys[8].pubkey.equals(lutSigner)).toBe(true);
    expect(hex(ix.data)).toBe('f8105307bf85afac' + '00' + '0700000000000000');
    expect(closeRandomnessIx({ kind: RNG_KIND.FUSION, payer, owner, nonce, lutSlot: 1n }).keys[4].pubkey.equals(pendingFusionPda(owner, nonce)[0])).toBe(true);
    const b = closeRandomnessIx({ kind: RNG_KIND.BATTLE, payer, owner, nonce, lutSlot: 1n });
    expect(b.keys[4].pubkey.equals(battlePda(owner, nonce)[0])).toBe(true);
    expect(hex(b.data)).toBe('1bd71150ab869e2e' + '0700000000000000');
  });
  it('open_pack: 14 fixed accounts (#12: config ro, ledger shard, vault ro) + 4 per chip (asset, chip_state, collection_meta[rolled], core_collection); $CG optionals = program id when absent', () => {
    const randomness = rngPda(RNG_KIND.PACK, owner, nonce)[0];
    const cores = [pk(), pk(), pk()];
    const ix = openPackIx({ payer, buyer: owner, nonce, packNo: 2, qty: 5, randomness, rolledCollections: [2, 0, 2], coreCollectionOf: (i) => cores[i] });
    expect(ix.keys.length).toBe(14 + 12);
    const pending = pendingPackPda(owner, nonce)[0];
    expect(ix.keys[1].pubkey.equals(configPda()[0]) && !ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.equals(ledgerPdaOf(owner)[0]) && !ix.keys[2].isWritable).toBe(true); // pack 3/5 → shard read-only
    expect(ix.keys[3].pubkey.equals(pending)).toBe(true);
    expect(ix.keys[5].pubkey.equals(pityPda(owner)[0])).toBe(true);
    expect(ix.keys[7].pubkey.equals(vaultPda()[0]) && !ix.keys[7].isWritable).toBe(true);
    expect(ix.keys[8].pubkey.equals(CHIP_CORE_ID) && !ix.keys[8].isWritable).toBe(true);
    expect(ix.keys[14].pubkey.equals(assetPda(pending, 2, 0)[0])).toBe(true);
    expect(ix.keys[15].pubkey.equals(chipStatePda(assetPda(pending, 2, 0)[0])[0])).toBe(true);
    expect(ix.keys[16].pubkey.equals(collectionMetaPda(2)[0])).toBe(true);
    expect(ix.keys[17].pubkey.equals(cores[2])).toBe(true);
    expect(ix.keys[20].pubkey.equals(collectionMetaPda(0)[0])).toBe(true);
    expect(hex(ix.data)).toBe('4bcb90413ffd6755' + '0700000000000000' + '02');
    const cg = openPackIx({ payer, buyer: owner, nonce, packNo: 0, randomness, rolledCollections: [0], coreCollectionOf: () => cores[0], cg: { cgMint: pk(), treasury: pk() } });
    expect(cg.keys[2].isWritable).toBe(true); // qty 1 → pack 0 settles → shard writable
    expect(cg.keys[8].pubkey.equals(CHIP_CORE_ID)).toBe(false);
    expect(cg.keys[9].isWritable && cg.keys[10].isWritable).toBe(true);
    expect(openPackIx({ payer, buyer: owner, nonce, packNo: 4, qty: 5, randomness, rolledCollections: [0], coreCollectionOf: () => cores[0] }).keys[2].isWritable).toBe(true);
  });
  it('fuse_reveal: 16 fixed accounts (11 + #12 ledger shard + vault / cg_mint / vault_cg / token program for the SEC-M3 fee burn) + 4 per material; result asset = ["asset", pending, 0, 0]', () => {
    const randomness = rngPda(RNG_KIND.FUSION, owner, nonce)[0];
    const mats = [pk(), pk(), pk()].map((asset, i) => ({ asset, collectionIdx: i === 2 ? 4 : 3 }));
    const core = new Map([[3, pk()], [4, pk()]]);
    const cgMint = pk();
    const ix = fuseRevealIx({ payer, owner, nonce, randomness, resultCollectionIdx: 3, materials: mats, coreCollectionOf: (i) => core.get(i)!, cgMint });
    const pending = pendingFusionPda(owner, nonce)[0];
    expect(ix.keys.length).toBe(16 + 12);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[2].pubkey.equals(ledgerPdaOf(owner)[0]) && ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[8].pubkey.equals(assetPda(pending, 0, 0)[0])).toBe(true);
    expect(ix.keys[12].pubkey.equals(vaultPda()[0]) && ix.keys[12].isWritable).toBe(true);
    expect(ix.keys[13].pubkey.equals(cgMint)).toBe(true);
    expect(ix.keys[16].pubkey.equals(mats[0].asset)).toBe(true);
    expect(ix.keys[26].pubkey.equals(collectionMetaPda(4)[0])).toBe(true);
    expect(ix.keys[27].pubkey.equals(core.get(4)!)).toBe(true);
    expect(hex(ix.data)).toBe('67b5437253112c85' + '0700000000000000');
  });
  it('PDAs match the client / on-chain seeds', () => {
    const o = new PublicKey('HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho');
    expect(rngAuthPda(RNG_KIND.PACK)[0].toBase58()).toBe('8TV3LLVWNzUbtvCp2C4fiy5WruHLfAxZ3nACqzsfgxY8');
    expect(rngAuthPda(RNG_KIND.BATTLE)[0].toBase58()).toBe('ChdDyaYFFF2Sao2k1DEP5jgX4cc1fpSCSN14s7amoELG');
    expect(rngPda(RNG_KIND.PACK, o, 7n)[0].toBase58()).toBe('93nCoQQNvMzFoebdiBAaLC3PD4BYnVaVL5vNAfzSt51R');
    expect(rngPda(RNG_KIND.BATTLE, o, 7n)[0].toBase58()).toBe('GuUbqXRaXA6e6WAwbSUq7eRbngsq8bQeQ4obewsp7rEu');
    expect(pendingPackPda(o, 7n)[0].toBase58()).toBe('67V8LExYNyY1h1gGkQNUBQ7dpFaM7xQuFTUZLtZ3JHVm');
    expect(configPda()[0].toBase58()).toBe('EhxhoujVrKmDJuXv1Q3PeRTzYdDaYxYPqWinJ2PCXAgy');
    expect(sbStatePda()[0].toBase58()).toBe('4UFmCebEmzESoDTtHrmaftXj7YAsAH4HMios3yMWyVUT'); // devnet Aio4… ["STATE"]
  });
  it('raw Switchboard decoders: RandomnessAccountData offsets + OracleAccountData.gateway_uri @3584 (NUL-trimmed)', () => {
    const data = encodeRandomness({ authority: rngAuthPda(RNG_KIND.PACK)[0], queue: pk(), oracle: pk(), seedSlot: 123n, revealSlot: 130n, value: ORACLE_VALUE, lutSlot: 100n });
    expect(hex(data.subarray(0, 8))).toBe('0a42e587dcefd972');
    expect(data.length).toBe(480);
    const r = decodeRandomness(data);
    expect(r.seedSlot).toBe(123n); expect(r.revealSlot).toBe(130n); expect(r.lutSlot).toBe(100n); expect(hex(r.value)).toBe(hex(ORACLE_VALUE));
    expect(r.authority.equals(rngAuthPda(RNG_KIND.PACK)[0])).toBe(true);
    expect(decodeOracleGateway(encodeOracle('https://xyz.switchboard.xyz/'))).toBe('https://xyz.switchboard.xyz/');
    expect(() => decodeOracleGateway(data)).toThrow(/OracleAccountData/);
    expect(() => decodeRandomness(encodeOracle('x'))).toThrow(/RandomnessAccountData/);
  });
  it('packSeed / toEconPack mirror packs.rs open_pack (keccak(value ‖ pack_no) only for bundles; LIVE odds)', () => {
    expect(hex(packSeed(ORACLE_VALUE, 1, 0))).toBe(hex(ORACLE_VALUE));
    expect(hex(packSeed(ORACLE_VALUE, 5, 0))).not.toBe(hex(ORACLE_VALUE));
    expect(hex(packSeed(ORACLE_VALUE, 5, 1))).not.toBe(hex(packSeed(ORACLE_VALUE, 5, 0)));
    const e = toEconPack(1, { ...DEFAULT_PACK, oddsBps: [9_000, 1_000, 0, 0, 0, 0, 0, 0, 0], pityTier: 0 });
    expect(e.oddsBps).toEqual([9_000, 1_000, 0, 0, 0, 0, 0, 0, 0]); expect(e.pity).toBeNull(); expect(e.id).toBe('standard');
    expect(toEconPack(2, DEFAULT_PACK).pity).toEqual({ tier: 6, hardAt: 60, softStart: 30, softStepBps: 25 });
    expect(toEconPack(0, { ...DEFAULT_PACK, dailyCap: 1 }).dailyCap).toBe(1);
    expect(PACKS.standard.chips).toBe(3);
  });
  it('customErrorCode parses messages, logs and confirmTransaction errors; clampCuPrice keeps fee ≤ 0.001 SOL', () => {
    expect(customErrorCode(new Error('failed: custom program error: 0x1775'))).toBe(6005);
    expect(customErrorCode({ message: 'x', logs: ['Program GC failed: custom program error: 0x1780'] })).toBe(6016);
    expect(customErrorCode({ message: '{"InstructionError":[1,{"Custom":6015}]}' })).toBe(6015);
    expect(customErrorCode(new Error('blockhash expired'))).toBeUndefined();
    expect(clampCuPrice(7_000, 700_000)).toBe(7_000);
    expect(clampCuPrice(500, 700_000)).toBe(1_000); // floor
    expect(clampCuPrice(5_000_000, 700_000)).toBe(200_000); // hard cap (200k µlam/CU × 700k CU = 0.00014 SOL, under the budget)
    expect(clampCuPrice(5_000_000, 700_000, { floor: 1_000, cap: 200_000, maxFeeLamports: 100_000 })).toBe(Math.floor((100_000 * 1_000_000) / 700_000)); // budget cap binds
  });
});

describe('crank · oracle gateway', () => {
  it('POSTs the SDK payload {slothash[], randomness_key hex, slot, rpc} and decodes {signature b64, recovery_id, value[]}', async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const f = gateway({ onCall: (url, body) => { seen = { url, body: body as Record<string, unknown> }; } });
    const randomness = pk();
    const rnd = decodeRandomness(encodeRandomness({ authority: pk(), queue: pk(), oracle: pk(), seedSlot: 4_000n, seedSlothash: new Uint8Array(32).fill(7) }));
    const r = await fetchGatewayReveal(f, 'https://oracle-1.example.com/', randomness, rnd, 'https://api.devnet.solana.com');
    expect(seen!.url).toBe('https://oracle-1.example.com/gateway/api/v1/randomness_reveal');
    expect(seen!.body).toEqual({ slothash: Array(32).fill(7), randomness_key: hex(randomness.toBytes()), slot: 4000, rpc: 'https://api.devnet.solana.com' });
    expect(hex(r.signature)).toBe(hex(ORACLE_SIG)); expect(r.recoveryId).toBe(1); expect(hex(r.value)).toBe(hex(ORACLE_VALUE));
  });
  it('HTTP / network / malformed answers → GatewayError (retryable, never a tx)', async () => {
    const rnd = decodeRandomness(encodeRandomness({ authority: pk(), queue: pk(), oracle: pk(), seedSlot: 1n }));
    await expect(fetchGatewayReveal(gateway({ fail: 500 }), 'https://g', pk(), rnd, 'r')).rejects.toBeInstanceOf(GatewayError);
    await expect(fetchGatewayReveal(gateway({ fail: 'network' }), 'https://g', pk(), rnd, 'r')).rejects.toThrow(/unreachable/);
    const bad: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ signature: 'AAAA', recovery_id: 0, value: [1, 2] }) });
    await expect(fetchGatewayReveal(bad, 'https://g', pk(), rnd, 'r')).rejects.toThrow(/malformed/);
  });
});

describe('crank · pack pipeline', () => {
  let w: World;
  beforeEach(() => { w = world(); });

  it('discovers the purchase from the indexer DB, reveals via the gateway, opens with the pre-simulated collections, then reclaims rent', async () => {
    runtime(w);
    const f = gateway();
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f, log: (s) => log.push(s) });
    expect(await c.tick()).toBe(1);
    expect(f.calls).toBe(1);
    // without a lookup table reveal + open (33 keys) do not fit one tx → tx 1 = reveal (preflight skipped),
    // tx 2 = open_pack, tx 3 = close_randomness
    expect(w.conn.sent.length).toBe(3);
    const [t1, t2, t3] = w.conn.sent;
    expect(t1.skipPreflight).toBe(true);
    expect(t1.ixs.length).toBe(2 + 1); // 2 compute-budget + reveal
    expect(hex(t1.ixs[2].data.subarray(0, 8))).toBe('1e8255dcd0501ca9');
    expect(t2.skipPreflight).toBe(false);
    const open = t2.ixs[2];
    expect(hex(open.data.subarray(0, 8))).toBe('4bcb90413ffd6755');
    // collections passed == expandRandomness(value, live pack, pity=4, pool=10) — what open_pack will re-derive
    const rolls = expandRandomness(ORACLE_VALUE, toEconPack(1, DEFAULT_PACK), 4, 10);
    const metas = rolls.map((r) => collectionMetaPda(r.collectionIdx)[0].toBase58());
    expect([open.keys[16], open.keys[20], open.keys[24]].map((k) => k.toBase58())).toEqual(metas); // 14 fixed keys since #12
    expect(open.keys[17].equals(w.cores[rolls[0].collectionIdx])).toBe(true);
    expect(hex(t3.ixs[2].data.subarray(0, 8))).toBe('f8105307bf85afac');
    expect(t3.skipPreflight).toBe(false);
    // state machine
    const job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('closed');
    expect(job.reveal_sig).toBe(t1.signature);
    expect(JSON.parse(job.settle_sigs)).toEqual([t2.signature]);
    expect(job.close_sig).toBe(t3.signature);
    expect(w.conn.get(w.pending)).toBeUndefined();
    expect(w.conn.get(w.randomness)).toBeUndefined();
    expect(c.stats).toMatchObject({ reveals: 1, opens: 1, closes: 1, errors: 0 });
    expect(log.some((l) => l.includes('open_pack') && l.includes('#1/1'))).toBe(true);
    // idempotent: nothing left to do
    expect(await c.tick()).toBe(0);
    expect(w.conn.sent.length).toBe(3);
    expect(crankStatus(w.db)).toMatchObject({ pending: 0, closed: 1, abandoned: 0, healthy: true });
  });

  it('#28 quest chip voucher: discovered from the vouchers table, opened like a pack with ONE chip rolled from the template odds (pity ignored), 3-chip CU budget', async () => {
    const voucher = { template: 1, odds: [3000, 5000, 1800, 200, 0, 0, 0, 0, 0], soulboundDays: 7 };
    w = world({ voucher });
    expect(w.db.get(`SELECT status FROM vouchers WHERE wallet = ? AND nonce = '7'`, w.buyer.toBase58())).toEqual({ status: 'pending' });
    expect(w.db.get(`SELECT 1 FROM pack_purchases WHERE buyer = ?`, w.buyer.toBase58())).toBeUndefined(); // never a "purchase"
    runtime(w);
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway() });
    expect(await c.tick()).toBe(1);
    // same pipeline as a purchase; with a single chip the reveal + open_pack fit ONE tx even without a LUT → [reveal+open, close]
    expect(w.conn.sent.length).toBe(2);
    expect(hex(w.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe('1e8255dcd0501ca9');
    const open = w.conn.sent[0].ixs[3];
    expect(hex(open.data.subarray(0, 8))).toBe('4bcb90413ffd6755');
    expect(hex(w.conn.sent[1].ixs[2].data.subarray(0, 8))).toBe('f8105307bf85afac');
    expect(open.keys.length).toBe(14 + 4); // exactly one chip
    // the collection passed == expandRandomness(value, synthetic voucher def, pity irrelevant, pool = all 10)
    const [roll] = expandRandomness(ORACLE_VALUE, voucherEconPack({ voucherOdds: voucher.odds }), 999, 10);
    expect(open.keys[16].equals(collectionMetaPda(roll.collectionIdx)[0])).toBe(true);
    expect(open.keys[17].equals(w.cores[roll.collectionIdx])).toBe(true);
    expect(roll.rarity).toBeLessThanOrEqual(3); // template 1 never rolls above Rare+
    expect(w.conn.sent[0].ixs[0].data.readUInt32LE(1)).toBe(CU.OPEN_3 + CU.REVEAL_ONLY); // setComputeUnitLimit(units) = [0x02, u32 le]; combined tx = open budget + reveal
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
    expect(c.stats).toMatchObject({ reveals: 1, opens: 1, closes: 1, errors: 0 });
    expect(await c.tick()).toBe(0);
  });

  it('bundle ×3: reveal only in the first tx, sub-seeds per pack_no, pity re-read between packs, $CG treasury ATA on the last', async () => {
    w = world({ qty: 3, paidCg: 750_000_000n });
    const opened: number[] = [];
    runtime(w, { onOpen: (n) => { opened.push(n); w.conn.set(pityPda(w.buyer)[0], encodePlayerPity(w.buyer, [0, 4 + n + 1, 0, 0])); } });
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway() });
    await c.tick();
    expect(opened).toEqual([0, 1, 2]);
    expect(w.conn.sent.length).toBe(5); // reveal + 3 opens + close
    expect(hex(w.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe('1e8255dcd0501ca9');
    const opens = w.conn.sent.slice(1, 4);
    expect(opens[0].ixs.length).toBe(2 + 1); // open only (reveal went first)
    expect(opens[1].ixs.length).toBe(2 + 1); // open only
    expect(opens[2].ixs.length).toBe(2 + 2); // create ATA (treasury $CG) + open
    expect(opens[2].ixs[2].programId.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    // per-pack seed + pity: pack 1 uses pity 4, pack 2 pity 5 (as the runtime advanced it), pack 3 pity 6
    const econ = toEconPack(1, DEFAULT_PACK);
    for (const [i, t] of opens.entries()) {
      const openIx = t.ixs[t.ixs.length - 1];
      expect(openIx.data[16]).toBe(i);
      const rolls = expandRandomness(packSeed(ORACLE_VALUE, 3, i), econ, 4 + i, 10);
      expect(openIx.keys[16].equals(collectionMetaPda(rolls[0].collectionIdx)[0])).toBe(true);
      expect(openIx.keys[8].equals(w.cgMint)).toBe(true); // $CG optionals present on every pack (program ignores them until the last)
    }
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
    expect(c.stats.opens).toBe(3);
  });

  it('resumes a half-opened bundle from PendingPack.value without touching the oracle (SEC-C2)', async () => {
    w = world({ qty: 2, revealed: true });
    w.conn.set(w.pending, encodePendingPack({ buyer: w.buyer, sku: 1, qty: 2, opened: 1, randomness: w.randomness, commitSlot: w.commitSlot, nonce: w.nonce, revealed: true, value: ORACLE_VALUE }));
    runtime(w);
    const f = gateway();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f });
    await c.tick();
    expect(f.calls).toBe(0);
    expect(w.conn.sent[0].ixs.length).toBe(2 + 1);
    expect(w.conn.sent[0].ixs[2].data[16]).toBe(1); // pack_no 1
    expect(w.conn.sent[0].skipPreflight).toBe(false);
    expect(c.stats).toMatchObject({ reveals: 0, opens: 1, closes: 1 });
  });

  it('already revealed on chain (player / other worker) → no gateway call, plain open_pack', async () => {
    w.conn.set(w.randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.PACK)[0], queue: w.queue, oracle: w.oracle, seedSlot: w.commitSlot, revealSlot: 4_005n, value: ORACLE_VALUE }), SB_OWNER);
    runtime(w);
    const f = gateway();
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f });
    await c.tick();
    expect(f.calls).toBe(0);
    expect(w.conn.sent[0].ixs.length).toBe(3);
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
  });

  it('oracle not ready → GatewayError, exponential backoff, no transaction; later success', async () => {
    runtime(w);
    let now = 1_000_000;
    let ready = false;
    const f: FetchLike = async (url, init) => (ready ? gateway()(url, init) : { ok: false, status: 404, text: async () => 'not yet' });
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f, log: (s) => log.push(s), now: () => now });
    await c.tick();
    let job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('pending'); expect(job.attempts).toBe(1); expect(job.next_at).toBe(now + 1_000); expect(job.last_error).toMatch(/gateway 404/);
    expect(w.conn.sent.length).toBe(0);
    expect(await c.tick()).toBe(0); // not due yet
    now += 1_001;
    await c.tick();
    job = c.job(job.key)!;
    expect(job.attempts).toBe(2); expect(job.next_at).toBe(now + 2_000);
    expect(c.stats.gatewayErrors).toBe(2);
    now += 2_001; ready = true;
    await c.tick();
    expect(c.job(job.key)!.phase).toBe('closed');
    expect(crankStatus(w.db, now)).toMatchObject({ closed: 1, healthy: true });
  });

  it('refund window open + oracle silent → phase stale (never cancels for the player), re-checked later; rent reclaimed after the refund', async () => {
    runtime(w);
    w.conn.slot = Number(w.commitSlot) + STALE_PACK_SLOTS + 1;
    let now = 5_000_000;
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway({ fail: 404 }), log: (s) => log.push(s), now: () => now });
    await c.tick();
    let job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('stale');
    expect(job.next_at).toBe(now + 10 * 60_000);
    expect(w.conn.sent.length).toBe(0);
    expect(log.some((l) => /stale/.test(l))).toBe(true);
    // the buyer calls cancel_stale_pack from the app → PendingPack gone; the crank returns rent
    w.conn.del(w.pending);
    now += 10 * 60_000 + 1;
    await c.tick();
    job = c.job(job.key)!;
    expect(job.phase).toBe('closed');
    expect(w.conn.sent.length).toBe(1);
    expect(hex(w.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe('f8105307bf85afac');
    expect(w.conn.get(w.randomness)).toBeUndefined();
  });

  it('lost the race: another opener bumped `opened` (InvalidQuantity) → re-reads and finishes the rest of the bundle', async () => {
    w = world({ qty: 2 });
    runtime(w);
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway() });
    // between our reveal and our open_pack(0), "someone" opened pack 0 → our open fails with InvalidQuantity
    const realOnTx = w.conn.onTx;
    let injected = false;
    w.conn.onTx = (ixs) => {
      const isOpen = ixs.some((ix) => ix.data.subarray(0, 8).equals(ixDiscriminator('open_pack')));
      if (isOpen && !injected) {
        injected = true;
        const rnd = decodeRandomness(w.conn.get(w.randomness)!);
        w.conn.set(w.pending, encodePendingPack({ buyer: w.buyer, sku: 1, qty: 2, opened: 1, randomness: w.randomness, commitSlot: w.commitSlot, nonce: w.nonce, revealed: true, value: rnd.value }));
        throw new ProgramError(6005, 2);
      }
      realOnTx(ixs);
    };
    await c.tick();
    const job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('closed');
    expect(c.stats.errors).toBe(0);
    // sent: reveal, failed open (pack 0), open pack 1, close
    expect(w.conn.sent.length).toBe(4);
    expect(w.conn.sent[1].err?.code).toBe(6005);
    expect(w.conn.sent[2].ixs.length).toBe(3);
    expect(w.conn.sent[2].ixs[2].data[16]).toBe(1);
  });

  it('a genuine program error backs off, and repeated failure parks the job as abandoned with an alert', async () => {
    runtime(w, { failOpenWith: 6019 /* InvalidCollection */ });
    let now = 9_000_000;
    const log: string[] = [];
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), log: (s) => log.push(s), now: () => now });
    await c.tick();
    let job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('pending'); expect(job.attempts).toBe(1); expect(job.last_error).toMatch(/custom 6019/);
    for (let i = 0; i < 70 && job.phase !== 'abandoned'; i++) { now = job.next_at + 1; await c.tick(); job = c.job(job.key)!; }
    expect(job.phase).toBe('abandoned');
    expect(job.attempts).toBe(60);
    expect(log.some((l) => l.includes('ALERT') && l.includes('abandoned'))).toBe(true);
    expect(crankStatus(w.db, now).healthy).toBe(false);
    // abandoned jobs are retried once an hour (the parked next_at) — the program may have been fixed
    now = job.next_at + 1;
    runtime(w);
    await c.tick();
    expect(c.job(job.key)!.phase).toBe('closed');
  });

  it('payer below the hard floor → nothing is sent and the gateway is not called; job parked 30 s; alert once below the soft threshold', async () => {
    runtime(w);
    w.conn.balanceLamports = 10_000_000; // 0.01 SOL < 0.05 floor
    const log: string[] = [];
    const f = gateway();
    let now = 3_000_000;
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: f, log: (s) => log.push(s), now: () => now });
    await c.tick();
    expect(w.conn.sent.length).toBe(0);
    expect(f.calls).toBe(0);
    const job = c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!;
    expect(job.phase).toBe('pending');
    expect(job.next_at).toBe(now + 30_000);
    expect(log.filter((l) => l.includes('ALERT payer')).length).toBe(1);
    // topped up → proceeds normally
    w.conn.balanceLamports = 1_000_000_000; now += 60_001;
    await c.tick();
    expect(c.job(job.key)!.phase).toBe('closed');
  });

  it('on-chain sweep discovers packs/fusions/battles the DB never saw, and history rows only get a rent reclaim', async () => {
    w = world({ withDbRow: false });
    runtime(w);
    // an old purchase in the DB that was opened before the crank existed: randomness still on chain → close only
    const oldBuyer = pk(), oldNonce = 3n;
    const [oldRng] = rngPda(RNG_KIND.PACK, oldBuyer, oldNonce);
    w.conn.set(oldRng, encodeRandomness({ authority: rngAuthPda(RNG_KIND.PACK)[0], queue: w.queue, oracle: w.oracle, seedSlot: 100n, revealSlot: 105n, value: ORACLE_VALUE, lutSlot: 90n }), SB_OWNER);
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: oldBuyer.toBase58(), sku: 1, qty: 1, currency: 0, amount: '1', nonce: '3', randomness: oldRng.toBase58() } }]), w.db);
    ingestTx(tx([{ program: 'chip_core', name: 'PackOpened', data: { buyer: oldBuyer.toBase58(), sku: 1, nonce: '3', assets: [pk().toBase58(), pk().toBase58(), pk().toBase58(), PublicKey.default.toBase58(), PublicKey.default.toBase58()], rarities: [0, 0, 1, 0, 0], collections: [1, 2, 3, 0, 0], count: 3, roll: 'ab'.repeat(32), pityBefore: 0, pityAfter: 1 } }]), w.db);
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway() });
    expect(await c.tick()).toBe(1); // only the history row (no sweep yet) → close_randomness
    expect(w.conn.get(oldRng)).toBeUndefined();
    expect(c.job(jobKey(RNG_KIND.PACK, oldBuyer, oldNonce))!.phase).toBe('closed');
    // with the sweep, the DB-less pending pack is found and opened
    await c.tick({ sweep: true });
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
    expect(c.stats.opens).toBe(1);
  });
});

describe('crank · fusions and wagers', () => {
  it('fusion: reveal + fuse_reveal with materials\' collections from ChipState, then rent reclaim', async () => {
    const w = world({ withDbRow: false });
    runtime(w);
    w.conn.del(w.pending); w.conn.del(w.randomness);
    const owner = pk(), nonce = 11n;
    const [pending] = pendingFusionPda(owner, nonce);
    const [randomness] = rngPda(RNG_KIND.FUSION, owner, nonce);
    const mats = [pk(), pk(), pk()];
    mats.forEach((m, i) => w.conn.set(chipStatePda(m)[0], encodeChipState(m, i === 1 ? 5 : 2, 4)));
    w.conn.set(pending, encodePendingFusion({ owner, recipe: 4, materials: mats, resultCollectionIdx: 2, randomness, commitSlot: 4_100n, nonce }));
    w.conn.set(randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.FUSION)[0], queue: w.queue, oracle: w.oracle, seedSlot: 4_100n }), SB_OWNER);
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway() });
    await c.tick({ sweep: true });
    const job = c.job(jobKey(RNG_KIND.FUSION, owner, nonce))!;
    expect(job.phase).toBe('closed');
    const fuseTxs = w.conn.sent.filter((t) => t.ixs.some((ix) => hex(ix.data.subarray(0, 8)) === '67b5437253112c85'));
    expect(fuseTxs.length).toBe(1);
    const fuse = fuseTxs[0].ixs[2];
    const revealIdx = w.conn.sent.findIndex((t) => hex(t.ixs[2].data.subarray(0, 8)) === '1e8255dcd0501ca9');
    expect(revealIdx).toBeGreaterThanOrEqual(0);
    expect(revealIdx).toBeLessThan(w.conn.sent.indexOf(fuseTxs[0])); // reveal lands before the settle
    expect(fuse.keys[6].equals(collectionMetaPda(2)[0])).toBe(true);
    expect(fuse.keys[7].equals(w.cores[2])).toBe(true);
    expect(fuse.keys[16 + 4 + 2].equals(collectionMetaPda(5)[0])).toBe(true); // material 1 in collection 5 (16 fixed keys since SEC-M3 + #12)
    expect(fuse.keys[16 + 4 + 3].equals(w.cores[5])).toBe(true);
    expect(c.stats.fusions).toBe(1);
    expect(w.conn.get(randomness)).toBeUndefined();
  });

  it('wager: reveal_battle_randomness only (the battle oracle resolves), then close after Resolved/Cancelled', async () => {
    const w = world({ withDbRow: false });
    runtime(w);
    w.conn.del(w.pending); w.conn.del(w.randomness);
    const challenger = pk(), nonce = 21n;
    const [battle] = battlePda(challenger, nonce);
    const [randomness] = rngPda(RNG_KIND.BATTLE, challenger, nonce);
    w.conn.set(battle, encodeWagerBattle({ challenger, opponent: pk(), randomness, commitSlot: 4_200n, status: 1, nonce }), ARENA_ID);
    w.conn.set(randomness, encodeRandomness({ authority: rngAuthPda(RNG_KIND.BATTLE)[0], queue: w.queue, oracle: w.oracle, seedSlot: 4_200n }), SB_OWNER);
    let now = 7_000_000;
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), now: () => now });
    await c.tick({ sweep: true });
    let job = c.job(jobKey(RNG_KIND.BATTLE, challenger, nonce))!;
    expect(job.phase).toBe('pending');
    expect(w.conn.sent.length).toBe(1);
    expect(hex(w.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe('b74978e7ef0abd5a');
    expect(w.conn.sent[0].ixs[2].programId.equals(ARENA_ID)).toBe(true);
    expect(decodeRandomness(w.conn.get(randomness)!).revealSlot).toBeGreaterThan(0n);
    expect(job.next_at).toBe(now + 30_000);
    // still Accepted → nothing more (no cancel: only the players may)
    now += 30_001; await c.tick();
    expect(w.conn.sent.length).toBe(1);
    // oracle resolved it
    w.conn.set(battle, encodeWagerBattle({ challenger, opponent: pk(), randomness, commitSlot: 4_200n, status: 2, nonce }), ARENA_ID);
    now += 30_001; await c.tick();
    job = c.job(job.key)!;
    expect(job.phase).toBe('closed');
    expect(hex(w.conn.sent[1].ixs[2].data.subarray(0, 8))).toBe('1bd71150ab869e2e');
    expect(w.conn.get(randomness)).toBeUndefined();
  });

  it('with our static lookup table reveal + open_pack ×5 ($CG) fits one transaction; without it they are split (docs/06 §4.2 вывод 3)', async () => {
    const w = world({ qty: 1, sku: 2, paidCg: 1_000_000n });
    runtime(w);
    const lut = new AddressLookupTableAccount({ key: pk(), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [
      CHIP_CORE_ID, MPL_CORE_ID, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, SYSVAR_SLOT_HASHES_ID, WSOL_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, SB_OWNER, sbStatePda()[0], rngAuthPda(RNG_KIND.PACK)[0],
      configPda()[0], vaultPda()[0], ...allLedgerPdas(), w.queue, w.treasury, w.cgMint, ...w.cores, ...w.cores.map((_, i) => collectionMetaPda(i)[0]),
    ] } });
    const c = new Crank({ connection: asConn(w.conn), payer: w.payer, db: w.db, fetch: gateway(), lookupTables: [lut] });
    await c.tick();
    expect(w.conn.sent.length).toBe(2); // [reveal, createATA, open] + close
    const t = w.conn.sent[0];
    expect(t.skipPreflight).toBe(true);
    expect(t.ixs.map((ix) => hex(ix.data.subarray(0, 8)).slice(0, 16))).toEqual(expect.arrayContaining(['1e8255dcd0501ca9', '4bcb90413ffd6755']));
    expect(t.ixs.length).toBe(2 + 3); // reveal + createATA + open
    expect(c.job(jobKey(RNG_KIND.PACK, w.buyer, w.nonce))!.phase).toBe('closed');
    // without a LUT a 5-chip $CG open does not fit even on its own → the reveal still lands (chain fact),
    // the open fails with a clear, retryable "configure LOOKUP_TABLE" error (never a silent stall)
    const w2 = world({ qty: 1, sku: 2, paidCg: 1_000_000n });
    runtime(w2);
    const log: string[] = [];
    const c2 = new Crank({ connection: asConn(w2.conn), payer: w2.payer, db: w2.db, fetch: gateway(), log: (s) => log.push(s) });
    await c2.tick();
    expect(w2.conn.sent.length).toBe(1);
    expect(hex(w2.conn.sent[0].ixs[2].data.subarray(0, 8))).toBe('1e8255dcd0501ca9');
    const j2 = c2.job(jobKey(RNG_KIND.PACK, w2.buyer, w2.nonce))!;
    expect(j2.phase).toBe('pending');
    expect(j2.last_error).toMatch(/LOOKUP_TABLE/);
    expect(j2.reveal_sig).toBe(w2.conn.sent[0].signature); // the landed reveal is recorded at once; the next pass sees reveal_slot > 0 and skips the gateway
    expect(decodeRandomness(w2.conn.get(w2.randomness)!).revealSlot).toBeGreaterThan(0n);
    // 3-chip packs fit without a LUT (split into reveal + open)
    const w3 = world({ qty: 1, sku: 1 });
    runtime(w3);
    const c3 = new Crank({ connection: asConn(w3.conn), payer: w3.payer, db: w3.db, fetch: gateway() });
    await c3.tick();
    expect(w3.conn.sent.length).toBe(3);
    expect(c3.job(jobKey(RNG_KIND.PACK, w3.buyer, w3.nonce))!.phase).toBe('closed');
  });

  it('CU limits: bundle of 5 uses the larger open budget; reveal-only and close are small', () => {
    expect(CU.OPEN_5).toBeGreaterThan(CU.OPEN_3);
    expect(CU.OPEN_5).toBeLessThanOrEqual(1_400_000);
    expect(CU.REVEAL_ONLY).toBeLessThan(CU.FUSE_REVEAL);
    expect(CU.CLOSE).toBeLessThanOrEqual(200_000);
  });
});

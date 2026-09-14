import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PACKS, expandRandomness, uniformBps } from '@guttercaps/economy';
import golden from '../../../packages/economy/golden/pack_expand.json';
import { BorshReader, BorshWriter, u64le } from './borsh';
import { accountDiscriminator, ixDiscriminator, eventsFromLogs, findEvent, optional, parseCustomError, concat, eventDiscriminator } from './anchor';
import {
  decodeChipState, decodeGameConfig, decodePendingPack, decodePlayerPity, decodeListing, decodeTokenStake, readPackOpened, chipIsFree, CHIP_FLAG,
} from './accounts';
import { assetPda, chipStatePda, configPda, pendingPackPda, ata, freshNonce, rewardRootPda } from './pdas';
import { buyPackIx, openPackIx, payServiceIx, Currency, fuseIx } from './ix/chipCore';
import { saleSplit } from './ix/market';
import { wagerSplit, leagueOf } from './ix/arena';
import { unstakePenalty } from './ix/staking';
import { usdCentsToUnits, usdCentsToLamports, usdCentsToMicroSkr, priceUsd, assertFeed } from './pyth';
import { PYTH_SOL_USD_FEED_ID_HEX, PYTH_SKR_USD_FEED_ID_HEX } from './ids';
import { packSeed } from './flows/packFlow';
import { describeProgramError, humanizeTxError } from './errors';
import { revealValueFromIx } from './switchboard';
import { TransactionInstruction } from '@solana/web3.js';
import { CHIP_CORE_ID } from './ids';
import { base58Encode } from '@/shared/lib/base58';
import { fmtUnits, parseUnits } from '@/shared/lib/format';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('borsh', () => {
  it('round-trips scalar types', () => {
    const k = Keypair.generate().publicKey;
    const w = new BorshWriter().u8(7).u16(65_000).u32(4_000_000_000).u64(2n ** 63n + 5n).i64(-42n).u128(2n ** 100n + 1n).bool(true).pubkey(k).string('héllo');
    w.option(9, (x) => w.u8(x)).vec([1, 2, 3], (x) => w.u16(x));
    const r = new BorshReader(w.toBytes());
    expect(r.u8()).toBe(7); expect(r.u16()).toBe(65_000); expect(r.u32()).toBe(4_000_000_000); expect(r.u64()).toBe(2n ** 63n + 5n); expect(r.i64()).toBe(-42n);
    expect(r.u128()).toBe(2n ** 100n + 1n); expect(r.bool()).toBe(true); expect(r.pubkey().equals(k)).toBe(true); expect(r.string()).toBe('héllo');
    expect(r.option(() => r.u8())).toBe(9); expect(r.vec(() => r.u16())).toEqual([1, 2, 3]); expect(r.remaining).toBe(0);
  });
  it('u64le matches Rust to_le_bytes', () => {
    expect(hex(u64le(1n))).toBe('0100000000000000');
    expect(hex(u64le(0x0102030405060708n))).toBe('0807060504030201');
  });
});

describe('anchor conventions', () => {
  it('discriminators are sha256 prefixes', () => {
    // well-known Anchor values
    expect(hex(ixDiscriminator('initialize'))).toBe('afaf6d1f0d989bed');
    expect(hex(accountDiscriminator('GameConfig'))).toHaveLength(16);
    expect(hex(accountDiscriminator('GameConfig'))).not.toBe(hex(accountDiscriminator('ChipState')));
  });
  it('optional account = program id readonly', () => {
    const m = optional(undefined, CHIP_CORE_ID);
    expect(m.pubkey.equals(CHIP_CORE_ID)).toBe(true); expect(m.isWritable).toBe(false); expect(m.isSigner).toBe(false);
    const k = Keypair.generate().publicKey;
    expect(optional(k, CHIP_CORE_ID).isWritable).toBe(true);
  });
  it('parses custom program errors from messages and logs', () => {
    expect(parseCustomError({ message: 'failed: custom program error: 0x1776' })).toEqual({ code: 6006, programId: undefined });
    const logs = [`Program ${CHIP_CORE_ID.toBase58()} invoke [1]`, `Program ${CHIP_CORE_ID.toBase58()} failed: custom program error: 0x1770`];
    expect(parseCustomError({ message: 'x', logs })?.programId).toBe(CHIP_CORE_ID.toBase58());
    expect(describeProgramError(6006, CHIP_CORE_ID.toBase58())).toBe('chip_core: Daily purchase cap reached for this SKU');
    expect(humanizeTxError({ message: 'custom program error: 0x1770', logs })).toBe('chip_core: Game is paused');
    expect(humanizeTxError(new Error('User rejected the request.'))).toBe('Signature rejected in wallet');
  });
  it('extracts events from logs and decodes PackOpened', () => {
    const buyer = Keypair.generate().publicKey;
    const assets = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const roll = new Uint8Array(32).fill(0xab);
    const w = new BorshWriter().pubkey(buyer).u8(1).u64(77n);
    for (const a of assets) w.pubkey(a);
    w.bytes(Uint8Array.from([0, 2, 1, 0, 0])).bytes(Uint8Array.from([3, 7, 1, 0, 0])).u8(3).bytes(roll).u16(22).u16(23);
    const payload = concat(eventDiscriminator('PackOpened'), w.toBytes());
    const b64 = btoa(String.fromCharCode(...payload));
    const logs = ['Program log: Instruction: OpenPack', `Program data: ${b64}`, 'Program log: done'];
    expect(eventsFromLogs(logs)).toHaveLength(1);
    const ev = findEvent(logs, 'PackOpened', readPackOpened)!;
    expect(ev.buyer.equals(buyer)).toBe(true); expect(ev.nonce).toBe(77n); expect(ev.count).toBe(3);
    expect(ev.assets).toHaveLength(3); expect(ev.rarities).toEqual([0, 2, 1]); expect(ev.collections).toEqual([3, 7, 1]);
    expect(hex(ev.roll)).toBe('ab'.repeat(32)); expect(ev.pityBefore).toBe(22); expect(ev.pityAfter).toBe(23);
  });
});

describe('account layouts (sizes = 8 + INIT_SPACE)', () => {
  const pk = () => Keypair.generate().publicKey;
  it('ChipState = 8 + 32+1+1+1+8+1+8+8+1 = 69', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('ChipState')).pubkey(pk()).u8(3).u8(4).u8(2).u64(1234n).u8(CHIP_FLAG.LISTED).i64(0n).i64(1_700_000_000n).u8(254);
    const buf = w.toBytes();
    expect(buf.length).toBe(69);
    const c = decodeChipState(buf);
    expect(c.rarity).toBe(4); expect(c.level).toBe(2); expect(c.index).toBe(1234n); expect(c.flags & CHIP_FLAG.LISTED).toBeTruthy();
    expect(chipIsFree(c)).toBe(false);
    expect(chipIsFree({ ...c, flags: 0 })).toBe(true);
    expect(chipIsFree({ ...c, flags: 0, lockUntil: BigInt(Math.floor(Date.now() / 1000) + 100) })).toBe(false);
  });
  it('PlayerPity = 8 + 32+8+8+4+1+1 = 62', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('PlayerPity')).pubkey(pk());
    [0, 23, 4, 0].forEach((c) => w.u16(c)); w.i64(1n); [0, 1, 0, 0].forEach((b) => w.u8(b)); w.bool(true).u8(255);
    const buf = w.toBytes(); expect(buf.length).toBe(62);
    const p = decodePlayerPity(buf); expect(p.counters).toEqual([0, 23, 4, 0]); expect(p.starterClaimed).toBe(true);
  });
  it('PendingPack = 8 + 32+1+1+1+32+8+8+8+8+8+2+8+1 = 126 (paid_skr added in fee schedule v2)', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('PendingPack')).pubkey(pk()).u8(2).u8(5).u8(1).pubkey(pk()).u64(1000n).u64(0n).u64(0n).u64(1_950_000_000n).u64(7_000_000n).u16(19).u64(42n).u8(250);
    const buf = w.toBytes(); expect(buf.length).toBe(126);
    const p = decodePendingPack(buf); expect(p.qty).toBe(5); expect(p.opened).toBe(1); expect(p.paidCg).toBe(1_950_000_000n); expect(p.paidSkr).toBe(7_000_000n); expect(p.nonce).toBe(42n);
  });
  it('GameConfig decodes with 4 PackDefs (PackDef = 1+4+8+18+1+1+1+2+2+2+1+1 = 42)', () => {
    const w = new BorshWriter().bytes(accountDiscriminator('GameConfig'));
    for (let i = 0; i < 10; i++) w.pubkey(pk()); // admin, pending_admin, treasury, buyback, cg, usdc, skr, staking_program, pyth_sol, pyth_skr
    w.u8(4).bool(false);
    for (let s = 0; s < 4; s++) {
      w.u8(3).u32(499).u64(750_000_000n);
      [4500, 2500, 1500, 800, 450, 180, 50, 18, 2].forEach((o) => w.u16(o));
      w.u8(1).u8(0).u8(6).u16(60).u16(30).u16(25).bool(false).bool(s !== 3);
    }
    w.u16(750).u16(500).u8(10).u64(0n).u64(0n).u64(0n).u64(0n).u64(0n).u32(1).u8(255).u8(254);
    const buf = w.toBytes();
    expect(buf.length).toBe(8 + 32 * 10 + 1 + 1 + 42 * 4 + 2 + 2 + 1 + 8 * 5 + 4 + 1 + 1);
    const g = decodeGameConfig(buf);
    expect(g.packs).toHaveLength(4); expect(g.packs[1].oddsBps[0]).toBe(4500); expect(g.packs[3].enabled).toBe(false); expect(g.collectionsCreated).toBe(10); expect(g.marketFeeBps).toBe(750); expect(g.skrDiscountBps).toBe(500);
  });
  it('Listing / TokenStake decode', () => {
    const l = decodeListing(new BorshWriter().bytes(accountDiscriminator('Listing')).pubkey(pk()).pubkey(pk()).u64(250_000_000n).u8(0).i64(1n).u8(1).toBytes());
    expect(l.price).toBe(250_000_000n); expect(l.currency).toBe(0);
    const t = decodeTokenStake(new BorshWriter().bytes(accountDiscriminator('TokenStake')).pubkey(pk()).u8(1).u64(500_000_000n).u128(750_000_000n).u128(0n).i64(99n).u8(1).toBytes());
    expect(t.weight).toBe(750_000_000n); expect(t.tier).toBe(1);
  });
  it('rejects wrong discriminator', () => {
    expect(() => decodeChipState(new Uint8Array(69))).toThrow(/discriminator/);
  });
});

describe('PDAs', () => {
  it('are deterministic and program-owned', () => {
    const [cfg, bump] = configPda();
    expect(PublicKey.isOnCurve(cfg.toBytes())).toBe(false); expect(bump).toBeLessThanOrEqual(255);
    const buyer = Keypair.generate().publicKey;
    const [p1] = pendingPackPda(buyer, 5n); const [p2] = pendingPackPda(buyer, 6n);
    expect(p1.equals(p2)).toBe(false);
    const [a0] = assetPda(p1, 0, 0); const [a1] = assetPda(p1, 0, 1);
    expect(a0.equals(a1)).toBe(false);
    expect(chipStatePda(a0)[0].equals(chipStatePda(a0)[0])).toBe(true);
    expect(rewardRootPda(2, 143)[0]).toBeInstanceOf(PublicKey);
  });
  it('ATA derivation matches spl-token', () => {
    const mint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    const owner = new PublicKey('11111111111111111111111111111112');
    const [expected] = PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), mint.toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
    expect(ata(mint, owner).equals(expected)).toBe(true);
  });
  it('fresh nonces are unique and fit u64', () => {
    const a = freshNonce(); const b = freshNonce();
    expect(a).not.toBe(b); expect(a < 2n ** 64n).toBe(true);
  });
});

describe('instruction builders', () => {
  const buyer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  it('buy_pack has 11 accounts (generic SPL leg), optional slots collapse to program id', () => {
    const ix = buyPackIx({ buyer, sku: 1, qty: 5, currency: Currency.SOL, nonce: 9n, maxLamports: 1_000n, randomness: Keypair.generate().publicKey, priceUpdate: Keypair.generate().publicKey, usdcMint: mint, cgMint: mint });
    expect(ix.keys).toHaveLength(11);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[7].pubkey.equals(CHIP_CORE_ID)).toBe(true); // buyer_token absent for SOL
    expect(ix.keys[6].pubkey.equals(CHIP_CORE_ID)).toBe(false); // price_update present
    expect(hex(new Uint8Array(ix.data).slice(0, 8))).toBe(hex(ixDiscriminator('buy_pack')));
    const r = new BorshReader(new Uint8Array(ix.data), 8);
    expect(r.u8()).toBe(1); expect(r.u8()).toBe(5); expect(r.u8()).toBe(0); expect(r.u64()).toBe(9n); expect(r.u64()).toBe(1_000n);
    // SKR: price_update present AND token legs present
    const skr = Keypair.generate().publicKey;
    const ix2 = buyPackIx({ buyer, sku: 1, qty: 1, currency: Currency.SKR, nonce: 1n, maxLamports: 500_000_000n, randomness: Keypair.generate().publicKey, priceUpdate: Keypair.generate().publicKey, usdcMint: mint, cgMint: mint, skrMint: skr });
    expect(ix2.keys[6].pubkey.equals(CHIP_CORE_ID)).toBe(false);
    expect(ix2.keys[7].pubkey.equals(CHIP_CORE_ID)).toBe(false);
    expect(new Uint8Array(ix2.data)[10]).toBe(3);
  });
  it('pay_service: 11 accounts; $CG path burns (cg_mint present, treasury ATA absent)', () => {
    const ref = new Uint8Array(32).fill(7);
    const cg = payServiceIx({ buyer, kind: 0, currency: Currency.CG, maxUnits: 0n, refHash: ref, treasury: mint, usdcMint: mint, cgMint: mint });
    expect(cg.keys).toHaveLength(11);
    expect(cg.keys[7].pubkey.equals(CHIP_CORE_ID)).toBe(true); // treasury_token absent
    expect(cg.keys[8].pubkey.equals(mint)).toBe(true); // cg_mint present
    const usdc = payServiceIx({ buyer, kind: 6, currency: Currency.USDC, maxUnits: 0n, refHash: ref, treasury: mint, usdcMint: mint, cgMint: mint });
    expect(usdc.keys[7].pubkey.equals(CHIP_CORE_ID)).toBe(false);
    expect(usdc.keys[8].pubkey.equals(CHIP_CORE_ID)).toBe(true);
    expect(hex(new Uint8Array(usdc.data).slice(0, 8))).toBe(hex(ixDiscriminator('pay_service')));
    expect(new Uint8Array(usdc.data).length).toBe(8 + 1 + 1 + 8 + 32);
    expect(() => payServiceIx({ buyer, kind: 0, currency: Currency.CG, maxUnits: 0n, refHash: new Uint8Array(4), treasury: mint, usdcMint: mint, cgMint: mint })).toThrow(/32 bytes/);
  });
  it('open_pack appends 4 remaining accounts per chip', () => {
    const core = Keypair.generate().publicKey;
    const ix = openPackIx({ payer: buyer, buyer, nonce: 9n, packNo: 2, randomness: Keypair.generate().publicKey, rolledCollections: [0, 3, 3], coreCollectionOf: () => core });
    expect(ix.keys).toHaveLength(13 + 12);
    expect(ix.keys[13 + 2].pubkey.equals(chipStatePda(ix.keys[13 + 0].pubkey)[0])).toBe(false); // [asset, state, meta, core]
    expect(ix.keys[13 + 1].pubkey.equals(chipStatePda(ix.keys[13].pubkey)[0])).toBe(true);
  });
  it('fuse: [asset,state]×3 then [meta,core]×3', () => {
    const mats = Array.from({ length: 3 }, (_, i) => ({ asset: Keypair.generate().publicKey, collectionIdx: i }));
    const ix = fuseIx({ owner: buyer, nonce: 1n, useBooster: true, randomness: CHIP_CORE_ID, materials: mats, resultCollectionIdx: 0, cgMint: mint, coreCollectionOf: () => mint });
    expect(ix.keys).toHaveLength(14 + 12);
    expect(ix.keys[14].pubkey.equals(mats[0].asset)).toBe(true);
    expect(ix.keys[14 + 6 + 1].pubkey.equals(mint)).toBe(true);
    const r = new BorshReader(new Uint8Array(ix.data), 8); expect(r.u64()).toBe(1n); expect(r.bool()).toBe(true);
  });
});

describe('economy glue', () => {
  it('golden vectors: expandRandomness matches Rust-verified fixtures', () => {
    const skus = ['starter', 'standard', 'premium', 'limited'] as const;
    for (const v of golden.vectors) {
      const vrf = Uint8Array.from(v.vrf);
      expect([0, 1, 2, 3, 4].map((s) => uniformBps(vrf, s))).toEqual(v.uniform);
      const out = expandRandomness(vrf, PACKS[skus[v.sku]], v.pity, v.pool).map((r) => [r.rarity, r.collectionIdx]);
      expect(out).toEqual(v.out);
    }
  });
  it('bundle sub-seed = keccak(value ‖ pack_no), single pack = value', () => {
    const v = new Uint8Array(32).fill(1);
    expect(packSeed(v, 1, 0)).toBe(v);
    expect(hex(packSeed(v, 5, 0))).not.toBe(hex(v));
    expect(hex(packSeed(v, 5, 0))).not.toBe(hex(packSeed(v, 5, 1)));
    expect(hex(packSeed(v, 5, 1))).toBe(hex(packSeed(v, 5, 1)));
  });
  it('sale split 90 / 2.5 royalty / 7.5 fee (⅓ buyback-burn, ⅔ treasury); live fee override', () => {
    const s = saleSplit(1_000_000n);
    expect(s.seller).toBe(900_000n); expect(s.royalty).toBe(25_000n); expect(s.fee).toBe(75_000n); expect(s.buyback).toBe(24_997n); expect(s.treasury).toBe(50_003n);
    expect(s.fee + s.royalty + s.seller).toBe(1_000_000n);
    const live = saleSplit(1_000_000n, 600); expect(live.fee).toBe(60_000n); expect(live.seller).toBe(915_000n);
    expect(saleSplit(1_000_000n, 5_000).fee).toBe(100_000n); // hard cap 10 %
  });
  it('wager split (5 % rake → 40 treasury / 40 burn / 20 pool) & leagues', () => {
    const w = wagerSplit(100_000_000n);
    expect(w.pot).toBe(200_000_000n); expect(w.rake).toBe(10_000_000n); expect(w.payout).toBe(190_000_000n);
    expect(w.treasury).toBe(4_000_000n); expect(w.seasonPool).toBe(2_000_000n); expect(w.burn).toBe(4_000_000n);
    expect(w.treasury + w.seasonPool + w.burn).toBe(w.rake);
    expect(leagueOf(799)).toBe(0); expect(leagueOf(800)).toBe(1); expect(leagueOf(7000)).toBe(5);
  });
  it('early exit penalty only while locked', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(unstakePenalty(1_000_000n, 2, BigInt(now + 10), now)).toBe(100_000n);
    expect(unstakePenalty(1_000_000n, 2, BigInt(now - 10), now)).toBe(0n);
  });
});

describe('switchboard reveal parsing', () => {
  it('extracts the 32-byte value at offset 73', () => {
    const value = crypto.getRandomValues(new Uint8Array(32));
    const data = concat(new Uint8Array(8), new Uint8Array(64), Uint8Array.of(1), value);
    const ix = new TransactionInstruction({ programId: CHIP_CORE_ID, keys: [], data: Buffer.from(data) });
    expect(hex(revealValueFromIx(ix))).toBe(hex(value));
  });
});

describe('formatting', () => {
  it('base58 matches web3 PublicKey encoding', () => {
    const k = Keypair.generate().publicKey;
    expect(base58Encode(k.toBytes())).toBe(k.toBase58());
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe('112');
  });
  it('units', () => {
    expect(fmtUnits(1_234_567_890n, 9, 3)).toBe('1.234');
    expect(fmtUnits(1_000_000n, 6, 2, 2)).toBe('1.00');
    expect(parseUnits('0.25', 9)).toBe(250_000_000n);
    expect(parseUnits('12', 6)).toBe(12_000_000n);
    expect(parseUnits('abc', 6)).toBeNull();
  });
});

describe('pyth quoting (SOL + SKR rails)', () => {
  const feedSol = { price: 15_000_000_000n, conf: 0n, exponent: -8, publishTime: 0n, feedIdHex: PYTH_SOL_USD_FEED_ID_HEX }; // $150.00
  const feedSkr = { price: 1_740_000n, conf: 0n, exponent: -8, publishTime: 0n, feedIdHex: PYTH_SKR_USD_FEED_ID_HEX };       // $0.0174
  it('usdCentsToUnits matches the on-chain integer formula for both decimals', () => {
    expect(usdCentsToLamports(499n, feedSol)).toBe((499n * 1_000_000_000n * 100_000_000n) / 100n / 15_000_000_000n); // 4.99 USD → 0.03326666 SOL
    expect(usdCentsToLamports(499n, feedSol)).toBe(33_266_666n);
    expect(usdCentsToMicroSkr(499n, feedSkr)).toBe((499n * 1_000_000n * 100_000_000n) / 100n / 1_740_000n);            // 4.99 USD → 286.78 SKR
    expect(usdCentsToMicroSkr(499n, feedSkr)).toBe(286_781_609n);
    expect(usdCentsToUnits(100n, feedSol, 9)).toBe(usdCentsToLamports(100n, feedSol));
  });
  it('display price and feed guard', () => {
    expect(priceUsd(feedSol)).toBeCloseTo(150, 6);
    expect(priceUsd(feedSkr)).toBeCloseTo(0.0174, 8);
    expect(() => assertFeed(feedSkr, PYTH_SOL_USD_FEED_ID_HEX, 'SOL/USD')).toThrow(/SOL\/USD/);
    expect(() => assertFeed(feedSkr, PYTH_SKR_USD_FEED_ID_HEX, 'SKR/USD')).not.toThrow();
    expect(() => usdCentsToUnits(1n, { ...feedSol, price: 0n }, 9)).toThrow();
  });
});

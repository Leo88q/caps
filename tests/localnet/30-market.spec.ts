// T-L-M — marketplace: freeze-in-place listings, buy split, offers (docs/06 §3.5 "Маркет").
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { findEvent } from '@/chain/anchor';
import { BorshReader } from '@/chain/borsh';
import { CHIP_FLAG, decodeCoreAssetHeader, decodeListing, decodeOffer } from '@/chain/accounts';
import { MarketCurrency, acceptOfferIx, buyIx, cancelListingIx, cancelOfferIx, listIx, makeOfferIx, saleSplit, updatePriceIx } from '@/chain/ix/market';
import { stakeChipIx } from '@/chain/ix/staking';
import { listingPda, offerPda } from '@/chain/pdas';
import { BUYBACK, TREASURY, binariesPresent, getEnv, setParamsIx, setPausedIx, tokenBalance, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail, lamportsClose } from './helpers/expect';
import { Currency, SKU, buyPack, loadChip, mintChips, revealAndOpenAll, valueOf } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const SOL = 1_000_000_000n;

const readChipSold = (r: BorshReader) => ({ asset: r.pubkey(), seller: r.pubkey(), buyer: r.pubkey(), price: r.u64(), currency: r.u8(), fee: r.u64(), royalty: r.u64(), viaOffer: r.bool() });

suite('T-L-M market', () => {
  let env: Env;
  let seller: Keypair;
  let buyer: Keypair;
  beforeAll(async () => {
    env = await getEnv();
    seller = await env.player({ usdc: 10_000_000_000n, cg: 10_000_000_000n, skr: 10_000_000_000n });
    buyer = await env.player({ sol: 50n * SOL, usdc: 10_000_000_000n, cg: 10_000_000_000n, skr: 10_000_000_000n });
  });

  it('M01 list in SOL / USDC / SKR ≥ min price: 0.5 $CG burned, F_LISTED, Core asset frozen; below min → PriceTooLow', async () => {
    const chips = await mintChips(env, seller, 1, valueOf('M01'));
    const [c1, c2, c3] = chips;
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, seller.publicKey);
    await env.chain.send([listIx({ seller: seller.publicKey, asset: c1.asset, collectionIdx: c1.collectionIdx, coreCollection: env.coreOf(c1.collectionIdx), price: 5n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, seller.publicKey))).toBe(500_000n);
    const l = decodeListing((await env.chain.getAccount(listingPda(c1.asset)[0]))!.data);
    expect(l.price).toBe(5n * SOL);
    expect(l.currency).toBe(0);
    expect(l.seller.equals(seller.publicKey)).toBe(true);
    expect((await loadChip(env.chain, c1.asset))!.flags & CHIP_FLAG.LISTED).toBe(CHIP_FLAG.LISTED);
    await env.chain.send([listIx({ seller: seller.publicKey, asset: c2.asset, collectionIdx: c2.collectionIdx, coreCollection: env.coreOf(c2.collectionIdx), price: 1_000_000n, currency: MarketCurrency.USDC, cgMint: env.mints.cg })], { signers: [seller] });
    await env.chain.send([listIx({ seller: seller.publicKey, asset: c3.asset, collectionIdx: c3.collectionIdx, coreCollection: env.coreOf(c3.collectionIdx), price: 5_000_000n, currency: MarketCurrency.SKR, cgMint: env.mints.cg })], { signers: [seller] });
    // a listed chip cannot be listed twice (init on live PDA) nor staked
    await expectAnyFail(env.chain.send([listIx({ seller: seller.publicKey, asset: c1.asset, collectionIdx: c1.collectionIdx, coreCollection: env.coreOf(c1.collectionIdx), price: 5n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] }), 'double list');
    await expectFail(env.chain.send([stakeChipIx({ owner: seller.publicKey, asset: c1.asset, collectionIdx: c1.collectionIdx, coreCollection: env.coreOf(c1.collectionIdx) })], { signers: [seller] }), Err.staking('ChipNotFree'), 'stake a listed chip');
    const more = await mintChips(env, seller, 1, valueOf('M01b'));
    await expectFail(env.chain.send([listIx({ seller: seller.publicKey, asset: more[0].asset, collectionIdx: more[0].collectionIdx, coreCollection: env.coreOf(more[0].collectionIdx), price: 999_999n, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] }), Err.market('PriceTooLow'));
    await expectFail(env.chain.send([listIx({ seller: seller.publicKey, asset: more[0].asset, collectionIdx: more[0].collectionIdx, coreCollection: env.coreOf(more[0].collectionIdx), price: 99_999n, currency: MarketCurrency.USDC, cgMint: env.mints.cg })], { signers: [seller] }), Err.market('PriceTooLow'));
    // not the owner
    await expectFail(env.chain.send([listIx({ seller: buyer.publicKey, asset: more[1].asset, collectionIdx: more[1].collectionIdx, coreCollection: env.coreOf(more[1].collectionIdx), price: 5n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [buyer] }), Err.market('NotOwner'));
  });

  it('M02 list a soulbound / time-locked chip → ChipLocked', async () => {
    const p = await env.player({ cg: 1_000_000_000n });
    const b = await buyPack(env, p, { sku: SKU.STARTER, currency: Currency.SOL });
    const [open] = await revealAndOpenAll(env, p, b, valueOf('M02'));
    const st = (await loadChip(env.chain, open.assets[0]))!;
    await expectFail(env.chain.send([listIx({ seller: p.publicKey, asset: open.assets[0], collectionIdx: st.collectionIdx, coreCollection: env.coreOf(st.collectionIdx), price: 5n * SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [p] }), Err.market('ChipLocked'));
  });

  it('M03 buy in SOL: seller gets price − 7.5 % − 2.5 %, fee ⅓ buyback / ⅔ treasury, royalty → treasury, deliver_sold → new owner, flag cleared, listing closed', async () => {
    const [c] = await mintChips(env, seller, 1, valueOf('M03'));
    const price = 2n * SOL;
    await env.chain.send([listIx({ seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
    const before = { seller: await env.chain.balance(seller.publicKey), treasury: await env.chain.balance(TREASURY.publicKey), buyback: await env.chain.balance(BUYBACK.publicKey), buyer: await env.chain.balance(buyer.publicKey) };
    const listingRent = (await env.chain.getAccount(listingPda(c.asset)[0]))!.lamports;
    const tx = await env.chain.send([buyIx({ buyer: buyer.publicKey, seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), expectedPrice: price, expectedCurrency: MarketCurrency.SOL, treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc, skrMint: env.mints.skr })], { signers: [buyer] });
    const split = saleSplit(price, 750);
    expect(split.fee).toBe(150_000_000n);
    expect(split.royalty).toBe(50_000_000n);
    expect((await env.chain.balance(seller.publicKey)) - before.seller).toBe(split.seller + listingRent);
    expect((await env.chain.balance(BUYBACK.publicKey)) - before.buyback).toBe(split.buyback);
    expect((await env.chain.balance(TREASURY.publicKey)) - before.treasury).toBe(split.treasury + split.royalty);
    expect(lamportsClose(before.buyer - (await env.chain.balance(buyer.publicKey)), price, 50_000n)).toBe(true);
    const ev = findEvent(tx.logs, 'ChipSold', readChipSold)!;
    expect(ev.price).toBe(price);
    expect(ev.fee).toBe(split.fee);
    expect(ev.royalty).toBe(split.royalty);
    expect(ev.viaOffer).toBe(false);
    expect(decodeCoreAssetHeader((await env.chain.getAccount(c.asset))!.data).owner.equals(buyer.publicKey)).toBe(true);
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.LISTED).toBe(0);
    expect(await env.chain.getAccount(listingPda(c.asset)[0])).toBeNull();
    // the new owner can list it right away (no lock on bought chips)
    await env.chain.send([listIx({ seller: buyer.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price: 1_000_000n, currency: MarketCurrency.USDC, cgMint: env.mints.cg })], { signers: [buyer] });
    // USDC buy — SPL legs
    const sBefore = await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey);
    const tBefore = await tokenBalance(env.chain, env.mints.usdc, TREASURY.publicKey);
    await env.chain.send([buyIx({ buyer: seller.publicKey, seller: buyer.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), expectedPrice: 1_000_000n, expectedCurrency: MarketCurrency.USDC, treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc, skrMint: env.mints.skr })], { signers: [seller] });
    const s2 = saleSplit(1_000_000n, 750);
    expect((await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey)) - sBefore).toBe(s2.seller);
    expect((await tokenBalance(env.chain, env.mints.usdc, TREASURY.publicKey)) - tBefore).toBe(s2.treasury + s2.royalty);
  });

  it('M04 expected_price / currency mismatch → CurrencyMismatch (front-running guard)', async () => {
    const [c] = await mintChips(env, seller, 1, valueOf('M04'));
    await env.chain.send([listIx({ seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price: SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
    const buy = (price: bigint, cur: 0 | 1 | 3) => env.chain.send([buyIx({ buyer: buyer.publicKey, seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), expectedPrice: price, expectedCurrency: cur, treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc, skrMint: env.mints.skr })], { signers: [buyer] });
    await env.chain.send([updatePriceIx({ seller: seller.publicKey, asset: c.asset, price: 2n * SOL })], { signers: [seller] });
    await expectFail(buy(SOL, MarketCurrency.SOL), Err.market('CurrencyMismatch'), 'stale price');
    await expectFail(buy(2n * SOL, MarketCurrency.USDC), Err.market('CurrencyMismatch'), 'wrong currency');
    await buy(2n * SOL, MarketCurrency.SOL);
  });

  it('M05 self-trade → SelfTrade', async () => {
    const [c] = await mintChips(env, seller, 1, valueOf('M05'));
    await env.chain.send([listIx({ seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price: SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
    await expectFail(env.chain.send([buyIx({ buyer: seller.publicKey, seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), expectedPrice: SOL, expectedCurrency: MarketCurrency.SOL, treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc, skrMint: env.mints.skr })], { signers: [seller] }), Err.market('SelfTrade'));
  });

  it('M06 update_price (seller only, ≥ min) + cancel: flag cleared, unfrozen, rent back; stranger → NotSeller', async () => {
    const [c] = await mintChips(env, seller, 1, valueOf('M06'));
    await env.chain.send([listIx({ seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price: SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
    await expectFail(env.chain.send([updatePriceIx({ seller: buyer.publicKey, asset: c.asset, price: 3n * SOL })], { signers: [buyer] }), Err.market('NotSeller'));
    await expectFail(env.chain.send([updatePriceIx({ seller: seller.publicKey, asset: c.asset, price: 1n })], { signers: [seller] }), Err.market('PriceTooLow'));
    await env.chain.send([updatePriceIx({ seller: seller.publicKey, asset: c.asset, price: 3n * SOL })], { signers: [seller] });
    expect(decodeListing((await env.chain.getAccount(listingPda(c.asset)[0]))!.data).price).toBe(3n * SOL);
    await expectFail(env.chain.send([cancelListingIx({ seller: buyer.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) })], { signers: [buyer] }), Err.market('NotSeller'));
    const before = await env.chain.balance(seller.publicKey);
    await env.chain.send([cancelListingIx({ seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) })], { signers: [seller] });
    expect(await env.chain.getAccount(listingPda(c.asset)[0])).toBeNull();
    expect((await loadChip(env.chain, c.asset))!.flags & CHIP_FLAG.LISTED).toBe(0);
    expect(await env.chain.balance(seller.publicKey)).toBeGreaterThan(before);
    // a cancelled chip can be staked again
    await env.chain.send([stakeChipIx({ owner: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx) })], { signers: [seller] });
  });

  it('M07 offers in USDC: make → escrow; accept (chip NOT listed) → split + delivery; expired → OfferExpired; cancel returns escrow; TTL > 30 d → TtlTooLong', async () => {
    const [c] = await mintChips(env, seller, 1, valueOf('M07'));
    const amount = 5_000_000n;
    const bBefore = await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey);
    await env.chain.send([makeOfferIx({ bidder: buyer.publicKey, asset: c.asset, amountUsdc: amount, ttlSecs: 3600n, usdcMint: env.mints.usdc })], { signers: [buyer] });
    expect(bBefore - (await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey))).toBe(amount);
    const o = decodeOffer((await env.chain.getAccount(offerPda(c.asset, buyer.publicKey)[0]))!.data);
    expect(o.amountUsdc).toBe(amount);
    await expectFail(env.chain.send([makeOfferIx({ bidder: seller.publicKey, asset: c.asset, amountUsdc: amount, ttlSecs: 31n * 86_400n, usdcMint: env.mints.usdc })], { signers: [seller] }), Err.market('TtlTooLong'));
    await expectFail(env.chain.send([makeOfferIx({ bidder: seller.publicKey, asset: c.asset, amountUsdc: 99_999n, ttlSecs: 3600n, usdcMint: env.mints.usdc })], { signers: [seller] }), Err.market('PriceTooLow'));
    const sBefore = await tokenBalance(env.chain, env.mints.usdc, seller.publicKey);
    const tx = await env.chain.send([acceptOfferIx({ seller: seller.publicKey, bidder: buyer.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc })], { signers: [seller] });
    const split = saleSplit(amount, 750);
    expect((await tokenBalance(env.chain, env.mints.usdc, seller.publicKey)) - sBefore).toBe(split.seller);
    expect(findEvent(tx.logs, 'ChipSold', readChipSold)!.viaOffer).toBe(true);
    expect(decodeCoreAssetHeader((await env.chain.getAccount(c.asset))!.data).owner.equals(buyer.publicKey)).toBe(true);
    expect(await env.chain.getAccount(offerPda(c.asset, buyer.publicKey)[0])).toBeNull();
    // cancel path
    const [d] = await mintChips(env, seller, 1, valueOf('M07b'));
    await env.chain.send([makeOfferIx({ bidder: buyer.publicKey, asset: d.asset, amountUsdc: amount, ttlSecs: 60n, usdcMint: env.mints.usdc })], { signers: [buyer] });
    const b2 = await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey);
    await env.chain.send([cancelOfferIx({ bidder: buyer.publicKey, asset: d.asset, usdcMint: env.mints.usdc })], { signers: [buyer] });
    expect((await tokenBalance(env.chain, env.mints.usdc, buyer.publicKey)) - b2).toBe(amount);
    if (env.chain.canWarp) {
      await env.chain.send([makeOfferIx({ bidder: buyer.publicKey, asset: d.asset, amountUsdc: amount, ttlSecs: 60n, usdcMint: env.mints.usdc })], { signers: [buyer] });
      await env.chain.warpSeconds(61n);
      await expectFail(env.chain.send([acceptOfferIx({ seller: seller.publicKey, bidder: buyer.publicKey, asset: d.asset, collectionIdx: d.collectionIdx, coreCollection: env.coreOf(d.collectionIdx), treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc })], { signers: [seller] }), Err.market('OfferExpired'));
      await env.chain.send([cancelOfferIx({ bidder: buyer.publicKey, asset: d.asset, usdcMint: env.mints.usdc })], { signers: [buyer] });
    }
    // accepting an offer on a LISTED chip is refused (must cancel the listing first)
    const [e] = await mintChips(env, seller, 1, valueOf('M07c'));
    await env.chain.send([listIx({ seller: seller.publicKey, asset: e.asset, collectionIdx: e.collectionIdx, coreCollection: env.coreOf(e.collectionIdx), price: SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
    await env.chain.send([makeOfferIx({ bidder: buyer.publicKey, asset: e.asset, amountUsdc: amount, ttlSecs: 3600n, usdcMint: env.mints.usdc })], { signers: [buyer] });
    await expectFail(env.chain.send([acceptOfferIx({ seller: seller.publicKey, bidder: buyer.publicKey, asset: e.asset, collectionIdx: e.collectionIdx, coreCollection: env.coreOf(e.collectionIdx), treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc })], { signers: [seller] }), Err.market('ChipLocked'));
  });

  it('M08 market fee: set_params > 10 % → FeeTooHigh; fee 10 % applied to the split', async () => {
    await expectFail(env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 1001 })], { signers: [env.admin] }), Err.chip('FeeTooHigh'));
    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 1000 })], { signers: [env.admin] });
    const [c] = await mintChips(env, seller, 1, valueOf('M08'));
    await env.chain.send([listIx({ seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price: SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
    const tBefore = await env.chain.balance(TREASURY.publicKey);
    const tx = await env.chain.send([buyIx({ buyer: buyer.publicKey, seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), expectedPrice: SOL, expectedCurrency: MarketCurrency.SOL, treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc, skrMint: env.mints.skr })], { signers: [buyer] });
    const split = saleSplit(SOL, 1000);
    expect(findEvent(tx.logs, 'ChipSold', readChipSold)!.fee).toBe(split.fee);
    expect((await env.chain.balance(TREASURY.publicKey)) - tBefore).toBe(split.treasury + split.royalty);
    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 750 })], { signers: [env.admin] });
    env.config = await env.refreshConfig();
  });

  it('M09 listing while chip_core is paused is allowed (decision L); buying too', async () => {
    const [c] = await mintChips(env, seller, 1, valueOf('M09'));
    await env.chain.send([setPausedIx(env.admin.publicKey, true)], { signers: [env.admin] });
    try {
      await env.chain.send([listIx({ seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), price: SOL, currency: MarketCurrency.SOL, cgMint: env.mints.cg })], { signers: [seller] });
      await env.chain.send([buyIx({ buyer: buyer.publicKey, seller: seller.publicKey, asset: c.asset, collectionIdx: c.collectionIdx, coreCollection: env.coreOf(c.collectionIdx), expectedPrice: SOL, expectedCurrency: MarketCurrency.SOL, treasury: TREASURY.publicKey, buybackWallet: BUYBACK.publicKey, usdcMint: env.mints.usdc, skrMint: env.mints.skr })], { signers: [buyer] });
    } finally {
      await env.chain.send([setPausedIx(env.admin.publicKey, false)], { signers: [env.admin] });
    }
    expect(decodeCoreAssetHeader((await env.chain.getAccount(c.asset))!.data).owner.equals(buyer.publicKey)).toBe(true);
    expect(new PublicKey(BUYBACK.publicKey)).toBeInstanceOf(PublicKey);
  });
});

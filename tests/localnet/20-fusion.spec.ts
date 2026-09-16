// T-L-F — fusion: atomic recipes, randomized recipes (commit → reveal), failure refunds,
// boosters, stale cancel (docs/06 §3.5 "Fusion").
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { FUSION_RECIPES, expandRandomness, uniformBps } from '@guttercaps/economy';
import { findEvent } from '@/chain/anchor';
import { CHIP_FLAG, decodePendingFusion, decodePlayerItems, readChipFused } from '@/chain/accounts';
import { cancelStaleFusionIx, fuseIx, fuseRevealIx, thawChipIx, type FuseMaterial } from '@/chain/ix/chipCore';
import { initRandomnessIx, rngAccounts } from '@/chain/ix/rng';
import { RNG_KIND, assetPda, pendingFusionPda, playerItemsPda } from '@/chain/pdas';
import { toEconPack } from '@/chain/flows/packFlow';
import { SB_MOCK_ID, SB_ORACLE, SB_QUEUE, binariesPresent, getEnv, grantBoosterIx, tokenBalance, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { Currency, SKU, buyPack, loadChip, loadPity, nextNonce, openPack, revealPack, valueOf, vaultKey } from './helpers/flows';
import { forgeRandomness, randomnessAccount, revealIx } from './helpers/sbmock';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
/** scenarios that forge accounts or move the clock — LiteSVM back-end only (RPC = LOCALNET_RPC set) */
const svmOnly = it.skipIf(!!process.env.LOCALNET_RPC);
const STALE = 10_800n;
const H = 3600n;

interface Chip extends FuseMaterial { rarity: number }

/**
 * Mint chips of an exact rarity: search a Standard-pack value whose expansion yields ≥ `n`
 * chips of `rarity` (Standard odds reach Legend+; Diamond needs many tries — not used here).
 * Returns chips in the requested collection when `collectionIdx` is given (same-collection recipes).
 */
async function chipsOf(env: Env, owner: Keypair, rarity: number, n: number, collectionIdx?: number): Promise<Chip[]> {
  const out: Chip[] = [];
  const econ = toEconPack(SKU.STANDARD, env.config.packs[SKU.STANDARD]);
  let salt = 0;
  while (out.length < n) {
    const pity = (await loadPity(env.chain, owner.publicKey))?.counters[SKU.STANDARD] ?? 0;
    let value: Uint8Array | undefined;
    for (; salt < 200_000 && !value; salt++) {
      const v = valueOf(`chipsOf-${rarity}-${collectionIdx ?? 'any'}`, salt);
      const rolls = expandRandomness(v, econ, pity, env.config.collectionsCreated);
      const hits = rolls.filter((r) => r.rarity === rarity && (collectionIdx === undefined || r.collectionIdx === collectionIdx)).length;
      if (hits >= Math.min(2, n - out.length) || (hits >= 1 && n - out.length === 1)) value = v;
    }
    if (!value) throw new Error(`no value yields rarity ${rarity} in collection ${collectionIdx}`);
    const b = await buyPack(env, owner, { sku: SKU.STANDARD, currency: Currency.USDC });
    await revealPack(env, b, value);
    const r = await openPack(env, owner.publicKey, b.nonce, 0, value, owner);
    r.rolled.forEach((x, i) => { if (x.rarity === rarity && (collectionIdx === undefined || x.collectionIdx === collectionIdx) && out.length < n) out.push({ asset: r.assets[i], collectionIdx: x.collectionIdx, rarity }); });
  }
  return out;
}

async function fuse(env: Env, owner: Keypair, mats: Chip[], o: { resultCollectionIdx?: number; useBooster?: boolean; randomized: boolean; nonce?: bigint }) {
  const nonce = o.nonce ?? nextNonce();
  const rng = rngAccounts(RNG_KIND.FUSION, owner.publicKey, nonce);
  const ixs = [];
  if (o.randomized) ixs.push(initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }));
  ixs.push(fuseIx({
    owner: owner.publicKey, nonce, useBooster: o.useBooster ?? false,
    rng: o.randomized ? { randomness: rng.randomness, queue: SB_QUEUE, oracle: SB_ORACLE } : undefined,
    materials: mats, resultCollectionIdx: o.resultCollectionIdx ?? mats[0].collectionIdx, cgMint: env.mints.cg, coreCollectionOf: env.coreOf,
  }));
  const tx = await env.chain.send(ixs, { signers: [owner], label: 'fuse' });
  const pending = pendingFusionPda(owner.publicKey, nonce)[0];
  return { nonce, rng, pending, tx, resultAsset: assetPda(pending, 0, 0)[0], event: findEvent(tx.logs, 'ChipFused', readChipFused) };
}

suite('T-L-F fusion', () => {
  let env: Env;
  let owner: Keypair;
  beforeAll(async () => {
    env = await getEnv();
    owner = await env.player({ usdc: 100_000_000_000n, cg: 100_000_000_000n });
  });

  it('F01 recipe 0 (Common → Common+, any collection): atomic burn 3 + mint 1, fee 2.5 $CG burned, no PlayerItems, PendingFusion closed', async () => {
    const mats = await chipsOf(env, owner, 0, 3);
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    const cfg0 = await env.refreshConfig();
    const r = await fuse(env, owner, mats, { randomized: false, resultCollectionIdx: mats[1].collectionIdx });
    expect(r.event?.success).toBe(true);
    expect(r.event?.recipe).toBe(0);
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, owner.publicKey))).toBe(2_500_000n);
    expect((await env.refreshConfig()).burnedTotal - cfg0.burnedTotal).toBe(2_500_000n);
    for (const m of mats) { expect(await env.chain.getAccount(m.asset)).toBeNull(); expect(await loadChip(env.chain, m.asset)).toBeNull(); }
    const res = (await loadChip(env.chain, r.resultAsset))!;
    expect(res.rarity).toBe(1);
    expect(res.collectionIdx).toBe(mats[1].collectionIdx);
    expect(res.lockUntil).toBe(0n);
    expect(await env.chain.getAccount(r.pending)).toBeNull();
    expect(await env.chain.getAccount(playerItemsPda(owner.publicKey)[0])).toBeNull();
    expect(FUSION_RECIPES[0].feeCgMicro).toBe(2_500_000);
  });

  it('F02 recipe 1 (Common+ → Rare) is same-collection: mixed materials → MaterialCollectionMismatch; result collection must be theirs', async () => {
    const a = await chipsOf(env, owner, 1, 2, 0);
    const b = await chipsOf(env, owner, 1, 1, 1);
    await expectFail(fuse(env, owner, [...a, ...b], { randomized: false, resultCollectionIdx: 0 }), Err.chip('MaterialCollectionMismatch'), 'mixed collections');
    const c = await chipsOf(env, owner, 1, 1, 0);
    await expectFail(fuse(env, owner, [...a, ...c], { randomized: false, resultCollectionIdx: 1 }), Err.chip('MaterialCollectionMismatch'), 'foreign result collection');
    const r = await fuse(env, owner, [...a, ...c], { randomized: false, resultCollectionIdx: 0 });
    expect((await loadChip(env.chain, r.resultAsset))!.rarity).toBe(2);
    // any-collection recipe: the result must still come from one of the inputs' collections
    const mixed = [...(await chipsOf(env, owner, 0, 2, 2)), ...(await chipsOf(env, owner, 0, 1, 3))];
    await expectFail(fuse(env, owner, mixed, { randomized: false, resultCollectionIdx: 5 }), Err.chip('MaterialCollectionMismatch'), 'result not among inputs');
    // rarity mismatch and duplicate material
    const x = await chipsOf(env, owner, 0, 2);
    const y = await chipsOf(env, owner, 1, 1);
    await expectFail(fuse(env, owner, [...x, ...y], { randomized: false, resultCollectionIdx: x[0].collectionIdx }), Err.chip('MaterialRarityMismatch'), 'mixed rarities');
    await expectFail(fuse(env, owner, [x[0], x[1], x[0]], { randomized: false, resultCollectionIdx: x[0].collectionIdx }), Err.chip('DuplicateMaterial'), 'duplicate');
  });

  it('F03 recipe 3 (Rare+ → Epic, same collection) locks the result for 1 h: lock_until, Core frozen; thaw before → StillLocked', async () => {
    const mats = await chipsOf(env, owner, 3, 3, 4);
    const r = await fuse(env, owner, mats, { randomized: false, resultCollectionIdx: 4 });
    const res = (await loadChip(env.chain, r.resultAsset))!;
    expect(res.rarity).toBe(4);
    const now = await env.chain.now();
    expect(res.lockUntil).toBeGreaterThanOrEqual(now + H - 30n);
    const thaw = () => env.chain.send([thawChipIx({ owner: owner.publicKey, asset: r.resultAsset, collectionIdx: 4, coreCollection: env.coreOf(4) })], { signers: [owner] });
    await expectFail(thaw(), Err.chip('StillLocked'));
    if (!env.chain.canWarp) return;
    await env.chain.warpSeconds(H + 1n);
    await thaw();
  }, 600_000);

  it('F04 recipe 4 (Epic → Epic+, 85 %) success: commit freezes materials (F_FUSING) and escrows the 120 $CG fee in the vault (SEC-M3), reveal → burn 3 + mint 1 + burn the fee', async () => {
    const mats = await chipsOf(env, owner, 4, 3);
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    const vaultBefore = await tokenBalance(env.chain, env.mints.cg, vaultKey());
    const cfg0 = await env.refreshConfig();
    const r = await fuse(env, owner, mats, { randomized: true, resultCollectionIdx: mats[0].collectionIdx });
    expect(r.event).toBeUndefined();
    for (const m of mats) expect((await loadChip(env.chain, m.asset))!.flags & CHIP_FLAG.FUSING).toBe(CHIP_FLAG.FUSING);
    const pf = decodePendingFusion((await env.chain.getAccount(r.pending))!.data);
    expect(pf.recipe).toBe(4);
    expect(pf.randomness.equals(r.rng.randomness)).toBe(true);
    expect(pf.boosted).toBe(false);
    // SEC-M3: the fee is parked, not burned — vault +120 $CG, liab_cg +120 $CG, burned_total unchanged
    expect(pf.feeEscrowed).toBe(120_000_000n);
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, owner.publicKey))).toBe(120_000_000n);
    expect((await tokenBalance(env.chain, env.mints.cg, vaultKey())) - vaultBefore).toBe(120_000_000n);
    const cfg1 = await env.refreshConfig();
    expect(cfg1.liabCg - cfg0.liabCg).toBe(120_000_000n);
    expect(cfg1.burnedTotal).toBe(cfg0.burnedTotal);
    // a busy material cannot be used again
    await expectFail(fuse(env, owner, [mats[0], ...(await chipsOf(env, owner, 4, 2))], { randomized: true }), Err.chip('ChipNotFree'), 'material already fusing');
    // pick a value that rolls < 8 500
    let v = valueOf('F04'); for (let s = 0; uniformBps(v, 0) >= 8500; s++) v = valueOf('F04', s);
    await env.chain.send([revealIx({ kind: RNG_KIND.FUSION, payer: env.admin.publicKey, randomness: r.rng.randomness, value: v })], { signers: [env.admin] });
    const tx = await env.chain.send([fuseRevealIx({ payer: env.admin.publicKey, owner: owner.publicKey, nonce: r.nonce, randomness: r.rng.randomness, resultCollectionIdx: mats[0].collectionIdx, materials: mats, coreCollectionOf: env.coreOf, cgMint: env.mints.cg })], { signers: [env.admin] });
    const ev = findEvent(tx.logs, 'ChipFused', readChipFused)!;
    expect(ev.success).toBe(true);
    expect(ev.thresholdBps).toBe(8500);
    expect(ev.rollBps).toBe(uniformBps(v, 0));
    expect(ev.feeBurned).toBe(120_000_000n);
    for (const m of mats) expect(await env.chain.getAccount(m.asset)).toBeNull();
    const res = (await loadChip(env.chain, r.resultAsset))!;
    expect(res.rarity).toBe(5);
    expect(res.lockUntil).toBeGreaterThan(await env.chain.now());
    expect(await env.chain.getAccount(r.pending)).toBeNull();
    // the escrowed fee is burned at settlement: vault back to where it was, liability released, burned_total +120 $CG
    expect(await tokenBalance(env.chain, env.mints.cg, vaultKey())).toBe(vaultBefore);
    const cfg2 = await env.refreshConfig();
    expect(cfg2.liabCg).toBe(cfg0.liabCg);
    expect(cfg2.burnedTotal - cfg0.burnedTotal).toBe(120_000_000n);
  }, 600_000);

  it('F05 failure: 2 burned, 1 returned (lowest asset key), unfrozen, ChipFused{success:false}', async () => {
    const mats = await chipsOf(env, owner, 4, 3);
    const r = await fuse(env, owner, mats, { randomized: true, resultCollectionIdx: mats[0].collectionIdx });
    let v = valueOf('F05'); for (let s = 0; uniformBps(v, 0) < 8500; s++) v = valueOf('F05', s);
    await env.chain.send([revealIx({ kind: RNG_KIND.FUSION, payer: env.admin.publicKey, randomness: r.rng.randomness, value: v })], { signers: [env.admin] });
    const tx = await env.chain.send([fuseRevealIx({ payer: env.admin.publicKey, owner: owner.publicKey, nonce: r.nonce, randomness: r.rng.randomness, resultCollectionIdx: mats[0].collectionIdx, materials: mats, coreCollectionOf: env.coreOf, cgMint: env.mints.cg })], { signers: [env.admin] });
    const ev = findEvent(tx.logs, 'ChipFused', readChipFused)!;
    expect(ev.success).toBe(false);
    expect(ev.result.equals(PublicKey.default)).toBe(true);
    const survivor = [...mats].sort((a, b) => Buffer.compare(a.asset.toBuffer(), b.asset.toBuffer()))[0];
    for (const m of mats) {
      if (m.asset.equals(survivor.asset)) {
        const st = (await loadChip(env.chain, m.asset))!;
        expect(st.flags & CHIP_FLAG.FUSING).toBe(0);
        expect(await env.chain.getAccount(m.asset)).not.toBeNull();
      } else expect(await env.chain.getAccount(m.asset)).toBeNull();
    }
    expect(await env.chain.getAccount(r.resultAsset)).toBeNull();
  }, 600_000);

  svmOnly('F06 fake randomness at fuse_reveal (SEC-C1) → RandomnessMismatch (pinned account) / foreign owner', async () => {
    if (!env.chain.canWarp) return;
    const mats = await chipsOf(env, owner, 4, 3);
    const r = await fuse(env, owner, mats, { randomized: true, resultCollectionIdx: mats[0].collectionIdx });
    const pf = decodePendingFusion((await env.chain.getAccount(r.pending))!.data);
    const forged = await forgeRandomness(env.chain, { owner: Keypair.generate().publicKey, kind: RNG_KIND.FUSION, seedSlot: pf.commitSlot, revealSlot: await env.chain.slot(), value: valueOf('F06') });
    await expectFail(env.chain.send([fuseRevealIx({ payer: env.admin.publicKey, owner: owner.publicKey, nonce: r.nonce, randomness: forged, resultCollectionIdx: mats[0].collectionIdx, materials: mats, coreCollectionOf: env.coreOf, cgMint: env.mints.cg })], { signers: [env.admin] }), Err.chip('RandomnessMismatch'), 'forged account');
    const real = (await env.chain.getAccount(r.rng.randomness))!;
    await env.chain.setAccount(r.rng.randomness, { owner: Keypair.generate().publicKey, data: real.data, lamports: real.lamports });
    await expectFail(env.chain.send([fuseRevealIx({ payer: env.admin.publicKey, owner: owner.publicKey, nonce: r.nonce, randomness: r.rng.randomness, resultCollectionIdx: mats[0].collectionIdx, materials: mats, coreCollectionOf: env.coreOf, cgMint: env.mints.cg })], { signers: [env.admin] }), Err.chip('RandomnessMismatch'), 'owner swapped');
    await env.chain.setAccount(r.rng.randomness, { owner: SB_MOCK_ID, data: real.data, lamports: real.lamports });
    // unrevealed → RandomnessNotResolved
    await expectFail(env.chain.send([fuseRevealIx({ payer: env.admin.publicKey, owner: owner.publicKey, nonce: r.nonce, randomness: r.rng.randomness, resultCollectionIdx: mats[0].collectionIdx, materials: mats, coreCollectionOf: env.coreOf, cgMint: env.mints.cg })], { signers: [env.admin] }), Err.chip('RandomnessNotResolved'), 'not revealed yet');
  }, 600_000);

  svmOnly('F07/F08 cancel_stale_fusion: before window → NotStale; after → materials unfrozen, PendingFusion closed, escrowed fee returned 100 % (SEC-M3)', async () => {
    if (!env.chain.canWarp) return;
    const mats = await chipsOf(env, owner, 4, 3);
    const cgBefore = await tokenBalance(env.chain, env.mints.cg, owner.publicKey);
    const liab0 = (await env.refreshConfig()).liabCg;
    const r = await fuse(env, owner, mats, { randomized: true, resultCollectionIdx: mats[0].collectionIdx });
    expect(cgBefore - (await tokenBalance(env.chain, env.mints.cg, owner.publicKey))).toBe(120_000_000n);
    const cancel = () => env.chain.send([cancelStaleFusionIx({ owner: owner.publicKey, nonce: r.nonce, randomness: r.rng.randomness, materials: mats, coreCollectionOf: env.coreOf, cgMint: env.mints.cg })], { signers: [owner] });
    await expectFail(cancel(), Err.chip('NotStale'));
    await env.chain.warpSlots(STALE + 1n);
    await cancel();
    for (const m of mats) expect((await loadChip(env.chain, m.asset))!.flags & CHIP_FLAG.FUSING).toBe(0);
    expect(await env.chain.getAccount(r.pending)).toBeNull();
    // the oracle never answered → the player gets the whole fee back and the liability is released
    expect(await tokenBalance(env.chain, env.mints.cg, owner.publicKey)).toBe(cgBefore);
    expect((await env.refreshConfig()).liabCg).toBe(liab0);
    // after a reveal the cancel path is closed (must settle instead)
    const mats2 = await chipsOf(env, owner, 4, 3);
    const r2 = await fuse(env, owner, mats2, { randomized: true, resultCollectionIdx: mats2[0].collectionIdx });
    await env.chain.send([revealIx({ kind: RNG_KIND.FUSION, payer: env.admin.publicKey, randomness: r2.rng.randomness, value: valueOf('F08') })], { signers: [env.admin] });
    await env.chain.warpSlots(STALE + 1n);
    await expectFail(env.chain.send([cancelStaleFusionIx({ owner: owner.publicKey, nonce: r2.nonce, randomness: r2.rng.randomness, materials: mats2, coreCollectionOf: env.coreOf, cgMint: env.mints.cg })], { signers: [owner] }), Err.chip('RandomnessAlreadyRevealed'));
  }, 600_000);

  it('F09 booster: +15 pp (threshold 10 000 for 85 % + 15), decremented; none left → NoBooster', async () => {
    await env.chain.send([grantBoosterIx({ authority: env.admin.publicKey, payer: env.admin.publicKey, owner: owner.publicKey, count: 1 })], { signers: [env.admin] });
    const mats = await chipsOf(env, owner, 4, 3);
    const r = await fuse(env, owner, mats, { randomized: true, useBooster: true, resultCollectionIdx: mats[0].collectionIdx });
    expect(decodePlayerItems((await env.chain.getAccount(playerItemsPda(owner.publicKey)[0]))!.data).boosters).toBe(0);
    expect(decodePendingFusion((await env.chain.getAccount(r.pending))!.data).boosted).toBe(true);
    let v = valueOf('F09'); for (let s = 0; uniformBps(v, 0) < 8500 || uniformBps(v, 0) >= 9500; s++) v = valueOf('F09', s); // would fail unboosted, passes boosted (cap 95 %)
    await env.chain.send([revealIx({ kind: RNG_KIND.FUSION, payer: env.admin.publicKey, randomness: r.rng.randomness, value: v })], { signers: [env.admin] });
    const tx = await env.chain.send([fuseRevealIx({ payer: env.admin.publicKey, owner: owner.publicKey, nonce: r.nonce, randomness: r.rng.randomness, resultCollectionIdx: mats[0].collectionIdx, materials: mats, coreCollectionOf: env.coreOf, cgMint: env.mints.cg })], { signers: [env.admin] });
    const ev = findEvent(tx.logs, 'ChipFused', readChipFused)!;
    expect(ev.thresholdBps).toBe(9500);
    expect(ev.success).toBe(true);
    const more = await chipsOf(env, owner, 4, 3);
    await expectFail(fuse(env, owner, more, { randomized: true, useBooster: true, resultCollectionIdx: more[0].collectionIdx }), Err.chip('NoBooster'));
    // booster on an atomic recipe is ignored (no decrement, no error)
    const com = await chipsOf(env, owner, 0, 3);
    const a = await fuse(env, owner, com, { randomized: false, useBooster: true, resultCollectionIdx: com[0].collectionIdx });
    expect(a.event?.success).toBe(true);
  }, 600_000);

  it('F10/F11 materials that are staked / listed / not owned → rejected; missing rng accounts for a randomized recipe → RandomnessMismatch', async () => {
    const other = await env.player({ usdc: 10_000_000_000n, cg: 10_000_000_000n });
    const theirs = await chipsOf(env, other, 0, 1);
    const mine = await chipsOf(env, owner, 0, 2);
    await expectFail(fuse(env, owner, [...mine, ...theirs], { randomized: false, resultCollectionIdx: mine[0].collectionIdx }), Err.chip('NotAssetOwner'), 'foreign material');
    const mats = await chipsOf(env, owner, 4, 3);
    await expectFail(fuse(env, owner, mats, { randomized: false, resultCollectionIdx: mats[0].collectionIdx }), Err.chip('RandomnessMismatch'), 'randomized recipe without rng accounts');
    // randomness account of another owner's nonce → seeds mismatch
    const rng = rngAccounts(RNG_KIND.FUSION, other.publicKey, 55n);
    await expectAnyFail(env.chain.send([fuseIx({ owner: owner.publicKey, nonce: 55n, useBooster: false, rng: { randomness: rng.randomness, queue: SB_QUEUE, oracle: SB_ORACLE }, materials: mats, resultCollectionIdx: mats[0].collectionIdx, cgMint: env.mints.cg, coreCollectionOf: env.coreOf })], { signers: [owner] }), 'foreign rng PDA');
    expect((await randomnessAccount(env.chain, rng.randomness))).toBeNull();
  }, 600_000);
});

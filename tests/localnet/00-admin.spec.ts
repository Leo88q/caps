// T-L-G — admin & global (docs/06 §3.5 "Общие / админ").
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { COLLECTIONS } from '@/shared/lib/lore';
import { decodeArenaConfig, decodeCollectionMeta, decodeCoreAssetHeader, decodeEmissionState, decodePlayerItems } from '@/chain/accounts';
import { BorshWriter } from '@/chain/borsh';
import { LEDGER_SHARDS, allLedgerPdas, arenaConfigPda, collectionMetaPda, configPda, emissionPda, ledgerShardOf, playerItemsPda, vaultPda } from '@/chain/pdas';
import { PACKS } from '@guttercaps/economy';
import { binariesPresent, getEnv, type Env, TREASURY, acceptAdminIx, createCollectionIx, grantBoosterIx, initLedgerIx, pauseIx, proposeAdminIx, setParamsIx, setPausedIx, setPauserIx, sweepVaultIx, tokenBalance, unpauseIx, type Pausable } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { Currency, SKU, buyPack, revealAndOpenAll, valueOf } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
if (!bins.ok && !process.env.LOCALNET_RPC) console.warn(`[tests/localnet] skipped — missing program binaries:\n  ${bins.missing.join('\n  ')}\n  run \`anchor build -- --features localnet\` and \`npm run localnet:fixtures\` (see tests/localnet/README.md)`);

/** Encode `[PackDef; 4]` from the live config with a patch applied to one SKU (Borsh layout = PackDef 42 B). */
export function encodePacks(env: Env, patch: Partial<Record<number, Partial<Env['config']['packs'][number]>>>): Uint8Array {
  const w = new BorshWriter();
  env.config.packs.forEach((p0, i) => {
    const p = { ...p0, ...(patch[i] ?? {}) };
    w.u8(p.chips).u32(p.priceUsdCents).u64(p.priceCgMicro);
    for (const o of p.oddsBps) w.u16(o);
    w.u8(p.floor).u8(p.dailyCap).u8(p.pityTier).u16(p.pityHardAt).u16(p.pitySoftStart).u16(p.pitySoftStepBps).bool(p.featuredOnly).bool(p.enabled);
  });
  return w.toBytes();
}

suite('T-L-G admin', () => {
  let env: Env;
  beforeAll(async () => { env = await getEnv(); });

  it('G01 initialize + 10 create_collection: config, vault rent floor, CollectionMeta from lore, Core collection with update authority = meta PDA', async () => {
    const cfg = env.config;
    expect(cfg.admin.equals(env.admin.publicKey)).toBe(true);
    expect(cfg.treasury.equals(TREASURY.publicKey)).toBe(true);
    expect(cfg.collectionsCreated).toBe(COLLECTIONS.length);
    expect(cfg.paused).toBe(false);
    expect(cfg.packs.map((p) => p.priceUsdCents)).toEqual([PACKS.starter, PACKS.standard, PACKS.premium, PACKS.limited].map((p) => p.priceUsdCents));
    expect(cfg.marketFeeBps).toBe(750);
    expect(cfg.skrDiscountBps).toBe(500);
    expect(await env.chain.balance(vaultPda()[0])).toBeGreaterThanOrEqual(await env.chain.rentExempt(0));
    for (let i = 0; i < COLLECTIONS.length; i++) {
      const meta = decodeCollectionMeta((await env.chain.getAccount(collectionMetaPda(i)[0]))!.data);
      expect(meta.idx).toBe(i);
      expect(meta.symbol).toBe(COLLECTIONS[i].symbol);
      expect(meta.minted).toBe(0n);
      const core = await env.chain.getAccount(meta.coreCollection);
      expect(core, `core collection ${i}`).not.toBeNull();
      expect(core!.owner.toBase58()).toBe('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
      const header = decodeCoreAssetHeader(core!.data);
      expect(header.name).toBe(COLLECTIONS[i].name);
      expect(header.updateAuthority?.equals(collectionMetaPda(i)[0])).toBe(true);
    }
  });

  it('G01b create_collection: 11th index, non-sequential index and a non-admin signer are rejected', async () => {
    const core = Keypair.generate();
    await expectFail(env.chain.send([createCollectionIx({ admin: env.admin.publicKey, idx: 10, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [env.admin, core] }), Err.chip('InvalidCollection'), 'idx 10');
    await expectFail(env.chain.send([createCollectionIx({ admin: env.admin.publicKey, idx: 3, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [env.admin, core] }), Err.anchor('ConstraintSeeds'), 'existing idx (init on a live PDA)');
    const stranger = await env.player();
    await expectFail(env.chain.send([createCollectionIx({ admin: stranger.publicKey, idx: 10, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [stranger, core] }), Err.anchor('ConstraintHasOne'), 'stranger');
  });

  it('G02 set_params: full patch bumps params_version; every guard-rail rejects', async () => {
    const before = await env.refreshConfig();
    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 800, skrDiscountBps: 700, featuredCollection: 2 })], { signers: [env.admin] });
    const after = await env.refreshConfig();
    expect(after.paramsVersion).toBe(before.paramsVersion + 1);
    expect(after.marketFeeBps).toBe(800);
    expect(after.skrDiscountBps).toBe(700);
    expect(after.featuredCollection).toBe(2);
    // restore defaults so later specs see the documented fee schedule
    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 750, skrDiscountBps: 500, featuredCollection: 0 })], { signers: [env.admin] });
    env.config = await env.refreshConfig();

    const admin = env.admin.publicKey;
    await expectFail(env.chain.send([setParamsIx(admin, { marketFeeBps: 1001 })], { signers: [env.admin] }), Err.chip('FeeTooHigh'), 'fee > 10 %');
    await expectFail(env.chain.send([setParamsIx(admin, { skrDiscountBps: 1501 })], { signers: [env.admin] }), Err.chip('FeeTooHigh'), 'skr discount > 15 %');
    await expectFail(env.chain.send([setParamsIx(admin, { featuredCollection: 10 })], { signers: [env.admin] }), Err.chip('InvalidCollection'), 'featured ≥ created');
    const odds = [...env.config.packs[1].oddsBps]; odds[0] += 1;
    await expectFail(env.chain.send([setParamsIx(admin, { packs: encodePacks(env, { 1: { oddsBps: odds } }) })], { signers: [env.admin] }), Err.chip('OddsSumInvalid'), 'odds ≠ 10 000');
    const top = [...env.config.packs[1].oddsBps]; top[0] -= 300; top[7] += 300; // Legend+ + Diamond = 320 bps > 200 on Standard
    await expectFail(env.chain.send([setParamsIx(admin, { packs: encodePacks(env, { 1: { oddsBps: top } }) })], { signers: [env.admin] }), Err.chip('OddsGuardRail'), 'top-2 guard rail');
    const cheap = encodePacks(env, { 1: { priceUsdCents: 49 } });
    await expectFail(env.chain.send([setParamsIx(admin, { packs: cheap })], { signers: [env.admin] }), Err.chip('OddsGuardRail'), 'price < $0.50');
    const pity = encodePacks(env, { 1: { pityHardAt: 5 } });
    await expectFail(env.chain.send([setParamsIx(admin, { packs: pity })], { signers: [env.admin] }), Err.chip('OddsGuardRail'), 'pity_hard_at < 10');
    const chips = encodePacks(env, { 2: { chips: 6 } });
    await expectFail(env.chain.send([setParamsIx(admin, { packs: chips })], { signers: [env.admin] }), Err.chip('InvalidQuantity'), 'chips > 5');
    const stranger = await env.player();
    await expectFail(env.chain.send([setParamsIx(stranger.publicKey, { marketFeeBps: 100 })], { signers: [stranger] }), Err.anchor('ConstraintHasOne'), 'non-admin');
  });

  it('G03 set_paused: buy_pack → Paused while paused, admin-only, unpause restores', async () => {
    await env.chain.send([setPausedIx(env.admin.publicKey, true)], { signers: [env.admin] });
    expect((await env.refreshConfig()).paused).toBe(true);
    const buyer = await env.player({ usdc: 100_000_000n });
    await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC }), Err.chip('Paused'), 'buy while paused');
    const stranger = await env.player();
    await expectFail(env.chain.send([setPausedIx(stranger.publicKey, false)], { signers: [stranger] }), Err.anchor('ConstraintHasOne'), 'stranger unpause');
    await env.chain.send([setPausedIx(env.admin.publicKey, false)], { signers: [env.admin] });
    expect((await env.refreshConfig()).paused).toBe(false);
    await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
  });

  it('G03b pauser role (SEC-H2): pauser may `pause` on chip_core / staking / arena but cannot un-pause or change params; admin does both; cleared pauser loses the right', async () => {
    const pauser = await env.player();
    const stranger = await env.player();
    const pausedOf: Record<Pausable, () => Promise<boolean>> = {
      chip_core: async () => (await env.refreshConfig()).paused,
      staking: async () => decodeEmissionState((await env.chain.getAccount(emissionPda()[0]))!.data).paused,
      arena: async () => decodeArenaConfig((await env.chain.getAccount(arenaConfigPda()[0]))!.data).paused,
    };
    for (const program of ['chip_core', 'staking', 'arena'] as Pausable[]) {
      // nobody but admin before a pauser is set (Pubkey::default() never matches a real signer)
      await expectFail(env.chain.send([pauseIx(program, pauser.publicKey)], { signers: [pauser] }), Err.anchor('ConstraintRaw'), `${program}: pause before designation`);
      await expectFail(env.chain.send([setPauserIx(program, stranger.publicKey, pauser.publicKey)], { signers: [stranger] }), Err.anchor('ConstraintHasOne'), `${program}: stranger sets pauser`);
      await env.chain.send([setPauserIx(program, env.admin.publicKey, pauser.publicKey)], { signers: [env.admin] });
      // pauser: pause OK (idempotent), un-pause impossible (no instruction accepts it), stranger refused
      await env.chain.send([pauseIx(program, pauser.publicKey)], { signers: [pauser], label: `${program}: pauser pauses` });
      expect(await pausedOf[program]()).toBe(true);
      await env.chain.send([pauseIx(program, pauser.publicKey)], { signers: [pauser], label: `${program}: pause twice` });
      await expectFail(env.chain.send([unpauseIx(program, pauser.publicKey)], { signers: [pauser] }), Err.anchor('ConstraintHasOne'), `${program}: pauser un-pauses`);
      await expectFail(env.chain.send([pauseIx(program, stranger.publicKey)], { signers: [stranger] }), Err.anchor('ConstraintRaw'), `${program}: stranger pauses`);
      if (program === 'chip_core') {
        const buyer = await env.player({ usdc: 100_000_000n });
        await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC }), Err.chip('Paused'), 'buy while pauser-paused');
        await expectFail(env.chain.send([setParamsIx(pauser.publicKey, { marketFeeBps: 100 })], { signers: [pauser] }), Err.anchor('ConstraintHasOne'), 'pauser cannot set_params');
      }
      // admin: un-pause, and `pause` also works for the admin itself
      await env.chain.send([unpauseIx(program, env.admin.publicKey)], { signers: [env.admin] });
      expect(await pausedOf[program]()).toBe(false);
      await env.chain.send([pauseIx(program, env.admin.publicKey)], { signers: [env.admin] });
      expect(await pausedOf[program]()).toBe(true);
      await env.chain.send([unpauseIx(program, env.admin.publicKey)], { signers: [env.admin] });
      // clearing the pauser revokes the right
      await env.chain.send([setPauserIx(program, env.admin.publicKey, PublicKey.default)], { signers: [env.admin] });
      await expectFail(env.chain.send([pauseIx(program, pauser.publicKey)], { signers: [pauser] }), Err.anchor('ConstraintRaw'), `${program}: cleared pauser`);
      expect(await pausedOf[program]()).toBe(false);
    }
    expect((await env.refreshConfig()).pauser.equals(PublicKey.default)).toBe(true);
  });

  it('G04 propose_admin / accept_admin: two-step hand-over, only the proposed key may accept, round-trip back', async () => {
    const next = await env.player();
    const stranger = await env.player();
    await expectFail(env.chain.send([acceptAdminIx(stranger.publicKey)], { signers: [stranger] }), Err.anchor('ConstraintRaw'), 'accept without proposal');
    await env.chain.send([proposeAdminIx(env.admin.publicKey, next.publicKey)], { signers: [env.admin] });
    expect((await env.refreshConfig()).pendingAdmin.equals(next.publicKey)).toBe(true);
    await expectFail(env.chain.send([acceptAdminIx(stranger.publicKey)], { signers: [stranger] }), Err.anchor('ConstraintRaw'), 'stranger accepts');
    await env.chain.send([acceptAdminIx(next.publicKey)], { signers: [next] });
    let cfg = await env.refreshConfig();
    expect(cfg.admin.equals(next.publicKey)).toBe(true);
    expect(cfg.pendingAdmin.equals(PublicKey.default)).toBe(true);
    await expectFail(env.chain.send([setPausedIx(env.admin.publicKey, true)], { signers: [env.admin] }), Err.anchor('ConstraintHasOne'), 'old admin');
    // hand it back for the rest of the suite
    await env.chain.send([proposeAdminIx(next.publicKey, env.admin.publicKey)], { signers: [next] });
    await env.chain.send([acceptAdminIx(env.admin.publicKey)], { signers: [env.admin] });
    cfg = await env.refreshConfig();
    expect(cfg.admin.equals(env.admin.publicKey)).toBe(true);
  });

  it('G05 sweep_vault never dips below liabilities: after a USDC buy without open the vault keeps liab_usdc; after open it is swept', async () => {
    const buyer = await env.player({ usdc: 100_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const led = await env.ledger();
    expect(led.liabUsdc).toBeGreaterThanOrEqual(b.paid);
    // #12: the liability sits in the buyer's shard only; config carries no counters any more
    const shard = await env.ledgerShard(ledgerShardOf(buyer.publicKey));
    expect(shard.liabUsdc).toBeGreaterThanOrEqual(b.paid);
    const vault = vaultPda()[0];
    const treasuryBefore = await tokenBalance(env.chain, env.mints.usdc, TREASURY.publicKey);
    await env.chain.send([sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey, mint: env.mints.usdc })], { signers: [env.admin] });
    expect(await tokenBalance(env.chain, env.mints.usdc, vault)).toBeGreaterThanOrEqual(led.liabUsdc);
    // settle the purchase → liability released → sweep moves it
    await revealAndOpenAll(env, buyer, b, valueOf('G05'));
    const liabAfter = (await env.ledger()).liabUsdc;
    expect(liabAfter).toBe(led.liabUsdc - b.paid);
    await env.chain.send([sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey, mint: env.mints.usdc })], { signers: [env.admin] });
    expect(await tokenBalance(env.chain, env.mints.usdc, vault)).toBe(liabAfter);
    expect(await tokenBalance(env.chain, env.mints.usdc, TREASURY.publicKey)).toBeGreaterThanOrEqual(treasuryBefore + b.paid);
    // SOL leg never below liab_lamports + rent floor
    const solBuyer = await env.player();
    const sb = await buyPack(env, solBuyer, { sku: SKU.STANDARD, currency: Currency.SOL });
    await env.chain.send([sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey })], { signers: [env.admin] });
    const led2 = await env.ledger();
    expect(await env.chain.balance(vault)).toBeGreaterThanOrEqual(led2.liabLamports + (await env.chain.rentExempt(0)));
    expect(led2.liabLamports).toBeGreaterThanOrEqual(sb.paid);
    const stranger = await env.player();
    await expectFail(env.chain.send([sweepVaultIx({ admin: stranger.publicKey, treasury: TREASURY.publicKey })], { signers: [stranger] }), Err.anchor('ConstraintHasOne'), 'stranger sweep');
  });

  it('G05b (#12) sweep_vault needs every ledger shard: a missing / duplicated / foreign shard is rejected, never treated as zero liability', async () => {
    const all = allLedgerPdas();
    const sweep = (shards: PublicKey[]) => env.chain.send([sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey, shards })], { signers: [env.admin] });
    await expectFail(sweep(all.slice(0, LEDGER_SHARDS - 1)), Err.chip('InvalidShard'), 'one shard missing');
    await expectFail(sweep([all[1], all[0], ...all.slice(2)]), Err.chip('InvalidShard'), 'shards out of order');
    await expectFail(sweep([all[0], all[0], ...all.slice(2)]), Err.chip('InvalidShard'), 'duplicated shard');
    await expectFail(sweep([configPda()[0], ...all.slice(1)]), Err.anchor('AccountDiscriminatorMismatch'), 'foreign account in a shard slot');
    // init_ledger is idempotent-by-failure: a second init of an existing shard fails (system program: account already in use), shard ≥ N is InvalidShard
    await expectAnyFail(env.chain.send([initLedgerIx({ payer: env.admin.publicKey, shard: 0 })], { signers: [env.admin] }), 're-init shard 0');
    await expectFail(env.chain.send([initLedgerIx({ payer: env.admin.publicKey, shard: LEDGER_SHARDS })], { signers: [env.admin] }), Err.chip('InvalidShard'), 'shard out of range');
    // the happy path still works and every shard carries its own id + bump
    await sweep(all);
    for (let i = 0; i < LEDGER_SHARDS; i++) expect((await env.ledgerShard(i)).shard).toBe(i);
  });

  it('G06 grant_booster: admin grants ≤ 10, PlayerItems created; a stranger → Unauthorized; > 10 → InvalidQuantity', async () => {
    const owner = await env.player();
    await env.chain.send([grantBoosterIx({ authority: env.admin.publicKey, payer: env.admin.publicKey, owner: owner.publicKey, count: 3 })], { signers: [env.admin] });
    const items = decodePlayerItems((await env.chain.getAccount(playerItemsPda(owner.publicKey)[0]))!.data);
    expect(items.owner.equals(owner.publicKey)).toBe(true);
    expect(items.boosters).toBe(3);
    const stranger = await env.player();
    await expectFail(env.chain.send([grantBoosterIx({ authority: stranger.publicKey, payer: stranger.publicKey, owner: owner.publicKey, count: 1 })], { signers: [stranger] }), Err.chip('Unauthorized'), 'stranger grants');
    await expectFail(env.chain.send([grantBoosterIx({ authority: env.admin.publicKey, payer: env.admin.publicKey, owner: owner.publicKey, count: 11 })], { signers: [env.admin] }), Err.chip('InvalidQuantity'), '> 10');
    expect(decodePlayerItems((await env.chain.getAccount(playerItemsPda(owner.publicKey)[0]))!.data).boosters).toBe(3);
    expect(configPda()[0]).toBeInstanceOf(PublicKey);
  });
});

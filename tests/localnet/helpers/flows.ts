// Scenario building blocks on top of the REAL client builders (client/src/chain/ix/*):
// buy a pack, reveal through the mock, open every pack of a bundle, fuse, etc. Each helper
// returns what the specs assert on (accounts, events, balances) and nothing is cached across
// calls, so scenarios stay independent.
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PACKS, expandRandomness } from '@guttercaps/economy';
import { findEvent } from '@/chain/anchor';
import { decodePendingPack, decodePlayerPity, readPackOpened, readCompressedClaimsCreated, decodeChipState, decodeCompressedMintClaim, type PackOpenedEvent, type CompressedClaimsCreatedEvent, type PendingPack, type ChipState, type CompressedMintClaim } from '@/chain/accounts';
import { Currency, buyPackIx, openPackIx, openCompressedPackIx, cancelStalePackIx, type CurrencyCode } from '@/chain/ix/chipCore';
import { initRandomnessIx, rngAccounts } from '@/chain/ix/rng';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { RNG_KIND, assetPda, chipStatePda, compressedMintClaimPda, pendingPackPda, pityPda, vaultPda } from '@/chain/pdas';
import { packSeed, toEconPack, voucherEconPack } from '@/chain/flows/packFlow';
import type { Chain, TxResult } from './chain';
import { SB_ORACLE, SB_QUEUE, type Env } from './env';
import { refreshPyth, unitsForCents } from './pyth';
import { revealIx, valueOf } from './sbmock';

export const SKU = { STARTER: 0, STANDARD: 1, PREMIUM: 2, LIMITED: 3 } as const;
export { Currency };

let nonceCounter = 1_000n;
export const nextNonce = () => ++nonceCounter;

export interface BuyResult { nonce: bigint; randomness: PublicKey; pending: PublicKey; tx: TxResult; paid: bigint }

/** Expected units for a SOL / SKR purchase at the fixture prices (same math as the program). */
export function quoteUnits(env: Env, sku: number, qty: number, currency: CurrencyCode): bigint {
  const def = env.config.packs[sku];
  const bundle = qty >= 25 ? 1800 : qty >= 10 ? 1200 : qty >= 5 ? 700 : 0;
  let discount = sku === SKU.LIMITED || sku === SKU.STARTER ? 0 : bundle;
  if (currency === Currency.SKR) discount = Math.min(discount + env.config.skrDiscountBps, 3000);
  const cents = (BigInt(def.priceUsdCents) * BigInt(qty) * BigInt(10_000 - discount)) / 10_000n;
  if (currency === Currency.SOL) return unitsForCents(cents, env.pyth.sol);
  if (currency === Currency.SKR) return unitsForCents(cents, env.pyth.skr);
  if (currency === Currency.USDC) return cents * 10_000n;
  return (def.priceCgMicro * BigInt(qty) * BigInt(10_000 - discount)) / 10_000n;
}

/**
 * `init_randomness + buy_pack` in ONE transaction (exactly what PackFlow.buy sends).
 * Refreshes the Pyth fixtures first so the 60 s window holds after clock warps.
 */
export async function buyPack(env: Env, buyer: Keypair, o: { sku: number; qty?: number; currency?: CurrencyCode; nonce?: bigint; maxUnits?: bigint; priceUpdate?: PublicKey; extraIxs?: TransactionInstruction[]; skipInit?: boolean; randomness?: PublicKey; stalePrice?: bigint; conf?: Partial<Record<'sol' | 'skr', bigint>> }): Promise<BuyResult> {
  const { chain } = env;
  const qty = o.qty ?? 1;
  const currency = o.currency ?? Currency.SOL;
  const nonce = o.nonce ?? nextNonce();
  const rng = rngAccounts(RNG_KIND.PACK, buyer.publicKey, nonce);
  const randomness = o.randomness ?? rng.randomness;
  if (chain.kind === 'litesvm') await refreshPyth(chain, env.pyth, { ageS: o.stalePrice ?? 0n, conf: o.conf });
  const volatile = currency === Currency.SOL || currency === Currency.SKR;
  const quoted = volatile ? quoteUnits(env, o.sku, qty, currency) : 0n;
  const ixs: TransactionInstruction[] = [...(o.extraIxs ?? [])];
  if (!o.skipInit) ixs.push(initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await chain.slot()) - 1n }));
  ixs.push(buyPackIx({
    buyer: buyer.publicKey, sku: o.sku, qty, currency, nonce,
    maxLamports: volatile ? (o.maxUnits ?? (quoted * 101n) / 100n) : 0n,
    randomness, queue: SB_QUEUE, oracle: SB_ORACLE,
    priceUpdate: volatile ? (o.priceUpdate ?? (currency === Currency.SKR ? env.pyth.skr.account : env.pyth.sol.account)) : undefined,
    usdcMint: env.mints.usdc, cgMint: env.mints.cg, skrMint: env.mints.skr,
  }));
  const tx = await chain.send(ixs, { signers: [buyer], label: `buy_pack sku=${o.sku} qty=${qty} cur=${currency}` });
  const pending = pendingPackPda(buyer.publicKey, nonce)[0];
  return { nonce, randomness, pending, tx, paid: volatile ? quoted : quoteUnits(env, o.sku, qty, currency) };
}

export async function loadPending(chain: Chain, key: PublicKey): Promise<PendingPack | null> {
  const a = await chain.getAccount(key);
  return a && a.data.length ? decodePendingPack(a.data) : null;
}

export async function loadPity(chain: Chain, wallet: PublicKey) {
  const a = await chain.getAccount(pityPda(wallet)[0]);
  return a ? decodePlayerPity(a.data) : null;
}

export async function loadChip(chain: Chain, asset: PublicKey): Promise<ChipState | null> {
  const a = await chain.getAccount(chipStatePda(asset)[0]);
  return a && a.data.length ? decodeChipState(a.data) : null;
}

/** Permissionless reveal of a pack randomness account with a chosen value (defaults to a label-derived one). */
export async function revealPack(env: Env, b: { randomness: PublicKey }, value: Uint8Array = valueOf('pack'), payer: Keypair = env.admin): Promise<TxResult> {
  return env.chain.send([revealIx({ kind: RNG_KIND.PACK, payer: payer.publicKey, randomness: b.randomness, value })], { signers: [payer], label: 'reveal_randomness' });
}

export interface OpenResult { tx: TxResult; event: PackOpenedEvent; rolled: { rarity: number; collectionIdx: number }[]; assets: PublicKey[] }

/**
 * Build the `open_pack` instruction for pack `packNo` — simulates `expandRandomness` off-chain
 * (with the live PackDef + pity counter) to know which collection accounts to pass, as the crank does.
 */
export async function openPackInstruction(env: Env, buyer: PublicKey, nonce: bigint, packNo: number, value: Uint8Array, payer: PublicKey, opts: { pityOverride?: number; rolledOverride?: number[] } = {}): Promise<{ ix: TransactionInstruction; rolled: { rarity: number; collectionIdx: number }[] }> {
  const { chain } = env;
  const pending = (await loadPending(chain, pendingPackPda(buyer, nonce)[0]))!;
  const cfg = await env.refreshConfig();
  const def = cfg.packs[pending.sku];
  // (#28) a quest chip voucher: 1 chip, template odds, no floor / pity, every district — same as the crank's voucherEconPack
  const econ = pending.voucher ? voucherEconPack(pending) : toEconPack(pending.sku, def);
  const pool = !pending.voucher && def.featuredOnly ? [cfg.featuredCollection] : Array.from({ length: cfg.collectionsCreated }, (_, i) => i);
  const pity = opts.pityOverride ?? (await loadPity(chain, buyer))?.counters[pending.sku] ?? 0;
  const rolls = expandRandomness(packSeed(value, pending.qty, packNo), econ, pity, pool.length);
  const rolled = rolls.map((r) => ({ rarity: r.rarity as number, collectionIdx: pool[r.collectionIdx] }));
  const rolledCollections = opts.rolledOverride ?? rolled.map((r) => r.collectionIdx);
  const ix = openPackIx({
    payer, buyer, nonce, packNo, qty: pending.qty, randomness: pending.randomness, rolledCollections, coreCollectionOf: env.coreOf,
    cg: pending.paidCg > 0n ? { cgMint: env.mints.cg, treasury: env.config.treasury } : undefined,
  });
  return { ix, rolled };
}

/** Open one pack of a purchase (value must already be revealed or persisted). */
export async function openPack(env: Env, buyer: PublicKey, nonce: bigint, packNo: number, value: Uint8Array, payer: Keypair = env.admin, opts: { pityOverride?: number; rolledOverride?: number[]; prepend?: TransactionInstruction[] } = {}): Promise<OpenResult> {
  const { ix, rolled } = await openPackInstruction(env, buyer, nonce, packNo, value, payer.publicKey, opts);
  const tx = await env.chain.send([...(opts.prepend ?? []), ix], { signers: [payer], label: `open_pack #${packNo}` });
  const event = findEvent(tx.logs, 'PackOpened', readPackOpened);
  if (!event) throw new Error(`PackOpened event missing:\n${tx.logs.join('\n')}`);
  const pending = pendingPackPda(buyer, nonce)[0];
  const assets = rolled.map((_, i) => assetPda(pending, packNo, i)[0]);
  return { tx, event, rolled, assets };
}

export interface CompressedOpenResult {
  tx: TxResult;
  event: CompressedClaimsCreatedEvent;
  rolled: { rarity: number; collectionIdx: number }[];
}

/** Build the compressed roll-to-claim instruction without sending it. The
 * collection accounts are caller-supplied transport data; the program
 * recomputes the roll and rejects a mismatched account, which is useful for
 * negative localnet coverage as well as cranker clients. */
export async function openCompressedPackInstruction(
  env: Env,
  buyer: PublicKey,
  nonce: bigint,
  packNo: number,
  value: Uint8Array,
  payer: PublicKey,
  opts: { pityOverride?: number; collectionOverride?: number[] } = {},
): Promise<{ ix: TransactionInstruction; rolled: { rarity: number; collectionIdx: number }[] }> {
  const pending = (await loadPending(env.chain, pendingPackPda(buyer, nonce)[0]))!;
  const cfg = await env.refreshConfig();
  const def = pending.voucher ? voucherEconPack(pending) : toEconPack(pending.sku, cfg.packs[pending.sku]);
  const pool = !pending.voucher && cfg.packs[pending.sku].featuredOnly
    ? [cfg.featuredCollection]
    : Array.from({ length: cfg.collectionsCreated }, (_, i) => i);
  const pity = opts.pityOverride ?? (await loadPity(env.chain, buyer))?.counters[pending.sku] ?? 0;
  const rolls = expandRandomness(packSeed(value, pending.qty, packNo), def, pity, pool.length);
  const rolled = rolls.map((r) => ({ rarity: r.rarity as number, collectionIdx: pool[r.collectionIdx] }));
  const ix = openCompressedPackIx({
    payer,
    buyer,
    nonce,
    packNo,
    chips: rolled.length,
    collectionIdx: opts.collectionOverride ?? rolled.map((r) => r.collectionIdx),
    randomness: pending.randomness,
  });
  return { ix, rolled };
}

/**
 * V2 replacement for `openPack`: resolve the deterministic roll into
 * claim-bound compressed chips without pretending that DAS has already
 * returned an asset id or proof. Bubblegum minting and registration are
 * deliberately separate follow-up transactions.
 */
export async function openCompressedPack(
  env: Env,
  buyer: PublicKey,
  nonce: bigint,
  packNo: number,
  value: Uint8Array,
  payer: Keypair = env.admin,
  opts: { pityOverride?: number; collectionOverride?: number[] } = {},
): Promise<CompressedOpenResult> {
  const { ix, rolled } = await openCompressedPackInstruction(env, buyer, nonce, packNo, value, payer.publicKey, opts);
  const tx = await env.chain.send([ix], { signers: [payer], label: `open_compressed_pack #${packNo}` });
  const event = findEvent(tx.logs, 'CompressedClaimsCreated', readCompressedClaimsCreated);
  if (!event) throw new Error(`CompressedClaimsCreated event missing:\n${tx.logs.join('\\n')}`);
  return { tx, event, rolled };
}

/** Reveal + open every pack of a purchase through the compressed claim path.
 * The purchase remains open until Bubblegum mint/registration settles each
 * claim; this helper intentionally does not finalize the settlement. */
export async function revealAndOpenCompressedAll(env: Env, buyer: Keypair, b: { nonce: bigint; randomness: PublicKey }, value: Uint8Array = valueOf('pack'), payer: Keypair = env.admin): Promise<CompressedOpenResult[]> {
  await revealPack(env, b, value, payer);
  const pending = (await loadPending(env.chain, pendingPackPda(buyer.publicKey, b.nonce)[0]))!;
  const out: CompressedOpenResult[] = [];
  for (let i = pending.opened; i < pending.qty; i++) {
    out.push(await openCompressedPack(env, buyer.publicKey, b.nonce, i, value, payer));
  }
  return out;
}

/** Reveal + open every pack of a purchase; returns one OpenResult per pack. */
export async function revealAndOpenAll(env: Env, buyer: Keypair, b: { nonce: bigint; randomness: PublicKey }, value: Uint8Array = valueOf('pack'), payer: Keypair = env.admin): Promise<OpenResult[]> {
  await revealPack(env, b, value, payer);
  const pending = (await loadPending(env.chain, pendingPackPda(buyer.publicKey, b.nonce)[0]))!;
  const out: OpenResult[] = [];
  for (let i = pending.opened; i < pending.qty; i++) {
    const prepend = i === pending.qty - 1 && pending.paidCg > 0n
      ? [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ataOf(env.mints.cg, env.config.treasury), env.config.treasury, env.mints.cg)]
      : [];
    out.push(await openPack(env, buyer.publicKey, b.nonce, i, value, payer, { prepend }));
  }
  return out;
}

/** A wallet with freshly opened Bubblegum V2 claim accounts. The claim PDA is the
 * economic handle until the asynchronous DAS mint/registration step completes. */
export async function mintCompressedChips(
  env: Env,
  owner: Keypair,
  packs = 1,
  value?: Uint8Array,
): Promise<{ claim: PublicKey; collectionIdx: number; rarity: number; state: CompressedMintClaim }[]> {
  const out: { claim: PublicKey; collectionIdx: number; rarity: number; state: CompressedMintClaim }[] = [];
  for (let p = 0; p < packs; p++) {
    const b = await buyPack(env, owner, { sku: SKU.STANDARD, qty: 1, currency: Currency.USDC });
    const [r] = await revealAndOpenCompressedAll(env, owner, b, value ?? valueOf('mintCompressedChips', Number(b.nonce)));
    for (const claimNonce of r.event.claimNonces) {
      const claim = compressedMintClaimPda(owner.publicKey, claimNonce)[0];
      const state = decodeCompressedMintClaim((await env.chain.getAccount(claim))!.data);
      out.push({ claim, collectionIdx: state.collectionIdx, rarity: state.rarity, state });
    }
  }
  return out;
}

export function cancelStale(env: Env, buyer: Keypair, b: { nonce: bigint; randomness: PublicKey }, paidMint?: PublicKey) {
  return env.chain.send([cancelStalePackIx({ buyer: buyer.publicKey, nonce: b.nonce, randomness: b.randomness, paidMint })], { signers: [buyer], label: 'cancel_stale_pack' });
}

export const vaultKey = () => vaultPda()[0];
export const ataOf = (mint: PublicKey, owner: PublicKey) => createAtaIdempotentIx(owner, owner, mint).keys[1].pubkey;
export { PACKS, RNG_KIND, valueOf };

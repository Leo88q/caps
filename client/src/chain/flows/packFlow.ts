// Commit → reveal → open state machine for packs. Pure orchestration: no
// React here; the UI subscribes through the `txs` store callbacks.
import { Connection, PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { PACKS, expandRandomness, type PackDef as EconPackDef } from '@guttercaps/economy';
import { sendTx, TxError, type WalletLike } from '../tx';
import { prepareRandomness, prepareReveal, readRandomness } from '../switchboard';
import { buyPackIx, cancelStalePackIx, openPackIx, payMintFor, Currency, RENT_RESERVE_PER_CHIP, STALE_PACK_SLOTS, type CurrencyCode } from '../ix/chipCore';
import { createAtaIdempotentIx } from '../ix/spl';
import { collectionMetaPda, configPda, freshNonce, pendingPackPda, pityPda, vaultPda } from '../pdas';
import {
  decodeCollectionMeta, decodeGameConfig, decodePendingPack, decodePlayerPity, readPackOpened, type GameConfig, type PackDef, type PackOpenedEvent, type PendingPack,
} from '../accounts';
import { findEvent } from '../anchor';

export type PackPhase = 'quote' | 'signing' | 'committed' | 'revealing' | 'opening' | 'done' | 'stale' | 'error';

export interface PackFlowState {
  phase: PackPhase;
  nonce: bigint;
  sku: number;
  qty: number;
  currency: CurrencyCode;
  randomness?: PublicKey;
  buySignature?: string;
  openSignatures: string[];
  opened: PackOpenedEvent[];
  error?: string;
  revealAttempt?: number;
}

export interface PackFlowDeps {
  connection: Connection;
  wallet: WalletLike;
  onState: (s: PackFlowState) => void;
  /** optional accelerators from the backend quote */
  quote?: { priceUpdateAccount?: PublicKey; maxLamports?: bigint; switchboardQueue?: PublicKey };
}

export const SKU_IDS = ['starter', 'standard', 'premium', 'limited'] as const;

/** Convert on-chain PackDef → economy PackDef (so expandRandomness uses LIVE params, not defaults). */
export function toEconPack(sku: number, p: PackDef): EconPackDef {
  const base = PACKS[SKU_IDS[sku]];
  return {
    ...base,
    chips: p.chips,
    priceUsdCents: p.priceUsdCents,
    priceCgMicro: p.priceCgMicro === 0n ? null : Number(p.priceCgMicro),
    oddsBps: p.oddsBps,
    floor: p.floor as EconPackDef['floor'],
    dailyCap: p.dailyCap === 0 ? null : p.dailyCap,
    pity: p.pityTier === 0 ? null : { tier: p.pityTier as 6, hardAt: p.pityHardAt, softStart: p.pitySoftStart, softStepBps: p.pitySoftStepBps },
    pool: p.featuredOnly ? 'featured' : 'all',
  };
}

export async function fetchGameConfig(connection: Connection): Promise<GameConfig> {
  const info = await connection.getAccountInfo(configPda()[0], 'confirmed');
  if (!info) throw new Error('GameConfig not found — program not initialized on this cluster');
  return decodeGameConfig(new Uint8Array(info.data));
}

export async function fetchCoreCollections(connection: Connection, count: number): Promise<Map<number, PublicKey>> {
  const keys = Array.from({ length: count }, (_, i) => collectionMetaPda(i)[0]);
  const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
  const m = new Map<number, PublicKey>();
  infos.forEach((info, i) => { if (info) m.set(i, decodeCollectionMeta(new Uint8Array(info.data)).coreCollection); });
  return m;
}

/** Per-pack 32-byte seed: single pack = value; bundle = keccak(value ‖ pack_no). */
export function packSeed(value: Uint8Array, qty: number, packNo: number): Uint8Array {
  if (qty === 1) return value;
  const buf = new Uint8Array(33);
  buf.set(value, 0);
  buf[32] = packNo;
  return keccak_256(buf);
}

export class PackFlow {
  state: PackFlowState;
  private cfg?: GameConfig;

  constructor(private deps: PackFlowDeps, init: { sku: number; qty: number; currency: CurrencyCode; nonce?: bigint }) {
    this.state = { phase: 'quote', nonce: init.nonce ?? freshNonce(), sku: init.sku, qty: init.qty, currency: init.currency, openSignatures: [], opened: [] };
  }

  private set(patch: Partial<PackFlowState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  /** Step 1 — create+commit randomness and pay, in ONE transaction. */
  async buy(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const def = this.cfg.packs[this.state.sku];
      if (!def.enabled) throw new Error('This pack is currently disabled');

      const rnd = await prepareRandomness(connection, wallet.publicKey, this.deps.quote?.switchboardQueue);
      this.set({ phase: 'signing', randomness: rnd.pubkey });

      const ixs = [...rnd.ixs];
      // vault ATAs must exist for SPL payments — idempotent create is cheap
      const skrMint = this.cfg.skrMint.equals(PublicKey.default) ? undefined : this.cfg.skrMint;
      const payMint = payMintFor(this.state.currency, { usdcMint: this.cfg.usdcMint, cgMint: this.cfg.cgMint, skrMint });
      if (this.state.currency !== Currency.SOL && !payMint) throw new Error('This currency is not enabled on this cluster');
      if (payMint) ixs.push(createAtaIdempotentIx(wallet.publicKey, vaultOwner(), payMint));

      const volatile = this.state.currency === Currency.SOL || this.state.currency === Currency.SKR;
      const fallbackFeed = this.state.currency === Currency.SKR ? this.cfg.pythSkrUsdFeed : this.cfg.pythSolUsdFeed;
      ixs.push(buyPackIx({
        buyer: wallet.publicKey,
        sku: this.state.sku,
        qty: this.state.qty,
        currency: this.state.currency,
        nonce: this.state.nonce,
        maxLamports: volatile ? (this.deps.quote?.maxLamports ?? 0n) : 0n,
        randomness: rnd.pubkey,
        priceUpdate: volatile ? (this.deps.quote?.priceUpdateAccount ?? fallbackFeed) : undefined,
        usdcMint: this.cfg.usdcMint,
        cgMint: this.cfg.cgMint,
        skrMint,
      }));

      const { signature } = await sendTx(connection, wallet, ixs, {
        signers: [rnd.keypair],
        cuLimit: 400_000,
        onSent: (sig) => this.set({ buySignature: sig }),
      });
      this.set({ phase: 'committed', buySignature: signature });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  /** Step 2 — reveal + open every pack of the bundle (resumable). */
  async open(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const [pendingKey] = pendingPackPda(wallet.publicKey, this.state.nonce);
      let pending = await this.loadPending(pendingKey);
      if (!pending) throw new Error('Pending pack not found (already opened?)');
      const randomness = pending.randomness;
      this.set({ randomness, phase: 'revealing' });

      // Do we already have the value on-chain (crank or previous attempt)?
      let value: Uint8Array | null = (await readRandomness(connection, wallet.publicKey, randomness))?.value ?? null;
      let revealIx = undefined as Awaited<ReturnType<typeof prepareReveal>>['ix'] | undefined;
      if (!value) {
        const slot = await connection.getSlot('confirmed');
        if (BigInt(slot) > pending.commitSlot + STALE_PACK_SLOTS) {
          // try one last time to fetch a reveal; if the oracle never answered → stale path
          try {
            const r = await prepareReveal(connection, wallet.publicKey, randomness, { maxWaitMs: 15_000, onAttempt: (n) => this.set({ revealAttempt: n }) });
            revealIx = r.ix; value = r.value;
          } catch {
            this.set({ phase: 'stale' });
            return;
          }
        } else {
          const r = await prepareReveal(connection, wallet.publicKey, randomness, { onAttempt: (n) => this.set({ revealAttempt: n }) });
          revealIx = r.ix; value = r.value;
        }
      }

      const def = this.cfg.packs[pending.sku];
      const econ = toEconPack(pending.sku, def);
      const pool = def.featuredOnly ? [this.cfg.featuredCollection] : Array.from({ length: this.cfg.collectionsCreated }, (_, i) => i);
      const cores = await fetchCoreCollections(connection, this.cfg.collectionsCreated);
      const coreOf = (idx: number) => {
        const c = cores.get(idx);
        if (!c) throw new Error(`collection ${idx} not created`);
        return c;
      };

      this.set({ phase: 'opening' });
      for (let packNo = pending.opened; packNo < pending.qty; packNo++) {
        // pity counter can change between packs of one bundle → re-read
        const pityInfo = await connection.getAccountInfo(pityPda(wallet.publicKey)[0], 'confirmed');
        const pity = pityInfo ? decodePlayerPity(new Uint8Array(pityInfo.data)).counters[pending.sku] : 0;
        const rolls = expandRandomness(packSeed(value, pending.qty, packNo), econ, pity, pool.length);
        const rolledCollections = rolls.map((r) => pool[r.collectionIdx]);

        const ixs = [];
        if (revealIx && packNo === pending.opened) ixs.push(revealIx);
        const isLast = packNo === pending.qty - 1;
        if (isLast && pending.paidCg > 0n) ixs.push(createAtaIdempotentIx(wallet.publicKey, this.cfg.treasury, this.cfg.cgMint));
        ixs.push(openPackIx({
          payer: wallet.publicKey, buyer: pending.buyer, nonce: pending.nonce, packNo, randomness, rolledCollections, coreCollectionOf: coreOf,
          cg: pending.paidCg > 0n ? { cgMint: this.cfg.cgMint, treasury: this.cfg.treasury } : undefined,
        }));

        try {
          const { signature, logs } = await sendTx(connection, wallet, ixs, { cuLimit: 1_400_000, skipPreflight: !!revealIx });
          const ev = findEvent(logs, 'PackOpened', readPackOpened);
          this.set({ openSignatures: [...this.state.openSignatures, signature], opened: ev ? [...this.state.opened, ev] : this.state.opened });
        } catch (e) {
          // lost the race against the crank → re-read and continue
          const fresh = await this.loadPending(pendingKey);
          if (!fresh || fresh.opened > packNo) { pending = fresh ?? pending; revealIx = undefined; if (!fresh) break; packNo = fresh.opened - 1; continue; }
          throw e;
        }
        revealIx = undefined;
      }
      this.set({ phase: 'done' });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  /** Oracle never answered (> STALE_PACK_SLOTS ≈ 72 min, reveal expired) → 100 % refund from the vault. */
  async refund(): Promise<string> {
    const { connection, wallet } = this.deps;
    this.cfg ??= await fetchGameConfig(connection);
    const [pendingKey] = pendingPackPda(wallet.publicKey, this.state.nonce);
    const pending = await this.loadPending(pendingKey);
    if (!pending) throw new Error('Nothing to refund');
    const paidMint = pending.paidUsdc > 0n ? this.cfg.usdcMint : pending.paidSkr > 0n ? this.cfg.skrMint : pending.paidCg > 0n ? this.cfg.cgMint : undefined;
    const { signature } = await sendTx(connection, wallet, [
      cancelStalePackIx({ buyer: wallet.publicKey, nonce: pending.nonce, randomness: pending.randomness, paidMint }),
    ], { cuLimit: 150_000 });
    this.set({ phase: 'done' });
    return signature;
  }

  private async loadPending(key: PublicKey): Promise<PendingPack | null> {
    const info = await this.deps.connection.getAccountInfo(key, 'confirmed');
    return info ? decodePendingPack(new Uint8Array(info.data)) : null;
  }
}

const vaultOwner = () => vaultPda()[0];

/** What the buyer pays up-front (before the Pyth SOL conversion). */
export function rentReserve(chips: number, qty: number): bigint {
  return RENT_RESERVE_PER_CHIP * BigInt(chips) * BigInt(qty);
}

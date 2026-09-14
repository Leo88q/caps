// Fusion: atomic for 100 % recipes, commit-reveal for risky ones.
import { Connection, PublicKey } from '@solana/web3.js';
import { FUSION_RECIPES, BOOSTER } from '@guttercaps/economy';
import { sendTx, TxError, type WalletLike } from '../tx';
import { prepareRandomness, prepareReveal, readRandomness } from '../switchboard';
import { cancelStaleFusionIx, fuseIx, fuseRevealIx, type FuseMaterial } from '../ix/chipCore';
import { freshNonce, pendingFusionPda } from '../pdas';
import { decodePendingFusion, readChipFused, type ChipFusedEvent, type GameConfig } from '../accounts';
import { findEvent } from '../anchor';
import { fetchCoreCollections, fetchGameConfig } from './packFlow';
import { CHIP_CORE_ID } from '../ids';

export type FusionPhase = 'idle' | 'signing' | 'committed' | 'revealing' | 'done' | 'stale' | 'error';

export interface FusionFlowState {
  phase: FusionPhase;
  nonce: bigint;
  recipe: number;
  boosted: boolean;
  materials: FuseMaterial[];
  resultCollectionIdx: number;
  randomness?: PublicKey;
  signatures: string[];
  result?: ChipFusedEvent;
  error?: string;
}

export function successBps(recipe: number, boosted: boolean): number {
  const r = FUSION_RECIPES[recipe];
  if (!r) return 0;
  if (r.successBps === 10_000 || !boosted) return r.successBps;
  return Math.min(BOOSTER.capBps, r.successBps + BOOSTER.bonusBps);
}

export class FusionFlow {
  state: FusionFlowState;
  private cfg?: GameConfig;

  constructor(
    private deps: { connection: Connection; wallet: WalletLike; onState: (s: FusionFlowState) => void },
    init: { recipe: number; boosted: boolean; materials: FuseMaterial[]; resultCollectionIdx: number; nonce?: bigint },
  ) {
    this.state = { phase: 'idle', nonce: init.nonce ?? freshNonce(), signatures: [], ...init };
  }

  private set(patch: Partial<FusionFlowState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  async fuse(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const cores = await fetchCoreCollections(connection, this.cfg.collectionsCreated);
      const coreOf = (i: number) => { const c = cores.get(i); if (!c) throw new Error(`collection ${i} missing`); return c; };
      const atomic = FUSION_RECIPES[this.state.recipe].successBps === 10_000;

      const ixs = [];
      let randomness: PublicKey = CHIP_CORE_ID; // placeholder for atomic recipes (never read)
      let signers = undefined as undefined | import('@solana/web3.js').Keypair[];
      if (!atomic) {
        const rnd = await prepareRandomness(connection, wallet.publicKey);
        randomness = rnd.pubkey;
        ixs.push(...rnd.ixs);
        signers = [rnd.keypair];
      }
      this.set({ phase: 'signing', randomness: atomic ? undefined : randomness });
      ixs.push(fuseIx({
        owner: wallet.publicKey, nonce: this.state.nonce, useBooster: this.state.boosted, randomness,
        materials: this.state.materials, resultCollectionIdx: this.state.resultCollectionIdx, cgMint: this.cfg.cgMint, coreCollectionOf: coreOf,
      }));
      const { signature, logs } = await sendTx(connection, wallet, ixs, { signers, cuLimit: atomic ? 700_000 : 400_000 });
      if (atomic) {
        const ev = findEvent(logs, 'ChipFused', readChipFused);
        this.set({ phase: 'done', signatures: [signature], result: ev });
      } else {
        this.set({ phase: 'committed', signatures: [signature] });
      }
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  async reveal(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const [pendingKey] = pendingFusionPda(wallet.publicKey, this.state.nonce);
      const info = await connection.getAccountInfo(pendingKey, 'confirmed');
      if (!info) throw new Error('Pending fusion not found (already revealed?)');
      const pending = decodePendingFusion(new Uint8Array(info.data));
      this.set({ phase: 'revealing', randomness: pending.randomness });
      const cores = await fetchCoreCollections(connection, this.cfg.collectionsCreated);
      const coreOf = (i: number) => { const c = cores.get(i); if (!c) throw new Error(`collection ${i} missing`); return c; };

      const already = (await readRandomness(connection, wallet.publicKey, pending.randomness))?.value;
      const ixs = [];
      if (!already) {
        const slot = await connection.getSlot('confirmed');
        try {
          const r = await prepareReveal(connection, wallet.publicKey, pending.randomness, { maxWaitMs: BigInt(slot) > pending.commitSlot + 300n ? 15_000 : 60_000 });
          ixs.push(r.ix);
        } catch {
          this.set({ phase: 'stale' });
          return;
        }
      }
      ixs.push(fuseRevealIx({
        payer: wallet.publicKey, owner: pending.owner, nonce: pending.nonce, randomness: pending.randomness,
        resultCollectionIdx: pending.resultCollectionIdx, materials: this.state.materials, coreCollectionOf: coreOf,
      }));
      const { signature, logs } = await sendTx(connection, wallet, ixs, { cuLimit: 800_000, skipPreflight: !already });
      const ev = findEvent(logs, 'ChipFused', readChipFused);
      this.set({ phase: 'done', signatures: [...this.state.signatures, signature], result: ev });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  async cancelStale(): Promise<string> {
    const { connection, wallet } = this.deps;
    this.cfg ??= await fetchGameConfig(connection);
    const cores = await fetchCoreCollections(connection, this.cfg.collectionsCreated);
    const coreOf = (i: number) => { const c = cores.get(i); if (!c) throw new Error(`collection ${i} missing`); return c; };
    const { signature } = await sendTx(connection, wallet, [
      cancelStaleFusionIx({ owner: wallet.publicKey, nonce: this.state.nonce, randomness: this.state.randomness ?? CHIP_CORE_ID, materials: this.state.materials, coreCollectionOf: coreOf }),
    ], { cuLimit: 300_000 });
    this.set({ phase: 'done', signatures: [...this.state.signatures, signature] });
    return signature;
  }
}

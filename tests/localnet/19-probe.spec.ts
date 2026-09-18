// TEMPORARY CI probe — delete together with the `DBG` instrumentation in fusion.rs.
// Reproduces F01's atomic fuse (recipe 0: burn 3 materials + mint 1) and re-throws the on-chain
// `DBG …` lines, so the check-run annotation carries the lamport drift itself instead of only the
// final `UnbalancedInstruction` — the runtime reports the *sum* changed, never which step changed it.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, Transaction } from '@solana/web3.js';
import { expandRandomness } from '@guttercaps/economy';
import { fuseIx } from '@/chain/ix/chipCore';
import { toEconPack } from '@/chain/flows/packFlow';
import { binariesPresent, getEnv, type Env } from './helpers/env';
import { Currency, SKU, buyPack, loadPity, openPack, revealPack, valueOf } from './helpers/flows';
import { TxFailure } from './helpers/chain';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);

suite('T-L-P probe', () => {
  let env: Env;
  let owner: Keypair;
  beforeAll(async () => {
    env = await getEnv();
    owner = await env.player({ usdc: 100_000_000_000n, cg: 100_000_000_000n });
  });

  it('P01 atomic fuse: dump the instruction frame after every step', async () => {
    const econ = toEconPack(SKU.STANDARD, env.config.packs[SKU.STANDARD]);
    const mats: { asset: Keypair['publicKey']; collectionIdx: number }[] = [];
    let salt = 0;
    while (mats.length < 3) {
      const pity = (await loadPity(env.chain, owner.publicKey))?.counters[SKU.STANDARD] ?? 0;
      let value: Uint8Array | undefined;
      for (; salt < 200_000 && !value; salt++) {
        const v = valueOf('probe-common', salt);
        if (expandRandomness(v, econ, pity, env.config.collectionsCreated).filter((r) => r.rarity === 0).length >= 2) value = v;
      }
      if (!value) throw new Error('probe: no value yields 2+ Commons');
      const b = await buyPack(env, owner, { sku: SKU.STANDARD, currency: Currency.USDC });
      await revealPack(env, b, value);
      const r = await openPack(env, owner.publicKey, b.nonce, 0, value, owner);
      r.rolled.forEach((x, i) => {
        if (x.rarity === 0 && mats.length < 3) mats.push({ asset: r.assets[i], collectionIdx: x.collectionIdx });
      });
    }
    const ix = fuseIx({
      owner: owner.publicKey,
      nonce: 9001n,
      useBooster: false,
      materials: mats,
      resultCollectionIdx: mats[1].collectionIdx,
      cgMint: env.mints.cg,
      coreCollectionOf: env.coreOf,
    });
    // LiteSVM answers a *failing simulation* with `FailedTransactionMetadata` only when the transaction
    // itself could not be processed; an instruction error comes back as `SimulatedTransactionInfo`, which
    // carries `postAccounts()` — the one view of a failed tx that survives the rollback and can name the
    // account that crossed the frame. If the binding drops the accounts instead, this branch says so.
    const svm = (env.chain as unknown as {
      svm: { simulateTransaction(t: unknown): unknown; latestBlockhash(): string };
    }).svm;
    const keys = [...new Map(ix.keys.map((k) => [k.pubkey.toBase58(), k.pubkey])).values()];
    const before = new Map<string, bigint>();
    for (const k of keys) before.set(k.toBase58(), await env.chain.balance(k));
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = owner.publicKey;
    tx.sign(owner);
    let post: string[] = [];
    try {
      const sim = svm.simulateTransaction({ messageBytes: new Uint8Array(tx.serializeMessage()), signatures: {} }) as {
        postAccounts?: () => { address: string; lamports: bigint; data: Uint8Array; programAddress: string }[];
      };
      const accounts = sim.postAccounts?.() ?? [];
      post = accounts
        .filter((a) => a.lamports !== (before.get(a.address) ?? 0n))
        .map((a) => `POST ${a.address} ${before.get(a.address) ?? 0n}→${a.lamports} len=${a.data.length} owner=${a.programAddress}`);
      if (post.length === 0) post = [`POST no lamport delta visible (${accounts.length} post accounts, ${before.size} keys)`];
    } catch (e) {
      post = [`POST simulation threw: ${String((e as Error).message).slice(0, 120)}`];
    }
    try {
      await env.chain.send([ix], { signers: [owner], label: 'probe-fuse' });
      expect('PROBE: the atomic fuse succeeded, so there is nothing to dump').toBe('');
    } catch (e) {
      const logs = (e as TxFailure).logs ?? [];
      const dbg = logs.filter((l) => l.includes('DBG '));
      const head = String((e as Error).message).split('\n')[0];
      throw new Error(
        `PROBE dump (${dbg.length} DBG lines, ${mats.map((m) => m.collectionIdx).join('/')})\n${dbg.join('\n')}\n${post.join('\n')}\nerr: ${head}`,
      );
    }
  });
});

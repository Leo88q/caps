// TEMPORARY CI probe — delete together with the `DBG` instrumentation in fusion.rs.
// Reproduces F01's atomic fuse (recipe 0: burn 3 materials + mint 1) and re-throws the on-chain
// `DBG …` lines, so the check-run annotation carries the lamport drift itself instead of only the
// final `UnbalancedInstruction` — the runtime reports the *sum* changed, never which step changed it.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
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
    try {
      await env.chain.send([ix], { signers: [owner], label: 'probe-fuse' });
      expect('PROBE: the atomic fuse succeeded, so there is nothing to dump').toBe('');
    } catch (e) {
      const logs = (e as TxFailure).logs ?? [];
      const dbg = logs.filter((l) => l.includes('DBG '));
      const head = String((e as Error).message).split('\n')[0];
      throw new Error(`PROBE dump (${dbg.length} DBG lines, ${mats.map((m) => m.collectionIdx).join('/')})\n${dbg.join('\n')}\nerr: ${head}`);
    }
  });
});

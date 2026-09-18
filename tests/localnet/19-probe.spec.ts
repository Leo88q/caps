// TEMPORARY CI probe — delete together with the `DBG` instrumentation in fusion.rs.
// Reproduces F01's atomic fuse (recipe 0: burn 3 materials + mint 1) and re-throws the on-chain
// `DBG …` lines, so the check-run annotation carries the lamport drift itself instead of only the
// final `UnbalancedInstruction` — the runtime reports the *sum* changed, never which step changed it.
import { beforeAll, describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { expandRandomness } from '@guttercaps/economy';
import { fuseIx } from '@/chain/ix/chipCore';
import { CHIP_CORE_ID } from '@/chain/ids';
import { toEconPack } from '@/chain/flows/packFlow';
import { binariesPresent, getEnv, type Env } from './helpers/env';
import { Currency, SKU, buyPack, loadPity, openPack, revealPack, valueOf, vaultKey } from './helpers/flows';
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
    // The frame the runtime sums has one account the handler can never see: the five `None` rng
    // placeholders are the chip_core program id, Anchor drops them, and `dbg_named_fuse` cannot reach
    // them — so the program's own sum is over 28 of the frame's keys, not 29. Appending the same key
    // again as a *remaining* account changes nothing about the frame (the key is already in the
    // instruction, and the runtime de-duplicates slots) but hands it to the handler.
    ix.keys.push({ pubkey: CHIP_CORE_ID, isSigner: false, isWritable: false } as never);
    // Two views of the same failing transaction from *outside* the program:
    //   * `simulateTransaction` under the ComputeBudget preamble `send` uses. An instruction error comes
    //     back as `SimulatedTransactionInfo`, whose `postAccounts()` is the only surviving view of a
    //     rolled-back transaction; diffing it against the pre-tx balances read here names every account
    //     whose lamports crossed the frame.
    //   * the bindings' `signatures` map has to be built the way `helpers/chain.ts` builds it (web3.js →
    //     `{ messageBytes, signatures }`); passing `{}` makes the kit encoder throw "Transaction has no
    //     expected signers therefore it cannot be encoded", which is what the first version of this probe
    //     got instead of an answer (run 35376218245 → 35377269251).
    //   * and the duplicate slots in `ix.keys` themselves: they are what the runtime's frame sum skips,
    //     so printing them says which accounts the in-program sum has to de-duplicate.
    const svm = (env.chain as unknown as {
      svm: { simulateTransaction(t: unknown): unknown; latestBlockhash(): string };
    }).svm;
    const keys = [...new Map(ix.keys.map((k) => [k.pubkey.toBase58(), k.pubkey])).values()];
    const dupes = ix.keys.map((k) => k.pubkey.toBase58()).filter((s, i, all) => all.indexOf(s) !== i);
    const before = new Map<string, bigint>();
    for (const k of keys) before.set(k.toBase58(), await env.chain.balance(k));
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = owner.publicKey;
    tx.sign(owner);
    const signatures: Record<string, Uint8Array> = {};
    for (const sig of tx.signatures) signatures[sig.publicKey.toBase58()] = new Uint8Array(sig.signature!);
    const interesting = [['chip_core', CHIP_CORE_ID], ['mpl_core', new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d')], ['owner', owner.publicKey], ['admin', env.admin.publicKey], ['vault', vaultKey()]] as const;
    const post: string[] = [
      `keys=${keys.length} slots=${ix.keys.length} dup=${dupes.length ? dupes.join(',') : 'none'}`,
      ...(await Promise.all(interesting.map(async ([n, k]) => `bal ${n} ${k.toBase58().slice(0, 8)}=${await env.chain.balance(k as PublicKey)}`))),
    ];
    try {
      const sim = svm.simulateTransaction({ messageBytes: new Uint8Array(tx.serializeMessage()), signatures }) as {
        postAccounts?: () => { address: string; lamports: bigint; data: Uint8Array; programAddress: string }[];
        err?: () => unknown;
        meta?: () => { logs?: () => string[] };
      };
      if (typeof sim.postAccounts === 'function') {
        const accounts = sim.postAccounts();
        const deltas = accounts.filter((a) => a.lamports !== (before.get(a.address) ?? 0n));
        for (const a of deltas) post.push(`POST ${a.address} ${before.get(a.address) ?? 0n}→${a.lamports} len=${a.data.length} owner=${a.programAddress}`);
        post.push(`POST sim ran: ${accounts.length} post accounts, ${deltas.length} with a lamport delta`);
      } else {
        // the doc comment on `simulateTransaction` says `FailedTransactionMetadata` means "simulation did
        // not succeed" — an instruction error is exactly that, so say which shape came back and keep the
        // `DBG` lines it did collect
        const tail = (sim.meta?.()?.logs?.() ?? []).filter((l) => l.includes('DBG ') || l.includes('failed')).join(' | ');
        post.push(`POST sim returned failure metadata err=${String(sim.err?.())} tail=${tail.slice(0, 400)}`);
      }
    } catch (e) {
      post.push(`POST simulation threw: ${String((e as Error).message).slice(0, 160)}`);
    }
    try {
      await env.chain.send([ix], { signers: [owner], label: 'probe-fuse' });
      expect('PROBE: the atomic fuse succeeded, so there is nothing to dump').toBe('');
    } catch (e) {
      const logs = (e as TxFailure).logs ?? [];
      const dbg = logs.filter((l) => l.includes('DBG '));
      const head = String((e as Error).message).split('\n')[0];
      // and the same balances once more: if these bindings leave a failed tx applied instead of rolling
      // it back, this *is* the drift, account by account
      const after: string[] = [];
      for (const k of keys) {
        const b = before.get(k.toBase58()) ?? 0n;
        const a = await env.chain.balance(k);
        if (a !== b) after.push(`${k.toBase58()} ${b}→${a}`);
      }
      throw new Error(
        `PROBE dump (${dbg.length} DBG lines, ${mats.map((m) => m.collectionIdx).join('/')})\n${dbg.join('\n')}\n${post.join('\n')}\nafter-fail deltas: ${after.length ? after.join('; ') : 'none (rolled back)'}\nerr: ${head}`,
      );
    }
  });
});

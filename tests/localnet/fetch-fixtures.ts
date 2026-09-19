// `npm run localnet:fixtures` — download the third-party programs the LiteSVM back-end loads from disk
// (`npm test` needs them next to our own target/deploy/*.so; the validator flow can `--clone` instead).
//
//   tests/localnet/fixtures/mpl_core.so        Metaplex Core   CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
//   tests/localnet/fixtures/pyth_receiver.so   Pyth receiver   rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ  (optional:
//                                              LiteSVM never executes it — Pyth accounts are forged with the right owner —
//                                              but run-validator.ts uses the dump when present, which makes the run offline-capable)
//
// mpl_core is NOT dumped from live mainnet anymore: mainnet is a moving target, and on 2026-09-17/18
// Metaplex deployed core@0.15.2, whose ELF litesvm 1.4.1 cannot load («Failed to add program: Offset or
// value is out of bounds» — the same message a truncated file produces, which cost a misdiagnosis).
// The fixture is instead pinned to a Metaplex GitHub release asset: those are the exact deployed bytes
// (the 0.15.2 asset is byte-count-identical to the mainnet dump) but immutable and versioned. Bump
// MPL_CORE_VERSION — and the CI cache key with it — when the suite should move to a newer core.
// `--from-chain` forces the old mainnet dump for mpl_core if a release asset is ever unavailable.
//
// The RPC dump path (still used for pyth_receiver) is the equivalent of
// `solana program dump <id> <file> -u <rpc>`, through JSON-RPC so no Solana CLI is required: for an
// upgradeable program the ELF lives in the ProgramData account (header 45 B: enum tag u32 = 3, slot u64,
// Option<Pubkey> upgrade authority), for a legacy loader program the account data IS the ELF.
//
//   RPC_URL=https://api.mainnet-beta.solana.com npm run localnet:fixtures            # default
//   npm run localnet:fixtures -- --only mpl_core                                     # one program
// The .so files are git-ignored (**/*.so) — every checkout fetches its own copy; CI caches the directory.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { checkProgramBinary } from './helpers/elf.ts';
import { resolve } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = resolve(import.meta.dirname, '../..');
const DIR = resolve(ROOT, 'tests/localnet/fixtures');
const RPC = process.env.RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? 'https://api.mainnet-beta.solana.com';
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/** Pinned Metaplex Core program version — see the header comment. 0.15.1 is the last release of the
 *  era whose binaries litesvm 1.4.1 loads (0.15.2, deployed to mainnet 2026-09-17/18, cannot be added). */
const MPL_CORE_VERSION = '0.15.1';
const MPL_CORE_RELEASE_URL = `https://github.com/metaplex-foundation/mpl-core/releases/download/release/core%40${MPL_CORE_VERSION}/mpl_core_program.so`;

type Fixture = {
  name: string;
  id: string;
  required: boolean;
  /** 'release' — pinned GitHub release asset (mpl_core); 'chain' — RPC dump of the live account (pyth). */
  source: 'release' | 'chain';
};

const FIXTURES: Fixture[] = [
  { name: 'mpl_core', id: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', required: true, source: 'release' },
  { name: 'pyth_receiver', id: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ', required: false, source: 'chain' },
];

async function downloadRelease(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function dump(connection: Connection, programId: PublicKey): Promise<Uint8Array> {
  const program = await connection.getAccountInfo(programId, 'confirmed');
  if (!program) throw new Error(`${programId.toBase58()} not found on ${RPC}`);
  if (!program.executable) throw new Error(`${programId.toBase58()} is not executable`);
  if (!program.owner.equals(UPGRADEABLE_LOADER)) return new Uint8Array(program.data); // legacy loaders: data = ELF
  if (program.data.length < 36 || program.data.readUInt32LE(0) !== 2) throw new Error(`${programId.toBase58()}: unexpected Program account layout`);
  const programData = new PublicKey(program.data.subarray(4, 36));
  const pd = await connection.getAccountInfo(programData, 'confirmed');
  if (!pd) throw new Error(`ProgramData ${programData.toBase58()} not found`);
  if (pd.data.readUInt32LE(0) !== 3) throw new Error(`${programData.toBase58()}: unexpected ProgramData layout`);
  const elf = pd.data.subarray(45);
  // ProgramData is over-allocated for future upgrades — trim the zero tail (loaders accept it either way)
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end--;
  return new Uint8Array(elf.subarray(0, Math.max(end, 1)));
}

async function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
  const force = process.argv.includes('--force');
  const fromChain = process.argv.includes('--from-chain');
  mkdirSync(DIR, { recursive: true });
  const connection = new Connection(RPC, 'confirmed');
  let failed = false;
  for (const f of FIXTURES) {
    if (only && f.name !== only) continue;
    const out = resolve(DIR, `${f.name}.so`);
    if (existsSync(out) && !force) {
      const c = checkProgramBinary(out);
      if (c.ok) { console.log(`[fixtures] ${f.name}.so already present (use --force to refetch)`); continue; }
      // A cached-but-broken file is worse than a missing one: the harness treats it as satisfied and litesvm
      // then fails with an offset error that looks like a broken test. Refetch, loudly.
      console.log(`[fixtures] ${f.name}.so present but NOT loadable (${c.reason}) — refetching`);
    }
    const useChain = f.source === 'chain' || (f.name === 'mpl_core' && fromChain);
    try {
      const elf = useChain
        ? await dump(connection, new PublicKey(f.id))
        : await downloadRelease(MPL_CORE_RELEASE_URL);
      if (elf.length < 4 || String.fromCharCode(...elf.subarray(1, 4)) !== 'ELF') throw new Error('downloaded data does not look like an ELF file');
      writeFileSync(out, elf);
      const after = checkProgramBinary(out);
      if (!after.ok) throw new Error(`wrote ${elf.length} bytes but the file is not loadable (${after.reason})`);
      console.log(`[fixtures] ${f.name}.so ← ${useChain ? `${f.id} from ${RPC}` : `metaplex-foundation/mpl-core release core@${MPL_CORE_VERSION}`} (${(elf.length / 1024).toFixed(0)} KiB)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[fixtures] ${f.name}: ${msg}${f.required ? '' : ' (optional — skipped)'}`);
      if (f.required) failed = true;
    }
  }
  if (failed) {
    console.error(`[fixtures] offline fallback: download ${MPL_CORE_RELEASE_URL} (or \`solana program dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/localnet/fixtures/mpl_core.so -u m\` on a machine with RPC access) and copy the file here.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// `npm run localnet:fixtures` — download the third-party programs the LiteSVM back-end loads from disk
// (`npm test` needs them next to our own target/deploy/*.so; the validator flow can `--clone` instead).
//
//   tests/localnet/fixtures/mpl_core.so        Metaplex Core   CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
//   tests/localnet/fixtures/pyth_receiver.so   Pyth receiver   rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ  (optional:
//                                              LiteSVM never executes it — Pyth accounts are forged with the right owner —
//                                              but run-validator.ts uses the dump when present, which makes the run offline-capable)
//
// Equivalent CLI: `solana program dump <id> <file> -u <rpc>`. This script does the same through JSON-RPC so no Solana
// CLI is required: for an upgradeable program the ELF lives in the ProgramData account (header 45 B: enum tag u32 = 3,
// slot u64, Option<Pubkey> upgrade authority), for a legacy loader program the account data IS the ELF.
//
//   RPC_URL=https://api.mainnet-beta.solana.com npm run localnet:fixtures            # default
//   npm run localnet:fixtures -- --only mpl_core                                     # one program
// The .so files are git-ignored (**/*.so) — every checkout fetches its own copy; CI caches the directory.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = resolve(import.meta.dirname, '../..');
const DIR = resolve(ROOT, 'tests/localnet/fixtures');
const RPC = process.env.RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? 'https://api.mainnet-beta.solana.com';
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

const FIXTURES = [
  { name: 'mpl_core', id: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', required: true },
  { name: 'pyth_receiver', id: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ', required: false },
] as const;

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
  mkdirSync(DIR, { recursive: true });
  const connection = new Connection(RPC, 'confirmed');
  let failed = false;
  for (const f of FIXTURES) {
    if (only && f.name !== only) continue;
    const out = resolve(DIR, `${f.name}.so`);
    if (existsSync(out) && !force) { console.log(`[fixtures] ${f.name}.so already present (use --force to refetch)`); continue; }
    try {
      const elf = await dump(connection, new PublicKey(f.id));
      if (elf.length < 4 || String.fromCharCode(...elf.subarray(1, 4)) !== 'ELF') throw new Error('dump does not look like an ELF file');
      writeFileSync(out, elf);
      console.log(`[fixtures] ${f.name}.so ← ${f.id} (${(elf.length / 1024).toFixed(0)} KiB) from ${RPC}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[fixtures] ${f.name}: ${msg}${f.required ? '' : ' (optional — skipped)'}`);
      if (f.required) failed = true;
    }
  }
  if (failed) {
    console.error('[fixtures] offline fallback: `solana program dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/localnet/fixtures/mpl_core.so -u m` on a machine with RPC access, then copy the file here.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

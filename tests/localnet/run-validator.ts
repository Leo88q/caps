// `npm run test:validator` / `anchor test` — run the localnet suite against a real validator.
//
//   1. copies fixtures/sb_mock-keypair.json → target/deploy/ (so `anchor build` emits sb_mock.so with
//      the id chip_core::randomness::SB_PROGRAM_ID expects under `--features localnet`)
//   2. `anchor build -- --features localnet`            (skip with SKIP_BUILD=1)
//   3. loads the Pyth PriceUpdateV2 fixtures fixtures/pyth_{sol,skr}_usd.json (SOL $150 / SKR $0.0174) as
//      genesis accounts owned by the cloned receiver program `rec5…`. Their `publish_time` is 2100-01-01:
//      the receiver SDK only checks `publish_time + 60 ≥ now`, so they never go stale; age-sensitive
//      scenarios are LiteSVM-only (chain.canWarp). Same files are declared in Anchor.toml [[test.validator.account]].
//   4. starts `solana-test-validator` with: our four programs + sb_mock (--bpf-program), mpl-core +
//      pyth receiver cloned from mainnet (--clone, or from `fixtures/*.so` when offline), the Pyth
//      fixtures (--account), and a pre-funded ANCHOR_WALLET
//   5. runs vitest with LOCALNET_RPC=http://127.0.0.1:8899
//   6. stops the validator (KEEP_VALIDATOR=1 keeps it running for a second `LOCALNET_RPC=… npm test`)
//
// Env knobs: SKIP_BUILD, KEEP_VALIDATOR, VALIDATOR_URL (clone source, default mainnet-beta),
// ANCHOR_WALLET (default ~/.config/solana/id.json, created if missing), RPC_PORT (8899),
// MPL_CORE_SO / PYTH_RECEIVER_SO (offline: use dumps instead of --clone), VITEST_ARGS.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.RPC_PORT ?? 8899);
const RPC = `http://127.0.0.1:${PORT}`;
const CLONE_URL = process.env.VALIDATOR_URL ?? 'https://api.mainnet-beta.solana.com';
const LEDGER = resolve(ROOT, 'test-ledger');
const OUT = resolve(ROOT, 'target/localnet');

const PROGRAMS = [
  ['GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q', 'chip_core'],
  ['GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz', 'market'],
  ['GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA', 'staking'],
  ['GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM', 'arena'],
  ['ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH', 'sb_mock'],
] as const;
const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const PYTH_RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';

const log = (m: string) => console.log(`[run-validator] ${m}`);
const sh = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env } });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r.status ?? 1;
};
const have = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

/** `solana account --output json`-shaped dump the validator accepts through `--account`. */
function writeAccountDump(path: string, pubkey: PublicKey, owner: string, data: Buffer, lamports = 10_000_000) {
  writeFileSync(path, JSON.stringify({
    pubkey: pubkey.toBase58(),
    account: { lamports, data: [data.toString('base64'), 'base64'], owner, executable: false, rentEpoch: 0, space: data.length },
  }, null, 2));
}

async function waitForRpc(child: ChildProcess, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`solana-test-validator exited with ${child.exitCode} (see test-ledger/validator.log)`);
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
      if (r.ok && ((await r.json()) as { result?: string }).result === 'ok') return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('validator did not become healthy in time');
}

async function main() {
  for (const bin of ['solana-test-validator', 'solana']) {
    if (!have(bin)) throw new Error(`${bin} not found in PATH — install the Solana CLI (Anchor.toml pins solana 2.1.x) or use \`npm test\` (LiteSVM, no validator needed)`);
  }
  mkdirSync(resolve(ROOT, 'target/deploy'), { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // 1. sb_mock keypair → target/deploy (anchor derives the program id from this file)
  const kpDst = resolve(ROOT, 'target/deploy/sb_mock-keypair.json');
  if (!existsSync(kpDst)) copyFileSync(resolve(ROOT, 'tests/localnet/fixtures/sb_mock-keypair.json'), kpDst);

  // 2. build with the localnet feature (SB_PROGRAM_ID = sb_mock)
  if (!process.env.SKIP_BUILD) {
    if (!have('anchor')) throw new Error('anchor not found in PATH (or set SKIP_BUILD=1 with prebuilt target/deploy/*.so)');
    if (sh('anchor', ['build', '--', '--features', 'localnet']) !== 0) throw new Error('anchor build failed');
  }
  for (const [, name] of PROGRAMS) {
    const so = resolve(ROOT, 'target/deploy', `${name}.so`);
    if (!existsSync(so)) throw new Error(`missing ${so}`);
  }

  // 3. wallet + Pyth fixtures
  const walletPath = (process.env.ANCHOR_WALLET ?? '~/.config/solana/id.json').replace(/^~/, homedir());
  if (!existsSync(walletPath)) {
    mkdirSync(dirname(walletPath), { recursive: true });
    writeFileSync(walletPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
    log(`created ${walletPath}`);
  }
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
  const fixture = (name: string) => { const f = resolve(ROOT, 'tests/localnet/fixtures', `${name}.json`); return { path: f, pubkey: (JSON.parse(readFileSync(f, 'utf8')) as { pubkey: string }).pubkey }; };
  const pythSol = fixture('pyth_sol_usd');
  const pythSkr = fixture('pyth_skr_usd');
  // admin pre-funded at genesis (airdrops on test validators are capped)
  writeAccountDump(resolve(OUT, 'admin.json'), admin.publicKey, '11111111111111111111111111111111', Buffer.alloc(0), 1_000_000 * 1_000_000_000);

  // 4. validator
  rmSync(LEDGER, { recursive: true, force: true });
  const args = ['--reset', '--quiet', '--ledger', LEDGER, '--rpc-port', String(PORT), '--limit-ledger-size', '50000000'];
  for (const [id, name] of PROGRAMS) args.push('--bpf-program', id, resolve(ROOT, 'target/deploy', `${name}.so`));
  const mplSo = process.env.MPL_CORE_SO ?? (existsSync(resolve(ROOT, 'tests/localnet/fixtures/mpl_core.so')) ? resolve(ROOT, 'tests/localnet/fixtures/mpl_core.so') : undefined);
  const recSo = process.env.PYTH_RECEIVER_SO ?? (existsSync(resolve(ROOT, 'tests/localnet/fixtures/pyth_receiver.so')) ? resolve(ROOT, 'tests/localnet/fixtures/pyth_receiver.so') : undefined);
  if (mplSo) args.push('--bpf-program', MPL_CORE, mplSo); else args.push('--url', CLONE_URL, '--clone-upgradeable-program', MPL_CORE);
  if (recSo) args.push('--bpf-program', PYTH_RECEIVER, recSo); else { if (!args.includes('--url')) args.push('--url', CLONE_URL); args.push('--clone-upgradeable-program', PYTH_RECEIVER); }
  for (const f of [pythSol, pythSkr, { pubkey: admin.publicKey.toBase58(), path: resolve(OUT, 'admin.json') }]) args.push('--account', f.pubkey, f.path);
  log(`$ solana-test-validator ${args.join(' ')}`);
  const validator = spawn('solana-test-validator', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  const stop = () => { if (validator.exitCode === null) { log('stopping validator'); validator.kill('SIGTERM'); } };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('SIGTERM', () => { stop(); process.exit(143); });

  let status = 1;
  try {
    await waitForRpc(validator);
    log(`validator ready at ${RPC} (mpl-core ${mplSo ? 'from dump' : 'cloned'}, pyth receiver ${recSo ? 'from dump' : 'cloned'})`);
    // 5. the suite
    const extra = (process.env.VITEST_ARGS ?? '').split(' ').filter(Boolean);
    status = sh('npx', ['vitest', 'run', '--config', 'tests/localnet/vitest.config.mts', ...extra], {
      env: { LOCALNET_RPC: RPC, ANCHOR_WALLET: walletPath, PYTH_SOL_ACCOUNT: pythSol.pubkey, PYTH_SKR_ACCOUNT: pythSkr.pubkey },
    });
  } finally {
    if (process.env.KEEP_VALIDATOR) {
      log(`validator left running at ${RPC}; re-run with:\n  LOCALNET_RPC=${RPC} ANCHOR_WALLET=${walletPath} npm test`);
      validator.unref();
    } else stop();
  }
  process.exit(status);
}

main().catch((e) => { console.error(`[run-validator] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });

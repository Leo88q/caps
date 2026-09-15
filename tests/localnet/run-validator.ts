// `npm run test:validator` / `anchor test` — run the localnet suite against a real validator.
//
//   1. copies fixtures/sb_mock-keypair.json → target/deploy/ (so `anchor build` emits sb_mock.so with
//      the id chip_core::randomness::SB_PROGRAM_ID expects under `--features localnet`)
//   2. `anchor build -- --features localnet`            (skip with SKIP_BUILD=1)
//   3. writes Pyth PriceUpdateV2 fixture dumps (SOL $150 / SKR $0.0174) into target/localnet/pyth_*.json —
//      the validator loads them as genesis accounts owned by the cloned receiver program `rec5…`.
//      `publish_time` is set 6 h in the FUTURE: the receiver SDK only checks `publish_time + 60 ≥ now`,
//      so the fixture stays valid for the whole run; age-sensitive scenarios are LiteSVM-only (chain.canWarp)
//   4. starts `solana-test-validator` with: our four programs + sb_mock (--bpf-program), mpl-core +
//      pyth receiver cloned from mainnet (--clone, or from `fixtures/*.so` when offline), the Pyth
//      fixtures (--account), and a pre-funded ANCHOR_WALLET
//   5. runs vitest with LOCALNET_RPC=http://127.0.0.1:8899 (+ PYTH_SOL_ACCOUNT / PYTH_SKR_ACCOUNT)
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
import { sha256 } from '@noble/hashes/sha256';

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

// Same fixture values as helpers/pyth.ts (kept literal here: this file runs under plain node, no vite aliases)
const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const SKR_FEED = '38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9';
const SOL_USD_PRICE = 15_000_000_000n;
const SKR_USD_PRICE = 1_740_000n;
const EXPO = -8;

const log = (m: string) => console.log(`[run-validator] ${m}`);
const sh = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env } });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r.status ?? 1;
};
const have = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

/** Deterministic fixture addresses so a re-run against a kept validator finds the same accounts. */
const fixtureKey = (name: string) => Keypair.fromSeed(sha256(new TextEncoder().encode(`guttercaps/localnet/pyth/${name}`))).publicKey;

function encodePriceUpdateV2(feedHex: string, price: bigint, publishTime: bigint): Buffer {
  const b = Buffer.alloc(134);
  let o = 0;
  Buffer.from(sha256(new TextEncoder().encode('account:PriceUpdateV2')).slice(0, 8)).copy(b, o); o += 8;
  o += 32;                                   // write_authority = default
  b.writeUInt8(1, o); o += 1;                // VerificationLevel::Full
  Buffer.from(feedHex, 'hex').copy(b, o); o += 32;
  b.writeBigInt64LE(price, o); o += 8;
  b.writeBigUInt64LE(price / 1000n, o); o += 8;
  b.writeInt32LE(EXPO, o); o += 4;
  b.writeBigInt64LE(publishTime, o); o += 8;
  b.writeBigInt64LE(publishTime - 1n, o); o += 8;
  b.writeBigInt64LE(price, o); o += 8;
  b.writeBigUInt64LE(price / 1000n, o); o += 8;
  b.writeBigUInt64LE(1n, o);
  return b;
}

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
  const publishTime = BigInt(Math.floor(Date.now() / 1000)) + 6n * 3600n; // valid until then + 60 s
  const solAcc = fixtureKey('SOL');
  const skrAcc = fixtureKey('SKR');
  writeAccountDump(resolve(OUT, 'pyth_sol_usd.json'), solAcc, PYTH_RECEIVER, encodePriceUpdateV2(SOL_FEED, SOL_USD_PRICE, publishTime));
  writeAccountDump(resolve(OUT, 'pyth_skr_usd.json'), skrAcc, PYTH_RECEIVER, encodePriceUpdateV2(SKR_FEED, SKR_USD_PRICE, publishTime));
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
  for (const f of ['pyth_sol_usd', 'pyth_skr_usd', 'admin']) args.push('--account', JSON.parse(readFileSync(resolve(OUT, `${f}.json`), 'utf8')).pubkey, resolve(OUT, `${f}.json`));
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
      env: { LOCALNET_RPC: RPC, ANCHOR_WALLET: walletPath, PYTH_SOL_ACCOUNT: solAcc.toBase58(), PYTH_SKR_ACCOUNT: skrAcc.toBase58() },
    });
  } finally {
    if (process.env.KEEP_VALIDATOR) {
      log(`validator left running at ${RPC}; re-run with:\n  LOCALNET_RPC=${RPC} ANCHOR_WALLET=${walletPath} PYTH_SOL_ACCOUNT=${solAcc.toBase58()} PYTH_SKR_ACCOUNT=${skrAcc.toBase58()} npm test`);
      validator.unref();
    } else stop();
  }
  process.exit(status);
}

main().catch((e) => { console.error(`[run-validator] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });

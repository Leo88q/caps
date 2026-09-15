// Test environment for tests/localnet: boots a chain (LiteSVM by default, RPC when
// LOCALNET_RPC is set), creates the three mints ($CG / USDC / SKR), runs the same admin
// setup as scripts/setup.ts (`initialize`, 10 × `create_collection` from lore, staking
// `init_emission` + `init_skr_pool`, arena `init_arena`), posts the Pyth price fixtures
// and hands out funded player wallets.
//
// The instruction builders / decoders are the REAL client ones (client/src/chain/*) —
// this suite doubles as the contract test of docs/04 §12. Vitest resolves `@/…` and
// `@guttercaps/economy` through tests/localnet/vitest.config.ts; `VITE_CLUSTER=localnet`
// there makes `SWITCHBOARD_ON_DEMAND_ID` = sb_mock.
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction,
  createTransferInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ixData, ro, rw, signer } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { ARENA_ID, CHIP_CORE_ID, MARKET_ID, MPL_CORE_ID, STAKING_ID, SWITCHBOARD_ON_DEMAND_ID, SYSTEM_PROGRAM_ID } from '@/chain/ids';
import { arenaConfigPda, ata, chipPoolPda, collectionMetaPda, configPda, emissionPda, skrPoolPda, tokenPoolPda, vaultPda } from '@/chain/pdas';
import { decodeCollectionMeta, decodeGameConfig, type GameConfig } from '@/chain/accounts';
import { COLLECTIONS } from '@/shared/lib/lore';
import { ELEMENT_OF_COLLECTION } from '@/shared/lib/rarity';
import { EMISSION_SPLIT } from '@guttercaps/economy';
import { Chain, LiteSvmChain, RpcChain, type ProgramBinary } from './chain';
import { postPythPrices, type PythPrices } from './pyth';

export const ROOT = resolve(__dirname, '../../..');
export const SB_MOCK_ID = new PublicKey('ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH');
export const TREASURY = Keypair.generate();
export const BUYBACK = Keypair.generate();
export const BATTLE_ORACLE = Keypair.generate();
export const QUEST_ORACLE = Keypair.generate();
export const SEASON_ORACLE = Keypair.generate();
export const SET_ORACLE = Keypair.generate();
/** any key works for the mock queue — the programs pin `SB_QUEUE` (devnet key on localnet) */
export const SB_QUEUE = new PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7');
export const SB_ORACLE = Keypair.generate().publicKey;
export const ELEMENT_INDEX: Record<string, number> = { paint: 0, steel: 1, wheels: 2, noise: 3, shadow: 4 };
export const ORACLE_DAILY_CAP = 1_000_000n * 1_000_000n; // 1 M $CG / day

const SOL = 1_000_000_000n;

export interface Env {
  chain: Chain;
  admin: Keypair;
  mints: { cg: PublicKey; usdc: PublicKey; skr: PublicKey };
  /** mint authorities before hand-over: usdc/skr stay with the admin (faucet), cg → emission PDA */
  config: GameConfig;
  coreCollections: Map<number, PublicKey>;
  coreOf: (idx: number) => PublicKey;
  pyth: PythPrices;
  /** new wallet with SOL + tokens (+ ATAs) */
  player(opts?: { sol?: bigint; cg?: bigint; usdc?: bigint; skr?: bigint }): Promise<Keypair>;
  /** mint more of a faucet token to an existing wallet (creates the ATA) */
  fund(to: PublicKey, token: 'usdc' | 'skr', amount: bigint): Promise<void>;
  refreshConfig(): Promise<GameConfig>;
}

export function programBinaries(): ProgramBinary[] {
  const dep = (name: string) => resolve(ROOT, 'target/deploy', `${name}.so`);
  const mplCore = process.env.MPL_CORE_SO ?? resolve(ROOT, 'tests/localnet/fixtures/mpl_core.so');
  return [
    { id: CHIP_CORE_ID, path: dep('chip_core') },
    { id: MARKET_ID, path: dep('market') },
    { id: STAKING_ID, path: dep('staking') },
    { id: ARENA_ID, path: dep('arena') },
    { id: SB_MOCK_ID, path: dep('sb_mock') },
    { id: MPL_CORE_ID, path: mplCore },
  ];
}

/** True when every `.so` the LiteSVM back-end needs is present (otherwise the suite skips itself with a hint). */
export function binariesPresent(): { ok: boolean; missing: string[] } {
  const missing = programBinaries().filter((p) => !existsSync(p.path)).map((p) => p.path);
  return { ok: missing.length === 0, missing };
}

async function bootChain(): Promise<Chain> {
  const rpc = process.env.LOCALNET_RPC;
  if (rpc) {
    const walletPath = (process.env.ANCHOR_WALLET ?? '~/.config/solana/id.json').replace(/^~/, homedir());
    const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
    return new RpcChain(new Connection(rpc, 'confirmed'), admin);
  }
  return LiteSvmChain.create(programBinaries());
}

// ---------------------------------------------------------------- admin instruction builders
// (no client builders exist for one-shot admin ixs; account order mirrors programs/*/src)

export function initializeIx(a: { admin: PublicKey; treasury: PublicKey; buyback: PublicKey; cg: PublicKey; usdc: PublicKey; skr: PublicKey; pythSol: PublicKey; pythSkr: PublicKey }): TransactionInstruction {
  const args = new BorshWriter().pubkey(a.treasury).pubkey(a.buyback).pubkey(a.cg).pubkey(a.usdc).pubkey(a.skr).pubkey(STAKING_ID).pubkey(a.pythSol).pubkey(a.pythSkr).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.admin), rw(configPda()[0]), rw(vaultPda()[0]), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('initialize', args)),
  });
}

export function createCollectionIx(a: { admin: PublicKey; idx: number; coreCollection: PublicKey; symbol: string; name: string; uri: string; element: number }): TransactionInstruction {
  const args = new BorshWriter().u8(a.idx).string(a.symbol).string(a.name).string(a.uri).u8(a.element).toBytes();
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.admin), rw(configPda()[0]), rw(collectionMetaPda(a.idx)[0]), signer(a.coreCollection), ro(MPL_CORE_ID), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('create_collection', args)),
  });
}

export interface ParamsPatch {
  packs?: Uint8Array; // pre-encoded [PackDef; 4] (42 B each)
  marketFeeBps?: number; featuredCollection?: number; treasury?: PublicKey; buybackWallet?: PublicKey;
  pythSolUsdFeed?: PublicKey; pythSkrUsdFeed?: PublicKey; skrMint?: PublicKey; skrDiscountBps?: number;
}
export function setParamsIx(admin: PublicKey, p: ParamsPatch): TransactionInstruction {
  const w = new BorshWriter();
  w.option(p.packs, (b) => w.bytes(b));
  w.option(p.marketFeeBps, (v) => w.u16(v));
  w.option(p.featuredCollection, (v) => w.u8(v));
  w.option(p.treasury, (k) => w.pubkey(k));
  w.option(p.buybackWallet, (k) => w.pubkey(k));
  w.option(p.pythSolUsdFeed, (k) => w.pubkey(k));
  w.option(p.pythSkrUsdFeed, (k) => w.pubkey(k));
  w.option(p.skrMint, (k) => w.pubkey(k));
  w.option(p.skrDiscountBps, (v) => w.u16(v));
  return new TransactionInstruction({ programId: CHIP_CORE_ID, keys: [signer(admin, false), rw(configPda()[0])], data: Buffer.from(ixData('set_params', w.toBytes())) });
}
export const setPausedIx = (admin: PublicKey, paused: boolean) =>
  new TransactionInstruction({ programId: CHIP_CORE_ID, keys: [signer(admin, false), rw(configPda()[0])], data: Buffer.from(ixData('set_paused', new BorshWriter().bool(paused).toBytes())) });
export const proposeAdminIx = (admin: PublicKey, next: PublicKey) =>
  new TransactionInstruction({ programId: CHIP_CORE_ID, keys: [signer(admin, false), rw(configPda()[0])], data: Buffer.from(ixData('propose_admin', new BorshWriter().pubkey(next).toBytes())) });
export const acceptAdminIx = (next: PublicKey) =>
  new TransactionInstruction({ programId: CHIP_CORE_ID, keys: [signer(next, false), rw(configPda()[0])], data: Buffer.from(ixData('accept_admin')) });
export function sweepVaultIx(a: { admin: PublicKey; treasury: PublicKey; mint?: PublicKey }): TransactionInstruction {
  const vault = vaultPda()[0];
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [
      signer(a.admin, false), ro(configPda()[0]), rw(vault), rw(a.treasury),
      a.mint ? rw(ata(a.mint, vault)) : ro(CHIP_CORE_ID), a.mint ? rw(ata(a.mint, a.treasury)) : ro(CHIP_CORE_ID), ro(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('sweep_vault')),
  });
}
export function grantBoosterIx(a: { authority: PublicKey; payer: PublicKey; owner: PublicKey; count: number }): TransactionInstruction {
  const [items] = PublicKey.findProgramAddressSync([Buffer.from('items'), a.owner.toBytes()], CHIP_CORE_ID);
  return new TransactionInstruction({
    programId: CHIP_CORE_ID,
    keys: [signer(a.authority, false), signer(a.payer), ro(configPda()[0]), ro(a.owner), rw(items), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('grant_booster', new BorshWriter().u16(a.count).toBytes())),
  });
}

export function initEmissionIx(a: { admin: PublicKey; cgMint: PublicKey; genesisTs: bigint }): TransactionInstruction {
  const split = [EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve].map((p) => p * 100);
  const w = new BorshWriter().pubkey(CHIP_CORE_ID).pubkey(MARKET_ID).pubkey(ARENA_ID).pubkey(QUEST_ORACLE.publicKey).pubkey(SEASON_ORACLE.publicKey).pubkey(SET_ORACLE.publicKey);
  for (const s of split) w.u16(s);
  w.i64(a.genesisTs);
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [signer(a.admin), rw(emissionPda()[0]), rw(tokenPoolPda()[0]), rw(chipPoolPda()[0]), rw(a.cgMint), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('init_emission', w.toBytes())),
  });
}
export function initSkrPoolIx(a: { admin: PublicKey; skrMint: PublicKey; maxRootBudget: bigint }): TransactionInstruction {
  const [pool] = skrPoolPda();
  return new TransactionInstruction({
    programId: STAKING_ID,
    keys: [signer(a.admin), ro(emissionPda()[0]), rw(pool), ro(a.skrMint), ro(ata(a.skrMint, pool)), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('init_skr_pool', new BorshWriter().u64(a.maxRootBudget).toBytes())),
  });
}
export function initArenaIx(a: { admin: PublicKey; battleOracle: PublicKey; cgMint: PublicKey; seasonPool: PublicKey; treasuryCg: PublicKey; oracleDailyCap: bigint }): TransactionInstruction {
  const w = new BorshWriter().pubkey(a.battleOracle).pubkey(a.cgMint).pubkey(a.seasonPool).pubkey(a.treasuryCg).u64(a.oracleDailyCap);
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys: [signer(a.admin), rw(arenaConfigPda()[0]), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('init_arena', w.toBytes())),
  });
}

// ---------------------------------------------------------------- boot

async function createMint(chain: Chain, payer: Keypair, decimals: number, authority: PublicKey): Promise<PublicKey> {
  const mint = Keypair.generate();
  await chain.send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(await chain.rentExempt(MINT_SIZE)), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, decimals, authority, null),
  ], { signers: [payer, mint], label: 'create mint' });
  return mint.publicKey;
}

let cached: Promise<Env> | undefined;

/** Boot once per vitest worker (files run sequentially, see vitest.config.ts) and reuse across specs. */
export function getEnv(): Promise<Env> {
  cached ??= boot();
  return cached;
}

async function boot(): Promise<Env> {
  const chain = await bootChain();
  const admin = chain.admin;
  if (chain.kind === 'rpc' && (await chain.balance(admin.publicKey)) < 50n * SOL) await chain.airdrop(admin.publicKey, 100n * SOL);

  // Pyth fixtures (owner = receiver program; LiteSVM: setAccount, RPC: must pre-exist — see helpers/pyth.ts)
  const pyth = await postPythPrices(chain);

  const already = await chain.getAccount(configPda()[0]);
  let cg: PublicKey, usdc: PublicKey, skr: PublicKey;
  if (already) {
    // RPC back-end re-run against an already initialised validator: reuse its mints (the $CG stash
    // is whatever the admin still holds — start a fresh validator for a full run).
    const cfg = decodeGameConfig(already.data);
    ({ cgMint: cg, usdcMint: usdc, skrMint: skr } = cfg);
  } else {
    // mints: $CG authority → admin now, handed to the emission PDA by init_emission; USDC/SKR stay admin-minted faucets
    cg = await createMint(chain, admin, 6, admin.publicKey);
    usdc = await createMint(chain, admin, 6, admin.publicKey);
    skr = await createMint(chain, admin, 6, admin.publicKey);
    // $CG faucet stash: minted BEFORE the authority moves to the emission PDA (100 M $CG)
    await chain.send([
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(cg, admin.publicKey), admin.publicKey, cg),
      createMintToInstruction(cg, ata(cg, admin.publicKey), admin.publicKey, 100_000_000n * 1_000_000n),
    ], { signers: [admin], label: 'cg stash' });
    await chain.send([initializeIx({ admin: admin.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey, cg, usdc, skr, pythSol: pyth.sol.account, pythSkr: pyth.skr.account })], { signers: [admin], label: 'initialize' });
    for (let i = 0; i < COLLECTIONS.length; i++) {
      const c = COLLECTIONS[i];
      const core = Keypair.generate();
      await chain.send([createCollectionIx({ admin: admin.publicKey, idx: i, coreCollection: core.publicKey, symbol: c.symbol, name: c.name, uri: `https://cdn.guttercaps.gg/c/${i}.json`, element: ELEMENT_INDEX[ELEMENT_OF_COLLECTION[i]] })], { signers: [admin, core], label: `create_collection ${i}` });
    }
    // vault + treasury token accounts for every SPL currency (buy_pack / sweep / open_pack assume they exist)
    const vault = vaultPda()[0];
    const atas: TransactionInstruction[] = [];
    for (const m of [cg, usdc, skr]) {
      atas.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(m, vault), vault, m));
      atas.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(m, TREASURY.publicKey), TREASURY.publicKey, m));
      atas.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(m, BUYBACK.publicKey), BUYBACK.publicKey, m));
    }
    await chain.send(atas, { signers: [admin], label: 'vault/treasury ATAs' });
    // staking: emission (takes over the $CG mint authority) + SKR prize pool + season pool ATA
    const genesis = (await chain.now()) - 10n; // day 0 started "just now"
    await chain.send([initEmissionIx({ admin: admin.publicKey, cgMint: cg, genesisTs: genesis })], { signers: [admin], label: 'init_emission' });
    const [pool] = skrPoolPda();
    await chain.send([
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(skr, pool), pool, skr),
      initSkrPoolIx({ admin: admin.publicKey, skrMint: skr, maxRootBudget: 0n }),
    ], { signers: [admin], label: 'init_skr_pool' });
    // arena: season pool = emission's $CG ATA (any token account works), treasury_cg = treasury's $CG ATA
    await chain.send([
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(cg, emissionPda()[0]), emissionPda()[0], cg),
      initArenaIx({ admin: admin.publicKey, battleOracle: BATTLE_ORACLE.publicKey, cgMint: cg, seasonPool: ata(cg, emissionPda()[0]), treasuryCg: ata(cg, TREASURY.publicKey), oracleDailyCap: ORACLE_DAILY_CAP }),
    ], { signers: [admin], label: 'init_arena' });
    for (const k of [TREASURY, BUYBACK, BATTLE_ORACLE, QUEST_ORACLE, SEASON_ORACLE, SET_ORACLE]) await chain.airdrop(k.publicKey, 2n * SOL);
  }
  cgStash = ata(cg, admin.publicKey);

  const refreshConfig = async () => decodeGameConfig((await chain.getAccount(configPda()[0]))!.data);
  const config = await refreshConfig();
  const coreCollections = new Map<number, PublicKey>();
  for (let i = 0; i < config.collectionsCreated; i++) {
    const meta = await chain.getAccount(collectionMetaPda(i)[0]);
    coreCollections.set(i, decodeCollectionMeta(meta!.data).coreCollection);
  }
  const coreOf = (idx: number) => { const c = coreCollections.get(idx); if (!c) throw new Error(`collection ${idx} not created`); return c; };

  const fund = async (to: PublicKey, token: 'usdc' | 'skr', amount: bigint) => {
    const mint = token === 'usdc' ? usdc : skr;
    await chain.send([
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(mint, to), to, mint),
      createMintToInstruction(mint, ata(mint, to), admin.publicKey, amount),
    ], { signers: [admin], label: `fund ${token}` });
  };
  const player = async (opts: { sol?: bigint; cg?: bigint; usdc?: bigint; skr?: bigint } = {}) => {
    const kp = Keypair.generate();
    await chain.airdrop(kp.publicKey, opts.sol ?? 20n * SOL);
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(cg, kp.publicKey), kp.publicKey, cg),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(usdc, kp.publicKey), kp.publicKey, usdc),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(skr, kp.publicKey), kp.publicKey, skr),
    ];
    if (opts.usdc) ixs.push(createMintToInstruction(usdc, ata(usdc, kp.publicKey), admin.publicKey, opts.usdc));
    if (opts.skr) ixs.push(createMintToInstruction(skr, ata(skr, kp.publicKey), admin.publicKey, opts.skr));
    await chain.send(ixs, { signers: [admin], label: 'player ATAs' });
    if (opts.cg) await mintCg(chain, admin, cg, kp.publicKey, opts.cg);
    return kp;
  };

  return { chain, admin, mints: { cg, usdc, skr }, config, coreCollections, coreOf, pyth, player, fund, refreshConfig };
}

/**
 * $CG faucet for tests. The mint authority is the emission PDA after `init_emission`, so tokens
 * can only enter through the program's mint paths; the harness therefore keeps a pre-minted
 * admin stash from before the hand-over and transfers from it.
 */
let cgStash: PublicKey | undefined;
export async function mintCg(chain: Chain, admin: Keypair, cg: PublicKey, to: PublicKey, amount: bigint) {
  if (!cgStash) throw new Error('cg stash not prepared (getEnv() first)');
  await chain.send([
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(cg, to), to, cg),
    createTransferInstruction(cgStash, ata(cg, to), admin.publicKey, amount),
  ], { signers: [admin], label: 'transfer $CG' });
}

export const tokenBalance = async (chain: Chain, mint: PublicKey, owner: PublicKey): Promise<bigint> => {
  const a = await chain.getAccount(getAssociatedTokenAddressSync(mint, owner, true));
  if (!a) return 0n;
  return new DataView(a.data.buffer, a.data.byteOffset + 64, 8).getBigUint64(0, true);
};

export { SWITCHBOARD_ON_DEMAND_ID };

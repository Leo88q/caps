"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SWITCHBOARD_ON_DEMAND_ID = exports.tokenBalance = exports.initLedgerIx = exports.acceptAdminIx = exports.proposeAdminIx = exports.unpauseIx = exports.pauseIx = exports.setPauserIx = exports.setPausedIx = exports.ORACLE_DAILY_CAP = exports.ELEMENT_INDEX = exports.SB_ORACLE = exports.SB_QUEUE = exports.SET_ORACLE = exports.SEASON_ORACLE = exports.QUEST_ORACLE = exports.BATTLE_ORACLE = exports.BUYBACK = exports.TREASURY = exports.SB_MOCK_ID = exports.ROOT = void 0;
exports.programBinaries = programBinaries;
exports.binariesPresent = binariesPresent;
exports.initializeIx = initializeIx;
exports.createCollectionIx = createCollectionIx;
exports.setParamsIx = setParamsIx;
exports.sweepVaultIx = sweepVaultIx;
exports.grantBoosterIx = grantBoosterIx;
exports.initEmissionIx = initEmissionIx;
exports.initSkrPoolIx = initSkrPoolIx;
exports.initArenaIx = initArenaIx;
exports.getEnv = getEnv;
exports.mintCg = mintCg;
// Test environment for tests/localnet: boots a chain (LiteSVM by default, RPC when
// LOCALNET_RPC is set), creates the three mints ($CG / USDC / SKR), runs the same admin
// setup as scripts/setup.ts (`initialize`, 8 × `create_collection` from lore, staking
// `init_emission` + `init_skr_pool`, arena `init_arena`), posts the Pyth price fixtures
// and hands out funded player wallets.
//
// The instruction builders / decoders are the REAL client ones (client/src/chain/*) —
// this suite doubles as the contract test of docs/04 §12. Vitest resolves `@/…` and
// `@guttercaps/economy` through tests/localnet/vitest.config.mts; `VITE_CLUSTER=localnet`
// there makes `SWITCHBOARD_ON_DEMAND_ID` = sb_mock.
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const elf_ts_1 = require("./elf.ts");
const anchor_1 = require("@/chain/anchor");
const chipCore_1 = require("@/chain/ix/chipCore");
const borsh_1 = require("@/chain/borsh");
const ids_1 = require("@/chain/ids");
Object.defineProperty(exports, "SWITCHBOARD_ON_DEMAND_ID", { enumerable: true, get: function () { return ids_1.SWITCHBOARD_ON_DEMAND_ID; } });
const pdas_1 = require("@/chain/pdas");
const accounts_1 = require("@/chain/accounts");
const lore_1 = require("@/shared/lib/lore");
const rarity_1 = require("@/shared/lib/rarity");
const economy_1 = require("@guttercaps/economy");
const chain_1 = require("./chain");
const pyth_1 = require("./pyth");
exports.ROOT = (0, node_path_1.resolve)(__dirname, '../../..');
exports.SB_MOCK_ID = new web3_js_1.PublicKey('ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH');
exports.TREASURY = web3_js_1.Keypair.generate();
exports.BUYBACK = web3_js_1.Keypair.generate();
exports.BATTLE_ORACLE = web3_js_1.Keypair.generate();
exports.QUEST_ORACLE = web3_js_1.Keypair.generate();
exports.SEASON_ORACLE = web3_js_1.Keypair.generate();
exports.SET_ORACLE = web3_js_1.Keypair.generate();
/** any key works for the mock queue — the programs pin `SB_QUEUE` (devnet key on localnet) */
exports.SB_QUEUE = new web3_js_1.PublicKey('EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7');
exports.SB_ORACLE = web3_js_1.Keypair.generate().publicKey;
exports.ELEMENT_INDEX = { paint: 0, steel: 1, wheels: 2, noise: 3, shadow: 4 };
exports.ORACLE_DAILY_CAP = 1000000n * 1000000n; // 1 M $CG / day
const SOL = 1000000000n;
function programBinaries() {
    const dep = (name) => (0, node_path_1.resolve)(exports.ROOT, 'target/deploy', `${name}.so`);
    const mplCore = process.env.MPL_CORE_SO ?? (0, node_path_1.resolve)(exports.ROOT, 'tests/localnet/fixtures/mpl_core.so');
    return [
        { id: ids_1.CHIP_CORE_ID, path: dep('chip_core') },
        { id: ids_1.MARKET_ID, path: dep('market') },
        { id: ids_1.STAKING_ID, path: dep('staking') },
        { id: ids_1.ARENA_ID, path: dep('arena') },
        { id: exports.SB_MOCK_ID, path: dep('sb_mock') },
        { id: ids_1.MPL_CORE_ID, path: mplCore },
    ];
}
/**
 * True when every `.so` the LiteSVM back-end needs is present *and loadable* (otherwise the suite skips itself with a hint).
 *
 * "Loadable" matters: run 81 died inside litesvm with `Offset or value is out of bounds`, which that binding emits
 * for a **0-byte** `.so` — an `existsSync` check calls that a passing precondition, and the failure then surfaces
 * as eight identical boot errors that look like broken scenarios (see tests/localnet/helpers/elf.ts).
 *
 * In CI (and whenever `LOCALNET_STRICT=1`) missing binaries are a hard failure instead of a skip:
 * a `describe.skipIf` run reports "0 failed" while executing nothing, which is exactly the false
 * green that `docs/09-production-readiness.md` §3.3 calls out. Locally the skip stays useful — that
 * is the whole point of the TS-only half of the pyramid.
 */
function binariesPresent() {
    const missing = programBinaries()
        .map((p) => ({ p, c: (0, elf_ts_1.checkProgramBinary)(p.path) }))
        .filter((x) => !x.c.ok)
        .map((x) => `${x.p.path} — ${x.c.reason}`);
    if (missing.length && (process.env.CI === '1' || process.env.LOCALNET_STRICT === '1')) {
        throw new Error(`[tests/localnet] ${missing.length} program binary/binaries missing — refusing to skip in CI/strict mode:\n  ${missing.join('\n  ')}\n` +
            `  run \`npm run localnet:build\` (pinned sb_mock keypair + the solana-install shim + the solana_version\n` +
            `  check — a bare \`anchor build -- --features localnet\` is the failure those three are hiding) and then\n` +
            `  \`npm run localnet:fixtures\`; if a fixture is broken, \`rm -f tests/localnet/fixtures/*.so\` first\n` +
            `  (see tests/localnet/README.md). Without CI=1/LOCALNET_STRICT=1 the same binaries are a skip, not an error`);
    }
    return { ok: missing.length === 0, missing };
}
async function bootChain() {
    const rpc = process.env.LOCALNET_RPC;
    if (rpc) {
        const walletPath = (process.env.ANCHOR_WALLET ?? '~/.config/solana/id.json').replace(/^~/, (0, node_os_1.homedir)());
        const admin = web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse((0, node_fs_1.readFileSync)(walletPath, 'utf8'))));
        return new chain_1.RpcChain(new web3_js_1.Connection(rpc, 'confirmed'), admin);
    }
    return chain_1.LiteSvmChain.create(programBinaries());
}
// ---------------------------------------------------------------- admin instruction builders
// (no client builders exist for one-shot admin ixs; account order mirrors programs/*/src)
function initializeIx(a) {
    const args = new borsh_1.BorshWriter().pubkey(a.treasury).pubkey(a.buyback).pubkey(a.cg).pubkey(a.usdc).pubkey(a.skr).pubkey(ids_1.STAKING_ID).pubkey(a.pythSol).pubkey(a.pythSkr).toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.admin), (0, anchor_1.rw)((0, pdas_1.configPda)()[0]), (0, anchor_1.rw)((0, pdas_1.vaultPda)()[0]), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('initialize', args)),
    });
}
function createCollectionIx(a) {
    const args = new borsh_1.BorshWriter().u8(a.idx).string(a.symbol).string(a.name).string(a.uri).u8(a.element).toBytes();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.admin), (0, anchor_1.rw)((0, pdas_1.configPda)()[0]), (0, anchor_1.rw)((0, pdas_1.collectionMetaPda)(a.idx)[0]), (0, anchor_1.signer)(a.coreCollection), (0, anchor_1.ro)(ids_1.MPL_CORE_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('create_collection', args)),
    });
}
function setParamsIx(admin, p) {
    const w = new borsh_1.BorshWriter();
    w.option(p.packs, (b) => w.bytes(b));
    w.option(p.marketFeeBps, (v) => w.u16(v));
    w.option(p.featuredCollection, (v) => w.u8(v));
    w.option(p.treasury, (k) => w.pubkey(k));
    w.option(p.buybackWallet, (k) => w.pubkey(k));
    w.option(p.pythSolUsdFeed, (k) => w.pubkey(k));
    w.option(p.pythSkrUsdFeed, (k) => w.pubkey(k));
    w.option(p.skrMint, (k) => w.pubkey(k));
    w.option(p.skrDiscountBps, (v) => w.u16(v));
    return new web3_js_1.TransactionInstruction({ programId: ids_1.CHIP_CORE_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.rw)((0, pdas_1.configPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('set_params', w.toBytes())) });
}
const setPausedIx = (admin, paused) => new web3_js_1.TransactionInstruction({ programId: ids_1.CHIP_CORE_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.rw)((0, pdas_1.configPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('set_paused', new borsh_1.BorshWriter().bool(paused).toBytes())) });
exports.setPausedIx = setPausedIx;
/** SEC-H2 pauser role — the same three instructions exist on chip_core (`config`), staking (`emission`) and arena (`arena_config`). */
const PAUSABLE = {
    chip_core: () => ({ programId: ids_1.CHIP_CORE_ID, account: (0, pdas_1.configPda)()[0] }),
    staking: () => ({ programId: ids_1.STAKING_ID, account: (0, pdas_1.emissionPda)()[0] }),
    arena: () => ({ programId: ids_1.ARENA_ID, account: (0, pdas_1.arenaConfigPda)()[0] }),
};
const setPauserIx = (program, admin, pauser) => {
    const t = PAUSABLE[program]();
    return new web3_js_1.TransactionInstruction({ programId: t.programId, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.rw)(t.account)], data: Buffer.from((0, anchor_1.ixData)('set_pauser', new borsh_1.BorshWriter().pubkey(pauser).toBytes())) });
};
exports.setPauserIx = setPauserIx;
const pauseIx = (program, authority) => {
    const t = PAUSABLE[program]();
    return new web3_js_1.TransactionInstruction({ programId: t.programId, keys: [(0, anchor_1.signer)(authority, false), (0, anchor_1.rw)(t.account)], data: Buffer.from((0, anchor_1.ixData)('pause')) });
};
exports.pauseIx = pauseIx;
/** Admin un-pause per program (`set_paused(false)` / `set_arena(paused: Some(false))`). */
const unpauseIx = (program, admin) => {
    const t = PAUSABLE[program]();
    const data = program === 'arena'
        ? (0, anchor_1.ixData)('set_arena', new borsh_1.BorshWriter().u8(0).u8(0).u8(1).bool(false).u8(0).toBytes())
        : (0, anchor_1.ixData)('set_paused', new borsh_1.BorshWriter().bool(false).toBytes());
    return new web3_js_1.TransactionInstruction({ programId: t.programId, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.rw)(t.account)], data: Buffer.from(data) });
};
exports.unpauseIx = unpauseIx;
const proposeAdminIx = (admin, next) => new web3_js_1.TransactionInstruction({ programId: ids_1.CHIP_CORE_ID, keys: [(0, anchor_1.signer)(admin, false), (0, anchor_1.rw)((0, pdas_1.configPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('propose_admin', new borsh_1.BorshWriter().pubkey(next).toBytes())) });
exports.proposeAdminIx = proposeAdminIx;
const acceptAdminIx = (next) => new web3_js_1.TransactionInstruction({ programId: ids_1.CHIP_CORE_ID, keys: [(0, anchor_1.signer)(next, false), (0, anchor_1.rw)((0, pdas_1.configPda)()[0])], data: Buffer.from((0, anchor_1.ixData)('accept_admin')) });
exports.acceptAdminIx = acceptAdminIx;
/** `sweep_vault` — remaining_accounts = every ledger shard in order (#12); `shards` overrides them for negative tests. */
function sweepVaultIx(a) {
    const vault = (0, pdas_1.vaultPda)()[0];
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [
            (0, anchor_1.signer)(a.admin, false), (0, anchor_1.ro)((0, pdas_1.configPda)()[0]), (0, anchor_1.rw)(vault), (0, anchor_1.rw)(a.treasury),
            a.mint ? (0, anchor_1.rw)((0, pdas_1.ata)(a.mint, vault)) : (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), a.mint ? (0, anchor_1.rw)((0, pdas_1.ata)(a.mint, a.treasury)) : (0, anchor_1.ro)(ids_1.CHIP_CORE_ID), (0, anchor_1.ro)(spl_token_1.TOKEN_PROGRAM_ID),
            (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID), // SOL leg: the vault PDA signs a system transfer (it is system-owned, never debited directly)
            ...(a.shards ?? (0, pdas_1.allLedgerPdas)()).map(anchor_1.ro),
        ],
        data: Buffer.from((0, anchor_1.ixData)('sweep_vault')),
    });
}
/** `init_ledger(shard)` — permissionless, creates `["ledger", shard]` (#12). */
const initLedgerIx = (a) => new web3_js_1.TransactionInstruction({ programId: ids_1.CHIP_CORE_ID, keys: [(0, anchor_1.signer)(a.payer), (0, anchor_1.rw)((0, pdas_1.ledgerPda)(a.shard)[0]), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)], data: Buffer.from((0, anchor_1.ixData)('init_ledger', new borsh_1.BorshWriter().u8(a.shard).toBytes())) });
exports.initLedgerIx = initLedgerIx;
function grantBoosterIx(a) {
    const [items] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('items'), a.owner.toBytes()], ids_1.CHIP_CORE_ID);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.CHIP_CORE_ID,
        keys: [(0, anchor_1.signer)(a.authority, false), (0, anchor_1.signer)(a.payer), (0, anchor_1.ro)((0, pdas_1.configPda)()[0]), (0, anchor_1.ro)(a.owner), (0, anchor_1.rw)(items), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('grant_booster', new borsh_1.BorshWriter().u16(a.count).toBytes())),
    });
}
function initEmissionIx(a) {
    const split = [economy_1.EMISSION_SPLIT.chipStaking, economy_1.EMISSION_SPLIT.tokenStaking, economy_1.EMISSION_SPLIT.quests, economy_1.EMISSION_SPLIT.pvpSeason, economy_1.EMISSION_SPLIT.eventsReserve].map((p) => p * 100);
    const w = new borsh_1.BorshWriter().pubkey(ids_1.CHIP_CORE_ID).pubkey(ids_1.MARKET_ID).pubkey(ids_1.ARENA_ID).pubkey(exports.QUEST_ORACLE.publicKey).pubkey(exports.SEASON_ORACLE.publicKey).pubkey(exports.SET_ORACLE.publicKey);
    for (const s of split)
        w.u16(s);
    w.i64(a.genesisTs);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [(0, anchor_1.signer)(a.admin), (0, anchor_1.rw)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)((0, pdas_1.tokenPoolPda)()[0]), (0, anchor_1.rw)((0, pdas_1.chipPoolPda)()[0]), (0, anchor_1.rw)(a.cgMint), (0, anchor_1.ro)(spl_token_1.TOKEN_PROGRAM_ID), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('init_emission', w.toBytes())),
    });
}
function initSkrPoolIx(a) {
    const [pool] = (0, pdas_1.skrPoolPda)();
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.STAKING_ID,
        keys: [(0, anchor_1.signer)(a.admin), (0, anchor_1.ro)((0, pdas_1.emissionPda)()[0]), (0, anchor_1.rw)(pool), (0, anchor_1.ro)(a.skrMint), (0, anchor_1.ro)((0, pdas_1.ata)(a.skrMint, pool)), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('init_skr_pool', new borsh_1.BorshWriter().u64(a.maxRootBudget).toBytes())),
    });
}
function initArenaIx(a) {
    const w = new borsh_1.BorshWriter().pubkey(a.battleOracle).pubkey(a.cgMint).pubkey(a.seasonPool).pubkey(a.treasuryCg).u64(a.oracleDailyCap);
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.ARENA_ID,
        keys: [(0, anchor_1.signer)(a.admin), (0, anchor_1.rw)((0, pdas_1.arenaConfigPda)()[0]), (0, anchor_1.ro)(ids_1.SYSTEM_PROGRAM_ID)],
        data: Buffer.from((0, anchor_1.ixData)('init_arena', w.toBytes())),
    });
}
// ---------------------------------------------------------------- boot
/**
 * Bind deterministic localnet tree placeholders for the claim/settlement
 * phase. The real deployment preallocates a compression-owned Merkle tree and
 * calls `create_bubblegum_tree`; this fixture deliberately stops at
 * `configure_bubblegum_tree` because claim creation must be testable without
 * pretending that a DAS indexer or Bubblegum executable has already minted a
 * leaf. Mint/registration tests must provide a real V2 tree fixture.
 */
async function ensureCompressedTreeBindings(chain, admin, collections) {
    const ixs = [];
    for (let idx = 0; idx < collections; idx++) {
        const [treeMeta] = (0, pdas_1.bubblegumTreeMetaPda)(idx);
        if (await chain.getAccount(treeMeta))
            continue;
        const [merkleTree] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('localnet_merkle_tree'), Buffer.from([idx])], ids_1.CHIP_CORE_ID);
        const [treeConfig] = web3_js_1.PublicKey.findProgramAddressSync([merkleTree.toBytes()], ids_1.MPL_BUBBLEGUM_V2_ID);
        const [treeAuthority] = (0, pdas_1.collectionMetaPda)(idx);
        ixs.push((0, chipCore_1.configureBubblegumTreeIx)({
            admin: admin.publicKey,
            collectionIdx: idx,
            merkleTree,
            treeConfig,
            treeAuthority,
            maxDepth: 5,
            canopy: 0,
        }));
    }
    if (ixs.length)
        await chain.send(ixs, { signers: [admin], label: 'configure localnet Bubblegum V2 trees' });
}
async function createMint(chain, payer, decimals, authority) {
    const mint = web3_js_1.Keypair.generate();
    await chain.send([
        web3_js_1.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(await chain.rentExempt(spl_token_1.MINT_SIZE)), space: spl_token_1.MINT_SIZE, programId: spl_token_1.TOKEN_PROGRAM_ID }),
        (0, spl_token_1.createInitializeMint2Instruction)(mint.publicKey, decimals, authority, null),
    ], { signers: [payer, mint], label: 'create mint' });
    return mint.publicKey;
}
let cached;
/** Boot once per vitest worker (files run sequentially in one fork, see vitest.config.mts) and reuse across specs. */
function getEnv() {
    cached ??= boot();
    return cached;
}
async function boot() {
    const chain = await bootChain();
    const admin = chain.admin;
    if (chain.kind === 'rpc' && (await chain.balance(admin.publicKey)) < 50n * SOL)
        await chain.airdrop(admin.publicKey, 100n * SOL);
    // Pyth fixtures (owner = receiver program; LiteSVM: setAccount, RPC: must pre-exist — see helpers/pyth.ts)
    const pyth = await (0, pyth_1.postPythPrices)(chain);
    const already = await chain.getAccount((0, pdas_1.configPda)()[0]);
    let cg, usdc, skr;
    if (already) {
        // RPC back-end re-run against an already initialised validator: reuse its mints (the $CG stash
        // is whatever the admin still holds — start a fresh validator for a full run).
        const cfg = (0, accounts_1.decodeGameConfig)(already.data);
        ({ cgMint: cg, usdcMint: usdc, skrMint: skr } = cfg);
    }
    else {
        // mints: $CG authority → admin now, handed to the emission PDA by init_emission; USDC/SKR stay admin-minted faucets
        cg = await createMint(chain, admin, 6, admin.publicKey);
        usdc = await createMint(chain, admin, 6, admin.publicKey);
        skr = await createMint(chain, admin, 6, admin.publicKey);
        // $CG faucet stash: minted BEFORE the authority moves to the emission PDA (100 M $CG)
        await chain.send([
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(cg, admin.publicKey), admin.publicKey, cg),
            (0, spl_token_1.createMintToInstruction)(cg, (0, pdas_1.ata)(cg, admin.publicKey), admin.publicKey, 100000000n * 1000000n),
        ], { signers: [admin], label: 'cg stash' });
        await chain.send([initializeIx({ admin: admin.publicKey, treasury: exports.TREASURY.publicKey, buyback: exports.BUYBACK.publicKey, cg, usdc, skr, pythSol: pyth.sol.account, pythSkr: pyth.skr.account })], { signers: [admin], label: 'initialize' });
        // #12: the LEDGER_SHARDS liability shards (permissionless, one tx)
        await chain.send(Array.from({ length: pdas_1.LEDGER_SHARDS }, (_, i) => (0, exports.initLedgerIx)({ payer: admin.publicKey, shard: i })), { signers: [admin], label: 'init_ledger ×4' });
        for (let i = 0; i < lore_1.COLLECTIONS.length; i++) {
            const c = lore_1.COLLECTIONS[i];
            const core = web3_js_1.Keypair.generate();
            await chain.send([createCollectionIx({ admin: admin.publicKey, idx: i, coreCollection: core.publicKey, symbol: c.symbol, name: c.name, uri: `https://cdn.guttercaps.gg/c/${i}.json`, element: exports.ELEMENT_INDEX[rarity_1.ELEMENT_OF_COLLECTION[i]] })], { signers: [admin, core], label: `create_collection ${i}` });
        }
        // vault + treasury token accounts for every SPL currency (buy_pack / sweep / open_pack assume they exist)
        const vault = (0, pdas_1.vaultPda)()[0];
        const atas = [];
        for (const m of [cg, usdc, skr]) {
            atas.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(m, vault), vault, m));
            atas.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(m, exports.TREASURY.publicKey), exports.TREASURY.publicKey, m));
            atas.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(m, exports.BUYBACK.publicKey), exports.BUYBACK.publicKey, m));
        }
        await chain.send(atas, { signers: [admin], label: 'vault/treasury ATAs' });
        // staking: emission (takes over the $CG mint authority) + SKR prize pool + season pool ATA
        const genesis = (await chain.now()) - 10n; // day 0 started "just now"
        await chain.send([initEmissionIx({ admin: admin.publicKey, cgMint: cg, genesisTs: genesis })], { signers: [admin], label: 'init_emission' });
        const [pool] = (0, pdas_1.skrPoolPda)();
        await chain.send([
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(skr, pool), pool, skr),
            initSkrPoolIx({ admin: admin.publicKey, skrMint: skr, maxRootBudget: 0n }),
        ], { signers: [admin], label: 'init_skr_pool' });
        // arena: season pool = $CG ATA of staking's ["season_pool"] PDA (spent only by fund_slice, SEC-L5), treasury_cg = treasury's $CG ATA;
        // the emission PDA's own $CG ATA is the staking vault (stakers' principal) and must stay separate
        await chain.send([
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(cg, (0, pdas_1.seasonPoolAuthPda)()[0]), (0, pdas_1.seasonPoolAuthPda)()[0], cg),
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(cg, (0, pdas_1.emissionPda)()[0]), (0, pdas_1.emissionPda)()[0], cg),
            initArenaIx({ admin: admin.publicKey, battleOracle: exports.BATTLE_ORACLE.publicKey, cgMint: cg, seasonPool: (0, pdas_1.ata)(cg, (0, pdas_1.seasonPoolAuthPda)()[0]), treasuryCg: (0, pdas_1.ata)(cg, exports.TREASURY.publicKey), oracleDailyCap: exports.ORACLE_DAILY_CAP }),
        ], { signers: [admin], label: 'init_arena' });
        for (const k of [exports.TREASURY, exports.BUYBACK, exports.BATTLE_ORACLE, exports.QUEST_ORACLE, exports.SEASON_ORACLE, exports.SET_ORACLE])
            await chain.airdrop(k.publicKey, 2n * SOL);
    }
    cgStash = (0, pdas_1.ata)(cg, admin.publicKey);
    const refreshConfig = async () => (0, accounts_1.decodeGameConfig)((await chain.getAccount((0, pdas_1.configPda)()[0])).data);
    const ledgerShard = async (shard) => (0, accounts_1.decodeVaultLedger)((await chain.getAccount((0, pdas_1.ledgerPda)(shard)[0])).data);
    const ledger = async () => (0, accounts_1.sumLedgers)(await Promise.all((0, pdas_1.allLedgerPdas)().map(async (k) => { const a = await chain.getAccount(k); return a ? (0, accounts_1.decodeVaultLedger)(a.data) : null; })));
    const config = await refreshConfig();
    await ensureCompressedTreeBindings(chain, admin, config.collectionsCreated);
    const coreCollections = new Map();
    for (let i = 0; i < config.collectionsCreated; i++) {
        const meta = await chain.getAccount((0, pdas_1.collectionMetaPda)(i)[0]);
        coreCollections.set(i, (0, accounts_1.decodeCollectionMeta)(meta.data).coreCollection);
    }
    const coreOf = (idx) => { const c = coreCollections.get(idx); if (!c)
        throw new Error(`collection ${idx} not created`); return c; };
    const fund = async (to, token, amount) => {
        const mint = token === 'usdc' ? usdc : skr;
        await chain.send([
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(mint, to), to, mint),
            (0, spl_token_1.createMintToInstruction)(mint, (0, pdas_1.ata)(mint, to), admin.publicKey, amount),
        ], { signers: [admin], label: `fund ${token}` });
    };
    const player = async (opts = {}) => {
        const kp = web3_js_1.Keypair.generate();
        await chain.airdrop(kp.publicKey, opts.sol ?? 20n * SOL);
        const ixs = [
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(cg, kp.publicKey), kp.publicKey, cg),
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(usdc, kp.publicKey), kp.publicKey, usdc),
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(skr, kp.publicKey), kp.publicKey, skr),
        ];
        if (opts.usdc)
            ixs.push((0, spl_token_1.createMintToInstruction)(usdc, (0, pdas_1.ata)(usdc, kp.publicKey), admin.publicKey, opts.usdc));
        if (opts.skr)
            ixs.push((0, spl_token_1.createMintToInstruction)(skr, (0, pdas_1.ata)(skr, kp.publicKey), admin.publicKey, opts.skr));
        await chain.send(ixs, { signers: [admin], label: 'player ATAs' });
        if (opts.cg)
            await mintCg(chain, admin, cg, kp.publicKey, opts.cg);
        return kp;
    };
    return { chain, admin, mints: { cg, usdc, skr }, config, coreCollections, coreOf, pyth, player, fund, refreshConfig, ledger, ledgerShard };
}
/**
 * $CG faucet for tests. The mint authority is the emission PDA after `init_emission`, so tokens
 * can only enter through the program's mint paths; the harness therefore keeps a pre-minted
 * admin stash from before the hand-over and transfers from it.
 */
let cgStash;
async function mintCg(chain, admin, cg, to, amount) {
    if (!cgStash)
        throw new Error('cg stash not prepared (getEnv() first)');
    await chain.send([
        (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(admin.publicKey, (0, pdas_1.ata)(cg, to), to, cg),
        (0, spl_token_1.createTransferInstruction)(cgStash, (0, pdas_1.ata)(cg, to), admin.publicKey, amount),
    ], { signers: [admin], label: 'transfer $CG' });
}
const tokenBalance = async (chain, mint, owner) => {
    const a = await chain.getAccount((0, spl_token_1.getAssociatedTokenAddressSync)(mint, owner, true));
    if (!a)
        return 0n;
    return new DataView(a.data.buffer, a.data.byteOffset + 64, 8).getBigUint64(0, true);
};
exports.tokenBalance = tokenBalance;

// T-L-SEC-F7 — only the upgrade authority can create the singleton configs (checklist A6 / C17).
//
// chip_core `initialize` and arena `init_arena` used to be first-caller-wins: anybody watching the
// deploy could create `["config"]` / `["arena_config"]` with their own admin + treasury before
// `npm run setup`. Both now read the program's ProgramData (upgradeable-loader PDA `[program_id]`)
// and require the signer to be the recorded upgrade authority (programs/chip_core/src/deploy_guard.rs).
//
// The shared environment's configs are already live, so this spec boots a private LiteSVM with just
// chip_core + arena. LiteSVM's `addProgram` creates no ProgramData, which doubles as the "program was
// not deployed upgradeable" case; the others are forged with `setAccount` (on a real cluster only the
// loader can write a loader-owned account, which is exactly why the program checks owner + address).
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { decodeGameConfig } from '@/chain/accounts';
import { ARENA_ID, CHIP_CORE_ID, SYSTEM_PROGRAM_ID } from '@/chain/ids';
import { arenaConfigPda, configPda } from '@/chain/pdas';
import { LiteSvmChain } from './helpers/chain';
import { BPF_LOADER_UPGRADEABLE_ID, binariesPresent, forgeProgramData, initArenaIx, initializeIx, programBinaries, programDataHeader, programDataPda } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok || !!process.env.LOCALNET_RPC);
const SOL = 1_000_000_000n;

suite('T-L-SEC-F7 initialize / init_arena are gated by the upgrade authority', () => {
  let chain: LiteSvmChain;
  let deployer: Keypair;
  let attacker: Keypair;

  const initCore = (who: Keypair, programData?: PublicKey) => chain.send([
    initializeIx({
      admin: who.publicKey, treasury: who.publicKey, buyback: who.publicKey,
      cg: Keypair.generate().publicKey, usdc: Keypair.generate().publicKey, skr: Keypair.generate().publicKey,
      pythSol: Keypair.generate().publicKey, pythSkr: Keypair.generate().publicKey, programData,
    }),
  ], { signers: [who], label: 'initialize' });
  const initArena = (who: Keypair, programData?: PublicKey) => chain.send([
    initArenaIx({
      admin: who.publicKey, battleOracle: who.publicKey, cgMint: Keypair.generate().publicKey,
      seasonPool: Keypair.generate().publicKey, treasuryCg: Keypair.generate().publicKey, oracleDailyCap: 1_000n, programData,
    }),
  ], { signers: [who], label: 'init_arena' });

  beforeAll(async () => {
    chain = await LiteSvmChain.create(programBinaries().filter((p) => p.id.equals(CHIP_CORE_ID) || p.id.equals(ARENA_ID)));
    deployer = chain.admin;
    attacker = Keypair.generate();
    await chain.airdrop(attacker.publicKey, 10n * SOL);
  });

  it('F7a program without ProgramData (not deployed upgradeable): nobody can initialise, not even the deployer', async () => {
    await expectFail(initCore(deployer), Err.chip('NotUpgradeAuthority'), 'chip_core, no ProgramData');
    await expectFail(initArena(deployer), Err.arena('NotUpgradeAuthority'), 'arena, no ProgramData');
    expect(await chain.getAccount(configPda()[0])).toBeNull();
    expect(await chain.getAccount(arenaConfigPda()[0])).toBeNull();
  });

  it('F7b immutable program (upgrade authority None) cannot be initialised', async () => {
    await forgeProgramData(chain, CHIP_CORE_ID, null);
    await expectFail(initCore(deployer), Err.chip('NotUpgradeAuthority'), 'immutable');
    expect(await chain.getAccount(configPda()[0])).toBeNull();
  });

  it('F7c front-run: the attacker cannot initialise a program whose upgrade authority is the deployer', async () => {
    for (const id of [CHIP_CORE_ID, ARENA_ID]) await forgeProgramData(chain, id, deployer.publicKey);
    await expectFail(initCore(attacker), Err.chip('NotUpgradeAuthority'), 'chip_core front-run');
    await expectFail(initArena(attacker), Err.arena('NotUpgradeAuthority'), 'arena front-run');
    expect(await chain.getAccount(configPda()[0])).toBeNull();
    expect(await chain.getAccount(arenaConfigPda()[0])).toBeNull();
  });

  it('F7d the attacker cannot substitute his own "ProgramData": wrong address, wrong owner, or another program\'s', async () => {
    // (1) his header in a system-owned account at an arbitrary address
    const fake = Keypair.generate().publicKey;
    await chain.setAccount(fake, { owner: SYSTEM_PROGRAM_ID, data: programDataHeader(attacker.publicKey) });
    await expectFail(initCore(attacker, fake), Err.chip('NotUpgradeAuthority'), 'fake address');
    // (2) same header, even loader-owned, at a non-PDA address
    const fakeLoaderOwned = Keypair.generate().publicKey;
    await chain.setAccount(fakeLoaderOwned, { owner: BPF_LOADER_UPGRADEABLE_ID, data: programDataHeader(attacker.publicKey) });
    await expectFail(initCore(attacker, fakeLoaderOwned), Err.chip('NotUpgradeAuthority'), 'loader-owned, wrong address');
    // (3) the genuine ProgramData of ANOTHER upgradeable program he controls
    const hisProgram = Keypair.generate().publicKey;
    const hisPd = await forgeProgramData(chain, hisProgram, attacker.publicKey);
    await expectFail(initCore(attacker, hisPd), Err.chip('NotUpgradeAuthority'), 'other program\'s ProgramData');
    await expectFail(initArena(attacker, hisPd), Err.arena('NotUpgradeAuthority'), 'arena: other program\'s ProgramData');
    // (4) arena's genuine ProgramData handed to chip_core (cross-program confusion)
    await forgeProgramData(chain, ARENA_ID, attacker.publicKey);
    await expectFail(initCore(attacker, programDataPda(ARENA_ID)), Err.chip('NotUpgradeAuthority'), 'arena ProgramData → chip_core');
    await forgeProgramData(chain, ARENA_ID, deployer.publicKey);
    expect(await chain.getAccount(configPda()[0])).toBeNull();
  });

  it('F7e old 4-account initialize (no ProgramData) is rejected outright', async () => {
    const ix = initializeIx({
      admin: attacker.publicKey, treasury: attacker.publicKey, buyback: attacker.publicKey, cg: attacker.publicKey, usdc: attacker.publicKey,
      skr: attacker.publicKey, pythSol: attacker.publicKey, pythSkr: attacker.publicKey,
    });
    const legacy = new TransactionInstruction({ programId: ix.programId, keys: ix.keys.slice(0, 4), data: ix.data });
    await expectAnyFail(chain.send([legacy], { signers: [attacker] }), 'legacy account list');
    expect(await chain.getAccount(configPda()[0])).toBeNull();
  });

  it('F7f the upgrade authority initialises both; the config admin is the deployer and a second init fails', async () => {
    await initCore(deployer);
    const cfg = decodeGameConfig((await chain.getAccount(configPda()[0]))!.data);
    expect(cfg.admin.equals(deployer.publicKey)).toBe(true);
    await initArena(deployer);
    const arena = (await chain.getAccount(arenaConfigPda()[0]))!;
    expect(new PublicKey(arena.data.subarray(8, 40)).equals(deployer.publicKey)).toBe(true);
    await expectAnyFail(initCore(deployer), 're-initialise (account already in use)');
    await expectAnyFail(initArena(deployer), 're-initialise arena');
  });
});

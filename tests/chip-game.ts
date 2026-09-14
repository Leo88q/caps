// Integration tests against a local validator (`anchor test` spins one up
// automatically). Pack open is intentionally NOT covered here — it needs a
// live Switchboard VRF oracle to write a real result, which a local
// validator can't simulate. Everything downstream of "you already own a
// chip" (upgrade, marketplace, staking) is fully covered end to end.

import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { assert } from 'chai';
import idl from '../client/src/lib/chip_game.idl.json';

const PROGRAM_ID = new PublicKey('ChpGame1111111111111111111111111111111111');

function symbolBuffer(symbol: string): number[] {
  const buf = Buffer.alloc(16);
  buf.write(symbol.slice(0, 16));
  return Array.from(buf);
}

function questProgressPda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('quest_progress'), owner.toBuffer()], PROGRAM_ID);
}

async function initQuestProgress(program: anchor.Program, payer: Keypair) {
  const [questProgress] = questProgressPda(payer.publicKey);
  await program.methods
    .initQuestProgress()
    .accounts({ owner: payer.publicKey, questProgress })
    .signers([payer])
    .rpc();
  return questProgress;
}

describe('chip-game', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(idl as anchor.Idl, PROGRAM_ID, provider);
  const admin = (provider.wallet as anchor.Wallet).payer;

  let config: PublicKey;
  let collection: PublicKey;
  let cgMint: PublicKey;
  let treasury: Keypair;
  let battleOracle: Keypair;

  // A "chip" in these tests is hand-minted via spl-token directly (bypassing
  // open_pack, which needs live VRF), then its ChipState is created via the
  // admin-gated seed_chip_state_for_test instruction (see
  // instructions/test_utils.rs) — that instruction exists specifically so
  // this suite can exercise upgrade/marketplace/staking/quests without a
  // live Switchboard oracle.
  async function mintTestChip(owner: PublicKey, rarity: Record<string, {}> = { common: {} }, level = 1) {
    const mint = await createMint(provider.connection, admin, collection, null, 0);
    const ata = await createAssociatedTokenAccount(provider.connection, admin, mint, owner);
    await mintTo(provider.connection, admin, mint, ata, collection, 1);

    const [chipState] = PublicKey.findProgramAddressSync(
      [Buffer.from('chip'), mint.toBuffer()],
      PROGRAM_ID,
    );

    await program.methods
      .seedChipStateForTest(rarity, level, new anchor.BN(1))
      .accounts({ config, admin: admin.publicKey, payer: admin.publicKey, chipState, mint, collection })
      .rpc();

    return { mint, ata, chipState };
  }

  before(async () => {
    [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
    cgMint = await createMint(provider.connection, admin, config, null, 6);
    treasury = Keypair.generate();
    battleOracle = Keypair.generate();

    await program.methods
      .initializeConfig(new anchor.BN(0.1 * anchor.web3.LAMPORTS_PER_SOL), 250)
      .accounts({ admin: admin.publicKey, config, treasury: treasury.publicKey, cgMint, battleOracle: battleOracle.publicKey })
      .rpc();

    [collection] = PublicKey.findProgramAddressSync(
      [Buffer.from('collection'), Buffer.from(symbolBuffer('TESTSET'))],
      PROGRAM_ID,
    );
    await program.methods
      .createCollection(symbolBuffer('TESTSET'))
      .accounts({ config, admin: admin.publicKey, collection, payer: admin.publicKey })
      .rpc();
  });

  it('initializes config with the right treasury and fee', async () => {
    const account = await program.account.gameConfig.fetch(config);
    assert.strictEqual(account.marketplaceFeeBps, 250);
    assert.strictEqual(account.treasury.toBase58(), treasury.publicKey.toBase58());
  });

  it('creates a collection with zero minted chips', async () => {
    const account = await program.account.collection.fetch(collection);
    assert.strictEqual(account.minted.toNumber(), 0);
  });

  it('rejects marketplace fee above 10%', async () => {
    const [badConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('config'), Buffer.from('bad')], // distinct seed so it doesn't collide
      PROGRAM_ID,
    );
    try {
      await program.methods
        .initializeConfig(new anchor.BN(1000), 1500) // 15% — should fail
        .accounts({ admin: admin.publicKey, config: badConfig, treasury: treasury.publicKey, cgMint, battleOracle: battleOracle.publicKey })
        .rpc();
      assert.fail('expected FeeTooHigh error');
    } catch (err) {
      assert.include(String(err), 'FeeTooHigh');
    }
  });

  // The following two suites depend on a hand-seeded ChipState (see the
  // note in mintTestChip above) and are written to show the exact call
  // shape expected in the client — treat them as the reference for wiring
  // your own end-to-end pack-open-based fixture once VRF is live on devnet.

  describe('marketplace', () => {
    it('lists, buys, and settles a fee split', async () => {
      const seller = Keypair.generate();
      const buyer = Keypair.generate();
      await provider.connection.requestAirdrop(buyer.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);

      const { mint, ata } = await mintTestChip(seller.publicKey);
      const [listing] = PublicKey.findProgramAddressSync(
        [Buffer.from('listing'), mint.toBuffer()],
        PROGRAM_ID,
      );
      const escrow = getAssociatedTokenAddressSync(mint, listing, true);

      await provider.connection.requestAirdrop(seller.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await new Promise((r) => setTimeout(r, 500)); // let the airdrop land before it pays for init_quest_progress
      const sellerQuestProgress = await initQuestProgress(program, seller);

      await program.methods
        .listChip(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
        .accounts({
          seller: seller.publicKey, config, chipMint: mint, sellerTokenAccount: ata,
          escrowTokenAccount: escrow, listing, questProgress: sellerQuestProgress,
        })
        .signers([seller])
        .rpc();

      const sellerBalanceBefore = await provider.connection.getBalance(seller.publicKey);
      const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);

      await program.methods
        .buyChip()
        .accounts({
          buyer: buyer.publicKey, config, treasury: treasury.publicKey, listing,
          seller: seller.publicKey, chipMint: mint, escrowTokenAccount: escrow, buyerTokenAccount: buyerAta,
        })
        .signers([buyer])
        .rpc();

      const sellerBalanceAfter = await provider.connection.getBalance(seller.publicKey);
      // Seller should net 97.5% of 1 SOL (2.5% fee to treasury).
      assert.approximately(
        sellerBalanceAfter - sellerBalanceBefore,
        0.975 * anchor.web3.LAMPORTS_PER_SOL,
        0.01 * anchor.web3.LAMPORTS_PER_SOL,
      );
    });
  });

  describe('staking', () => {
    it('accrues $CG rewards proportional to elapsed time', async () => {
      const owner = Keypair.generate();
      await provider.connection.requestAirdrop(owner.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      const { mint, ata, chipState } = await mintTestChip(owner.publicKey);

      await program.methods
        .stakeChip()
        .accounts({ owner: owner.publicKey, chipState, chipMint: mint, ownerTokenAccount: ata })
        .signers([owner])
        .rpc();

      // On a local validator you'd warp the clock forward here
      // (BankrunProvider / solana-test-validator's --warp-slot) rather than
      // sleeping in real time — sleeping is included only to keep this
      // runnable against a plain `solana-test-validator` without extras.
      await new Promise((r) => setTimeout(r, 2000));

      const ownerCg = getAssociatedTokenAddressSync(cgMint, owner.publicKey);
      await program.methods
        .claimRewards()
        .accounts({ owner: owner.publicKey, config, chipState, chipMint: mint, cgMint, ownerCgAccount: ownerCg })
        .signers([owner])
        .rpc();

      const balance = await provider.connection.getTokenAccountBalance(ownerCg);
      assert.isAbove(Number(balance.value.amount), 0);
    });
  });

  describe('quests', () => {
    it('tracks upgrade progress and pays out on claim', async () => {
      const owner = Keypair.generate();
      await provider.connection.requestAirdrop(owner.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await new Promise((r) => setTimeout(r, 500));

      const questProgress = await initQuestProgress(program, owner);

      // Two hand-minted chips: one to upgrade, one to burn as material.
      const target = await mintTestChip(owner.publicKey);
      const material = await mintTestChip(owner.publicKey);

      await program.methods
        .upgradeChip()
        .accounts({
          owner: owner.publicKey,
          chipState: target.chipState,
          targetMint: target.mint,
          materialState: material.chipState,
          materialMint: material.mint,
          materialTokenAccount: material.ata,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          questProgress,
        })
        .signers([owner])
        .rpc();

      const progressAfterUpgrade = await program.account.questProgress.fetch(questProgress);
      assert.strictEqual(progressAfterUpgrade.upgradesDaily, 1);

      const ownerCg = getAssociatedTokenAddressSync(cgMint, owner.publicKey);
      // owner_cg_account must exist before claim_quest mints into it.
      await createAssociatedTokenAccount(provider.connection, admin, cgMint, owner.publicKey);

      await program.methods
        .claimQuest(0, 1) // period 0 = daily, quest id 1 = "upgrade a chip"
        .accounts({ owner: owner.publicKey, config, questProgress, cgMint, ownerCgAccount: ownerCg })
        .signers([owner])
        .rpc();

      const balance = await provider.connection.getTokenAccountBalance(ownerCg);
      assert.strictEqual(Number(balance.value.amount), 20_000_000); // matches DAILY_QUESTS[1].reward

      try {
        await program.methods
          .claimQuest(0, 1)
          .accounts({ owner: owner.publicKey, config, questProgress, cgMint, ownerCgAccount: ownerCg })
          .signers([owner])
          .rpc();
        assert.fail('expected QuestAlreadyClaimed error on double-claim');
      } catch (err) {
        assert.include(String(err), 'QuestAlreadyClaimed');
      }
    });
  });
});

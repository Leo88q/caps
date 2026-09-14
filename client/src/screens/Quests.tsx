import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { getProgram, questProgressPda, configPda } from '../lib/program';
import { QuestsIcon } from '../lib/icons';
import { SprayNozzleButton } from '../lib/buttons';

// Mirrors the exact catalog hard-coded in instructions/quests.rs
// (DAILY_QUESTS / WEEKLY_QUESTS / PERMANENT_QUESTS) — target and reward
// here must match the contract's values or the progress bars and claim
// button will lie about what's actually claimable.
const CATALOG = {
  daily: [
    { id: 0, title: 'Open 3 packs', target: 3, reward: '20 $CG', field: 'packsOpenedDaily' as const },
    { id: 1, title: 'Upgrade a chip', target: 1, reward: '20 $CG', field: 'upgradesDaily' as const },
    { id: 2, title: 'Win a PvP battle', target: 1, reward: '20 $CG', field: 'battlesWonDaily' as const },
  ],
  weekly: [
    { id: 0, title: 'Win 5 PvP battles', target: 5, reward: '80 $CG', field: 'battlesWonWeekly' as const },
    { id: 1, title: 'List a chip on the marketplace', target: 1, reward: '40 $CG', field: 'listingsWeekly' as const },
  ],
  permanent: [
    { id: 0, title: 'Win 50 battles lifetime', target: 50, reward: '200 $CG', field: 'battlesWonLifetime' as const },
  ],
};

const PERIOD_INDEX = { daily: 0, weekly: 1, permanent: 2 } as const;

interface ProgressAccount {
  packsOpenedDaily: number;
  upgradesDaily: number;
  battlesWonDaily: number;
  battlesWonWeekly: number;
  listingsWeekly: number;
  battlesWonLifetime: number;
  claimedDailyMask: number;
  claimedWeeklyMask: number;
  claimedPermanentMask: number;
}

export function QuestsScreen({ wallet }: { wallet: AnchorWallet }) {
  const { connection } = useConnection();
  const [progress, setProgress] = useState<ProgressAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [notInitialized, setNotInitialized] = useState(false);

  async function refresh() {
    setLoading(true);
    const program = getProgram(connection, wallet);
    const [pda] = questProgressPda(wallet.publicKey);
    try {
      const account = await program.account.questProgress.fetch(pda);
      setProgress({
        packsOpenedDaily: account.packsOpenedDaily,
        upgradesDaily: account.upgradesDaily,
        battlesWonDaily: account.battlesWonDaily,
        battlesWonWeekly: account.battlesWonWeekly,
        listingsWeekly: account.listingsWeekly,
        battlesWonLifetime: account.battlesWonLifetime,
        claimedDailyMask: account.claimedDailyMask,
        claimedWeeklyMask: account.claimedWeeklyMask,
        claimedPermanentMask: account.claimedPermanentMask,
      });
      setNotInitialized(false);
    } catch {
      // Account doesn't exist yet — App.tsx's ensureQuestProgress on
      // connect should have created it; this only shows if that failed
      // (e.g. devnet unreachable) or ran before this screen mounted.
      setNotInitialized(true);
    }
    setLoading(false);
  }

  useEffect(() => { refresh(); }, [connection, wallet]);

  async function claim(period: keyof typeof PERIOD_INDEX, questId: number) {
    const program = getProgram(connection, wallet);
    const [config] = configPda();
    const [questProgress] = questProgressPda(wallet.publicKey);
    const configAccount = await program.account.gameConfig.fetch(config);
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    const ownerCgAccount = getAssociatedTokenAddressSync(configAccount.cgMint, wallet.publicKey);

    await program.methods
      .claimQuest(PERIOD_INDEX[period], questId)
      .accounts({
        owner: wallet.publicKey,
        config,
        questProgress,
        cgMint: configAccount.cgMint,
        ownerCgAccount,
      })
      .rpc();
    refresh();
  }

  if (loading) return <p style={{ padding: 16 }}>Загрузка…</p>;

  if (notInitialized || !progress) {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ color: '#888' }}>
          Прогресс квестов ещё не инициализирован для этого кошелька — обычно
          это делается автоматически при подключении. Попробуйте обновить
          страницу или проверьте, что devnet и программа доступны.
        </p>
      </div>
    );
  }

  function renderGroup(period: keyof typeof PERIOD_INDEX, title: string, claimedMask: number) {
    return (
      <div style={{ marginBottom: 22 }}>
        <p style={{ fontSize: 13, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{title}</p>
        {CATALOG[period].map((q) => {
          const current = progress![q.field];
          const isClaimed = (claimedMask & (1 << q.id)) !== 0;
          const isComplete = current >= q.target;
          return (
            <div key={q.id} style={{ border: '1px solid #333', borderRadius: 10, padding: 12, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 14 }}>{q.title}</span>
                <span style={{ fontSize: 12, color: '#888' }}>{q.reward}</span>
              </div>
              <div style={{ height: 6, background: '#222', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
                <div style={{ width: `${Math.min(100, (current / q.target) * 100)}%`, height: '100%', background: 'var(--cg-neon-cyan)' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: '#666' }}>{current}/{q.target}</span>
                <SprayNozzleButton
                  disabled={!isComplete || isClaimed}
                  style={{ padding: '6px 14px', fontSize: 12 }}
                  onClick={() => claim(period, q.id)}
                >
                  {isClaimed ? 'Claimed' : 'Claim'}
                </SprayNozzleButton>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="cg-brick-bg" style={{ padding: 16, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <QuestsIcon size={22} />
        <strong className="cg-heading" style={{ fontSize: 18 }}>Quests</strong>
      </div>
      {renderGroup('daily', 'Daily', progress.claimedDailyMask)}
      {renderGroup('weekly', 'Weekly', progress.claimedWeeklyMask)}
      {renderGroup('permanent', 'Permanent', progress.claimedPermanentMask)}
    </div>
  );
}

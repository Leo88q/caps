// Daily / weekly / permanent quests, streak, and Merkle claims (claim_root).
import { useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { useQuests, useClaims, useStreak, useMe, type ClaimLeaf } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { claimAnyRootIx } from '@/chain/ix/staking';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { fromHex, verifyRewardProof } from '@/chain/merkle';
import { CleanZone, KV, Pill, Progress, Skeleton, Empty } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { HumanCheck } from '@/shared/ui/HumanCheck';
import { fmtCg, fmtSkr, countdown } from '@/shared/lib/format';
import { rarityName } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { EXPLORER, MINTS } from '@/app/config';
import { ANTI_FARM, ROOT_KIND_LABEL, SKR_ANTI_FARM, isSkrRootKind } from '@guttercaps/economy';
import { useT, type MessageKey } from '@/shared/i18n';

type Cadence = 'daily' | 'weekly' | 'permanent';
const KIND_LABEL = ROOT_KIND_LABEL;
/** Roots pay either $CG (kinds 2..4, minted from emission) or SKR (kinds 5..7, prize pool). */
const fmtRoot = (kind: number, micro: bigint | string | number | undefined | null) => (isSkrRootKind(kind) ? fmtSkr(micro) : fmtCg(micro));

/**
 * Pre-check a claim leaf against the published root before spending a fee on it
 * (same bytes as `verify_proof` on-chain — see chain/merkle.ts).
 */
export function verifyProof(leaf: ClaimLeaf, wallet: Uint8Array, root: Uint8Array): boolean {
  return verifyRewardProof({ wallet, amountMicro: leaf.amountMicro!, kind: leaf.kind!, epoch: leaf.epoch! }, (leaf.proof ?? []).map(fromHex), root);
}

export default function Quests() {
  const t = useT();
  const quests = useQuests();
  const claims = useClaims();
  const streak = useStreak();
  const me = useMe();
  const cfg = useGameConfig();
  const wallet = useWalletLike();
  const { connection } = useConnection();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [tab, setTab] = useState<Cadence>('daily');
  const [busy, setBusy] = useState(false);
  const cgMint = cfg.data?.cgMint ?? MINTS.cg;
  const skrMint = cfg.data?.skrMint ?? MINTS.skr;

  const list = (quests.data ?? []).filter((q) => q.cadence === tab);
  const claimable = (claims.data ?? []).filter((c) => !c.claimed && new Date(c.claimableAt!).getTime() <= Date.now());
  const totalCg = claimable.filter((c) => !isSkrRootKind(c.kind!)).reduce((s, c) => s + BigInt(c.amountMicro ?? '0'), 0n);
  const totalSkr = claimable.filter((c) => isSkrRootKind(c.kind!)).reduce((s, c) => s + BigInt(c.amountMicro ?? '0'), 0n);
  const totalLabel = [totalCg > 0n || totalSkr === 0n ? fmtCg(totalCg) : null, totalSkr > 0n ? fmtSkr(totalSkr) : null].filter(Boolean).join(' + ');
  const REASONS = new Set(['account_too_new', 'play_10_matches_or_buy_a_pack', 'rewards_paused', 'device_limit', 'human_check_required']);
  /** Server reason codes → player copy (unknown codes are shown raw so nothing is hidden). */
  const reasonText = (code: string) => (REASONS.has(code) ? t(`quests.reason.${code}` as MessageKey, { n: ANTI_FARM.maxWalletsPerDevice }) : code);

  async function claimAll() {
    if (isMock()) { toast({ kind: 'money', title: t('quests.claimedMock'), body: totalLabel }); return; }
    if (!wallet) return;
    if (totalCg > 0n && !cgMint) return;
    if (totalSkr > 0n && !skrMint) { toast({ kind: 'error', title: t('quests.skrNotConfigured'), body: t('quests.skrNotConfiguredBody') }); return; }
    setBusy(true);
    try {
      const ixs = [];
      if (totalCg > 0n && cgMint) ixs.push(createAtaIdempotentIx(wallet.publicKey, wallet.publicKey, cgMint));
      if (totalSkr > 0n && skrMint) ixs.push(createAtaIdempotentIx(wallet.publicKey, wallet.publicKey, skrMint));
      for (const c of claimable) ixs.push(claimAnyRootIx({ wallet: wallet.publicKey, kind: c.kind!, epoch: c.epoch!, amount: BigInt(c.amountMicro!), proof: (c.proof ?? []).map(fromHex), cgMint, skrMint }));
      const { signature } = await sendTx(connection, wallet, ixs, { cuLimit: 80_000 + 60_000 * claimable.length });
      toast({ kind: 'money', title: t('quests.claimedToast', { amount: totalLabel }), href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['quests'] });
      void qc.invalidateQueries({ queryKey: ['chain', 'balances'] });
    } catch (e) {
      toast({ kind: 'error', title: t('quests.claimFailed'), body: String((e as Error)?.message ?? e) });
    } finally { setBusy(false); }
  }

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('quests.title')}</h1>
        <p className="page-sub">{t('quests.subtitle')}</p>
      </div>

      <div className="grid-2">
        <div className="card stack-sm">
          <div className="row between"><span className="strong">{t('quests.streak')}</span><span className="mono">{streak.data?.days ?? 0}/7</span></div>
          <Progress value={streak.data?.days ?? 0} max={7} tone="acid" />
          <div className="tiny muted">{t('quests.streakHint', { time: streak.data ? countdown(streak.data.resetsAt!) : '—' })}</div>
        </div>
        <CleanZone className="stack-sm">
          <KV k={t('quests.claimable')} v={totalLabel} accent />
          {claimable.map((c) => <KV key={`${c.kind}-${c.epoch}`} k={t('quests.rootEpoch', { kind: KIND_LABEL[c.kind!] ?? t('quests.root'), epoch: c.epoch! })} v={fmtRoot(c.kind!, c.amountMicro)} />)}
          <CleanConfirmButton disabled={busy || claimable.length === 0} onClick={claimAll}>{claimable.length > 1 ? t('quests.claimAll', { n: claimable.length }) : t('quests.claim')}</CleanConfirmButton>
          <div className="tiny muted">{t('quests.freeCaps', { daily: fmtCg(ANTI_FARM.dailyQuestRewardCapCgMicro, 0), weekly: fmtCg(ANTI_FARM.weeklyQuestRewardCapCgMicro, 0), chips: ANTI_FARM.freeChipsPerWalletPerWeek })}</div>
          <div className="tiny muted">{t('quests.skrPool', { weekly: SKR_ANTI_FARM.weeklyQuestCapSkr, season: SKR_ANTI_FARM.seasonCapSkr })}</div>
        </CleanZone>
      </div>

      {/* T-B-49: proof of human (settlement waits for it) + device dedupe notice */}
      <HumanCheck compact />
      {me.data?.flags?.deviceLimited && <div className="warn">{t('human.deviceLimited', { n: ANTI_FARM.maxWalletsPerDevice })}</div>}

      <div className="tabs">{(['daily', 'weekly', 'permanent'] as Cadence[]).map((c) => <Pill key={c} active={tab === c} onClick={() => setTab(c)}>{t(`quests.${c}`)}</Pill>)}</div>

      {quests.isLoading ? <Skeleton h={200} /> : list.length === 0 ? <Empty>{t('quests.empty')}</Empty> : (
        <div className="stack-sm">
          {list.map((q) => {
            const done = (q.value ?? 0) >= (q.target ?? 1);
            return (
              <div key={q.id} className="card row between" style={{ opacity: q.ineligibleReason ? 0.6 : 1 }}>
                <div className="grow stack-sm">
                  <div className="row between"><span className="strong">{q.title}</span><span className="mono small">{q.value}/{q.target}</span></div>
                  <Progress value={q.value ?? 0} max={q.target ?? 1} tone={done ? 'acid' : undefined} />
                  <div className="tiny muted">
                    {q.rewardCgMicro && q.rewardCgMicro !== '0' && <span>+{fmtCg(q.rewardCgMicro, 0)} </span>}
                    {q.rewardChip && <span>+ {t('quests.capRoll')} ({(q.rewardChip as { odds?: number[] }).odds?.map((o, i) => (o > 0 ? `${rarityName(i)} ${o / 100}%` : null)).filter(Boolean).join(', ')}) </span>}
                    {!!q.rewardBooster && <span>+ {t('quests.booster', { n: q.rewardBooster })} </span>}
                    {q.resetsAt && tab !== 'permanent' && <span>· {t('quests.resetsIn', { time: countdown(q.resetsAt) })}</span>}
                    {q.ineligibleReason && <span style={{ color: 'var(--cg-electric-orange)' }}> · {reasonText(q.ineligibleReason)}</span>}
                  </div>
                </div>
                {q.claimable ? <span className="pill pill-ok">{t('quests.inNextRoot')}</span> : done ? <span className="pill">{t('quests.done')}</span> : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="tiny muted">{t('quests.antiFarm', { sameOpponent: ANTI_FARM.pvpSameOpponentDailyCap, minSec: ANTI_FARM.pvpMinMatchDurationSec })}</div>
    </div>
  );
}

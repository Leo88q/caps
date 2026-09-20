// Daily / weekly / permanent quests, streak, and Merkle claims (claim_root / claim_skr_root / claim_item_root / claim_chip_root).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { useQuests, useClaims, useStreak, useMe, type ClaimLeaf } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { claimAnyRootIx, claimChipRootIx } from '@/chain/ix/staking';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { Currency } from '@/chain/ix/chipCore';
import { RNG_KIND, freshNonce } from '@/chain/pdas';
import { prepareRandomness } from '@/chain/switchboard';
import { fromHex, verifyRewardProof } from '@/chain/merkle';
import { usePackFlow } from '@/features/shop/usePackFlow';
import { CleanZone, KV, Pill, Progress, Skeleton, Empty } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { HumanCheck } from '@/shared/ui/HumanCheck';
import { fmtCg, fmtSkr, countdown } from '@/shared/lib/format';
import { rarityName } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { EXPLORER, MINTS } from '@/app/config';
import { ANTI_FARM, QUEST_CHIP_TEMPLATES, ROOT_KIND_LABEL, SKR_ANTI_FARM, isChipRootKind, isItemRootKind, isSkrRootKind } from '@guttercaps/economy';
import { useT, type MessageKey } from '@/shared/i18n';

type Cadence = 'daily' | 'weekly' | 'permanent';
const KIND_LABEL = ROOT_KIND_LABEL;

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
  const navigate = useNavigate();
  const packFlow = usePackFlow();
  const [tab, setTab] = useState<Cadence>('daily');
  const [busy, setBusy] = useState(false);
  const cgMint = cfg.data?.cgMint ?? MINTS.cg;
  const skrMint = cfg.data?.skrMint ?? MINTS.skr;

  /** A chip voucher leaf's "amount" is the TEMPLATE id (#28) → the rarities it can roll. */
  const voucherOdds = (leaf: Pick<ClaimLeaf, 'amountMicro'>) => QUEST_CHIP_TEMPLATES[Number(leaf.amountMicro ?? 0)]?.odds ?? [];
  const oddsText = (odds: readonly number[]) => odds.map((o, i) => (o > 0 ? `${rarityName(i)} ${o / 100}%` : null)).filter(Boolean).join(', ');
  /** Roots pay $CG (kinds 2..4, minted from emission), SKR (5..7, prize pool), boosters (8 — a unit count, CPI into PlayerItems) or a cap voucher (9 — one free cap roll). */
  const fmtRoot = (kind: number, amount: bigint | string | number | undefined | null) =>
    isChipRootKind(kind) ? t('quests.chipLeaf', { odds: oddsText(voucherOdds({ amountMicro: String(amount ?? 0) })) })
      : isItemRootKind(kind) ? t('quests.boosterLeaf', { n: Number(amount ?? 0) }) : isSkrRootKind(kind) ? fmtSkr(amount) : fmtCg(amount);
  const list = (quests.data ?? []).filter((q) => q.cadence === tab);
  const ready = (claims.data ?? []).filter((c) => !c.claimed && new Date(c.claimableAt!).getTime() <= Date.now());
  const claimable = ready.filter((c) => !isChipRootKind(c.kind!));   // one tx for every $CG / SKR / booster leaf
  const vouchers = ready.filter((c) => isChipRootKind(c.kind!));     // one tx EACH: the claim commits a randomness request (like buy_pack)
  const sumOf = (pick: (kind: number) => boolean) => claimable.filter((c) => pick(c.kind!)).reduce((s, c) => s + BigInt(c.amountMicro ?? '0'), 0n);
  const totalCg = sumOf((k) => !isSkrRootKind(k) && !isItemRootKind(k));
  const totalSkr = sumOf(isSkrRootKind);
  const totalBoosters = sumOf(isItemRootKind);
  const totalLabel = [
    totalCg > 0n || (totalSkr === 0n && totalBoosters === 0n && vouchers.length === 0) ? fmtCg(totalCg) : null,
    totalSkr > 0n ? fmtSkr(totalSkr) : null,
    totalBoosters > 0n ? t('quests.boosterLeaf', { n: Number(totalBoosters) }) : null,
    vouchers.length > 0 ? t('quests.chipLeaves', { n: vouchers.length }) : null,
  ].filter(Boolean).join(' + ');
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
      if (totalBoosters > 0n) void qc.invalidateQueries({ queryKey: ['chain', 'items'] }); // PlayerItems changed by the CPI grant
    } catch (e) {
      toast({ kind: 'error', title: t('quests.claimFailed'), body: String((e as Error)?.message ?? e) });
    } finally { setBusy(false); }
  }

  /**
   * #28 — claim one cap voucher: `init_randomness(0, nonce)` + `claim_chip_root` in ONE tx (the staking program CPIs
   * chip_core `open_voucher`, which commits the Switchboard request), then the normal pack opener reveals + mints the cap
   * (`/shop/opening/:nonce`, sku 0 · qty 1). The cap arrives soulbound for the template's days.
   */
  async function claimVoucher(leaf: ClaimLeaf) {
    if (isMock()) {
      toast({ kind: 'money', title: t('quests.voucherClaimedMock'), body: fmtRoot(leaf.kind!, leaf.amountMicro) });
      const nonce = await packFlow.start({ sku: 0, qty: 1, currency: Currency.USDC });
      if (nonce !== undefined) navigate(`/shop/opening/${nonce}`);
      return;
    }
    if (!wallet) return;
    setBusy(true);
    try {
      const nonce = freshNonce();
      const rnd = await prepareRandomness(connection, wallet.publicKey, RNG_KIND.PACK, nonce);
      const ixs = [
        ...rnd.ixs,
        claimChipRootIx({ wallet: wallet.publicKey, kind: leaf.kind!, epoch: leaf.epoch!, amount: BigInt(leaf.amountMicro!), proof: (leaf.proof ?? []).map(fromHex), nonce, queue: rnd.queue, oracle: rnd.oracle }),
      ];
      const { signature } = await sendTx(connection, wallet, ixs, { cuLimit: 500_000 });
      toast({ kind: 'money', title: t('quests.voucherClaimed'), body: t('quests.voucherClaimedBody'), href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['quests'] });
      void qc.invalidateQueries({ queryKey: ['me', 'pending'] });
      // hand over to the pack opener (reveal → open_pack → cap on the grid); resumable from /shop/opening/:nonce after a reload
      navigate(`/shop/opening/${nonce}`);
      void packFlow.resume(nonce, 0, 1, Currency.USDC);
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
          {vouchers.map((c) => (
            <div key={`${c.kind}-${c.epoch}`} className="stack-sm" data-testid="voucher-claim">
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                <span style={{ width: 44, flex: '0 0 auto' }} aria-hidden><div className="disc-slot">?</div></span>
                <div className="grow"><KV k={t('quests.rootEpoch', { kind: KIND_LABEL[c.kind!] ?? t('quests.root'), epoch: c.epoch! })} v={fmtRoot(c.kind!, c.amountMicro)} /></div>
              </div>
              <CleanConfirmButton disabled={busy} onClick={() => claimVoucher(c)}>{t('quests.claimVoucher')}</CleanConfirmButton>
              <div className="tiny muted">{t('quests.voucherHint', { days: QUEST_CHIP_TEMPLATES[Number(c.amountMicro ?? 0)]?.soulboundDays ?? 0 })}</div>
            </div>
          ))}
          <div className="tiny muted">{t('quests.freeCaps', { daily: fmtCg(ANTI_FARM.dailyQuestRewardCapCgMicro, 0), weekly: fmtCg(ANTI_FARM.weeklyQuestRewardCapCgMicro, 0), chips: ANTI_FARM.freeChipsPerWalletPerWeek })}</div>
          <div className="tiny muted">{t('quests.skrPool', { weekly: SKR_ANTI_FARM.weeklyQuestCapSkr, season: SKR_ANTI_FARM.seasonCapSkr })}</div>
          <div className="tiny muted">{t('quests.boosterHint')}</div>
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
                    {q.rewardChip && <span>+ {t('quests.capRoll')} ({oddsText((q.rewardChip as { odds?: number[] }).odds ?? [])}) </span>}
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

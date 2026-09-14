// Daily / weekly / permanent quests, streak, and Merkle claims (claim_root).
import { useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { keccak_256 } from '@noble/hashes/sha3';
import { useQuests, useClaims, useStreak, type ClaimLeaf } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { claimRootIx } from '@/chain/ix/staking';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { CleanZone, KV, Pill, Progress, Skeleton, Empty } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { fmtCg, countdown } from '@/shared/lib/format';
import { rarityName } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { EXPLORER, MINTS } from '@/app/config';
import { ANTI_FARM } from '@guttercaps/economy';
import { useT } from '@/shared/i18n';

type Cadence = 'daily' | 'weekly' | 'permanent';
const KIND_LABEL: Record<number, string> = { 2: 'Quests', 3: 'PvP season', 4: 'Events' };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));

/** leaf = keccak(0x00 ‖ wallet ‖ amount_le_u64 ‖ kind ‖ epoch_le_u32); nodes = keccak(sorted pair) */
export function verifyProof(leaf: ClaimLeaf, wallet: Uint8Array, root: Uint8Array): boolean {
  const amt = new Uint8Array(8); new DataView(amt.buffer).setBigUint64(0, BigInt(leaf.amountMicro!), true);
  const ep = new Uint8Array(4); new DataView(ep.buffer).setUint32(0, leaf.epoch!, true);
  let node = keccak_256(new Uint8Array([0, ...wallet, ...amt, leaf.kind!, ...ep]));
  for (const p of leaf.proof ?? []) {
    const sib = fromHex(p);
    const [a, b] = Buffer.compare(Buffer.from(node), Buffer.from(sib)) <= 0 ? [node, sib] : [sib, node];
    node = keccak_256(new Uint8Array([...a, ...b]));
  }
  return hex(node) === hex(root);
}

export default function Quests() {
  const t = useT();
  const quests = useQuests();
  const claims = useClaims();
  const streak = useStreak();
  const cfg = useGameConfig();
  const wallet = useWalletLike();
  const { connection } = useConnection();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [tab, setTab] = useState<Cadence>('daily');
  const [busy, setBusy] = useState(false);
  const cgMint = cfg.data?.cgMint ?? MINTS.cg;

  const list = (quests.data ?? []).filter((q) => q.cadence === tab);
  const claimable = (claims.data ?? []).filter((c) => !c.claimed && new Date(c.claimableAt!).getTime() <= Date.now());
  const total = claimable.reduce((s, c) => s + BigInt(c.amountMicro ?? '0'), 0n);

  async function claimAll() {
    if (isMock()) { toast({ kind: 'money', title: 'Claimed (mock)', body: fmtCg(total) }); return; }
    if (!wallet || !cgMint) return;
    setBusy(true);
    try {
      const ixs = [createAtaIdempotentIx(wallet.publicKey, wallet.publicKey, cgMint)];
      for (const c of claimable) ixs.push(claimRootIx({ wallet: wallet.publicKey, kind: c.kind!, epoch: c.epoch!, amount: BigInt(c.amountMicro!), proof: (c.proof ?? []).map(fromHex), cgMint }));
      const { signature } = await sendTx(connection, wallet, ixs, { cuLimit: 80_000 + 60_000 * claimable.length });
      toast({ kind: 'money', title: `Claimed ${fmtCg(total)}`, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['quests'] });
      void qc.invalidateQueries({ queryKey: ['chain', 'balances'] });
    } catch (e) {
      toast({ kind: 'error', title: 'Claim failed', body: String((e as Error)?.message ?? e) });
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
          <div className="row between"><span className="strong">Streak</span><span className="mono">{streak.data?.days ?? 0}/7</span></div>
          <Progress value={streak.data?.days ?? 0} max={7} tone="acid" />
          <div className="tiny muted">Day 7 drops a Common/Common+/Rare cap (soulbound 3 d) · resets in {streak.data ? countdown(streak.data.resetsAt!) : '—'}</div>
        </div>
        <CleanZone className="stack-sm">
          <KV k="Ready to claim" v={fmtCg(total)} accent />
          {claimable.map((c) => <KV key={`${c.kind}-${c.epoch}`} k={`${KIND_LABEL[c.kind!] ?? 'Root'} · epoch ${c.epoch}`} v={fmtCg(c.amountMicro)} />)}
          <CleanConfirmButton disabled={busy || claimable.length === 0} onClick={claimAll}>Claim {claimable.length > 1 ? `all (${claimable.length})` : ''}</CleanConfirmButton>
          <div className="tiny muted">Caps from free sources: {fmtCg(ANTI_FARM.dailyQuestRewardCapCgMicro, 0)}/day · {fmtCg(ANTI_FARM.weeklyQuestRewardCapCgMicro, 0)}/week · {ANTI_FARM.freeChipsPerWalletPerWeek} free caps/week.</div>
        </CleanZone>
      </div>

      <div className="tabs">{(['daily', 'weekly', 'permanent'] as Cadence[]).map((c) => <Pill key={c} active={tab === c} onClick={() => setTab(c)}>{c}</Pill>)}</div>

      {quests.isLoading ? <Skeleton h={200} /> : list.length === 0 ? <Empty>Nothing here yet.</Empty> : (
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
                    {q.rewardChip && <span>+ cap roll ({(q.rewardChip as { odds?: number[] }).odds?.map((o, i) => (o > 0 ? `${rarityName(i)} ${o / 100}%` : null)).filter(Boolean).join(', ')}) </span>}
                    {!!q.rewardBooster && <span>+ {q.rewardBooster} booster </span>}
                    {q.resetsAt && tab !== 'permanent' && <span>· resets in {countdown(q.resetsAt)}</span>}
                    {q.ineligibleReason && <span style={{ color: 'var(--cg-electric-orange)' }}> · {q.ineligibleReason}</span>}
                  </div>
                </div>
                {q.claimable ? <span className="pill pill-ok">in next root</span> : done ? <span className="pill">done</span> : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="tiny muted">Anti-farm: rewards need ≥ 1 paid pack or a 24 h-old wallet with 10 matches; device/IP dedupe; max {ANTI_FARM.pvpSameOpponentDailyCap} rewarded matches vs the same opponent per day; matches under {ANTI_FARM.pvpMinMatchDurationSec}s are not rewarded.</div>
    </div>
  );
}

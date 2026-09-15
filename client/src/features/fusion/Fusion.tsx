// Fusion bench: 3 slots → 1 result. Rule (any / same-collection) per recipe,
// success chance, booster toggle, fee (burned), result lock, set-break warning.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { FUSION_RECIPES, BOOSTER } from '@guttercaps/economy';
import { useMyChips, useFusionSuggest, useGrid, type Chip } from '@/api/hooks';
import { usePlayerItems, useWalletLike } from '@/chain/hooks';
import { FusionFlow, successBps, type FusionFlowState } from '@/chain/flows/fusionFlow';
import { useTxStore, fusionId } from '@/app/store/txs';
import { useUiStore } from '@/app/store/ui';
import { ChipArt } from '@/shared/ui/ChipArt';
import { CleanZone, KV, Modal, Pill, Skeleton } from '@/shared/ui/primitives';
import { CleanConfirmButton, SprayCapToggle } from '@/shared/ui/buttons';
import { chipName, collectionName, rarityColor, rarityName, collectionColor } from '@/shared/lib/rarity';
import { fmtCg, fmtPct, secondsToHuman } from '@/shared/lib/format';
import { isMock } from '@/api/client';
import { EXPLORER } from '@/app/config';
import { useT } from '@/shared/i18n';

export default function Fusion() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const chips = useMyChips({ status: 'free' });
  const suggest = useFusionSuggest(true);
  const grid = useGrid();
  const items = usePlayerItems();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const enqueue = useUiStore((s) => s.enqueueReveal);
  const upsertFusion = useTxStore((s) => s.upsertFusion);

  const all = useMemo(() => (chips.data?.pages.flatMap((p) => p.items ?? []) ?? []).filter((c) => !c.flags?.soulbound && !c.lockUntil && c.rarity! < 8), [chips.data]);
  const [slots, setSlots] = useState<(Chip | null)[]>([null, null, null]);
  const [resultCol, setResultCol] = useState<number | null>(null);
  const [booster, setBooster] = useState(false);
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [flow, setFlow] = useState<FusionFlowState | null>(null);
  const [busy, setBusy] = useState(false);

  // ?add=<asset> from the collection drawer
  useEffect(() => {
    const add = params.get('add');
    if (!add || !all.length) return;
    const c = all.find((x) => x.asset === add);
    if (c) setSlots((s) => (s.some((x) => x?.asset === add) ? s : [c, s[1], s[2]]));
    const p = new URLSearchParams(params); p.delete('add'); setParams(p, { replace: true });
  }, [params, all, setParams]);

  const filled = slots.filter((s): s is Chip => !!s);
  const from = filled[0]?.rarity;
  const recipe = from !== undefined ? FUSION_RECIPES[from] : undefined;
  const sameRarity = filled.every((c) => c.rarity === from);
  const sameCol = filled.every((c) => c.collection === filled[0]?.collection);
  const ruleOk = !recipe || recipe.rule === 'any' || sameCol;
  const cols = Array.from(new Set(filled.map((c) => c.collection!)));
  const effectiveResultCol = recipe?.rule === 'same-collection' ? filled[0]?.collection ?? null : resultCol ?? cols[0] ?? null;
  const ready = filled.length === 3 && sameRarity && ruleOk && !!recipe && effectiveResultCol !== null;
  const chance = recipe ? successBps(recipe.from, booster) : 0;
  const boosters = items.data?.boosters ?? 0;
  const breaksSet = filled.some((c) => (grid.data?.cells?.[c.collection!]?.[c.rarity!] ?? 0) === 1);
  const eligibleForSlot = (i: number) => all.filter((c) => !slots.some((s, j) => j !== i && s?.asset === c.asset) && (from === undefined || i === 0 || c.rarity === from) && (!recipe || recipe.rule === 'any' || i === 0 || c.collection === filled[0]?.collection));

  async function fuse() {
    if (!ready || !recipe) return;
    setBusy(true);
    try {
      if (isMock()) {
        const seq: FusionFlowState[] = [];
        const base: FusionFlowState = { phase: 'signing', nonce: 1n, recipe: recipe.from, boosted: booster, materials: [], resultCollectionIdx: effectiveResultCol!, signatures: [] };
        seq.push({ ...base });
        setFlow(seq[0]);
        await new Promise((r) => setTimeout(r, 1000));
        if (recipe.successBps < 10_000) { setFlow({ ...base, phase: 'committed' }); await new Promise((r) => setTimeout(r, 1200)); setFlow({ ...base, phase: 'revealing' }); await new Promise((r) => setTimeout(r, 1800)); }
        const success = Math.random() * 10_000 < chance;
        setFlow({ ...base, phase: 'done', result: { owner: PublicKey.default, recipe: recipe.from, materials: [], result: PublicKey.unique(), success, rollBps: Math.floor(Math.random() * 10_000), thresholdBps: chance, feeBurned: BigInt(recipe.feeCgMicro) } });
        if (success) enqueue([{ id: `fuse-${Date.now()}`, asset: 'mock', rarity: recipe.to, collectionIdx: effectiveResultCol!, fused: true }]);
        else toast({ kind: 'error', title: 'Fusion failed', body: `Rolled ${fmtPct(Math.floor(Math.random() * 10_000))} vs ${fmtPct(chance)} · 1 material refunded, fee burned` });
        setSlots([null, null, null]);
        return;
      }
      if (!wallet) return;
      const w = wallet.publicKey.toBase58();
      const f = new FusionFlow({ connection, wallet, onState: (s) => { setFlow({ ...s }); upsertFusion({ id: fusionId(w, s.nonce), wallet: w, createdAt: Date.now(), updatedAt: Date.now(), phase: s.phase, nonce: s.nonce.toString(), recipe: s.recipe, boosted: s.boosted, resultCollectionIdx: s.resultCollectionIdx, signatures: s.signatures, randomness: s.randomness?.toBase58(), materials: s.materials.map((m) => ({ asset: m.asset.toBase58(), collectionIdx: m.collectionIdx })), error: s.error, result: s.result ? { result: s.result.result.toBase58(), success: s.result.success, rollBps: s.result.rollBps, thresholdBps: s.result.thresholdBps, feeBurned: s.result.feeBurned.toString() } : undefined }); } },
        { recipe: recipe.from, boosted: booster, materials: filled.map((c) => ({ asset: new PublicKey(c.asset!), collectionIdx: c.collection! })), resultCollectionIdx: effectiveResultCol! });
      await f.fuse();
      if (f.state.phase === 'committed') await f.reveal();
      if (f.state.phase === 'stale') { toast({ kind: 'error', title: 'Oracle timeout', body: 'Cancel the fusion to unfreeze your materials.' }); return; }
      const r = f.state.result;
      if (r?.success) { enqueue([{ id: r.result.toBase58(), asset: r.result.toBase58(), rarity: recipe.to, collectionIdx: effectiveResultCol!, fused: true }]); toast({ kind: 'success', title: 'Fusion succeeded', href: EXPLORER.tx(f.state.signatures.at(-1)!) }); }
      else if (r) toast({ kind: 'error', title: 'Fusion failed', body: `Rolled ${fmtPct(r.rollBps)} vs ${fmtPct(r.thresholdBps)} · 1 material refunded`, href: EXPLORER.tx(f.state.signatures.at(-1)!) });
      setSlots([null, null, null]);
      // SEC-M7: the randomness account is no longer pinned → close it and return the rent (best effort; the crank sweeps the rest)
      if (f.state.randomness) { try { await f.reclaimRent(); } catch { /* optional */ } }
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['chain'] });
    } catch (e) {
      toast({ kind: 'error', title: 'Fusion stopped', body: String((e as Error)?.message ?? e) });
    } finally { setBusy(false); }
  }

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('fusion.title')}</h1>
        <p className="page-sub">{t('fusion.subtitle')}</p>
      </div>

      <div className="card stack">
        <div className="bench">
          {slots.map((s, i) => (
            <div key={i} className={`slot ${s ? 'filled' : ''}`} onClick={() => setPickFor(i)} style={{ borderColor: s ? rarityColor(s.rarity!) : undefined }}>
              {s ? <ChipArt collection={s.collection!} rarity={s.rarity!} index={s.index} level={s.level} size="92%" /> : <span>+ slot {i + 1}</span>}
            </div>
          ))}
        </div>
        <div className="bench-arrow">↓</div>
        <div className="row" style={{ justifyContent: 'center', gap: 16 }}>
          <div style={{ width: 120 }}>{recipe && effectiveResultCol !== null ? <ChipArt collection={effectiveResultCol} rarity={recipe.to} /> : <div className="slot" style={{ width: 120 }}>?</div>}</div>
          <div className="stack-sm">
            {recipe ? (
              <>
                <div className="strong">{rarityName(recipe.from)} → <span style={{ color: rarityColor(recipe.to) }}>{rarityName(recipe.to)}</span></div>
                <div className="small muted">Rule: {recipe.rule === 'any' ? 'any districts (pick the surviving story)' : 'all three from ONE district'}</div>
                <div className="small">Success <b className="mono" style={{ color: chance === 10_000 ? 'var(--cg-acid-green)' : 'var(--cg-electric-orange)' }}>{fmtPct(chance, 0)}</b>{recipe.successBps < 10_000 && ` · on fail ${recipe.refundOnFail} refunded`}</div>
                {recipe.resultLockSeconds > 0 && <div className="tiny muted">Result locked (no trade/fuse) for {secondsToHuman(recipe.resultLockSeconds)}</div>}
              </>
            ) : <div className="muted small">Pick three caps of the same tier.</div>}
          </div>
        </div>

        {recipe?.rule === 'any' && cols.length > 1 && (
          <div className="stack-sm">
            <span className="label">Result district</span>
            <div className="tag-list">{cols.map((c) => <Pill key={c} active={effectiveResultCol === c} onClick={() => setResultCol(c)}><span style={{ width: 8, height: 8, borderRadius: 4, background: collectionColor(c) }} />{collectionName(c)}</Pill>)}</div>
          </div>
        )}
        {filled.length > 0 && !sameRarity && <div className="danger">All three must share the same tier.</div>}
        {recipe && !ruleOk && <div className="danger">This step needs all three from the same district.</div>}
        {breaksSet && <div className="warn">Heads-up: one of these is your only copy of its archetype — fusing it breaks a district set.</div>}

        {recipe && recipe.successBps < 10_000 && (
          <div className="row between">
            <SprayCapToggle on={booster} onChange={(v) => boosters > 0 && setBooster(v)} label={`Use booster (+${BOOSTER.bonusBps / 100} pp, cap ${BOOSTER.capBps / 100}%) · you have ${boosters}`} />
          </div>
        )}

        {recipe && (
          <CleanZone>
            <KV k="Fee (burned)" v={fmtCg(recipe.feeCgMicro)} accent />
            <KV k="Randomness" v={recipe.successBps === 10_000 ? 'not needed — atomic' : 'Switchboard commit → reveal (2 signatures)'} />
            {recipe.successBps < 10_000 && <KV k="Network + oracle fees" v="≈ 0.003 SOL" />}
          </CleanZone>
        )}
        <CleanConfirmButton disabled={!ready || busy} onClick={fuse}>{busy ? 'Working…' : recipe && recipe.successBps < 10_000 ? `Fuse (${fmtPct(chance, 0)})` : 'Fuse'}</CleanConfirmButton>
        {flow && flow.phase !== 'done' && flow.phase !== 'idle' && <div className="small muted">Phase: {flow.phase}{flow.error ? ` — ${flow.error}` : ''}</div>}
      </div>

      <div className="card stack-sm">
        <div className="strong">Suggested (keeps your sets intact)</div>
        {suggest.isLoading && <Skeleton h={60} />}
        {(suggest.data ?? []).slice(0, 5).map((s, i) => (
          <div key={i} className="row between small">
            <span className="row" style={{ gap: 4 }}>{s.materials!.slice(0, 3).map((m) => <span key={m.asset} style={{ width: 28 }}><ChipArt collection={m.collection!} rarity={m.rarity!} /></span>)} <span className="muted">→ {rarityName(s.resultRarity ?? s.recipe?.to ?? 0)}</span></span>
            <button className="btn btn-sm" onClick={() => setSlots(s.materials!.slice(0, 3) as Chip[])}>Load</button>
          </div>
        ))}
        {suggest.data?.length === 0 && <div className="muted small">No safe triples yet — open more packs or buy duplicates.</div>}
      </div>

      <div className="card">
        <div className="strong" style={{ marginBottom: 8 }}>All recipes</div>
        <table className="table"><thead><tr><th>Step</th><th>Rule</th><th>Success</th><th>Fee</th><th>Lock</th></tr></thead><tbody>
          {FUSION_RECIPES.map((r) => <tr key={r.from}><td><span style={{ color: rarityColor(r.from) }}>{rarityName(r.from)}</span> → <span style={{ color: rarityColor(r.to) }}>{rarityName(r.to)}</span></td><td className="muted">{r.rule}</td><td className="mono">{fmtPct(r.successBps, 0)}</td><td className="mono">{fmtCg(r.feeCgMicro, 1)}</td><td className="muted">{secondsToHuman(r.resultLockSeconds)}</td></tr>)}
        </tbody></table>
      </div>

      <Modal open={pickFor !== null} onClose={() => setPickFor(null)} title={`Slot ${(pickFor ?? 0) + 1}`} wide>
        {pickFor !== null && (
          <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}>
            {slots[pickFor] && <div className="chip-card" onClick={() => { setSlots((s) => s.map((x, j) => (j === pickFor ? null : x))); setPickFor(null); }}><div className="slot" style={{ aspectRatio: 1, borderRadius: '50%', display: 'grid', placeItems: 'center' }}>✕</div><div className="chip-meta">clear</div></div>}
            {eligibleForSlot(pickFor).map((c) => (
              <div key={c.asset} className="chip-card" onClick={() => { setSlots((s) => s.map((x, j) => (j === pickFor ? c : x))); setPickFor(null); }}>
                <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} />
                <div className="chip-meta"><span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span> · {chipName(c.collection!, c.rarity!)}</div>
              </div>
            ))}
            {eligibleForSlot(pickFor).length === 0 && <div className="empty">No eligible caps for this slot.</div>}
          </div>
        )}
      </Modal>
    </div>
  );
}

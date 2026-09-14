// /verify/:signature — provably-fair verifier. Recomputes the pack roll
// locally from the 32 randomness bytes with the SAME code the program uses
// (golden-vector tested against the Rust implementation).
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQuery } from '@tanstack/react-query';
import { PACKS, expandRandomness, effectiveOdds } from '@guttercaps/economy';
import { usePackVerify } from '@/api/hooks';
import { findEvent } from '@/chain/anchor';
import { readPackOpened, type PackOpenedEvent } from '@/chain/accounts';
import { toEconPack, fetchGameConfig } from '@/chain/flows/packFlow';
import { RARITIES, chipName, rarityColor, rarityName, collectionName } from '@/shared/lib/rarity';
import { fmtPct, shortKey } from '@/shared/lib/format';
import { EXPLORER } from '@/app/config';
import { Skeleton } from '@/shared/ui/primitives';
import { ChipArt } from '@/shared/ui/ChipArt';
import { isMock } from '@/api/client';
import { useT } from '@/shared/i18n';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export default function Verify() {
  const t = useT();
  const { signature = '' } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(signature);
  const { connection } = useConnection();
  const api = usePackVerify(signature);

  // Independent path: read the transaction ourselves and decode PackOpened from logs.
  const chain = useQuery({
    queryKey: ['verify', 'chain', signature],
    enabled: !!signature && !isMock(),
    queryFn: async () => {
      const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx?.meta?.logMessages) throw new Error('Transaction not found');
      const ev = findEvent(tx.meta.logMessages, 'PackOpened', readPackOpened);
      if (!ev) throw new Error('No PackOpened event in this transaction');
      const cfg = await fetchGameConfig(connection);
      return { ev, cfg, slot: tx.slot };
    },
    retry: 1,
  });

  const local = useMemo(() => {
    const ev: PackOpenedEvent | undefined = chain.data?.ev;
    if (!ev || !chain.data) return null;
    const def = chain.data.cfg.packs[ev.sku];
    const econ = toEconPack(ev.sku, def);
    const pool = def.featuredOnly ? [chain.data.cfg.featuredCollection] : Array.from({ length: chain.data.cfg.collectionsCreated }, (_, i) => i);
    const rolls = expandRandomness(ev.roll, econ, ev.pityBefore, pool.length).map((r) => ({ rarity: r.rarity, collection: pool[r.collectionIdx] }));
    const onChain = ev.rarities.map((r, i) => ({ rarity: r, collection: ev.collections[i] }));
    const matches = rolls.length === onChain.length && rolls.every((r, i) => r.rarity === onChain[i].rarity && r.collection === onChain[i].collection);
    return { rolls, onChain, matches, odds: effectiveOdds(econ, ev.pityBefore), econ };
  }, [chain.data]);

  const data = local ?? (api.data ? {
    rolls: api.data.recomputed ?? [], onChain: api.data.onChain ?? [], matches: !!api.data.matches, odds: api.data.effectiveOddsBps ?? PACKS.standard.oddsBps as unknown as number[], econ: PACKS.standard,
  } : null);
  const rollHex = chain.data ? hex(chain.data.ev.roll) : api.data?.rollHex;
  const pity = chain.data?.ev.pityBefore ?? api.data?.pityBefore;

  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('verify.title')}</h1>
        <p className="page-sub">{t('verify.subtitle')}</p>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); nav(`/verify/${input.trim()}`); }}>
        <input className="input mono" placeholder="transaction signature" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn" type="submit">Verify</button>
      </form>

      {signature && (chain.isLoading || api.isLoading) && <Skeleton h={200} />}
      {signature && chain.error && api.error && <div className="danger">{String((chain.error as Error).message)} · backend: {String((api.error as Error).message)}</div>}

      {data && (
        <>
          <div className={data.matches ? 'ok' : 'danger'} style={{ fontSize: 15 }}>
            {data.matches ? '✓ Local recomputation matches the on-chain result.' : '✗ MISMATCH — the on-chain result does not follow from the randomness. Please report this.'}
          </div>
          <div className="card stack-sm">
            <div className="row between small"><span className="muted">Transaction</span><a className="mono" href={EXPLORER.tx(signature)} target="_blank" rel="noreferrer">{shortKey(signature, 8)} ↗</a></div>
            {chain.data && <div className="row between small"><span className="muted">Opened in slot</span><span className="mono">{chain.data.slot}</span></div>}
            <div className="row between small"><span className="muted">Pity before</span><span className="mono">{pity}</span></div>
            <div className="small muted">32 randomness bytes</div>
            <div className="verify-hex mono">{rollHex}</div>
          </div>

          <div className="card stack-sm">
            <div className="strong">Effective odds at that moment (per slot)</div>
            <div className="odds-legend">{data.odds.map((bps, r) => bps > 0 && <span key={r}><span style={{ color: rarityColor(r) }}>{RARITIES[r]}</span> {fmtPct(bps, 2)}</span>)}</div>
            <div className="tiny muted">Slot i: rarity = rollRarity(uniformBps(bytes, i)); collection = pool[bytes[(5i+4) mod 32] mod |pool|]; last slot gets the SKU floor and hard pity.</div>
          </div>

          <div className="card">
            <table className="table">
              <thead><tr><th>Slot</th><th>Recomputed here</th><th>On-chain event</th><th></th></tr></thead>
              <tbody>
                {data.rolls.map((r, i) => {
                  const o = data.onChain[i];
                  const ok = o && o.rarity === r.rarity && o.collection === r.collection;
                  return (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td><span className="row"><span style={{ width: 28 }}><ChipArt collection={r.collection!} rarity={r.rarity!} /></span><span style={{ color: rarityColor(r.rarity!) }}>{rarityName(r.rarity!)}</span> · {collectionName(r.collection!)}</span></td>
                      <td>{o ? <><span style={{ color: rarityColor(o.rarity!) }}>{rarityName(o.rarity!)}</span> · {chipName(o.collection!, o.rarity!)}</> : '—'}</td>
                      <td style={{ color: ok ? 'var(--cg-acid-green)' : 'var(--cg-neon-magenta)' }}>{ok ? '✓' : '✗'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <details className="card">
            <summary className="small">Verify independently (Node.js)</summary>
            <pre className="tiny mono" style={{ whiteSpace: 'pre-wrap' }}>{`git clone https://github.com/Leo88q/caps && cd caps/packages/economy && npm i
node --experimental-strip-types -e "
import('./src/index.ts').then(({ PACKS, expandRandomness }) => {
  const vrf = Uint8Array.from(Buffer.from('${rollHex ?? ''}', 'hex'));
  console.log(expandRandomness(vrf, PACKS.${(['starter', 'standard', 'premium', 'limited'] as const)[chain.data?.ev.sku ?? 1]}, ${pity ?? 0}, ${chain.data?.cfg.collectionsCreated ?? 10}));
})"`}</pre>
          </details>
        </>
      )}
    </div>
  );
}

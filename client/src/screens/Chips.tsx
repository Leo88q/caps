import { useEffect, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getProgram, rarityLabel, chipStatePda, listingPda, toLamports, configPda, questProgressPda } from '../lib/program';
import { SpillCanButton } from '../lib/buttons';
import './chip-physics.css';

// Idle pulse speed + glow intensity scale with rarity — power users can
// scan rarity from animation alone, per Block 8. Faster duration = more
// noticeable pulse; Common is nearly static, Diamond is unmistakable.
const RARITY_PHYSICS: Record<string, { duration: string; glow: string; size: string }> = {
  Common: { duration: '6s', glow: 'transparent', size: '0px' },
  'Common+': { duration: '5s', glow: 'rgba(154,154,154,0.3)', size: '3px' },
  Rare: { duration: '4.2s', glow: 'rgba(127,168,173,0.35)', size: '4px' },
  'Rare+': { duration: '3.6s', glow: 'rgba(127,147,176,0.4)', size: '5px' },
  Epic: { duration: '3s', glow: 'rgba(169,127,168,0.45)', size: '6px' },
  'Epic+': { duration: '2.5s', glow: 'rgba(185,143,106,0.5)', size: '7px' },
  Legend: { duration: '2.1s', glow: 'rgba(192,148,106,0.55)', size: '8px' },
  'Legend+': { duration: '1.7s', glow: 'rgba(163,185,127,0.6)', size: '9px' },
  Diamond: { duration: '1.3s', glow: 'rgba(199,199,204,0.7)', size: '11px' },
};

const DRAG_THRESHOLD_PX = 10;

interface ChipRow {
  publicKey: PublicKey;
  mint: PublicKey;
  rarity: string;
  level: number;
  index: number;
  staked: boolean;
}

interface DragState {
  mint: PublicKey;
  rarity: string;
  index: number;
  x: number;
  y: number;
}

export function ChipsScreen({ wallet }: { wallet: AnchorWallet }) {
  const { connection } = useConnection();
  const [chips, setChips] = useState<ChipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [peelingMint, setPeelingMint] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [overDropZone, setOverDropZone] = useState(false);
  const peelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    setLoading(true);
    const program = getProgram(connection, wallet);
    // Filtering to "chips this wallet owns" properly requires cross-referencing
    // token accounts owned by `wallet.publicKey` against each chip's mint —
    // omitted here for brevity; swap program.account.chipState.all() for a
    // getTokenAccountsByOwner scan + chipStatePda lookup per mint in production.
    const all = await program.account.chipState.all();
    setChips(
      all.map((a) => ({
        publicKey: a.publicKey,
        mint: a.account.mint,
        rarity: rarityLabel(a.account.rarity),
        level: a.account.level,
        index: a.account.index.toNumber(),
        staked: a.account.staked,
      })),
    );
    setLoading(false);
  }

  useEffect(() => { refresh(); }, [connection, wallet]);

  async function upgrade(chipMint: PublicKey, materialMint: PublicKey) {
    const program = getProgram(connection, wallet);
    const [chipState] = chipStatePda(chipMint);
    const [materialState] = chipStatePda(materialMint);
    // materialTokenAccount would be the caller's ATA for materialMint —
    // derive with getAssociatedTokenAddressSync in a full implementation.
    await program.methods
      .upgradeChip()
      .accounts({
        owner: wallet.publicKey,
        chipState,
        targetMint: chipMint,
        materialState,
        materialMint,
        questProgress: questProgressPda(wallet.publicKey)[0],
      })
      .rpc();
    refresh();
  }

  async function listChipForSale(chipMint: PublicKey, priceSol: number) {
    const program = getProgram(connection, wallet);
    const [config] = configPda();
    const [chipState] = chipStatePda(chipMint);
    const [listing] = listingPda(chipMint);
    const sellerTokenAccount = getAssociatedTokenAddressSync(chipMint, wallet.publicKey);
    const escrowTokenAccount = getAssociatedTokenAddressSync(chipMint, listing, true);
    await program.methods
      .listChip(toLamports(priceSol))
      .accounts({
        seller: wallet.publicKey,
        config,
        chipState,
        chipMint,
        sellerTokenAccount,
        escrowTokenAccount,
        listing,
        questProgress: questProgressPda(wallet.publicKey)[0],
      })
      .rpc();
    refresh();
  }

  // --- Drag-to-sell lifecycle ---
  // 1. pointerdown starts a peel timer (Block 8 "getting ready" cue).
  // 2. Once peeling, if the pointer moves past DRAG_THRESHOLD_PX before
  //    release, it becomes a real drag: the card renders as a ghost outline
  //    in place, and a floating preview follows the pointer.
  // 3. pointerup checks whether the release point overlaps the sell drop
  //    zone's bounding rect. Inside it → prompt for a price and list the
  //    chip for sale. Outside it → the card just snaps back (state clears).
  function onCardPointerDown(chip: ChipRow, e: React.PointerEvent) {
    if (chip.staked) return;
    pressOrigin.current = { x: e.clientX, y: e.clientY };
    peelTimer.current = setTimeout(() => setPeelingMint(chip.mint.toBase58()), 220);
  }

  function onCardPointerMove(chip: ChipRow, e: React.PointerEvent) {
    if (chip.staked || !pressOrigin.current) return;
    const dx = e.clientX - pressOrigin.current.x;
    const dy = e.clientY - pressOrigin.current.y;
    if (!drag && peelingMint === chip.mint.toBase58() && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      setDrag({ mint: chip.mint, rarity: chip.rarity, index: chip.index, x: e.clientX, y: e.clientY });
    }
  }

  function onWindowPointerMove(e: PointerEvent) {
    setDrag((current) => {
      if (!current) return current;
      const zoneRect = dropZoneRef.current?.getBoundingClientRect();
      const inside = !!zoneRect
        && e.clientX >= zoneRect.left && e.clientX <= zoneRect.right
        && e.clientY >= zoneRect.top && e.clientY <= zoneRect.bottom;
      setOverDropZone(inside);
      return { ...current, x: e.clientX, y: e.clientY };
    });
  }

  function onWindowPointerUp() {
    if (peelTimer.current) clearTimeout(peelTimer.current);
    pressOrigin.current = null;

    if (drag && overDropZone) {
      const priceInput = window.prompt(`List chip #${drag.index} (${drag.rarity}) for how many SOL?`, '1');
      const price = priceInput ? parseFloat(priceInput) : NaN;
      if (!Number.isNaN(price) && price > 0) {
        listChipForSale(drag.mint, price);
      }
    }
    setDrag(null);
    setOverDropZone(false);
    setPeelingMint(null);
  }

  useEffect(() => {
    if (!drag) return;
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, overDropZone]);

  function endPeelIfNotDragging() {
    if (drag) return; // window listener owns cleanup once a real drag started
    if (peelTimer.current) clearTimeout(peelTimer.current);
    pressOrigin.current = null;
    setPeelingMint(null);
  }

  if (loading) return <p style={{ padding: 16 }}>Загрузка…</p>;

  return (
    <div style={{ padding: 16, position: 'relative' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {chips.map((chip, i) => {
          const physics = RARITY_PHYSICS[chip.rarity] ?? RARITY_PHYSICS.Common;
          const isDraggingThis = drag?.mint.toBase58() === chip.mint.toBase58();
          return (
            <div
              key={chip.publicKey.toBase58()}
              className={`chip-card chip-card-glow ${peelingMint === chip.mint.toBase58() ? 'chip-peeling' : ''} ${isDraggingThis ? 'chip-drag-ghost' : ''}`}
              style={{
                '--float-duration': physics.duration,
                '--glow-color': physics.glow,
                '--glow-size': physics.size,
                '--float-tilt': `${(i % 2 === 0 ? 1 : -1) * 0.6}deg`,
                animationDelay: `-${(i * 0.4).toFixed(1)}s`,
                touchAction: 'none',
              } as React.CSSProperties}
              onPointerDown={(e) => onCardPointerDown(chip, e)}
              onPointerMove={(e) => onCardPointerMove(chip, e)}
              onPointerUp={endPeelIfNotDragging}
              onPointerLeave={endPeelIfNotDragging}
            >
              <p style={{ fontSize: 11, color: '#888', margin: 0 }}>#{chip.index}</p>
              <p style={{ fontWeight: 500, margin: '4px 0' }}>{chip.rarity}</p>
              <p style={{ fontSize: 12, color: '#888', margin: 0 }}>Уровень {chip.level}{chip.staked ? ' · в стейкинге' : ''}</p>
              {!chip.staked && (
                <SpillCanButton
                  style={{ width: '100%', marginTop: 8, fontSize: 12, padding: '8px 10px' }}
                  onClick={() => upgrade(chip.mint, chip.mint /* pick a real material chip in the UI */)}
                >
                  Прокачать
                </SpillCanButton>
              )}
              {!chip.staked && (
                <p style={{ fontSize: 10, color: '#555', margin: '6px 0 0' }}>Удерживайте и тащите вниз, чтобы продать</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Drop zone: only rendered while an actual drag is in progress. */}
      {drag && (
        <div
          ref={dropZoneRef}
          className="chip-drop-zone"
          style={{
            position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 50,
            borderColor: overDropZone ? 'var(--cg-acid-green)' : 'rgba(216,216,220,0.3)',
            background: overDropZone ? 'rgba(182,255,60,0.12)' : 'rgba(0,0,0,0.6)',
          }}
        >
          Отпустите здесь, чтобы выставить #{drag.index} на продажу
        </div>
      )}

      {/* Floating drag preview follows the pointer. */}
      {drag && (
        <div
          className="chip-drag-preview"
          style={{ left: drag.x, top: drag.y }}
        >
          #{drag.index}
          <br />{drag.rarity}
        </div>
      )}
    </div>
  );
}

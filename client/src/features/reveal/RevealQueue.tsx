// Global reveal overlay: plays the existing PackRevealAnimation for every
// item in ui.revealQueue, one at a time. Fed by the pack flow, fusion flow
// and quest chip rewards. Reduced-motion collapses to the final card.
import { useCallback } from 'react';
import { useUiStore } from '@/app/store/ui';
import { PackRevealAnimation } from './PackRevealAnimation';
import { chipName, rarityName, chipArtUrl } from '@/shared/lib/rarity';
import { ChipArt } from '@/shared/ui/ChipArt';

export function RevealQueue() {
  const queue = useUiStore((s) => s.revealQueue);
  const shift = useUiStore((s) => s.shiftReveal);
  const reduced = useUiStore((s) => s.reducedMotion);
  const instant = useUiStore((s) => s.instantReveal);
  const head = queue[0];
  const done = useCallback(() => shift(), [shift]);
  if (!head) return null;

  if (reduced || instant) {
    return (
      <div className="modal-backdrop" onClick={done} style={{ zIndex: 90 }}>
        <div className="modal center stack" onClick={(e) => e.stopPropagation()}>
          <div style={{ width: 270, margin: '0 auto' }}><ChipArt collection={head.collectionIdx} rarity={head.rarity} index={head.index} level={head.level} imageUrl={chipArtUrl(head.collectionIdx, head.rarity, 512)} /></div>
          <div className="cg-heading" style={{ fontSize: 22 }}>{chipName(head.collectionIdx, head.rarity)}</div>
          <div className="muted">{rarityName(head.rarity)}{head.fused ? ' · fused' : ''} · {queue.length - 1} more</div>
          <button className="btn btn-block" onClick={done}>Next</button>
        </div>
      </div>
    );
  }

  return (
    <PackRevealAnimation
      key={head.id}
      rarity={rarityName(head.rarity)}
      chipName={chipName(head.collectionIdx, head.rarity)}
      chipArt={<ChipArt collection={head.collectionIdx} rarity={head.rarity} index={head.index} level={head.level} imageUrl={chipArtUrl(head.collectionIdx, head.rarity, 512)} />}
      isOnChain
      remaining={queue.length - 1}
      onDone={done}
    />
  );
}

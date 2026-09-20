import { ChipArt } from './ChipArt';
import { chipArtUrl } from '../lib/rarity';

/** A centered row of real cap discs for hero / disconnected states.
 *  Zero new bytes: deterministic local masters (`/art/…`), same as the Codex. */
export function ShowcaseStrip({ items, size = 72 }: { items: [collection: number, rarity: number][]; size?: number }) {
  return (
    <div className="showcase" aria-hidden>
      {items.map(([ci, ri]) => (
        <span key={`${ci}-${ri}`} style={{ width: size }}>
          <ChipArt collection={ci} rarity={ri} imageUrl={chipArtUrl(ci, ri, size > 100 ? 512 : 256)} />
        </span>
      ))}
    </div>
  );
}

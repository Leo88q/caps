// One-line wrapper for the generated spray-stencil badges
// (client/public/icons/gen/*.webp). Keeps call sites readable:
// <GenBadge name="mech-fusion" size={28} />.
interface Props {
  /** file name under /icons/gen without the extension */
  name: string;
  size?: number;
  className?: string;
}

export function GenBadge({ name, size = 24, className }: Props) {
  return (
    <img
      src={`/icons/gen/${name}.webp`}
      width={size}
      height={size}
      alt=""
      aria-hidden
      loading="eager"
      decoding="async"
      className={`gic ${className ?? ''}`}
    />
  );
}

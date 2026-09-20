// SVG filter defs behind street-kit.css — mounted once at the app root:
//   #st-goo         paint-drip coalescing (buttons, .st-drip)
//   #st-spray       rough spray-paint edges (frames, stickers, paint buttons)
//   #st-spray-lite  cheaper pass for stencil corners
// NOTE (stand-in): these are standard textbook recipes with the exact IDs the
// kit expects. When the real street-filters.html lands, replace the three
// <filter> bodies 1:1 — no CSS or TSX changes needed.
export function StreetFilters() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden focusable="false">
      <defs>
        <filter id="st-goo" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b" />
          <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" />
        </filter>
        <filter id="st-spray" x="-40%" y="-40%" width="180%" height="180%">
          <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="7" result="warp" />
          <feDisplacementMap in="SourceGraphic" in2="warp" scale="6" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="st-spray-lite" x="-40%" y="-40%" width="180%" height="180%">
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="3" result="warp" />
          <feDisplacementMap in="SourceGraphic" in2="warp" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}

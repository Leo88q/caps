#!/usr/bin/env python3
"""P1 rim-ladder fix (docs/07-art-spec.md §3) — one-shot, zone-limited.

Three chips whose rim material violates the §3 ladder:
  02-4  Epic      rim is gray  (s 3.9)  -> magenta enamel  (family s 44–72)
  02-2  Rare      rim is pink  (s 49.5) -> polished steel  (family s 0.3–1.8)
  03-3  Rare+     rim is gray  (s 2.6)  -> steel petrol    (family s 23–29)

Only the rim band (92–100 % of the disc radius, feathered 1.5 % inwards) is
touched; the story zone and the per-pixel luminance texture are preserved.
Pre-images: art_drafts/raw/{key}_v4.png (first run creates them).
"""
from __future__ import annotations

import colorsys
import math
import os
import shutil
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C, R = 1024.0, 896.0
FEATHER = (0.905, 0.92)  # blend band inside the rim edge

FIXES = {
    '02-4': {'h': 0.885, 's': 0.66, 'vmul': 0.86},   # magenta enamel
    '02-2': {'h': None,   's': 0.06, 'vmul': 1.00},  # neutral steel (desaturate)
    '03-3': {'h': 0.545, 's': 0.28, 'vmul': 0.95},   # petrol
}


def w_of(rr: float) -> float:
    """1 inside the rim band, feathered to 0 across FEATHER..(inwards)."""
    if rr >= FEATHER[1]:
        return 1.0
    if rr <= FEATHER[0]:
        return 0.0
    return (rr - FEATHER[0]) / (FEATHER[1] - FEATHER[0])


def main() -> int:
    for key, p in FIXES.items():
        src = os.path.join(ROOT, 'art_drafts', 'master', f'{key}.png')
        bak = os.path.join(ROOT, 'art_drafts', 'raw', f'{key}_v4.png')
        if not os.path.exists(bak):
            shutil.copy(src, bak)
        im = Image.open(src).convert('RGBA')
        px = im.load()
        for y in range(0, 2048):
            for x in range(0, 2048):
                rr = math.hypot(x + 0.5 - C, y + 0.5 - C) / R
                if rr < FEATHER[0] or rr >= 1.0:
                    continue
                r, g, b, a = px[x, y]
                if a != 255:
                    continue
                h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                if p['h'] is not None:
                    h = p['h']
                s2 = max(s, p['s']) if p['h'] is not None else p['s']
                v2 = min(1.0, v * p['vmul'])
                nr, ng, nb = colorsys.hsv_to_rgb(h, s2, v2)
                w = w_of(rr)
                px[x, y] = (round(r + (nr * 255 - r) * w),
                            round(g + (ng * 255 - g) * w),
                            round(b + (nb * 255 - b) * w), a)
        im.save(src)
        print(f'{key}: rim fixed (backup raw/{key}_v4.png)')
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""District recolor toward lore.ts palette (owner decision, 2026-09-25).

Art question #3 of art_regeneration_plan.md §6 was "edit lore.ts or repaint the
frames?" — owner picked: repaint. Districts 01 (yellow→cyan), 02 (gray→orange)
and 06 (neutral→cyan) get a luminance-preserving duotone shift inside the disc:
  * story zone (0–70 % R): full strength
  * texture ring (70–92 % R): reduced strength
  * rim (92–100 % R): untouched — the §3 tier ladder must survive
Originals are backed up once as art_drafts/raw/{key}_v3.png. Deterministic,
idempotent (safe to re-run: it recolors from the backup, not from itself).

Usage: python3 scripts/art-recolor-districts.py            # all 27 masters
       python3 scripts/art-recolor-districts.py 01 06      # subset
"""
from __future__ import annotations

import colorsys
import math
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageStat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(ROOT, 'art_drafts', 'master')
RAW = os.path.join(ROOT, 'art_drafts', 'raw')

R = 896.0
TARGET = {
    '01': ((22, 229, 217), 0.70),   # cyan  #16E5D9 (lore), strong shift from yellow
    '02': ((255, 122, 26), 0.60),   # orange #FF7A1A (lore), gray scenes get the cast
    '06': ((22, 229, 217), 0.55),   # cyan  #16E5D9 (lore), neutral scenes
}
ZONES = ((0.70, 1.00), (0.92, 0.45), (1.00, 0.0))  # (r_frac, strength) — first match wins


def zone_mask() -> Image.Image:
    """Radial strength ramp: story (0–0.70 R) = 255, texture (→0.92 R) → 150,
    hard 0 outside 0.93 R (the rim keeps its §3 material)."""
    import numpy as np
    yy, xx = np.mgrid[0:2048, 0:2048]
    r = np.hypot(xx + 0.5 - 1024, yy + 0.5 - 1024) / R
    a = np.interp(r, [0.0, 0.70, 0.92, 0.93], [255.0, 255.0, 150.0, 0.0], right=0.0)
    m = Image.fromarray(a.astype('uint8'), 'L').filter(ImageFilter.GaussianBlur(2))
    return m


def tint_lut(color: tuple[int, int, int]):
    """L -> RGB duotone map: 0 -> #16151A, mid -> district colour, 255 -> pale tint."""
    lo, mid = (22, 21, 26), color
    luts = []
    for ch in range(3):
        lut = []
        for L in range(256):
            t = L / 255.0
            if t < 0.55:
                k = t / 0.55
                v = lo[ch] + (mid[ch] - lo[ch]) * (k ** 0.85)
            else:
                k = (t - 0.55) / 0.45
                hi = min(255, mid[ch] + 120)
                v = mid[ch] + (hi - mid[ch]) * (k ** 1.1)
            lut.append(max(0, min(255, round(v))))
        luts += lut
    return luts


def rim_rgb(im: Image.Image):
    px = im.load()
    acc, n = [0, 0, 0], 0
    for y in range(0, 2048, 4):
        for x in range(0, 2048, 4):
            rr = math.hypot(x + 0.5 - 1024, y + 0.5 - 1024) / R
            if 0.92 <= rr < 1.0:
                r, g, b, a = px[x, y]
                if a > 250:
                    acc[0] += r; acc[1] += g; acc[2] += b; n += 1
    return tuple(round(v / n) for v in acc)


def story_stats(path: str):
    im = Image.open(path).convert('RGBA')
    px = im.load()
    hist = [0] * 12
    tot = 0
    for y in range(0, 2048, 6):
        for x in range(0, 2048, 6):
            rr = math.hypot(x + 0.5 - 1024, y + 0.5 - 1024) / R
            if not (0.30 <= rr < 0.70):
                continue
            r, g, b, a = px[x, y]
            if a <= 250:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if s < 0.12 or v < 0.08:
                continue
            hist[int(h * 12) % 12] += 1
            tot += 1
    top = max(range(12), key=hist.__getitem__) if tot else -1
    return top, round(100 * (hist[top] / tot), 1) if tot else 0.0


def main() -> int:
    subset = set(sys.argv[1:]) or set(TARGET)
    MASK = zone_mask()
    print(f'{"key":6} {"hue_bin":14} {"rim":18} lum')
    for dist, (color, _) in sorted(TARGET.items()):
        if dist not in subset:
            continue
        target_bin = {  # hue bins: cyan ≈ 5 (150–180°), orange ≈ 1 (30–60°)
            (22, 229, 217): 5, (255, 122, 26): 1,
        }[color]
        for t in range(9):
            key = f'{dist}-{t}'
            src = os.path.join(M, f'{key}.png')
            backup = os.path.join(RAW, f'{key}_v3.png')
            if not os.path.exists(backup):
                shutil.copy(src, backup)
            orig = Image.open(backup).convert('RGBA')  # always from the backup
            before = story_stats(backup)
            # luminance -> district duotone (per-channel LUTs applied to the L plane)
            gray = orig.convert('L')
            if dist == '01':
                # District 01 was light-ochre overall; lore wants dark asphalt + cyan moth.
                # Compress tones: ochre field (~L 90-110) falls to dark asphalt,
                # the bright stencil (~L 200+) stays a glowing cyan.
                gray = gray.point(lambda v: max(0, min(255, round((v - 55) * 1.6))))
            luts = tint_lut(color)
            tinted = Image.merge('RGB', [gray.point(luts[ch * 256:(ch + 1) * 256]) for ch in range(3)])
            strength = TARGET[dist][1]
            smask = MASK.point(lambda v, s=strength: round(v * s))
            out = Image.composite(tinted, orig.convert('RGB'), smask)
            out = out.convert('RGBA')
            out.putalpha(orig.getchannel('A'))
            out.save(src)
            after = story_stats(src)
            rim = rim_rgb(out)
            lum = round(ImageStat.Stat(out.convert('L')).mean[0], 1)
            mark = '✅' if after[0] == target_bin and before[0] != target_bin else (' =' if before[0] == target_bin else '🟡')
            print(f'{key:6} {before[0]}→{after[0]} {after[1]:>4}% {mark} rim={rim} lum={lum}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

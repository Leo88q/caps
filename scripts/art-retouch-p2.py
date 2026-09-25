#!/usr/bin/env python3
"""P2 art retouch (reports/ASSET-INVENTORY-2026-09-25.md §9, items 5-6).

5. Legend (tier 6, all districts) + 03-7: raise brightness/contrast — Legend was
   the flattest, darkest tier (03-6 p10 = 2/255 ≈ black at 56 px).
6. Diamond (tier 8, all districts): the rim must read chrome/holo + cyan (§3);
   it was grey #56556A…#838988, indistinguishable from Rare steel.

One-shot: NOT idempotent — to redo, `git checkout` the masters first, then run.
Both edits are in-place on art_drafts/master/*.png (git-tracked → revertible),
keep the disc alpha binary and never touch the story zone of Diamond cards
(only the 0.90–1.00 R rim band is recoloured, luminance structure preserved).
"""
import colorsys
import math
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(ROOT, 'art_drafts', 'master')
C, R = 1024.0, 896.0

DISTRICTS = ['01', '02', '03', '04', '05', '06', '07', '10']


def lift_legend(path: str) -> None:
    """Gamma 0.82 + mild S-contrast on RGB; alpha untouched (binary)."""
    im = Image.open(path).convert('RGBA')
    arr = np.asarray(im, dtype=np.float32)
    rgb = arr[..., :3] / 255.0
    rgb = np.clip((rgb ** 0.82 - 0.5) * 1.10 + 0.515, 0, 1) * 255.0
    arr[..., :3] = rgb
    Image.fromarray(arr.astype('uint8'), 'RGBA').save(path)


def holo_rim(path: str) -> None:
    """Recolour the 0.90–1.00 R rim band: chrome-ice iridescence (§3 Diamond).

    Value (texture/shading) is kept from the original; hue/saturation are
    replaced with an angular cyan↔azure sweep plus a faint magenta flash —
    reads as holographic foil while staying inside the no-trust-blue rule
    (#2E8BFF avoided: hue 195–215°, not 210+ saturated blue).
    """
    im = Image.open(path).convert('RGBA')
    arr = np.asarray(im, dtype=np.float32) / 255.0
    h_px, w_px = arr.shape[:2]
    yy, xx = np.mgrid[0:h_px, 0:w_px].astype(np.float32)
    rr = np.hypot(xx - C, yy - C) / R

    band = np.clip((rr - 0.895) / 0.035, 0, 1) * np.clip((0.998 - rr) / 0.012, 0, 1)
    theta = np.arctan2(yy - C, xx - C)

    v = arr[..., 0] * 0.2126 + arr[..., 1] * 0.7152 + arr[..., 2] * 0.0722
    v = np.clip(v * 1.28 + 0.05, 0, 1)  # chrome needs luminance headroom

    hue = 195.0 + 22.0 * np.sin(3 * theta + 0.8) + 6.0 * np.sin(7 * theta)
    sat = 0.42 + 0.16 * np.sin(2 * theta + 2.1)
    # faint magenta flash on two sectors — the 'holo' tell
    flash = np.clip(np.cos(theta - 0.9), 0, 1) ** 6 + np.clip(np.cos(theta - 4.1), 0, 1) ** 6
    hue = np.where(flash > 0.5, 305.0 - (305.0 - hue) * 0.55, hue)
    sat = np.where(flash > 0.5, sat * 0.8 + 0.10, sat)

    hh = (hue / 360.0).astype(np.float64)
    ss = np.clip(sat, 0, 1).astype(np.float64).ravel()
    vv = np.clip(v, 0, 1).astype(np.float64).ravel()
    rgb = np.zeros((hh.size, 3))
    flat_h = hh.ravel()
    for i in range(flat_h.size):
        rgb[i] = colorsys.hsv_to_rgb(flat_h[i], ss[i], vv[i])
    rgb = rgb.reshape(h_px, w_px, 3).astype(np.float32)

    w = band[..., None]
    mixed = arr[..., :3] * (1 - w) + rgb * w
    arr[..., :3] = mixed
    out = Image.fromarray((arr * 255).astype('uint8'), 'RGBA')
    out.save(path)


def rim_stats(path: str) -> tuple:
    im = Image.open(path).convert('RGBA')
    arr = np.asarray(im, dtype=np.float32)
    yy, xx = np.mgrid[0:arr.shape[0], 0:arr.shape[1]].astype(np.float32)
    rr = np.hypot(xx - C, yy - C) / R
    m = (rr >= 0.92) & (rr < 1.0) & (arr[..., 3] > 250)
    px = arr[m][:, :3]
    mx = px.max(axis=1)
    mn = px.min(axis=1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0).mean() * 100
    return px.mean(axis=0).round(1).tolist(), round(float(sat), 1)


if __name__ == '__main__':
    print('== tier 6 + 03-7 lift ==')
    for d in DISTRICTS:
        p = os.path.join(M, f'{d}-6.png')
        before = rim_stats(p)
        lift_legend(p)
        print(f'  {d}-6 rim {before} -> {rim_stats(p)}')
    p = os.path.join(M, '03-7.png')
    lift_legend(p)
    print('  03-7 lifted')
    print('== tier 8 holo rim ==')
    for d in DISTRICTS:
        p = os.path.join(M, f'{d}-8.png')
        before = rim_stats(p)
        holo_rim(p)
        print(f'  {d}-8 rim {before} -> {rim_stats(p)}')

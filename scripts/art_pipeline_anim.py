#!/usr/bin/env python3
"""animation_url loops for tiers 6-8 (docs/07-art-spec.md §4).

Spec allows the loops to be made "процедурно из мастера" (procedurally from the
master) — which is exactly what this does: the 2048² collector card is the base,
a soft specular sweep rotates over the disc (bronze tiers), Diamond additionally
gets a slow cyan/magenta holo shimmer. 48 frames @ 30 fps = 1.6 s, first frame ==
frame N (the sweep band is symmetric under 180°), so the loop is seamless.

Output: exports/cdn/nft/{d}-{r}.webm (VP9) + .mp4 (H.264), 1024², <= 1.5 MB.
ffmpeg binary comes from the `imageio-ffmpeg` pip package (no apt in this env).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
FPS = 30
FRAMES = 48                       # 1.6 s — spec allows <= 3 s
BUDGET = 1_500_000                # 1.5 MB per file
CYAN = (22, 229, 217)
MAGENTA = (255, 46, 138)


def disc_mask(size: int) -> Image.Image:
    """Soft-edged circular mask at 76 % of the card (same disc as the card recipe)."""
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    c, r = size // 2, round(size * 0.76 / 2)
    d.ellipse((c - r, c - r, c + r, c + r), fill=255)
    return m.filter(ImageFilter.GaussianBlur(3))


def sweep_band(size: int, width: float, alpha: int, shift: float) -> Image.Image:
    """A soft diagonal band through the centre; `shift` moves it off-centre."""
    band = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(band)
    c = size / 2
    # band runs at 45°: draw as a rotated thick line via polygon
    off = shift * size
    w = width * size / 2
    d.polygon([(c - w - off, -size), (c + w - off, -size),
               (c + w + off, 2 * size), (c - w + off, 2 * size)], fill=alpha)
    band = band.filter(ImageFilter.GaussianBlur(size * 0.06))
    rgba = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    rgba.putalpha(band)
    return rgba


def tint_band(size: int, color: tuple[int, int, int], width: float, alpha: int, shift: float) -> Image.Image:
    band = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(band)
    c = size / 2
    off = shift * size
    w = width * size / 2
    d.polygon([(c - w - off, -size), (c + w - off, -size),
               (c + w + off, 2 * size), (c - w + off, 2 * size)], fill=alpha)
    band = band.filter(ImageFilter.GaussianBlur(size * 0.10))
    rgba = Image.new('RGBA', (size, size), color + (0,))
    rgba.putalpha(band)
    return rgba


def frame(base: Image.Image, mask: Image.Image, t: float, tier: int) -> Image.Image:
    """t in [0,1) — loop phase. Bronze: one white sweep; Diamond adds holo shimmer."""
    theta = t * 360.0
    im = base.copy()
    sweep = sweep_band(SIZE, 0.34, 56 if tier < 8 else 44, 0.0).rotate(theta, resample=Image.BICUBIC)
    sweep.putalpha(Image.composite(sweep.getchannel('A'), Image.new('L', (SIZE, SIZE), 0), mask))
    im.alpha_composite(sweep)
    if tier >= 8:
        for color, speed, shift in ((CYAN, 0.5, -0.18), (MAGENTA, 1.0, 0.18)):
            tb = tint_band(SIZE, color, 0.30, 40, shift).rotate(
                (t * speed % 1.0) * 360.0, resample=Image.BICUBIC)
            tb.putalpha(Image.composite(tb.getchannel('A'), Image.new('L', (SIZE, SIZE), 0), mask))
            im.alpha_composite(tb)
    return im


def encode(ffmpeg: str, frames_dir: str, out_base: str) -> list[str]:
    problems = []
    common = ['-framerate', str(FPS), '-start_number', '0',
              '-i', os.path.join(frames_dir, 'f%03d.png'), '-an']
    webm = os.path.join(out_base + '.webm')
    mp4 = os.path.join(out_base + '.mp4')
    r1 = subprocess.run([ffmpeg, *common, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0',
                         '-pix_fmt', 'yuv420p', '-y', webm], capture_output=True, text=True)
    r2 = subprocess.run([ffmpeg, *common, '-c:v', 'libx264', '-crf', '27', '-pix_fmt', 'yuv420p',
                         '-movflags', '+faststart', '-y', mp4], capture_output=True, text=True)
    for r, fp in ((r1, webm), (r2, mp4)):
        if r.returncode != 0:
            problems.append(f'{fp}: ffmpeg exit {r.returncode}: {r.stderr[-300:]}')
        elif os.path.getsize(fp) > BUDGET:
            problems.append(f'{fp}: {os.path.getsize(fp)} B > 1.5 MB')
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--params', required=True)
    args = ap.parse_args()
    P = json.load(open(args.params))
    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:
        print(f'imageio-ffmpeg not available: {e}\n  pip install imageio-ffmpeg', file=sys.stderr)
        return 3

    problems: list[str] = []
    made = 0
    with tempfile.TemporaryDirectory() as tmp:
        for chip in P['chips']:
            card_path = os.path.join(P['card_dir'], f"{chip['key']}.png")
            if not os.path.exists(card_path):
                problems.append(f"missing card {chip['key']}")
                continue
            base = Image.open(card_path).convert('RGBA').resize((SIZE, SIZE), Image.LANCZOS)
            mask = disc_mask(SIZE)
            frames_dir = os.path.join(tmp, 'frames')
            os.makedirs(frames_dir, exist_ok=True)
            for i in range(FRAMES):
                frame(base, mask, i / FRAMES, chip['tier']).convert('RGB').save(
                    os.path.join(frames_dir, f'f{i:03d}.png'), compress_level=1)
            problems += encode(ffmpeg, frames_dir, os.path.join(P['out_dir'], chip['key']))
            made += 1

    print(f'animation: {made} chips encoded (webm+mp4)')
    if problems:
        print('ANIMATION PROBLEMS:', file=sys.stderr)
        for p in problems:
            print(' ', p, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())

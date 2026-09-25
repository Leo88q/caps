#!/usr/bin/env python3
"""Portfolio exports that are NOT part of the 72-chip pipeline (docs/07 §4/§6).

Regenerates the gitignored exports/cdn sub-trees from committed sources:
  covers/{num}.png 2048² + covers/{num}-1500x500.jpg   <- art_drafts/covers/
  packs/{sku}.png 1536×2048                            <- art_drafts/packs/
  collection/hero-2048.png + hero-1500x500.jpg         <- art_drafts/site/collection-hero-src.png
  tokens/* (mirror of client/public/tokens)            <- wallet / exchange listings

Run standalone (`python3 scripts/export-portfolio.py`) or via
`npm run assets:portfolio`; `npm run assets:pipeline -- --animation` covers the
chip exports (game/nft/og/m).
"""
from __future__ import annotations

import os
import shutil
import sys

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CDN = os.path.join(ROOT, 'exports', 'cdn')
DISTRICTS = ('01', '02', '03', '04', '05', '06', '07', '10')
PACKS = ('starter', 'standard', 'premium', 'limited')


def upscale(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    up = im.resize(size, Image.LANCZOS)
    return up.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))


def banner_from(sq: Image.Image, y_bias: int = 0) -> Image.Image:
    """1500×500 center crop of a square; y_bias shifts the window (px, + = down)."""
    w, h = sq.size
    ch = round(w * 500 / 1500)
    y0 = min(h - ch, max(0, (h - ch) // 2 + y_bias))
    return sq.crop((0, y0, w, y0 + ch)).resize((1500, 500), Image.LANCZOS)


def main() -> int:
    made = 0

    # covers
    os.makedirs(os.path.join(CDN, 'covers'), exist_ok=True)
    for n in DISTRICTS:
        src = os.path.join(ROOT, 'art_drafts', 'covers', f'{n}.png')
        if not os.path.exists(src):
            print(f'cover source missing: {src}', file=sys.stderr)
            return 2
        up = upscale(Image.open(src).convert('RGB'), (2048, 2048))
        up.save(os.path.join(CDN, 'covers', f'{n}.png'), optimize=True)
        banner_from(up).save(os.path.join(CDN, 'covers', f'{n}-1500x500.jpg'),
                             quality=86, optimize=True)
        made += 2

    # packs
    os.makedirs(os.path.join(CDN, 'packs'), exist_ok=True)
    for sku in PACKS:
        src = os.path.join(ROOT, 'art_drafts', 'packs', f'{sku}.png')
        if not os.path.exists(src):
            print(f'pack source missing: {src}', file=sys.stderr)
            return 2
        upscale(Image.open(src).convert('RGB'), (1536, 2048)).save(
            os.path.join(CDN, 'packs', f'{sku}.png'), optimize=True)
        made += 1

    # collection hero (маркетплейс-главная коллекции)
    os.makedirs(os.path.join(CDN, 'collection'), exist_ok=True)
    src = os.path.join(ROOT, 'art_drafts', 'site', 'collection-hero-src.png')
    if not os.path.exists(src):
        print(f'hero source missing: {src}', file=sys.stderr)
        return 2
    sq = upscale(Image.open(src).convert('RGB'), (2048, 2048))
    # unsharp harder for the hero: it is the first thing a buyer sees
    sq = sq.filter(ImageFilter.UnsharpMask(radius=2, percent=70, threshold=2))
    sq.save(os.path.join(CDN, 'collection', 'hero-2048.png'), optimize=True)
    # caps sit low in the source frame -> bias the banner window down
    banner_from(sq, y_bias=120).save(os.path.join(CDN, 'collection', 'hero-1500x500.jpg'),
                                     quality=88, optimize=True)
    made += 2

    # tokens: mirror client/public/tokens (wallet + exchange listing sizes)
    os.makedirs(os.path.join(CDN, 'tokens'), exist_ok=True)
    tdir = os.path.join(ROOT, 'client', 'public', 'tokens')
    for f in sorted(os.listdir(tdir)):
        shutil.copy(os.path.join(tdir, f), os.path.join(CDN, 'tokens', f))
        made += 1

    print(f'portfolio exports ok: {made} files -> exports/cdn/{{covers,packs,collection,tokens}}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

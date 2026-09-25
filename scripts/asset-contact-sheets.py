#!/usr/bin/env python3
"""Contact sheets for owner review (reports/ASSET-INVENTORY-2026-09-25.md §10).

  reports/contact-masters.png — all 72 masters at 150 px (9 × 8 grid, labelled)
  reports/contact-56.png      — the §2.1 legibility test at 56 px
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(ROOT, 'art_drafts', 'master')
OUT = os.path.join(ROOT, 'reports')
DISTRICTS = ['01', '02', '03', '04', '05', '06', '07', '10']
TIERS = ['C', 'C+', 'R', 'R+', 'E', 'E+', 'L', 'L+', 'D']


def sheet(size: int, path: str) -> None:
    pad, label = 8, 14 if size >= 100 else 0
    cell = size + pad
    W, H = 9 * cell + pad, 8 * (cell + label) + pad
    col = Image.new('RGB', (W, H), (22, 21, 26))
    d = ImageDraw.Draw(col)
    for r, dist in enumerate(DISTRICTS):
        for t in range(9):
            k = f'{dist}-{t}'
            im = Image.open(os.path.join(M, f'{k}.png')).resize((size, size), Image.LANCZOS)
            x, y = pad + t * cell, pad + r * (cell + label)
            col.paste(im, (x, y), im)
            if label:
                d.text((x + 2, y + size + 1), f'{dist}·{TIERS[t]}', fill=(200, 200, 205))
    col.save(path, optimize=True)
    print(path, f'{os.path.getsize(path) // 1024} KB')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    sheet(150, os.path.join(OUT, 'contact-masters.png'))
    sheet(56, os.path.join(OUT, 'contact-56.png'))

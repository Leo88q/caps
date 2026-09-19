#!/usr/bin/env python3
"""Robust cut of generator drafts to master format per docs/07-art-spec.md §1.

Handles the two draft styles the image generator produces:
  - light/gray flat background (disc darker or brighter than bg)
  - black flat background with a dark disc face (bbox underestimates nothing
    bright, but the disc edge can be a soft dark gradient)
Cut rule: scale so the disc FILLS the master mask (r=896). Radius source is
min(bbox_radius, p10 of per-angle content radii) — p10 instead of p0 keeps one
noisy angle from over-zooming, and it still closes background slivers.

Usage: python3 make_master_robust.py IN.png OUT.png
Prints QA metrics as TSV (superset of make_master.py output).
"""
import math
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

CANVAS = 2048
R_MASTER = 896  # diameter 1792 = 87.5% of canvas
CONTENT_THR = 12  # per-channel diff from bg that counts as disc content


def bg_of(rgb: Image.Image):
    w, h = rgb.size
    corners = []
    for (x0, y0) in [(0, 0), (w - 24, 0), (0, h - 24), (w - 24, h - 24)]:
        corners.append(ImageStat.Stat(rgb.crop((x0, y0, x0 + 24, y0 + 24))).median)
    return tuple(sorted(ch[0] for ch in zip(*corners))[1] for _ in range(3))


def bbox_at(rgb, bg, thr=30):
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    diff = diff.filter(ImageFilter.MedianFilter(9))
    return diff.point(lambda p: 255 if p >= thr else 0).getbbox()


def content_radii(rgb, bg, cx, cy):
    px = rgb.load()
    w, h = rgb.size
    out = []
    for a in range(0, 360):
        last = 0
        for r in range(5, int(max(w, h))):
            x = int(cx + r * math.cos(math.radians(a)))
            y = int(cy + r * math.sin(math.radians(a)))
            if x < 0 or y < 0 or x >= w or y >= h:
                break
            p = px[x, y]
            if max(abs(p[0] - bg[0]), abs(p[1] - bg[1]), abs(p[2] - bg[2])) >= CONTENT_THR:
                last = r
        out.append(last)
    out.sort()
    return out


def circle_mask(size: int, r: int, ss: int = 4) -> Image.Image:
    big = Image.new("L", (size * ss, size * ss), 0)
    d = ImageDraw.Draw(big)
    c = size * ss // 2
    d.ellipse((c - r * ss, c - r * ss, c + r * ss, c + r * ss), fill=255)
    m = big.resize((size, size), Image.LANCZOS)
    return m.point(lambda p: 255 if p >= 128 else 0)


def main(inp: str, outp: str) -> None:
    src = Image.open(inp).convert("RGB")
    w, h = src.size
    bg = bg_of(src)
    bbox = bbox_at(src, bg)
    if bbox is None:
        raise SystemExit("no disc found")
    cx, cy = (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0
    r_bbox = max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 2.0
    radii = content_radii(src, bg, cx, cy)
    r_p10 = radii[len(radii) // 10]
    r_src = min(r_bbox, r_p10)

    scale = R_MASTER / r_src
    scaled = src.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    master.paste(scaled, (round(CANVAS / 2 - cx * scale), round(CANVAS / 2 - cy * scale)))
    alpha = circle_mask(CANVAS, R_MASTER)
    r, g, b = master.split()[:3]
    master = Image.merge("RGBA", (r, g, b, alpha))
    master.save(outp, "PNG")

    # ---- QA metrics ----
    a_min, a_max = alpha.getextrema()
    binary = a_min == 0 and a_max == 255
    L = master.convert("RGB").convert("L")
    ann = Image.new("L", (CANVAS, CANVAS), 0)
    d = ImageDraw.Draw(ann)
    c = CANVAS // 2
    d.ellipse((c - 627, c - 627, c + 627, c + 627), fill=255)   # 70%R
    d.ellipse((c - 269, c - 269, c + 269, c + 269), fill=0)     # 30%R
    lum_scene = ImageStat.Stat(L, ann).mean[0] / 255.0
    core = Image.new("L", (CANVAS, CANVAS), 0)
    d2 = ImageDraw.Draw(core)
    d2.ellipse((c - 269, c - 269, c + 269, c + 269), fill=255)
    lum_core = ImageStat.Stat(L, core).mean[0] / 255.0
    # background leak inside the disc (sampled grid, tolerance 12 per channel)
    px = master.load()
    tot = leak = 0
    for y in range(c - 880, c + 880, 8):
        for x in range(c - 880, c + 880, 8):
            if (x - c) ** 2 + (y - c) ** 2 <= 880 ** 2 and px[x, y][3] == 255:
                tot += 1
                p = px[x, y]
                if (abs(p[0] - bg[0]) <= 12 and abs(p[1] - bg[1]) <= 12
                        and abs(p[2] - bg[2]) <= 12):
                    leak += 1
    corners_alpha = {master.getpixel(p)[3] for p in
                     [(8, 8), (CANVAS - 9, 8), (8, CANVAS - 9), (CANVAS - 9, CANVAS - 9)]}
    print(f"{outp}\tcanvas={CANVAS}x{CANVAS}\tdisc_d=1792(87.5%)\talpha_binary={binary}"
          f"\tr_bbox={r_bbox:.0f}\tr_p10={r_p10}\tbg={bg}"
          f"\tlum_scene={lum_scene:.2f}\tlum_core={lum_core:.2f}"
          f"\tbg_leak={leak / max(tot, 1) * 100:.1f}%\tcorners_alpha={corners_alpha}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

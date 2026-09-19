#!/usr/bin/env python3
"""Cut generator drafts to master format per docs/07-art-spec.md §1.

Input:  raw draft on flat uniform background, disc anywhere in frame.
Output: master PNG-32, 2048x2048, disc centered, diameter 1792 px (87.5%),
        alpha strictly binary (0 outside / 255 inside), sRGB.

Usage: python3 make_master.py IN.png OUT.png
Prints QA metrics as TSV.
"""
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

CANVAS = 2048
R_MASTER = 896  # diameter 1792 = 87.5% of canvas


def find_disc(src: Image.Image):
    """Return (cx, cy, r_bbox) of the disc on a uniform background."""
    rgb = src.convert("RGB")
    w, h = rgb.size
    # background = median of 4 corner patches
    corners = []
    for (x0, y0) in [(0, 0), (w - 24, 0), (0, h - 24), (w - 24, h - 24)]:
        patch = rgb.crop((x0, y0, x0 + 24, y0 + 24))
        corners.append(ImageStat.Stat(patch).median)
    bg = tuple(sorted(ch[0] for ch in zip(*corners))[1] for _ in range(3))
    bg_img = Image.new("RGB", rgb.size, bg)
    diff = ImageChops.difference(rgb, bg_img).convert("L")
    diff = diff.filter(ImageFilter.MedianFilter(9))  # kill specks
    mask = diff.point(lambda p: 255 if p >= 30 else 0)
    bbox = mask.getbbox()
    if bbox is None:
        raise SystemExit("no disc found")
    cx = (bbox[0] + bbox[2]) / 2.0
    cy = (bbox[1] + bbox[3]) / 2.0
    r_bbox = max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 2.0
    return cx, cy, r_bbox


def circle_mask(size: int, r: int, ss: int = 4) -> Image.Image:
    """Binary circle alpha mask, 4x supersampled for a clean (still binary) edge."""
    big = Image.new("L", (size * ss, size * ss), 0)
    d = ImageDraw.Draw(big)
    c = size * ss // 2
    d.ellipse((c - r * ss, c - r * ss, c + r * ss, c + r * ss), fill=255)
    m = big.resize((size, size), Image.LANCZOS)
    return m.point(lambda p: 255 if p >= 128 else 0)


def main(inp: str, outp: str) -> None:
    src = Image.open(inp).convert("RGB")
    cx, cy, r_src = find_disc(src)
    scale = R_MASTER / r_src
    sw, sh = src.size
    nw, nh = round(sw * scale), round(sh * scale)
    scaled = src.resize((nw, nh), Image.LANCZOS)

    master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    px = round(CANVAS / 2 - cx * scale)
    py = round(CANVAS / 2 - cy * scale)
    master.paste(scaled, (px, py))

    alpha = circle_mask(CANVAS, R_MASTER)
    r, g, b = master.split()[:3]
    master = Image.merge("RGBA", (r, g, b, alpha))
    master.save(outp, "PNG")

    # ---- QA metrics ----
    a_min, a_max = alpha.getextrema()
    binary = a_min == 0 and a_max == 255
    # face tone: mean luminance in annulus 70-30 %R (scene zone) and inner 30%R
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
    # corner transparency check
    corners_alpha = [master.getpixel((8, 8))[3], master.getpixel((CANVAS - 9, 8))[3],
                     master.getpixel((8, CANVAS - 9))[3], master.getpixel((CANVAS - 9, CANVAS - 9))[3]]
    print(f"{outp}\tcanvas={CANVAS}x{CANVAS}\tdisc_d=1792(87.5%)\talpha_binary={binary}"
          f"\tlum_scene={lum_scene:.2f}\tlum_core={lum_core:.2f}\tcorners_alpha={set(corners_alpha)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

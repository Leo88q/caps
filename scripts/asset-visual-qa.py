#!/usr/bin/env python3
"""Objective visual QA for the 72 chip masters (docs/07-art-spec.md §2.1/§2.2/§3).

Everything here is measurable, so the review does not depend on a human eye:
  * rim band (92-100% R) mean colour + saturation per tier  -> §3 material ladder
  * dominant hue of the story zone (30-70% R) per district  -> §2.2 one leading colour
  * trust-blue #2E8BFF usage inside the disc                 -> §2.2 hard ban
  * detail density (edge energy) per tier                    -> §3 growing complexity
  * pairwise distance between masters                        -> §3 "same story evolves",
                                                                plus duplicate detection
  * legibility proxies at 130 px and 56 px                   -> §2.1 readability test

Writes reports/asset-visual-qa.json and prints a summary.
"""
from __future__ import annotations

import colorsys
import json
import math
import os

from PIL import Image, ImageFilter, ImageStat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MDIR = os.path.join(ROOT, "art_drafts", "master")
OUT = os.path.join(ROOT, "reports", "asset-visual-qa.json")

CANVAS = 2048
C = CANVAS / 2
R = 896

DISTRICTS = ["01", "02", "03", "04", "05", "06", "07", "10"]
TIERS = [
    "Common", "Common+", "Rare", "Rare+", "Epic",
    "Epic+", "Legend", "Legend+", "Diamond",
]
# §3: rim material must differ per tier; expected families for the ladder
RIM_EXPECT = {
    0: "zinc matte", 1: "zinc wet", 2: "polished steel", 3: "steel petrol",
    4: "enamel magenta", 5: "enamel orange", 6: "bronze patina",
    7: "bronze acid", 8: "chrome holo",
}
TRUST_BLUE = (0x2E, 0x8B, 0xFF)


def zone_pixels(im: Image.Image, r0: float, r1: float):
    """Pixels of the annulus r0..r1 (fractions of R), as (r,g,b) tuples."""
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()
    step = 2  # sample every 2nd pixel — 1.3 M samples/disc is plenty
    out = []
    for y in range(0, h, step):
        for x in range(0, w, step):
            dx, dy = x + 0.5 - C, y + 0.5 - C
            d = math.hypot(dx, dy) / R
            if r0 <= d < r1:
                r, g, b, a = px[x, y]
                if a > 250:
                    out.append((r, g, b))
    return out


def mean_color(px):
    n = len(px) or 1
    return tuple(round(sum(p[i] for p in px) / n, 1) for i in range(3))


def mean_sat(px):
    if not px:
        return 0.0
    s = 0.0
    for r, g, b in px:
        mx, mn = max(r, g, b), min(r, g, b)
        s += 0 if mx == 0 else (mx - mn) / mx
    return round(100 * s / len(px), 1)


def hue_hist(px, bins=12):
    """Hue histogram (percent) over pixels with any saturation."""
    hist = [0.0] * bins
    tot = 0
    for r, g, b in px:
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s < 0.12 or v < 0.08:
            continue
        hist[int(h * bins) % bins] += 1
        tot += 1
    if not tot:
        return [0.0] * bins, 0
    return [round(100 * x / tot, 1) for x in hist], tot


def edge_energy(im: Image.Image, box=None) -> float:
    """Mean |Laplacian| — a stand-in for 'how much detail is drawn here'."""
    g = im.convert("RGB")
    if box:
        g = g.crop(box)
    gray = g.convert("L")
    e = gray.filter(ImageFilter.FIND_EDGES)
    return round(ImageStat.Stat(e).mean[0], 2)


def sig(im: Image.Image, size=32) -> list:
    """Downsampled greyscale signature for cheap pairwise comparison."""
    return list(im.convert("L").resize((size, size), Image.LANCZOS).getdata())


def rms(a, b) -> float:
    return round(math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)) / len(a)), 2)


def trust_blue_share(px) -> float:
    n = 0
    for r, g, b in px:
        if abs(r - TRUST_BLUE[0]) < 26 and abs(g - TRUST_BLUE[1]) < 26 and abs(b - TRUST_BLUE[2]) < 26:
            n += 1
    return round(100.0 * n / (len(px) or 1), 4)


def main() -> int:
    rows = {}
    sigs = {}
    for d in DISTRICTS:
        for t in range(9):
            p = os.path.join(MDIR, f"{d}-{t}.png")
            im = Image.open(p)
            disc = im.crop((int(C - R), int(C - R), int(C + R), int(C + R)))
            rim = zone_pixels(im, 0.92, 1.00)
            story = zone_pixels(im, 0.30, 0.70)
            allp = zone_pixels(im, 0.0, 1.0)
            hh, colored = hue_hist(story)
            small130 = disc.resize((130, 130), Image.LANCZOS)
            small56 = disc.resize((56, 56), Image.LANCZOS)
            rows[f"{d}-{t}"] = {
                "rim_rgb": mean_color(rim),
                "rim_sat": mean_sat(rim),
                "story_rgb": mean_color(story),
                "story_sat": mean_sat(story),
                "disc_mean_lum": round(ImageStat.Stat(disc.convert("L")).mean[0], 1),
                "trust_blue_pct": trust_blue_share(allp),
                "colored_pct": round(100.0 * colored / (len(story) or 1), 1),
                "hue_hist": hh,
                "edge_2048": edge_energy(disc),
                "edge_130": edge_energy(small130),
                "edge_56": edge_energy(small56),
            }
            sigs[f"{d}-{t}"] = sig(disc)

    # pairwise distance inside each district (consecutive tiers + min pair)
    pairwise = {}
    for d in DISTRICTS:
        cons = []
        for t in range(8):
            cons.append(rms(sigs[f"{d}-{t}"], sigs[f"{d}-{t+1}"]))
        allpairs = {}
        for a in range(9):
            for b in range(a + 1, 9):
                allpairs[f"{a}-{b}"] = rms(sigs[f"{d}-{a}"], sigs[f"{d}-{b}"])
        mn = min(allpairs.items(), key=lambda kv: kv[1])
        pairwise[d] = {
            "consecutive_tier_rms": cons,
            "min_pair": mn[0],
            "min_rms": mn[1],
        }

    # cross-district duplicates (identical art copied between districts)
    dupes = []
    keys = list(sigs)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            if keys[i][:2] == keys[j][:2]:
                continue
            v = rms(sigs[keys[i]], sigs[keys[j]])
            if v < 8.0:
                dupes.append((keys[i], keys[j], v))
    dupes.sort(key=lambda x: x[2])

    report = {"rows": rows, "pairwise": pairwise, "cross_district_near_dupes": dupes[:20]}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(report, fh, indent=1)

    # ── console summary ────────────────────────────────────────────────────
    print("RIM / material ladder (§3) — mean colour of the 92–100% R band")
    print(f"{'tier':9} {'material':16} " + " ".join(f"{d:>14}" for d in DISTRICTS))
    for t in range(9):
        cells = []
        for d in DISTRICTS:
            v = rows[f"{d}-{t}"]
            r, g, b = v["rim_rgb"]
            cells.append(f"#{int(r):02X}{int(g):02X}{int(b):02X} s{v['rim_sat']:>4}")
        print(f"{t} {TIERS[t]:8} {RIM_EXPECT[t]:16} " + " ".join(f"{c:>14}" for c in cells))

    print("\nSTORY zone (30–70% R) — mean colour / saturation / detail")
    print(f"{'id':6} {'story rgb':16} {'sat%':>5} {'lum':>5} {'edge2048':>8} {'edge130':>7} {'edge56':>6} {'blue%':>6}")
    for d in DISTRICTS:
        for t in range(9):
            v = rows[f"{d}-{t}"]
            r, g, b = v["story_rgb"]
            print(f"{d}-{t:<4} #{int(r):02X}{int(g):02X}{int(b):02X}".ljust(23)
                  + f"{v['story_sat']:>5} {v['disc_mean_lum']:>5} {v['edge_2048']:>8} "
                  + f"{v['edge_130']:>7} {v['edge_56']:>6} {v['trust_blue_pct']:>6}")

    print("\nTIER SEPARATION inside a district (RMS of 32×32 signature, 0 = identical)")
    for d in DISTRICTS:
        p = pairwise[d]
        print(f"  {d}: consecutive {p['consecutive_tier_rms']}  min pair {p['min_pair']} = {p['min_rms']}")

    print(f"\nCROSS-DISTRICT near-duplicates (<8 RMS): {len(dupes)}")
    for a, b, v in dupes[:10]:
        print(f"  {a} ~ {b}  rms={v}")
    print(f"\nwrote {os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

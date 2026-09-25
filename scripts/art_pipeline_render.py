#!/usr/bin/env python3
"""Renderer for the GUTTERCAPS art pipeline (docs/07-art-spec.md §4).

Called by scripts/art-pipeline.ts, which supplies a params JSON with
district/rarity tables taken from `packages/economy/src/lore.ts` (the single
source of truth). Everything here is deterministic: same masters + same params
-> byte-stable outputs.

Outputs (exports/cdn/, gitignored — this is a build artifact tree):
  game/{d}-{r}-{256,512,1024}.webp  disc bbox crop -> resize -> WebP q90, alpha kept
  nft/{d}-{r}.png                   2048² opaque collector card (§4 recipe)
  og/{d}-{r}.jpg                    1200×630 social preview of the card

Budgets (§4): webp 256/512/1024 <= 40/120/350 KB — enforced, non-zero exit on miss.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys

from PIL import Image, ImageCms, ImageDraw, ImageFilter

CANVAS = 2048
CARD_DISC = round(CANVAS * 0.76)          # §4: disc Ø 76 % of the card canvas
OG_W, OG_H = 1200, 630
GAME_SIZES = (256, 512, 1024)
GAME_BUDGET_KB = {256: 40, 512: 120, 1024: 350}
WEBP_QUALITY = 90
BG = (22, 21, 26)                          # #16151A asphalt

# D1 from the inventory report: spec §2 wants an embedded sRGB IEC61966-2.1
# profile in every shipped file — the pipeline tags all of its outputs here.
SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()

# glow strength per vfxTier (RARITY_PROFILES.vfxTier) — higher rarity glows harder
GLOW_ALPHA = {0: 40, 1: 58, 2: 76, 3: 94, 4: 112}


def hx(c: str) -> tuple[int, int, int]:
    c = c.lstrip('#')
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def radial_mask(size: int, stops: list[tuple[float, int]]) -> Image.Image:
    """Radial gradient mask: stops = [(radius_fraction, alpha), ...] sorted by r."""
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    c = size / 2
    prev_r, prev_a = 0.0, stops[0][1]
    for r, a in stops:
        rr = int(r * c)
        if rr <= prev_r * c:
            continue
        steps = max(1, rr - int(prev_r * c))
        for i in range(steps):
            t = i / steps
            d.ellipse((c - prev_r * c - t * steps, c - prev_r * c - t * steps,
                       c + prev_r * c + t * steps, c + prev_r * c + t * steps),
                      fill=int(prev_a + (a - prev_a) * t))
        prev_r, prev_a = r, a
    d.ellipse((c - prev_r * c - 2, c - prev_r * c - 2, c + prev_r * c + 2, c + prev_r * c + 2),
              fill=prev_a)
    return m


def spray_texture(size: int) -> Image.Image:
    """Subtle spebble of white + black specks — the 'light spray texture' of §4."""
    noise = Image.effect_noise((size // 4, size // 4), 64).resize((size, size), Image.LANCZOS)
    return noise


def make_card(master_path: str, district_hex: str, glow_hex: str, vfx: int) -> Image.Image:
    """2048² opaque collector card per docs/07 §4."""
    col = hx(district_hex)
    glow = hx(glow_hex)

    # 1) asphalt base
    card = Image.new('RGB', (CANVAS, CANVAS), BG)

    # 2) light spray texture (two passes: pale specks in, dark specks out)
    noise = spray_texture(CANVAS)
    pale = Image.new('RGB', (CANVAS, CANVAS), (58, 56, 62))
    card = Image.composite(pale, card, noise.point(lambda v: max(0, (v - 150) // 6)))
    dark = Image.new('RGB', (CANVAS, CANVAS), (12, 11, 14))
    card = Image.composite(dark, card, noise.point(lambda v: max(0, (130 - v) // 7)))

    # 3) vignette in the district colour (edges only)
    vig_alpha = radial_mask(CANVAS, [(0.52, 0), (0.80, 26), (1.0, 88)])
    vig = Image.new('RGB', (CANVAS, CANVAS), tuple(int(c * 0.55) for c in col))
    card = Image.composite(vig, card, vig_alpha)
    edge_alpha = radial_mask(CANVAS, [(0.78, 0), (1.0, 110)])
    card = Image.composite(Image.new('RGB', (CANVAS, CANVAS), (8, 8, 10)), card, edge_alpha)

    # 4) rarity glow behind the disc (same colours as the game's RARITY_COLOR)
    glow_rgba = Image.new('RGBA', (CANVAS, CANVAS), glow + (0,))
    glow_rgba.putalpha(radial_mask(CANVAS, [(0.0, GLOW_ALPHA[vfx]), (0.30, GLOW_ALPHA[vfx] // 2),
                                            (0.62, 0)]))
    card = card.convert('RGBA')
    card.alpha_composite(glow_rgba)

    # 5) contact shadow: black 35 %, blur 40 px, shifted 24 px down (§4)
    shadow = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    r = CARD_DISC // 2
    cx, cy = CANVAS // 2, CANVAS // 2 + 24
    sd.ellipse((cx - r + 10, cy - r + 6, cx + r - 10, cy + r + 6), fill=(0, 0, 0, 89))
    shadow = shadow.filter(ImageFilter.GaussianBlur(40))
    card.alpha_composite(shadow)

    # 6) the disc itself, centred
    master = Image.open(master_path).convert('RGBA')
    bbox = master.getchannel('A').getbbox()
    disc = master.crop(bbox).resize((CARD_DISC, CARD_DISC), Image.LANCZOS)
    card.alpha_composite(disc, (CANVAS // 2 - CARD_DISC // 2, CANVAS // 2 - CARD_DISC // 2))

    return card.convert('RGB')


def make_og(card: Image.Image, title: str, subtitle: str) -> Image.Image:
    """1200×630 preview: the NFT card on the left, caption on the right (§4)."""
    og = Image.new('RGB', (OG_W, OG_H), BG)
    noise = spray_texture(1024)
    dark = Image.new('RGB', (1024, 1024), (14, 13, 16))
    og.paste(Image.composite(dark, og.crop((0, 0, 1024, 1024)),
                             noise.point(lambda v: max(0, (130 - v) // 8))), (0, 0))

    chip = card.resize((OG_H, OG_H), Image.LANCZOS)
    og.paste(chip, (0, 0))
    d = ImageDraw.Draw(og)
    d.line((OG_H, 0, OG_H, OG_H), fill=(45, 43, 50), width=2)

    from PIL import ImageFont
    f_big = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 46)
    f_mid = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 30)
    f_sm = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 24)
    x = OG_H + 48
    # wrap the title to up to 3 lines at ~440 px
    words, lines, cur = title.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if d.textlength(t, font=f_big) <= OG_W - x - 48:
            cur = t
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    y = 170
    for ln in lines[:3]:
        d.text((x + 2, y + 2), ln, font=f_big, fill=(0, 0, 0))
        d.text((x, y), ln, font=f_big, fill=(232, 230, 226))
        y += 58
    y += 18
    d.text((x, y), subtitle, font=f_mid, fill=(255, 46, 138))
    d.text((x, OG_H - 84), 'guttercaps.gg', font=f_sm, fill=(150, 150, 160))
    return og


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--params', required=True)
    args = ap.parse_args()
    P = json.load(open(args.params))
    root = P['root']
    out_game = os.path.join(root, P['out']['game'])
    out_nft = os.path.join(root, P['out']['nft'])
    out_og = os.path.join(root, P['out']['og'])
    for p in (out_game, out_nft, out_og):
        os.makedirs(p, exist_ok=True)

    only = P.get('only')  # list of glob patterns like "01-2", "04-*"
    def wanted(key: str) -> bool:
        if not only:
            return True
        return any(fnmatch.fnmatch(key, pat) for pat in only)

    problems: list[str] = []
    rows = []
    for di, dist in enumerate(P['districts']):
        d = dist['num']
        master_dir = os.path.join(root, 'art_drafts', 'master')
        for rar in P['rarities']:
            r = rar['tier']
            key = f'{d}-{r}'
            if not wanted(key):
                continue
            src = os.path.join(master_dir, f'{key}.png')
            if not os.path.exists(src):
                problems.append(f'missing master {key}')
                continue
            cap_name = P['caps'][di][r]
            master = Image.open(src).convert('RGBA')
            bbox = master.getchannel('A').getbbox()
            disc = master.crop(bbox)

            # game webp set
            sizes = {}
            for s in GAME_SIZES:
                im = disc.resize((s, s), Image.LANCZOS)
                fp = os.path.join(out_game, f'{key}-{s}.webp')
                im.save(fp, 'WEBP', quality=WEBP_QUALITY, icc_profile=SRGB_ICC)
                kb = os.path.getsize(fp) / 1024
                # adaptive quality: §4 budgets are hard, quality is not — step down
                # 90 -> 82 -> 74 until the file fits (few detailed 1024s need it)
                for q in (82, 74):
                    if kb <= GAME_BUDGET_KB[s]:
                        break
                    im.save(fp, 'WEBP', quality=q, icc_profile=SRGB_ICC)
                    kb = os.path.getsize(fp) / 1024
                sizes[s] = round(kb, 1)
                if kb > GAME_BUDGET_KB[s]:
                    problems.append(f'{key}-{s}.webp {kb:.1f} KB > {GAME_BUDGET_KB[s]} KB budget')

            # collector card + og
            card = make_card(src, dist['hex'], rar['hex'], rar['vfx'])
            card.save(os.path.join(out_nft, f'{key}.png'), optimize=True, icc_profile=SRGB_ICC)
            title = f"{dist['name']} — {cap_name}"
            subtitle = f"District {d} · {rar['name']} (tier {r} of 9)"
            make_og(card, title, subtitle).save(
                os.path.join(out_og, f'{key}.jpg'), quality=85, optimize=True,
                icc_profile=SRGB_ICC)
            rows.append(f'{key}  webp {sizes}  card {os.path.getsize(os.path.join(out_nft, key + ".png"))//1024}KB')

    for r in rows:
        print(r)
    if problems:
        print('BUDGET/INPUT PROBLEMS:', file=sys.stderr)
        for p in problems:
            print(' ', p, file=sys.stderr)
        return 2
    print(f"ok: rendered {len(rows)} chip export sets -> {os.path.relpath(out_game, root)} etc.")
    return 0


if __name__ == '__main__':
    sys.exit(main())

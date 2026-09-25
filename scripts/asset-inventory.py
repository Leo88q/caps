#!/usr/bin/env python3
"""Asset inventory + spec conformance check for Gutter Caps art.

Reads:  art_drafts/master/*.png   (docs/07-art-spec.md §2 — master contract)
        art_drafts/raw/*.png      (generator drafts)
        art_drafts/site/*.png     (site banners / backgrounds / icon source)
        client/public/art/*.webp  (docs/07-art-spec.md §4 — game derivatives)

Prints a TSV/JSON report. No writes, no network.
"""
from __future__ import annotations

import json
import os
import re
import sys

from PIL import Image, ImageCms

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CANVAS = 2048
DISC_D = 1792
R_MASTER = DISC_D // 2
CENTER = CANVAS / 2.0

DISTRICTS = ["01", "02", "03", "04", "05", "06", "07", "10"]
TIERS = list(range(9))
EXPECTED_MASTERS = {f"{d}-{r}" for d in DISTRICTS for r in TIERS}

WEBP_SIZES = (256, 512, 1024)
WEBP_BUDGET_KB = {256: 40, 512: 120, 1024: 350}


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT)


def kb(n: int) -> float:
    return round(n / 1024.0, 1)


def alpha_stats(im: Image.Image) -> dict:
    """Binary-alpha analysis of the master disc."""
    rgba = im.convert("RGBA")
    a = rgba.getchannel("A")
    # histogram: count of each alpha value
    hist = a.histogram()
    total = sum(hist)
    opaque = sum(hist[250:])          # 250..255
    transparent = sum(hist[:6])       # 0..5
    semi = total - opaque - transparent
    bbox = a.getbbox()
    out = {
        "bbox": bbox,
        "opaque_pct": round(100.0 * opaque / total, 3),
        "transparent_pct": round(100.0 * transparent / total, 3),
        "semi_pct": round(100.0 * semi / total, 4),
        "semi_px": semi,
    }
    if bbox:
        x0, y0, x1, y1 = bbox
        w, h = x1 - x0, y1 - y0
        out["bbox_w"] = w
        out["bbox_h"] = h
        out["cx"] = round((x0 + x1) / 2.0, 1)
        out["cy"] = round((y0 + y1) / 2.0, 1)
        out["cx_off"] = round(abs((x0 + x1) / 2.0 - CENTER), 1)
        out["cy_off"] = round(abs((y0 + y1) / 2.0 - CENTER), 1)
        out["aspect"] = round(w / h, 4) if h else None
    return out


def profile_info(path: str) -> str:
    try:
        im = Image.open(path)
        icc = im.info.get("icc_profile")
        if not icc:
            return "none"
        p = ImageCms.getOpenProfile(icc) if hasattr(ImageCms, "getOpenProfile") else \
            ImageCms.ImageCmsProfile(icc)
        return str(ImageCms.getProfileDescription(p)).strip()
    except Exception:
        return "unreadable"


def scan_master(path: str) -> dict:
    rec = {"file": rel(path), "bytes": os.path.getsize(path), "kb": kb(os.path.getsize(path))}
    with Image.open(path) as im:
        rec["mode"] = im.mode
        rec["fmt"] = im.format
        rec["w"], rec["h"] = im.size
        rec["profile"] = profile_info(path)
        a = alpha_stats(im)
        rec.update(a)
        rec["has_alpha_channel"] = im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info
        # mean luminance inside the disc (spec §2.2: dark substrate)
        rgba = im.convert("RGBA")
        disc = rgba.crop((CENTER - R_MASTER, CENTER - R_MASTER,
                          CENTER + R_MASTER, CENTER + R_MASTER))
        small = disc.resize((64, 64), Image.LANCZOS)
        px = list(small.convert("RGB").getdata())
        lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]
        rec["disc_mean_lum"] = round(sum(lum) / len(lum), 1)
    # verdict
    bad = []
    if (rec["w"], rec["h"]) != (CANVAS, CANVAS):
        bad.append(f"size {rec['w']}x{rec['h']} != 2048x2048")
    if rec["mode"] != "RGBA":
        bad.append(f"mode {rec['mode']} != RGBA")
    if rec.get("bbox_w"):
        if abs(rec["bbox_w"] - DISC_D) > 4 or abs(rec["bbox_h"] - DISC_D) > 4:
            bad.append(f"disc {rec['bbox_w']}x{rec['bbox_h']} != 1792x1792")
        if rec.get("aspect") and abs(rec["aspect"] - 1.0) > 0.01:
            bad.append(f"ellipse aspect {rec['aspect']}")
        if rec.get("cx_off", 0) > 2 or rec.get("cy_off", 0) > 2:
            bad.append(f"off-center dx={rec['cx_off']} dy={rec['cy_off']}")
    if rec["semi_pct"] > 0.5:
        bad.append(f"alpha not binary: {rec['semi_pct']}% semi-transparent")
    rec["issues"] = bad
    rec["ok"] = not bad
    return rec


def scan_generic(path: str) -> dict:
    rec = {"file": rel(path), "bytes": os.path.getsize(path), "kb": kb(os.path.getsize(path))}
    with Image.open(path) as im:
        rec["mode"] = im.mode
        rec["fmt"] = im.format
        rec["w"], rec["h"] = im.size
        if im.mode in ("RGBA", "LA", "PA"):
            a = im.getchannel("A")
            mn, mx = a.getextrema()
            rec["alpha"] = f"{mn}-{mx}"
        else:
            rec["alpha"] = "opaque"
    return rec


def main() -> int:
    report: dict = {}

    # ── masters ────────────────────────────────────────────────────────────
    mdir = os.path.join(ROOT, "art_drafts", "master")
    masters = {}
    for f in sorted(os.listdir(mdir)):
        if not f.lower().endswith(".png"):
            continue
        key = f[:-4]
        masters[key] = scan_master(os.path.join(mdir, f))

    missing = sorted(EXPECTED_MASTERS - set(masters))
    extra = sorted(set(masters) - EXPECTED_MASTERS)
    bad = sorted(k for k, v in masters.items() if not v["ok"])
    report["masters"] = {
        "dir": rel(mdir),
        "found": len(masters),
        "expected": len(EXPECTED_MASTERS),
        "missing": missing,
        "unexpected": extra,
        "failing": bad,
        "files": masters,
    }

    # ── client game derivatives ────────────────────────────────────────────
    adir = os.path.join(ROOT, "client", "public", "art")
    art = {}
    if os.path.isdir(adir):
        for f in sorted(os.listdir(adir)):
            if not f.lower().endswith(".webp"):
                continue
            m = re.match(r"^(\d{2})-(\d)-(\d+)\.webp$", f)
            if not m:
                continue
            d, r, size = m.group(1), m.group(2), int(m.group(3))
            rec = scan_generic(os.path.join(adir, f))
            rec.update({"district": d, "tier": int(r), "size": size})
            budget = WEBP_BUDGET_KB.get(size)
            rec["over_budget"] = bool(budget and rec["kb"] > budget)
            art[f"{d}-{r}-{size}"] = rec

    art_gaps = []
    for d in DISTRICTS:
        for r in TIERS:
            for s in WEBP_SIZES:
                if f"{d}-{r}-{s}" not in art:
                    art_gaps.append(f"{d}-{r}-{s}")
    report["client_art"] = {
        "dir": rel(adir),
        "count": len(art),
        "sizes_present": sorted({v["size"] for v in art.values()}),
        "expected_per_size": len(EXPECTED_MASTERS),
        "gaps": art_gaps,
        "over_budget": sorted(k for k, v in art.items() if v["over_budget"]),
        "files": art,
    }

    # ── site art ───────────────────────────────────────────────────────────
    sdir = os.path.join(ROOT, "art_drafts", "site")
    site = {}
    if os.path.isdir(sdir):
        for f in sorted(os.listdir(sdir)):
            if f.lower().endswith(".png"):
                site[f[:-4]] = scan_generic(os.path.join(sdir, f))
    report["site_art"] = {"dir": rel(sdir), "count": len(site), "files": site}

    # ── raw drafts ─────────────────────────────────────────────────────────
    rdir = os.path.join(ROOT, "art_drafts", "raw")
    raw = {}
    if os.path.isdir(rdir):
        for f in sorted(os.listdir(rdir)):
            if f.lower().endswith(".png"):
                raw[f[:-4]] = scan_generic(os.path.join(rdir, f))
    report["raw"] = {"dir": rel(rdir), "count": len(raw), "files": raw}

    # ── previews ───────────────────────────────────────────────────────────
    pdir = os.path.join(ROOT, "art_drafts")
    previews = {}
    for f in sorted(os.listdir(pdir)):
        if f.lower().endswith(".png"):
            previews[f[:-4]] = scan_generic(os.path.join(pdir, f))
    report["previews"] = {"dir": rel(pdir), "count": len(previews), "files": previews}

    # ── client public root ─────────────────────────────────────────────────
    pub = {}
    pdir2 = os.path.join(ROOT, "client", "public")
    for f in sorted(os.listdir(pdir2)):
        p = os.path.join(pdir2, f)
        if os.path.isfile(p) and f.lower().endswith((".png", ".webp", ".jpg", ".ico")):
            pub[f] = scan_generic(p)
        elif os.path.isfile(p) and f.lower().endswith(".svg"):
            pub[f] = {"file": rel(p), "bytes": os.path.getsize(p),
                      "kb": kb(os.path.getsize(p)), "mode": "svg", "fmt": "SVG",
                      "w": None, "h": None}
    report["client_public"] = {"dir": rel(pdir2), "count": len(pub), "files": pub}

    out = os.path.join(ROOT, "reports", "asset-inventory.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(report, fh, indent=1)
    print(f"wrote {rel(out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

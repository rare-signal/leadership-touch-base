"""Seed tile tags from a hand-curated table of (vid, layout, characters).

Claude visually inspected each preview frame once and recorded:
  - layout (N rows x M cols)
  - character_id per tile in row-major order (None = non-roster person)
  - content_bbox fractions (title card + Zoom chrome vary per video, so we
    express the face-grid region as fractions of the frame)

This is the fast path: no OCR, no detection. Run it, get 24 tile JSONs, then
correct any mistakes in the admin UI.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import subprocess
from PIL import Image, ImageDraw, ImageFont
from rich.console import Console

from larp_pipeline.paths import TILES, ensure_dirs, video_path

console = Console()

# ---------- Hand-curated seed table ----------
# Each entry: (vid, rows, cols, content_bbox_fracs, char_ids_row_major, notes)
# content_bbox_fracs = (left, top, right, bottom) as fractions of frame size.
# char_ids_row_major: tile idx 0 = top-left, idx (cols-1) = top-right, etc.
# None means "no roster character for this tile" (non-protagonist person).
#
# Roster reliable anchors:
#   cold_boss_ryan           ← "Ryan"
#   bro_coworker_charles     ← "Charles"
#   bro_coworker_xander      ← "Xander"
#   braxton                  ← "Braxton" (also single-speaker sketches of the
#                               curly-mustache actor)

# Fractions chosen by eye. Zoom title cards sit in top ~18-24%, chrome/caption
# in bottom ~18-22%. The 2x3 grid on 1080x1920 tends to live in y ≈ 0.27–0.51.
# For 2x2 layouts the grid is a bit taller (y ≈ 0.28–0.63).

# Default frame bboxes by layout — tuned by eye from the 1080x1920 portrait
# shorts. Title card typically ends ~y=0.20 and Zoom chrome starts ~y=0.53 for
# 2x3 layouts (smaller face grid), ~y=0.64 for 2x2 (bigger face grid).
# Tall-portrait (sh=1920) fractions — adjusted by visual check:
#   2x3: shift -40px on y vs the first estimate (two nudge-up clicks)
#   2x2: shift -140px on y vs the first estimate (seven nudge-up clicks)
BBOX_2x3 = (0.04, 0.349, 0.96, 0.829)
BBOX_2x2 = (0.04, 0.267, 0.96, 0.857)
BBOX_1x1 = (0.00, 0.00, 1.00, 1.00)

# Aspect-adjusted fractions for the shorter letterboxed videos (sh<1500).
# These were correct at the pre-shift values — 0JQkAxmLzhM for instance was
# perfectly aligned — so they keep the original fractions.
BBOX_2x3_SHORT = (0.04, 0.37, 0.96, 0.85)
BBOX_2x2_SHORT = (0.04, 0.34, 0.96, 0.93)

# Per-video pixel-bbox overrides (x, y, w, h). These take precedence over
# the layout-based fractions and are used when the grid sits at an atypical
# position in the frame. Obtained by eyeballing the clean preview frame.
BBOX_PIXELS: dict[str, tuple[int, int, int, int]] = {
    # 1080x1920 2x3 — grid sits higher + shorter than the default fraction.
    "9nWj2i1wzeQ":  (45, 700, 990, 820),
    # 1080x1920 2x2 — grid extends further down than the default.
    "0fSIY9WkPls":  (45, 650, 990, 1130),
    "6c4ezOY-HOc":  (45, 650, 990, 1130),
}


SEED: list[tuple[str, int, int, tuple[float, float, float, float], list[Optional[str]], str]] = [
    # (vid, rows, cols, bbox_fracs, [tile0, tile1, …], notes)
    ("0JQkAxmLzhM", 2, 3, BBOX_2x3,
     [None, "cold_boss_ryan", "bro_coworker_charles",
      "braxton", None, None],
     "2x3; Corey/Ryan/Charles top, Braxton/Igas/Spencer bottom"),
    ("0fSIY9WkPls", 2, 2, BBOX_2x2,
     [None, None, None, None],
     "2x2; no nameplates visible"),
    ("1sACHNa3_P0", 1, 1, BBOX_1x1,
     ["braxton"],
     "1x1 single-speaker sketch (Braxton actor)"),
    ("6c4ezOY-HOc", 2, 2, BBOX_2x2,
     [None, None, None, None],
     "2x2; no nameplates visible"),
    ("9nWj2i1wzeQ", 2, 3, BBOX_2x3,
     [None, "bro_coworker_charles", "braxton",
      None, None, "cold_boss_ryan"],
     "2x3; Corey/Charles/Braxton top, Igas/Bob/Ryan bottom"),
    ("ATcugwW9RJs", 1, 1, BBOX_1x1,
     ["braxton"],
     "1x1 sketch (Braxton actor as Gen Z intern)"),
    ("B7i2ObNrZzk", 2, 2, BBOX_2x2,
     [None, "bro_coworker_charles", None, None],
     "2x2; Igas/Charles top, Corey/Spencer bottom"),
    ("I4UEzvIaLxg", 2, 2, BBOX_2x2,
     ["cold_boss_ryan", "bro_coworker_charles", None, None],
     "2x2; Ryan/Charles top, Igas/Corey bottom"),
    ("IPmyYpcLvZE", 2, 3, BBOX_2x3,
     ["cold_boss_ryan", None, "bro_coworker_charles",
      "braxton", None, None],
     "2x3; Ryan/Corey/Charles top, Braxton/Igas/Spencer bottom"),
    ("IygvbdeNWqY", 1, 1, BBOX_1x1,
     ["braxton"],
     "1x1 sketch (Braxton actor)"),
    ("KY5X8uZgEdY", 2, 2, BBOX_2x2,
     ["cold_boss_ryan", "bro_coworker_charles", None, None],
     "2x2; Ryan/Charles top, Corey/Igas bottom"),
    ("NyHhdf6aVJM", 2, 2, BBOX_2x2,
     [None, "bro_coworker_charles", None, "cold_boss_ryan"],
     "2x2; Igas/Charles top, Corey/Ryan bottom"),
    ("Ob_jiY_9S2Y", 2, 3, BBOX_2x3,
     [None, None, "braxton",
      "bro_coworker_charles", "cold_boss_ryan", None],
     "2x3; Corey/Igas/Braxton top, Charles/Ryan/Spencer bottom"),
    ("T7xdZ5Lji6s", 1, 1, BBOX_1x1,
     ["braxton"],
     "1x1 sketch at breakfast (Braxton actor, VERSO JOBS shirt)"),
    ("TirJZUa620U", 2, 3, BBOX_2x3,
     ["cold_boss_ryan", None, "bro_coworker_charles",
      None, None, None],
     "2x3; Ryan/Corey/Charles top, Igas/Spencer/Bob bottom"),
    ("Tz0x8DcXQhE", 2, 2, BBOX_2x2,
     [None, "bro_coworker_charles", None, "cold_boss_ryan"],
     "2x2; Corey/Charles top, Igas/Ryan bottom"),
    ("V2DHYyZD03w", 2, 2, BBOX_2x2,
     ["cold_boss_ryan", "bro_coworker_charles", None, None],
     "2x2 small (720x1280); Ryan/Charles top guessed, bottom row unclear"),
    ("ZC4sxomSCDI", 2, 2, BBOX_2x2,
     [None, "bro_coworker_xander", None, None],
     "2x2; Xander presumed top-right (Xander is on roster); others unmatched"),
    ("cnhFdroa3Fc", 2, 2, BBOX_2x2,
     [None, "cold_boss_ryan", None, "bro_coworker_charles"],
     "2x2; Corey/Ryan top, Igas/Charles bottom"),
    ("fdvsrY1-F4I", 2, 3, BBOX_2x3,
     [None, None, "cold_boss_ryan",
      "bro_coworker_charles", None, "braxton"],
     "2x3; Igas/Spencer/Ryan top, Charles/Corey/Braxton bottom"),
    ("mhEjCqGcyqs", 2, 2, BBOX_2x2,
     ["cold_boss_ryan", "bro_coworker_charles", None, None],
     "2x2; Ryan/Charles top, Corey/Igas bottom"),
    ("ts6m_SCQ8_w", 2, 2, BBOX_2x2,
     ["cold_boss_ryan", "bro_coworker_charles", None, None],
     "2x2; Ryan/Charles top, Igas/Corey bottom"),
    ("wUGEyA4CirU", 2, 2, BBOX_2x2,
     ["cold_boss_ryan", "bro_coworker_charles", None, None],
     "2x2; Ryan/Charles top, Corey/Igas bottom"),
    ("wtaTQyf055I", 2, 3, BBOX_2x3,
     ["cold_boss_ryan", None, "braxton",
      None, None, "bro_coworker_charles"],
     "2x3; Ryan/Spencer/Braxton top, Igas/Corey/Charles bottom"),
]


def _frame_size(vid: str) -> tuple[int, int]:
    p = TILES / "frames" / f"{vid}.png"
    with Image.open(p) as im:
        return im.width, im.height


def _draw_overlay(vid: str, tiles: list[dict], out: Path) -> None:
    frame = TILES / "frames" / f"{vid}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(frame) as im:
        canvas = im.copy()
    d = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 22)
    except Exception:
        font = ImageFont.load_default()
    for t in tiles:
        cid = t.get("character_id")
        color = (56, 189, 248) if cid else (250, 180, 60)
        d.rectangle(
            [t["x"], t["y"], t["x"] + t["w"] - 1, t["y"] + t["h"] - 1],
            outline=color, width=4,
        )
        label = cid or "?"
        # Shaded label chip
        tx = t["x"] + 8
        ty = t["y"] + 8
        d.rectangle([tx - 2, ty - 2, tx + len(label) * 11 + 8, ty + 24],
                    fill=(0, 0, 0, 160))
        d.text((tx, ty), label, fill=(255, 255, 255), font=font)
    canvas.save(out)


def build_one(vid: str, rows: int, cols: int,
              bbox_fracs: tuple[float, float, float, float],
              char_ids: list[Optional[str]], notes: str) -> dict:
    ensure_dirs()
    sw, sh = _frame_size(vid)

    # Per-video pixel override wins over layout fractions.
    if vid in BBOX_PIXELS:
        bx, by, bw, bh = BBOX_PIXELS[vid]
    else:
        # If this is a shorter (letterboxed) video, the title card eats a
        # smaller vertical fraction — use the *_SHORT bbox profile.
        if sh < 1500 and bbox_fracs in (BBOX_2x3, BBOX_2x2):
            bbox_fracs = BBOX_2x3_SHORT if bbox_fracs == BBOX_2x3 else BBOX_2x2_SHORT
        lf, tf, rf, bf = bbox_fracs
        bx = int(sw * lf)
        by = int(sh * tf)
        bw = int(sw * (rf - lf))
        bh = int(sh * (bf - tf))

    tile_w = bw // cols
    tile_h = bh // rows
    margin = 6  # inner margin so bboxes don't include gutter

    tiles: list[dict] = []
    idx = 0
    for r in range(rows):
        for c in range(cols):
            cid = char_ids[idx] if idx < len(char_ids) else None
            tiles.append({
                "idx": idx,
                "row": r, "col": c,
                "x": bx + c * tile_w + margin,
                "y": by + r * tile_h + margin,
                "w": tile_w - margin * 2,
                "h": tile_h - margin * 2,
                "character_id": cid,
            })
            idx += 1

    matched = sum(1 for t in tiles if t.get("character_id"))
    doc = {
        "video_id": vid,
        "layout": f"{rows}x{cols}",
        "source_size": [sw, sh],
        "content_bbox": [bx, by, bw, bh],
        "tiles": tiles,
        "confidence": 1.0,              # human-curated
        "character_id_by_tile": {       # backwards-compat view for admin UI
            str(t["idx"]): t["character_id"]
            for t in tiles
            if t.get("character_id")
        },
        "notes": f"seed: {notes} ({matched}/{len(tiles)} tiles have roster chars)",
    }

    out_json = TILES / f"{vid}.json"
    out_json.write_text(json.dumps(doc, indent=2))
    _draw_overlay(vid, tiles, TILES / "previews" / f"{vid}.png")
    return doc


def run() -> None:
    ensure_dirs()
    console.print(f"[bold]seeding {len(SEED)} tile docs from hand-curated table[/bold]")
    total_tiles = 0
    total_matched = 0
    per_char: dict[str, int] = {}
    for (vid, rows, cols, bbox, chars, notes) in SEED:
        doc = build_one(vid, rows, cols, bbox, chars, notes)
        n = len(doc["tiles"])
        m = sum(1 for t in doc["tiles"] if t["character_id"])
        total_tiles += n
        total_matched += m
        for t in doc["tiles"]:
            if t["character_id"]:
                per_char[t["character_id"]] = per_char.get(t["character_id"], 0) + 1
        color = "green" if m > 0 else "yellow"
        console.print(f"[{color}]{vid}[/{color}] {rows}x{cols} → {m}/{n} tiles tagged")

    console.print(f"\n[bold]total: {total_matched}/{total_tiles} tiles tagged[/bold]")
    for cid, n in sorted(per_char.items(), key=lambda kv: -kv[1]):
        console.print(f"  {cid}: {n} appearances")

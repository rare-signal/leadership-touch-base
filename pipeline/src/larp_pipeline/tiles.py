"""Auto-detect zoom-grid tile bounding boxes from source video frames.

The VersoJobs shorts are shot as fake Zoom meetings — a small set of face tiles
laid out in a grid over a dark background. We detect the grid by looking for
narrow "dark gutter" bands that span a large fraction of the opposite axis.

For each source video we:
  1. Sample a frame from the middle (content most stable, intro/outro avoided).
  2. Trim letterboxing (pure-black borders).
  3. Build per-column and per-row "darkness" profiles — fraction of pixels that
     are below a brightness threshold.
  4. Find high-darkness bands that are wide enough to act as gutters.
  5. Group bands into (vertical-gutter, horizontal-gutter) → cell layout.
  6. Reject unrealistic layouts (1x1 or more than 4x4).

Output: data/tiles/<video_id>.json with
  {
    "video_id": str,
    "layout": "2x2" | "2x3" | "3x2" | "unknown",
    "source_size": [w, h],
    "content_bbox": [x, y, w, h],   # inside the full frame, after letterbox trim
    "tiles": [{"idx": int, "x": int, "y": int, "w": int, "h": int}, ...],
    "confidence": float,             # [0,1] — how grid-like the frame looked
    "character_id_by_tile": {},      # filled in by the /admin/tiles tagger
    "notes": str,
  }

Plus a preview PNG at data/tiles/previews/<video_id>.png with bboxes drawn.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from rich.console import Console

from larp_pipeline.paths import TILES, ensure_dirs, video_ids, video_path

console = Console()

# Tunables
DARK_THRESHOLD = 60        # pixel value below which we count as "dark"
GUTTER_DARK_FRAC = 0.85    # column must be >=85% dark to count as gutter pixel
MIN_TILE_FRACTION = 0.18   # each tile must be at least 18% of the content dim
MAX_TILES = 9              # sanity cap


def _ffprobe_duration(video: Path) -> float:
    r = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(video),
        ],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip() or 0)


def _sample_frame(video: Path, t: float) -> Image.Image:
    """Use ffmpeg to pull a single PNG frame at timestamp t."""
    r = subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-ss", f"{t:.2f}", "-i", str(video),
            "-vframes", "1", "-f", "image2pipe", "-vcodec", "png", "-",
        ],
        capture_output=True, check=True,
    )
    from io import BytesIO
    return Image.open(BytesIO(r.stdout)).convert("RGB")


def _trim_letterbox(gray: np.ndarray) -> tuple[int, int, int, int]:
    """Return (x, y, w, h) content bbox after stripping pure-black borders."""
    h, w = gray.shape
    row_max = gray.max(axis=1)
    col_max = gray.max(axis=0)
    nonblack_rows = np.where(row_max > 8)[0]
    nonblack_cols = np.where(col_max > 8)[0]
    if len(nonblack_rows) == 0 or len(nonblack_cols) == 0:
        return 0, 0, w, h
    y0, y1 = int(nonblack_rows[0]), int(nonblack_rows[-1])
    x0, x1 = int(nonblack_cols[0]), int(nonblack_cols[-1])
    return x0, y0, (x1 - x0 + 1), (y1 - y0 + 1)


def _find_tiles_band(gray: np.ndarray) -> tuple[int, int]:
    """Find (y_start, y_end) of the main "tiles band" — the tallest contiguous
    vertical stretch of rows that are not dominated by dark pixels.

    This strips away the "POV: ..." title card at the top and the Zoom chrome /
    captions at the bottom, which would otherwise masquerade as gutters.
    """
    h = gray.shape[0]
    dark = gray < DARK_THRESHOLD
    row_dark = dark.mean(axis=1)  # fraction of pixels per row that are dark
    # A row is part of the tiles band if most of it is NOT dark.
    in_band = row_dark < 0.55
    best = (0, 0, 0)  # length, start, end
    cur_start: int | None = None
    for y in range(h):
        if in_band[y]:
            if cur_start is None:
                cur_start = y
        else:
            if cur_start is not None:
                length = y - cur_start
                if length > best[0]:
                    best = (length, cur_start, y - 1)
                cur_start = None
    if cur_start is not None:
        length = h - cur_start
        if length > best[0]:
            best = (length, cur_start, h - 1)
    _, s, e = best
    # If the band is shorter than a third of the frame, fall back to the whole frame.
    if e - s + 1 < h * 0.33:
        return 0, h - 1
    return s, e


def _gutter_bands(profile: np.ndarray, min_band_px: int = 3, frac_thresh: float = GUTTER_DARK_FRAC) -> list[tuple[int, int]]:
    """Find (start, end) pixel bands where `profile >= frac_thresh`.

    profile is a 1D array of "fraction of pixels along the opposite axis that
    are dark" for each position along this axis.
    """
    mask = profile >= frac_thresh
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_band_px:
                bands.append((start, i - 1))
            start = None
    if start is not None and len(mask) - start >= min_band_px:
        bands.append((start, len(mask) - 1))
    return bands


def _interior_gutters(bands: list[tuple[int, int]], axis_len: int, edge_skip: int = 6) -> list[int]:
    """From raw gutter bands, return the centers of INTERIOR gutters only.

    We drop any band that starts at 0 or ends at axis_len-1 (these are just
    letterbox/frame edges, not cell dividers).
    """
    out: list[int] = []
    for s, e in bands:
        if s <= edge_skip:
            continue
        if e >= axis_len - 1 - edge_skip:
            continue
        out.append((s + e) // 2)
    # Dedupe nearby centers (< 10px apart)
    out.sort()
    merged: list[int] = []
    for c in out:
        if not merged or c - merged[-1] > 10:
            merged.append(c)
    return merged


@dataclass
class GridResult:
    layout: str  # e.g. "2x3"
    content_bbox: tuple[int, int, int, int]  # x, y, w, h in original frame
    tiles: list[dict] = field(default_factory=list)
    confidence: float = 0.0
    notes: str = ""


def detect_grid(img: Image.Image) -> GridResult:
    gray = np.array(img.convert("L"), dtype=np.uint8)
    lx, ly, lw, lh = _trim_letterbox(gray)
    letter_cropped = gray[ly : ly + lh, lx : lx + lw]
    if letter_cropped.size == 0:
        return GridResult(layout="unknown", content_bbox=(0, 0, 0, 0), notes="empty frame")

    # Strip the "POV: …" title card at top and the Zoom-chrome/captions at bottom.
    ts, te = _find_tiles_band(letter_cropped)
    cy = ly + ts
    ch = (te - ts + 1)
    cx = lx
    cw = lw
    content = gray[cy : cy + ch, cx : cx + cw]

    # Darkness fraction per column and per row within the trimmed content.
    dark = content < DARK_THRESHOLD
    col_dark_frac = dark.mean(axis=0)  # (W,)
    row_dark_frac = dark.mean(axis=1)  # (H,)

    vbands = _gutter_bands(col_dark_frac)
    hbands = _gutter_bands(row_dark_frac)
    vgutters = _interior_gutters(vbands, cw)
    hgutters = _interior_gutters(hbands, ch)

    n_cols = len(vgutters) + 1
    n_rows = len(hgutters) + 1
    layout = f"{n_rows}x{n_cols}"

    # Sanity: total tile count in [2, MAX_TILES]
    total = n_rows * n_cols
    if total < 2 or total > MAX_TILES:
        # Fall back to 1x1: treat the whole tiles band as one tile — the tagger
        # will let a human pick the right layout from a template.
        return GridResult(
            layout="1x1",
            content_bbox=(cx, cy, cw, ch),
            tiles=[{
                "idx": 0, "row": 0, "col": 0,
                "x": cx + 4, "y": cy + 4, "w": cw - 8, "h": ch - 8,
            }],
            confidence=0.0,
            notes=f"auto-detect found no interior gutters (guessed {layout}); manual tag needed",
        )

    # Build cell edges in content-local coordinates
    x_edges = [0, *vgutters, cw]
    y_edges = [0, *hgutters, ch]

    # Enforce min tile fraction — reject if any cell is too thin.
    widths = [x_edges[i + 1] - x_edges[i] for i in range(len(x_edges) - 1)]
    heights = [y_edges[i + 1] - y_edges[i] for i in range(len(y_edges) - 1)]
    if any(w < MIN_TILE_FRACTION * cw for w in widths) or any(
        h < MIN_TILE_FRACTION * ch for h in heights
    ):
        return GridResult(
            layout="1x1",
            content_bbox=(cx, cy, cw, ch),
            tiles=[{
                "idx": 0, "row": 0, "col": 0,
                "x": cx + 4, "y": cy + 4, "w": cw - 8, "h": ch - 8,
            }],
            confidence=0.0,
            notes=f"auto-detect bands too thin (widths={widths} heights={heights}); manual tag needed",
        )

    tiles: list[dict] = []
    idx = 0
    for r in range(n_rows):
        for c in range(n_cols):
            x0 = cx + x_edges[c]
            y0 = cy + y_edges[r]
            w = x_edges[c + 1] - x_edges[c]
            h = y_edges[r + 1] - y_edges[r]
            # Shrink by a small inner margin to avoid eating the gutter edge.
            margin = 4
            tiles.append({
                "idx": idx,
                "row": r, "col": c,
                "x": int(x0 + margin),
                "y": int(y0 + margin),
                "w": int(w - margin * 2),
                "h": int(h - margin * 2),
            })
            idx += 1

    # Confidence = average darkness of the chosen gutters (deeper, wider = better).
    gutter_scores: list[float] = []
    for v in vgutters:
        gutter_scores.append(float(col_dark_frac[v]))
    for hg in hgutters:
        gutter_scores.append(float(row_dark_frac[hg]))
    confidence = float(np.mean(gutter_scores)) if gutter_scores else 0.0

    return GridResult(
        layout=layout,
        content_bbox=(cx, cy, cw, ch),
        tiles=tiles,
        confidence=confidence,
        notes=f"{len(vgutters)} vertical + {len(hgutters)} horizontal gutters",
    )


def _draw_preview(img: Image.Image, result: GridResult, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas = img.copy()
    d = ImageDraw.Draw(canvas)
    cx, cy, cw, ch = result.content_bbox
    d.rectangle([cx, cy, cx + cw - 1, cy + ch - 1], outline=(255, 200, 0), width=2)
    for t in result.tiles:
        d.rectangle(
            [t["x"], t["y"], t["x"] + t["w"] - 1, t["y"] + t["h"] - 1],
            outline=(56, 189, 248),
            width=3,
        )
        d.text((t["x"] + 6, t["y"] + 6), f"{t['idx']}", fill=(255, 255, 255))
    canvas.save(out)


def analyze_one(vid: str, force: bool = False, save_preview: bool = True) -> dict:
    ensure_dirs()
    out_json = TILES / f"{vid}.json"
    if out_json.exists() and not force:
        return json.loads(out_json.read_text())

    video = video_path(vid)
    if not video.exists():
        console.print(f"[yellow]no video for {vid}[/yellow]")
        return {}

    duration = _ffprobe_duration(video)
    t = max(0.5, duration / 2)
    img = _sample_frame(video, t)
    w, h = img.size

    res = detect_grid(img)

    doc = {
        "video_id": vid,
        "layout": res.layout,
        "source_size": [w, h],
        "content_bbox": list(res.content_bbox),
        "tiles": res.tiles,
        "confidence": round(res.confidence, 3),
        "character_id_by_tile": {},
        "notes": res.notes,
    }
    out_json.write_text(json.dumps(doc, indent=2))

    if save_preview:
        _draw_preview(img, res, TILES / "previews" / f"{vid}.png")

    if res.layout == "unknown":
        console.print(f"[dim]{vid}: unknown ({res.notes})[/dim]")
    else:
        console.print(
            f"[green]{vid}[/green] -> {res.layout} (conf {res.confidence:.2f}) "
            f"{len(res.tiles)} tiles"
        )
    return doc


def run(force: bool = False) -> None:
    ensure_dirs()
    ids = video_ids()
    console.print(f"[bold]detecting tile layout for {len(ids)} videos[/bold]")
    by_layout: dict[str, list[str]] = {}
    for vid in ids:
        d = analyze_one(vid, force=force)
        by_layout.setdefault(d.get("layout", "unknown"), []).append(vid)

    console.print("\n[bold]Summary by layout:[/bold]")
    for lay, vids in sorted(by_layout.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        console.print(f"  {lay}: {len(vids):>2}  ({', '.join(vids[:6])}{'...' if len(vids) > 6 else ''})")
    console.print(f"\n[dim]previews in {TILES / 'previews'}[/dim]")

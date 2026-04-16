"""Extract keyframes from each video via ffmpeg.

Strategy: evenly-spaced frames across the clip's duration. Shorts are ~15-120s
so 4-6 frames per clip is plenty to capture all distinct shots/characters.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from rich.console import Console

from larp_pipeline.paths import (
    KEYFRAMES, ensure_dirs, info_path, video_ids, video_path,
)

console = Console()


def _duration(vid: str) -> float:
    """Read duration from info.json (preferred) or ffprobe fallback."""
    info = info_path(vid)
    if info.exists():
        try:
            d = json.loads(info.read_text()).get("duration")
            if d:
                return float(d)
        except Exception:
            pass
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(video_path(vid)),
    ], text=True).strip()
    return float(out)


def extract_one(vid: str, per_video: int = 6, force: bool = False) -> list[Path]:
    out_dir = KEYFRAMES / vid
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(out_dir.glob("frame_*.jpg"))
    if len(existing) >= per_video and not force:
        console.print(f"[dim]skip {vid} ({len(existing)} frames)[/dim]")
        return existing
    # clean if forcing or partial
    for f in existing:
        f.unlink()
    dur = _duration(vid)
    # Sample at 1/(n+1), 2/(n+1), ... to avoid very-first/very-last blank frames
    frames: list[Path] = []
    for i in range(per_video):
        t = dur * (i + 1) / (per_video + 1)
        out = out_dir / f"frame_{i:02d}.jpg"
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-ss", f"{t:.2f}", "-i", str(video_path(vid)),
            "-frames:v", "1", "-q:v", "3", str(out),
        ], check=True)
        frames.append(out)
    console.print(f"  [green]✓[/green] {vid}: {len(frames)} frames")
    return frames


def extract_all(per_video: int = 6) -> None:
    ensure_dirs()
    ids = video_ids()
    console.print(f"[bold]extracting {per_video} keyframes × {len(ids)} videos[/bold]")
    for vid in ids:
        extract_one(vid, per_video=per_video)
    console.print(f"[bold green]done[/bold green]")

"""Canonical data paths. All pipeline stages read/write through here."""
from __future__ import annotations

from pathlib import Path

# pipeline/src/larp_pipeline/paths.py -> repo root is 3 parents up
REPO_ROOT = Path(__file__).resolve().parents[3]
DATA = REPO_ROOT / "data"

RAW = DATA / "raw"                     # yt-dlp output: {video_id}/{video_id}.{mp4,info.json,en.srt,jpg}
TRANSCRIPTS = DATA / "transcripts"     # {video_id}.json
KEYFRAMES = DATA / "keyframes"         # {video_id}/frame_{idx}.jpg
CLUSTERS = DATA / "clusters"           # intermediate clustering artifacts
CHARACTERS = DATA / "characters"       # one canonical characters.json (list of characters)
PERSONAS = DATA / "personas"           # {character_id}.md + {character_id}.json
GRUNTS = DATA / "grunts"               # {character_id}/{n}.mp3 + sprite.json
CHANNEL_INDEX = DATA / "channel_index.json"


def ensure_dirs() -> None:
    for p in (RAW, TRANSCRIPTS, KEYFRAMES, CLUSTERS, CHARACTERS, PERSONAS, GRUNTS):
        p.mkdir(parents=True, exist_ok=True)


def video_ids() -> list[str]:
    """Return all video ids that have a downloaded mp4."""
    if not RAW.exists():
        return []
    return sorted(
        d.name for d in RAW.iterdir()
        if d.is_dir() and not d.name.startswith(".") and not d.name.startswith("UC")
        and (d / f"{d.name}.mp4").exists()
    )


def video_path(vid: str) -> Path:
    return RAW / vid / f"{vid}.mp4"


def info_path(vid: str) -> Path:
    return RAW / vid / f"{vid}.info.json"


def srt_path(vid: str) -> Path:
    # Prefer human subs (en), fall back to auto (en-orig)
    for name in (f"{vid}.en.srt", f"{vid}.en-orig.srt"):
        p = RAW / vid / name
        if p.exists():
            return p
    return RAW / vid / f"{vid}.en.srt"


def thumb_path(vid: str) -> Path:
    return RAW / vid / f"{vid}.jpg"

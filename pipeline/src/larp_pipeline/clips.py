"""Cut per-character silent MP4 clips + one master audio track per source.

Inputs
------
- data/raw/<vid>/<vid>.mp4        : source video
- data/tiles/<vid>.json           : tiles (bbox + character_id per tile)

Outputs
-------
- data/clips/_audio/<vid>.m4a     : full-duration master audio (AAC, loudnormed)
- data/clips/<char_id>/<vid>_<tile_idx>.mp4
                                  : silent, full-duration, cropped to tile bbox

Design notes
------------
Only one audio track matters per source video — the source already has every
participant's reactions baked in. At playback time, one "speaker" video per
meeting plays its master audio while every other tile plays muted.

We re-encode video so tiles are small and lightweight (H.264, CRF 24, 720p
target long-edge cap), and the audio as AAC 128kbps mono loudnormed to -16
LUFS so levels are consistent across sources. Full-duration clips let the
frontend seek to "speaking" vs "listening" ranges without re-cutting.
"""
from __future__ import annotations

import json
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from rich.console import Console

from larp_pipeline.paths import CLIP_AUDIO, CLIPS, TILES, ensure_dirs, video_ids, video_path

console = Console()

# Knobs
VIDEO_CRF = 24
VIDEO_LONG_EDGE_CAP = 720   # px — tile videos downscale to this max dimension
AUDIO_BITRATE = "128k"
AUDIO_LOUDNORM_I = -16      # integrated loudness target (LUFS)
WORKERS = 4                 # concurrent ffmpeg calls


@dataclass
class ClipJob:
    vid: str
    tile_idx: int
    character_id: str
    bbox: tuple[int, int, int, int]  # x, y, w, h in source pixels


def _load_tile_jobs() -> list[ClipJob]:
    jobs: list[ClipJob] = []
    for vid in video_ids():
        p = TILES / f"{vid}.json"
        if not p.exists():
            continue
        doc = json.loads(p.read_text())
        for t in doc.get("tiles", []):
            cid = t.get("character_id")
            if not cid:
                continue
            jobs.append(ClipJob(
                vid=vid,
                tile_idx=int(t["idx"]),
                character_id=cid,
                bbox=(int(t["x"]), int(t["y"]), int(t["w"]), int(t["h"])),
            ))
    return jobs


def _out_video_path(job: ClipJob) -> Path:
    d = CLIPS / job.character_id
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{job.vid}_{job.tile_idx}.mp4"


def _out_audio_path(vid: str) -> Path:
    CLIP_AUDIO.mkdir(parents=True, exist_ok=True)
    return CLIP_AUDIO / f"{vid}.m4a"


def _cut_clip(job: ClipJob, force: bool) -> tuple[str, bool, str]:
    """Return (job_key, success, message)."""
    out = _out_video_path(job)
    if out.exists() and not force:
        return (f"{job.character_id}/{out.name}", True, "cached")
    src = video_path(job.vid)
    if not src.exists():
        return (f"{job.character_id}/{out.name}", False, f"no source mp4: {src}")

    x, y, w, h = job.bbox
    # Ensure even dimensions (H.264 requires even w/h)
    w -= w % 2
    h -= h % 2
    # Compute scale cap so the longer edge is at most VIDEO_LONG_EDGE_CAP
    long_edge = max(w, h)
    if long_edge > VIDEO_LONG_EDGE_CAP:
        scale_flt = VIDEO_LONG_EDGE_CAP / long_edge
        sw = int(w * scale_flt) - int(w * scale_flt) % 2
        sh = int(h * scale_flt) - int(h * scale_flt) % 2
        vf = f"crop={w}:{h}:{x}:{y},scale={sw}:{sh}"
    else:
        vf = f"crop={w}:{h}:{x}:{y}"

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-vf", vf,
        "-an",                            # drop audio
        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(VIDEO_CRF),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        return (f"{job.character_id}/{out.name}", False,
                f"ffmpeg failed: {e.stderr.decode(errors='replace')[:200]}")
    return (f"{job.character_id}/{out.name}", True, "cut")


def _extract_audio(vid: str, force: bool) -> tuple[str, bool, str]:
    out = _out_audio_path(vid)
    if out.exists() and not force:
        return (f"_audio/{out.name}", True, "cached")
    src = video_path(vid)
    if not src.exists():
        return (f"_audio/{out.name}", False, f"no source mp4: {src}")
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-vn",
        "-af", f"loudnorm=I={AUDIO_LOUDNORM_I}:TP=-1.5:LRA=11",
        "-ac", "1",
        "-c:a", "aac", "-b:a", AUDIO_BITRATE,
        "-movflags", "+faststart",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        return (f"_audio/{out.name}", False,
                f"ffmpeg failed: {e.stderr.decode(errors='replace')[:200]}")
    return (f"_audio/{out.name}", True, "extracted")


def run(force: bool = False, only_vid: str | None = None) -> None:
    ensure_dirs()
    jobs = _load_tile_jobs()
    if only_vid:
        jobs = [j for j in jobs if j.vid == only_vid]
    if not jobs:
        console.print("[yellow]no tagged tiles to cut[/yellow]")
        return

    # Distinct videos needing audio
    audio_vids = sorted({j.vid for j in jobs})
    console.print(f"[bold]cutting {len(jobs)} tile clips + {len(audio_vids)} master audio tracks[/bold]")

    # --- Audio first (quick, short work) ---
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = [pool.submit(_extract_audio, v, force) for v in audio_vids]
        for f in as_completed(futs):
            key, ok, msg = f.result()
            color = "green" if ok else "red"
            console.print(f"  [{color}]audio[/{color}] {key}: {msg}")

    # --- Video clips ---
    success = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = [pool.submit(_cut_clip, j, force) for j in jobs]
        for f in as_completed(futs):
            key, ok, msg = f.result()
            if ok:
                success += 1
                if msg != "cached":
                    console.print(f"  [green]clip[/green]  {key}: {msg}")
            else:
                failed += 1
                console.print(f"  [red]clip[/red]   {key}: {msg}")

    console.print(f"\n[bold]clips: {success} ok, {failed} failed[/bold]")
    by_char: dict[str, int] = {}
    for j in jobs:
        by_char[j.character_id] = by_char.get(j.character_id, 0) + 1
    for cid, n in sorted(by_char.items(), key=lambda kv: -kv[1]):
        console.print(f"  {cid}: {n} clips")

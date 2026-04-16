"""Transcribe each video with faster-whisper.

Produces data/transcripts/{video_id}.json with:
  - video_id, duration, language, model
  - segments: [{start, end, text, avg_logprob, speaker_turn}]
  - words: [{start, end, word, probability, segment_idx, speaker_turn}]

`speaker_turn` is an integer that increments whenever we cross a `>>` marker
in the YouTube-provided subtitle track. This is coarse but free and often
correct — humans caption these videos (en.srt exists alongside auto-subs).
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from rich.console import Console

from larp_pipeline.paths import (
    TRANSCRIPTS, ensure_dirs, srt_path, video_ids, video_path,
)

console = Console()

MODEL_NAME = "small.en"   # CPU-friendly; bump to "medium.en" for cleaner output
COMPUTE_TYPE = "int8"     # int8 CPU is plenty for 2-min shorts


@dataclass
class Word:
    start: float
    end: float
    word: str
    probability: float
    speaker_turn: int = 0


@dataclass
class Segment:
    start: float
    end: float
    text: str
    avg_logprob: float
    speaker_turn: int = 0


def _parse_srt_turns(srt: Path) -> list[tuple[float, int]]:
    """Return sorted list of (time_seconds, turn_idx) for `>>` boundaries.

    Any time we see a new `>>` or `-` speaker marker, we increment the turn.
    """
    if not srt.exists():
        return []
    text = srt.read_text(encoding="utf-8", errors="ignore")
    blocks = re.split(r"\n\s*\n", text.strip())
    markers: list[tuple[float, int]] = []
    turn = 0
    seen_in_block: set[int] = set()
    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        m = re.match(r"(\d+):(\d+):(\d+)[.,](\d+)\s+-->", lines[1])
        if not m:
            continue
        h, mi, s, ms = map(int, m.groups())
        t = h * 3600 + mi * 60 + s + ms / 1000
        body = " ".join(lines[2:])
        # Count `>>` speaker boundaries inside this block
        hits = len(re.findall(r">>", body))
        if hits:
            turn += hits
            markers.append((t, turn))
    # dedupe keeping last per time
    markers.sort()
    return markers


def _turn_at(time: float, markers: list[tuple[float, int]]) -> int:
    if not markers:
        return 0
    # binary-ish: find last marker with t <= time
    turn = 0
    for t, k in markers:
        if t <= time:
            turn = k
        else:
            break
    return turn


def transcribe_one(vid: str, model, force: bool = False) -> Path:
    out = TRANSCRIPTS / f"{vid}.json"
    if out.exists() and not force:
        console.print(f"[dim]skip {vid} (already transcribed)[/dim]")
        return out
    mp4 = video_path(vid)
    console.print(f"[cyan]transcribing[/cyan] {vid} ({mp4.stat().st_size/1e6:.1f}MB)")
    segments_iter, info = model.transcribe(
        str(mp4),
        language="en",
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )
    markers = _parse_srt_turns(srt_path(vid))
    seg_list: list[Segment] = []
    word_list: list[Word] = []
    for i, s in enumerate(segments_iter):
        turn_s = _turn_at(s.start, markers)
        seg = Segment(
            start=round(s.start, 3),
            end=round(s.end, 3),
            text=s.text.strip(),
            avg_logprob=round(s.avg_logprob, 4),
            speaker_turn=turn_s,
        )
        seg_list.append(seg)
        for w in (s.words or []):
            word_list.append(Word(
                start=round(w.start, 3),
                end=round(w.end, 3),
                word=w.word,
                probability=round(w.probability, 4),
                speaker_turn=_turn_at(w.start, markers),
            ))
    doc = {
        "video_id": vid,
        "duration": round(info.duration, 2),
        "language": info.language,
        "model": MODEL_NAME,
        "compute_type": COMPUTE_TYPE,
        "segments": [asdict(s) for s in seg_list],
        "words": [asdict(w) for w in word_list],
        "srt_turn_markers": markers,
    }
    out.write_text(json.dumps(doc, indent=2))
    console.print(f"  [green]✓[/green] {len(seg_list)} segs, {len(word_list)} words -> {out.name}")
    return out


def transcribe_all(force: bool = False) -> None:
    from faster_whisper import WhisperModel
    ensure_dirs()
    ids = video_ids()
    if not ids:
        console.print("[yellow]no videos found in data/raw[/yellow]")
        return
    console.print(f"[bold]loading whisper {MODEL_NAME} ({COMPUTE_TYPE})[/bold]")
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE_TYPE)
    for vid in ids:
        transcribe_one(vid, model, force=force)
    console.print(f"[bold green]done: {len(ids)} videos[/bold green]")

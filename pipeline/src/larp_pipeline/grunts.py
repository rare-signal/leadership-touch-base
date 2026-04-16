"""Extract per-character non-verbal / short ad-lib audio clips.

Pipeline:
1. For each character, look at their `appearances` — pick the scenes where the
   character's `quoted_lines` match turns in the transcript.
2. Within those turns, find the SHORTEST, most distinctive utterance — single
   interjections like 'hey', 'yo', 'bro', 'hm', 'yeah', or laughs. We prefer
   segments with duration < 1.5s and word count <= 3.
3. ffmpeg cuts those segments from the source mp4 into mono 44.1kHz mp3s with
   loudness normalization (EBU R128 -16 LUFS).
4. Write a sprite JSON at data/grunts/sprite.json keyed by character id.

This is deliberately heuristic; human review of the produced clips is expected.
The tagging UI surfaces these for approval.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from rich.console import Console

from larp_pipeline.paths import (
    CHARACTERS, GRUNTS, TRANSCRIPTS, ensure_dirs, video_path,
)

console = Console()
MAX_GRUNT_S = 1.8
MIN_GRUNT_S = 0.25
MAX_WORDS = 4
PER_CHARACTER = 4


def _candidate_segments(vid: str, turns_of_interest: set[int]) -> list[dict]:
    tpath = TRANSCRIPTS / f"{vid}.json"
    if not tpath.exists():
        return []
    doc = json.loads(tpath.read_text())
    out: list[dict] = []
    for s in doc["segments"]:
        if turns_of_interest and s["speaker_turn"] not in turns_of_interest:
            continue
        dur = s["end"] - s["start"]
        words = s["text"].strip().split()
        if MIN_GRUNT_S <= dur <= MAX_GRUNT_S and 1 <= len(words) <= MAX_WORDS:
            out.append({
                "video_id": vid, "start": s["start"], "end": s["end"],
                "text": s["text"].strip(), "duration": round(dur, 2),
                "turn": s["speaker_turn"],
            })
    return out


def _guess_turns_for_character(char: dict, vid: str) -> set[int]:
    """Best-effort: find transcript turns containing this character's quoted_lines.

    Falls back to empty set (= all turns in the video) if no match.
    """
    tpath = TRANSCRIPTS / f"{vid}.json"
    if not tpath.exists():
        return set()
    doc = json.loads(tpath.read_text())
    # Collect quoted lines from the per_video observations if available
    per_video = CHARACTERS / "per_video" / f"{vid}.json"
    if not per_video.exists():
        return set()
    pv = json.loads(per_video.read_text())
    label_hints = set()
    for obs in pv.get("observations", []):
        # Match via quoted_lines against our canonical character's signature_phrases or aliases
        sigs = set(char.get("signature_phrases", []) + char.get("aliases", []) + [char["display_name"]])
        ql = obs.get("quoted_lines", [])
        if any(any(sig.lower() in q.lower() for sig in sigs if sig) for q in ql):
            label_hints.add(obs.get("label_hint"))
    if not label_hints:
        return set()
    # For turns with any matching text
    turns: set[int] = set()
    for s in doc["segments"]:
        text_l = s["text"].lower()
        for sig in char.get("signature_phrases", []):
            if sig and sig.lower() in text_l:
                turns.add(s["speaker_turn"])
    return turns


def _cut(src: Path, start: float, end: float, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    # Loudness-normalize and encode mono mp3 @ 96kbps (tiny files)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.2f}", "-to", f"{end:.2f}", "-i", str(src),
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ac", "1", "-ar", "44100", "-b:a", "96k", str(out),
    ], check=True)


def run() -> None:
    ensure_dirs()
    chars_file = CHARACTERS / "characters.json"
    if not chars_file.exists():
        raise SystemExit(f"missing {chars_file}")
    characters = json.loads(chars_file.read_text())

    sprite: dict[str, list[dict]] = {}
    for char in characters["characters"]:
        char_id = char["id"]
        console.print(f"[cyan]{char['display_name']}[/cyan] ({char_id})")
        candidates: list[dict] = []
        for app in char.get("appearances", []):
            vid = app["video_id"]
            turns = _guess_turns_for_character(char, vid)
            candidates.extend(_candidate_segments(vid, turns))
        # Sort by shortest + dedupe by text
        seen = set()
        dedup: list[dict] = []
        for c in sorted(candidates, key=lambda x: x["duration"]):
            key = c["text"].lower()
            if key in seen:
                continue
            seen.add(key)
            dedup.append(c)
        picks = dedup[:PER_CHARACTER]
        if not picks:
            console.print(f"  [yellow]no candidate grunts found[/yellow]")
            continue
        out_entries = []
        for i, p in enumerate(picks):
            out = GRUNTS / char_id / f"{i}.mp3"
            _cut(video_path(p["video_id"]), p["start"], p["end"], out)
            out_entries.append({
                "path": f"grunts/{char_id}/{i}.mp3",
                "text": p["text"],
                "duration": p["duration"],
                "source_video": p["video_id"],
                "source_start": p["start"],
            })
            console.print(f"  [green]✓[/green] {i} '{p['text']}' ({p['duration']}s)")
        sprite[char_id] = out_entries

    sprite_file = GRUNTS / "sprite.json"
    sprite_file.write_text(json.dumps(sprite, indent=2))
    console.print(f"[bold green]sprite -> {sprite_file}[/bold green]")

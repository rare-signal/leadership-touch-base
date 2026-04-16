"""Identify LARP characters from transcripts alone (no vision needed).

Why text-only: the cluster David uses doesn't have a VLM right now, and the
transcripts are actually rich enough — characters name each other in dialog
("Yo, Korman", "Rexton, what's up, bro?") and each has a distinct speech
register (corporate-speak, bro-chill, frazzled, monotone, etc.).

Two-pass:
1. Per-video: text LLM reads [youtube_title+description, transcript] and lists
   observations — one per distinct speaker-turn-cluster — with label_hint,
   names_heard, likely_role, signature_lines, register, turn_indices, and
   a best_keyframe_idx (we still extracted 6 frames per video — the LLM picks
   one as the avatar based on line quotes' timing + sanity rules).
2. Global: merge all observations into canonical characters.
"""
from __future__ import annotations

import json
from pathlib import Path

from rich.console import Console

from larp_pipeline.llm import ClusterClient
from larp_pipeline.paths import (
    CHARACTERS, KEYFRAMES, TRANSCRIPTS, ensure_dirs, info_path, video_ids,
)

console = Console()


def _load_transcript_script(vid: str) -> str:
    """Render transcript as turn-separated script."""
    p = TRANSCRIPTS / f"{vid}.json"
    if not p.exists():
        return ""
    doc = json.loads(p.read_text())
    turns: dict[int, list[str]] = {}
    for s in doc["segments"]:
        turns.setdefault(s["speaker_turn"], []).append(s["text"].strip())
    lines = []
    for k in sorted(turns):
        lines.append(f"[turn {k}] {' '.join(turns[k])}")
    return "\n".join(lines)


def _load_video_meta(vid: str) -> dict:
    p = info_path(vid)
    if not p.exists():
        return {}
    d = json.loads(p.read_text())
    return {
        "title": d.get("title") or d.get("fulltitle") or "",
        "description": d.get("description") or "",
        "duration_s": d.get("duration"),
        "view_count": d.get("view_count"),
    }


def _n_keyframes(vid: str) -> int:
    return len(list((KEYFRAMES / vid).glob("frame_*.jpg")))


PER_VIDEO_PROMPT = """You are analyzing one short comedy video from Verso Jobs on YouTube. The videos satirize corporate life at a fictional org called LARP. ONE actor plays every role, so "different character" means different costume/role/personality — NOT different voice actor.

Your job: identify which DISTINCT characters appear in this video based on the transcript.

INPUT METADATA:
title: {title}
description: {description}
duration_s: {duration}

TRANSCRIPT (turns are from YouTube's own `>>` speaker markers):
{transcript}

We've extracted {n_frames} keyframes (indices 0..{max_frame}) evenly spaced through the clip. You cannot see them — just pick a plausible best_frame_idx for each character (characters speaking early = lower index, late = higher).

Return JSON ONLY, matching this schema exactly:
{{
  "video_id": "{vid}",
  "scene_summary": "one sentence plot summary",
  "observations": [
    {{
      "label_hint": "short kebab-case nickname (e.g. 'cold-boss', 'bro-coworker', 'earnest-intern')",
      "turn_indices": [list of turn integers where THIS character speaks],
      "names_heard": ["any names the other characters call them by — read carefully for 'Yo, X' / 'X, what's up?' etc."],
      "likely_role": "their job/role at LARP",
      "register": "corporate-speak | bro-chill | frazzled | monotone | sycophant | chaos-agent | earnest | other",
      "signature_lines": ["1-3 verbatim memorable lines from THEIR turns"],
      "interpersonal_note": "how they relate to other characters in this scene",
      "best_frame_idx": integer 0..{max_frame}
    }}
  ]
}}

Be precise about turn_indices — assign each turn to exactly one character. If turn k is pure narration/ambient with no clear speaker, assign it to the most plausible character based on continuity.
"""


def analyze_video(client: ClusterClient, vid: str, force: bool = False) -> dict:
    out_dir = CHARACTERS / "per_video"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{vid}.json"
    if out.exists() and not force:
        return json.loads(out.read_text())

    transcript = _load_transcript_script(vid)
    if not transcript:
        console.print(f"[yellow]no transcript for {vid}, skipping[/yellow]")
        return {}
    meta = _load_video_meta(vid)
    n_frames = _n_keyframes(vid)
    prompt = PER_VIDEO_PROMPT.format(
        vid=vid,
        title=meta.get("title", ""),
        description=(meta.get("description", "") or "")[:600],
        duration=meta.get("duration_s", "?"),
        transcript=transcript,
        n_frames=max(n_frames, 1),
        max_frame=max(n_frames - 1, 0),
    )
    console.print(f"[cyan]analyzing[/cyan] {vid}")
    try:
        doc = client.chat_json(
            [{"role": "user", "content": prompt}],
            max_tokens=2000,
            temperature=0.3,
        )
    except Exception as e:
        console.print(f"[red]{vid} failed: {e}[/red]")
        out.write_text(json.dumps({"video_id": vid, "error": str(e)}, indent=2))
        return {}
    out.write_text(json.dumps(doc, indent=2))
    console.print(f"  [green]✓[/green] {vid}: {len(doc.get('observations', []))} chars")
    return doc


MERGE_PROMPT = """You are consolidating per-video character observations from {n} LARP comedy shorts into a canonical character roster.

ONE actor plays every role. Characters recur across videos. Your job: merge observations that describe the same character (matching names, matching role/register, matching signature_lines style) into single canonical entries.

STRICT RULES:
- Prefer names that show up MULTIPLE times across videos as canonical display_names.
- If a character is named explicitly (e.g. "Korman", "Rexton", "Rapstin") keep the real name. Otherwise invent a memorable display_name based on role+register.
- Aim for 5-10 canonical characters. Under-merge rather than over-merge if in doubt.
- Keep `appearances` complete (every video_id where any observation clearly points to this character).
- Include the best_frame_idx from each appearance so the UI can pick an avatar.

OBSERVATIONS (array of per-video docs):
{observations}

Return JSON ONLY, matching:
{{
  "characters": [
    {{
      "id": "snake_case_id",
      "display_name": "Title Case (preferring names heard in dialog)",
      "aliases": ["other names/hints"],
      "role": "role at LARP",
      "register": "corporate-speak | bro-chill | ...",
      "visual_description": "what they look like based on scenes — guess is OK",
      "signature_phrases": ["2-6 verbatim or near-verbatim memorable lines"],
      "appearances": [
        {{"video_id": "...", "best_frame_idx": 0, "turn_indices": [0,2], "note": "brief"}}
      ],
      "thumb_video_id": "video_id whose thumbnail is the best avatar for this character"
    }}
  ]
}}
"""


def _compact_obs(doc: dict) -> dict:
    """Trim per-video observation doc to essentials the merger actually needs."""
    return {
        "video_id": doc.get("video_id"),
        "scene_summary": doc.get("scene_summary", "")[:140],
        "observations": [
            {
                "label_hint": o.get("label_hint"),
                "names_heard": o.get("names_heard") or [],
                "likely_role": o.get("likely_role"),
                "register": o.get("register"),
                "signature_lines": (o.get("signature_lines") or [])[:2],
                "turn_indices": o.get("turn_indices") or [],
                "best_frame_idx": o.get("best_frame_idx", 0),
            }
            for o in doc.get("observations", [])
        ],
    }


def merge_characters(client: ClusterClient) -> Path:
    out_dir = CHARACTERS / "per_video"
    all_obs = []
    for f in sorted(out_dir.glob("*.json")):
        d = json.loads(f.read_text())
        if d.get("observations"):
            all_obs.append(_compact_obs(d))
    if not all_obs:
        raise SystemExit("no per-video observations; run per-video analysis first")
    console.print(f"[bold]merging {len(all_obs)} videos' observations[/bold]")
    prompt = MERGE_PROMPT.format(
        n=len(all_obs),
        observations=json.dumps(all_obs, indent=2),
    )
    doc = client.chat_json(
        [{"role": "user", "content": prompt}],
        max_tokens=12000,
        temperature=0.2,
    )
    out = CHARACTERS / "characters.json"
    out.write_text(json.dumps(doc, indent=2))
    console.print(f"[bold green]✓ {len(doc['characters'])} canonical characters[/bold green]")
    # Write a human-review markdown alongside
    review = ["# Character merge review\n"]
    for c in doc["characters"]:
        review.append(f"## {c['display_name']} (`{c['id']}`)")
        review.append(f"- **Role:** {c.get('role', '?')}  **Register:** {c.get('register', '?')}")
        review.append(f"- **Aliases:** {', '.join(c.get('aliases', [])) or '—'}")
        review.append(f"- **Appearances:** {len(c.get('appearances', []))} videos")
        review.append(f"- **Signature phrases:**")
        for p in c.get("signature_phrases", [])[:5]:
            review.append(f"  - _\"{p}\"_")
        review.append("")
    (CHARACTERS / "review.md").write_text("\n".join(review))
    return out


def run(force_per_video: bool = False, concurrency: int = 4) -> None:
    ensure_dirs()
    client = ClusterClient()
    ids = video_ids()
    tided = [v for v in ids if (TRANSCRIPTS / f"{v}.json").exists()]
    console.print(f"[bold]{len(tided)}/{len(ids)} videos have transcripts[/bold]")
    if concurrency > 1:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = {ex.submit(analyze_video, client, v, force_per_video): v for v in tided}
            for f in as_completed(futs):
                try:
                    f.result()
                except Exception as e:
                    console.print(f"[red]{futs[f]} threw: {e}[/red]")
    else:
        for vid in tided:
            analyze_video(client, vid, force=force_per_video)
    merge_characters(client)

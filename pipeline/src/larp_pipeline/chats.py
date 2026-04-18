"""Pre-generate chat message packs per meeting.

For every source video that has a tile doc with tagged characters (i.e. a
"meeting" with a known on-screen cast), call the local LLM cluster to produce
a pool of ~60 chat messages grounded in that meeting's transcript and cast
personas. The meeting UI loads this pool and draws from it during ambient
turns, falling through to live LLM generation only when the pool runs dry.

Each generated chat is one of:
  - "room":            drops in the public meeting chat; everyone sees it
  - "dm_to_user":      private DM to the user; uses {NAME} placeholder
  - "dm_cast_to_cast": intercepted/leaked DM between two cast members

Output: data/chats/{vid}.json
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from rich.console import Console

from larp_pipeline.llm import ClusterClient
from larp_pipeline.paths import DATA, TILES, TRANSCRIPTS, ensure_dirs

console = Console()

CHATS_DIR = DATA / "chats"

# Tuneable knobs
CHATS_PER_MEETING = 60
BATCH_SIZE = 15  # ask the LLM for this many at a time (JSON array)


def _load_transcript(vid: str) -> str:
    p = TRANSCRIPTS / f"{vid}.json"
    if not p.exists():
        return ""
    d = json.loads(p.read_text())
    segs = d.get("segments", []) or []
    return "\n".join(s.get("text", "").strip() for s in segs if s.get("text"))


def _load_tile_cast(vid: str) -> list[str]:
    p = TILES / f"{vid}.json"
    if not p.exists():
        return []
    doc = json.loads(p.read_text())
    out: list[str] = []
    for t in doc.get("tiles", []):
        cid = t.get("character_id")
        if cid and cid not in out:
            out.append(cid)
    return out


def _load_personas(character_ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for cid in character_ids:
        p = DATA / "personas" / f"{cid}.json"
        if p.exists():
            out[cid] = json.loads(p.read_text())
    return out


def _load_character_display_names() -> dict[str, str]:
    p = DATA / "characters" / "characters.json"
    if not p.exists():
        return {}
    d = json.loads(p.read_text())
    out: dict[str, str] = {}
    for c in d.get("characters", []):
        aliases = c.get("aliases") or []
        # Prefer a single-word capitalized alias (matches UI's castName helper)
        pretty = next(
            (a for a in aliases if a and a[:1].isupper() and a.replace(" ", "").isalpha() and " " not in a),
            c.get("display_name", c["id"]),
        )
        out[c["id"]] = pretty
    return out


def _prompt_for_batch(
    vid: str,
    transcript: str,
    personas: dict[str, dict],
    display_names: dict[str, str],
    batch_size: int,
) -> str:
    cast_lines = []
    for cid, persona in personas.items():
        name = display_names.get(cid, cid)
        one = persona.get("one_liner", "")
        cadence = ", ".join((persona.get("speech_patterns") or [])[:3])
        cast_lines.append(f"- {cid} ({name}) — {one}. Cadence: {cadence}")

    cast_name_lookup = ", ".join(
        f"{cid}={name}" for cid, name in display_names.items() if cid in personas
    )
    return f"""You are writing Zoom meeting chat messages for a LARP comedy bit.

MEETING TRANSCRIPT (what was spoken out loud during this meeting):
{transcript[:3000]}

CAST OF THIS MEETING (character_id → persona):
{chr(10).join(cast_lines)}

CAST DISPLAY NAMES: {cast_name_lookup}

Produce {batch_size} short chat messages that would plausibly appear alongside
this meeting. Each must be in-character for the sender. Vary the audience:

  - "room": typed into the public meeting chat. All cast + user see it.
    Short (<= 200 chars). Sounds like Zoom-chat voice (quick asides, emojis
    optional, not full prose).
  - "dm_to_user": private direct message to the user (use literal placeholder
    "{{NAME}}" where the user's name would go — the runtime substitutes it).
    Gossipy, confidential, conspiratorial. The user doesn't need to have
    prompted it.
  - "dm_cast_to_cast": a DM from one cast member to another (target_id). The
    user is viewing a side conversation they can see. Sender MUST be
    different from target.

STRICT RULES — violating these means the chat is broken:
  1. FIRST PERSON ONLY. Each sender speaks AS THEMSELVES using "I", "me",
     "my". A sender NEVER addresses themselves by their own display name
     in the third person. (No "for you, Charles" written by Charles.)
  2. No "sincerely, <name>" signoffs, no self-narration, no fake stage
     directions like "*laughs*".
  3. Messages must vary. Don't repeat the same construction twice within
     this batch. Each chat is a distinct beat.
  4. Do NOT label the audience inside the text (no "DM:" prefix). The
     audience field already tags it.
  5. For dm_to_user: the sender is writing TO the user. Address the user
     (use "{{NAME}}" sparingly — once per message max). Don't make the
     sender refer to themselves by name.
  6. For dm_cast_to_cast: sender and target are different characters. The
     sender addresses the TARGET by name (or pronoun) — never themselves.

Ground the content in the transcript's topic and each speaker's personality.
Reference specific phrases or ideas from the transcript when it fits. Mix
tones — earnest, petty, absurd, conspiratorial. Short. Punchy.

Respond with JSON ONLY, no markdown:
{{"chats": [
  {{"sender": "<character_id>", "audience": "room"|"dm_to_user"|"dm_cast_to_cast", "target": "<character_id or null>", "text": "..." }},
  ...
]}}
"""


def _generate_batch(
    client: ClusterClient,
    vid: str,
    transcript: str,
    personas: dict,
    display_names: dict,
    batch_size: int,
) -> list[dict]:
    prompt = _prompt_for_batch(vid, transcript, personas, display_names, batch_size)
    try:
        raw = client.chat_json(
            [{"role": "user", "content": prompt}],
            max_tokens=3500,
            temperature=0.9,
        )
    except Exception as e:
        console.print(f"[red]{vid}: batch failed: {e}[/red]")
        return []
    chats = raw.get("chats") if isinstance(raw, dict) else None
    if not isinstance(chats, list):
        return []
    valid_ids = set(personas.keys())
    cleaned: list[dict] = []
    for c in chats:
        if not isinstance(c, dict):
            continue
        sender = c.get("sender")
        audience = c.get("audience")
        text = (c.get("text") or "").strip()
        target = c.get("target")
        if sender not in valid_ids or not text:
            continue
        if audience not in ("room", "dm_to_user", "dm_cast_to_cast"):
            continue
        if audience == "dm_cast_to_cast":
            if target not in valid_ids or target == sender:
                continue
        else:
            target = None
        # Reject any message where the sender uses their own display name
        # in the text — that's the "Charles talks about Charles" bug. Match
        # as a standalone word (case-insensitive) so we don't false-positive
        # on substrings like "ryanair".
        sender_name = (display_names.get(sender) or "").strip()
        if sender_name:
            pattern = re.compile(rf"\b{re.escape(sender_name)}\b", re.IGNORECASE)
            if pattern.search(text):
                continue
        # Also block the id's tail (e.g. sender=cold_boss_ryan → "ryan")
        sender_tail = sender.split("_")[-1]
        if sender_tail and sender_tail != sender_name:
            pattern = re.compile(rf"\b{re.escape(sender_tail)}\b", re.IGNORECASE)
            if pattern.search(text):
                continue
        cleaned.append(
            {
                "sender": sender,
                "audience": audience,
                "target": target,
                "text": text[:400],
            }
        )
    return cleaned


def run(force: bool = False, only_vid: str | None = None) -> None:
    ensure_dirs()
    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    client = ClusterClient()
    display_names = _load_character_display_names()

    # Find all meetings (videos with >=1 tagged tile)
    meetings: list[str] = []
    if not TILES.exists():
        console.print("[red]no tiles/ directory[/red]")
        return
    for p in sorted(TILES.glob("*.json")):
        vid = p.stem
        if only_vid and vid != only_vid:
            continue
        cast = _load_tile_cast(vid)
        if cast:
            meetings.append(vid)

    console.print(f"[bold]Generating chat packs for {len(meetings)} meetings[/bold]")
    for vid in meetings:
        out = CHATS_DIR / f"{vid}.json"
        if out.exists() and not force:
            console.print(f"  [dim]{vid}: cached[/dim]")
            continue

        cast = _load_tile_cast(vid)
        personas = _load_personas(cast)
        if not personas:
            console.print(f"  [yellow]{vid}: no personas for cast {cast} — skip[/yellow]")
            continue
        transcript = _load_transcript(vid)
        if not transcript:
            console.print(f"  [yellow]{vid}: no transcript — skip[/yellow]")
            continue

        console.print(f"  {vid} cast={cast} → generating...")
        collected: list[dict] = []
        batches_needed = (CHATS_PER_MEETING + BATCH_SIZE - 1) // BATCH_SIZE
        for b in range(batches_needed):
            t0 = time.time()
            chats = _generate_batch(
                client, vid, transcript, personas, display_names, BATCH_SIZE
            )
            collected.extend(chats)
            console.print(
                f"    batch {b + 1}/{batches_needed}: +{len(chats)} ({time.time() - t0:.1f}s)"
            )
        # Trim to target
        collected = collected[:CHATS_PER_MEETING]
        # De-dupe identical text
        seen: set[str] = set()
        deduped: list[dict] = []
        for c in collected:
            key = c["text"].lower()
            if key in seen:
                continue
            seen.add(key)
            deduped.append(c)

        payload: dict[str, Any] = {
            "video_id": vid,
            "cast": cast,
            "chats": deduped,
        }
        out.write_text(json.dumps(payload, indent=2))
        console.print(f"    [green]saved {len(deduped)} chats → {out}[/green]")

    console.print("[bold green]done[/bold green]")

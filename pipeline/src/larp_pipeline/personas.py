"""Persona synthesis via local LLM cluster.

For each canonical character, we feed the cluster: their dossier + every scene
they appear in, and ask for a persona card + a roleplay system prompt.
"""
from __future__ import annotations

import json

from rich.console import Console

from larp_pipeline.llm import ClusterClient
from larp_pipeline.paths import CHARACTERS, PERSONAS, TRANSCRIPTS, ensure_dirs

console = Console()


def _gather_scenes(char: dict) -> str:
    scenes = []
    for app in char.get("appearances", []):
        vid = app["video_id"]
        tpath = TRANSCRIPTS / f"{vid}.json"
        if not tpath.exists():
            continue
        doc = json.loads(tpath.read_text())
        turns: dict[int, list[str]] = {}
        for s in doc["segments"]:
            turns.setdefault(s["speaker_turn"], []).append(s["text"].strip())
        wanted = set(app.get("turn_indices") or [])
        pieces = []
        for k in sorted(turns):
            marker = "★" if k in wanted else " "
            pieces.append(f"  {marker} [turn {k}] {' '.join(turns[k])}")
        scenes.append(f"— {vid} —\n" + "\n".join(pieces))
    return "\n\n".join(scenes) or "(no transcripts available)"


PERSONA_PROMPT = """You are writing a roleplay system prompt + persona card for ONE recurring character from the LARP comedy universe (Verso Jobs).

CHARACTER DOSSIER:
{dossier}

ALL SCENES THIS CHARACTER APPEARS IN (★ = this character is the primary speaker on that turn; no-star turns are their scene partner's for context):
{scenes}

Be specific to THIS character. Pull phrasings from their starred turns.

Return JSON ONLY, matching:
{{
  "id": "{char_id}",
  "display_name": "...",
  "one_liner": "one-sentence nameplate subtitle (e.g. 'Head of People Ops, always late to meetings')",
  "role": "...",
  "core_motivation": "what they fundamentally want in every interaction",
  "personality_primitives": {{
    "assertiveness": <0-10 int>,
    "warmth": <0-10 int>,
    "competence_belief": <0-10 int>,
    "corporate_fluency": <0-10 int>,
    "chaos": <0-10 int>
  }},
  "speech_patterns": ["3-6 concrete verbal tics — e.g. 'ends statements with right?', 'deploys corporate verbs as nouns'"],
  "catchphrases": ["2-5 verbatim or near-verbatim signature lines"],
  "triggers": {{
    "engages_when": ["topics/cues that make them speak up"],
    "derails_to": ["pet topics they pull meetings toward"]
  }},
  "meeting_behavior": "how they behave in a Zoom meeting — do they interrupt? monologue? lurk?",
  "system_prompt": "A 150-300 word system prompt written in second person ('You are ...') that you would paste into an LLM to make it roleplay this character in a mock corporate Zoom meeting. Include: their name/role, voice register, 3 verbatim example lines showing speech tics, what they tend to say, what they never say. End with: 'Keep responses to 1-3 sentences. Speak as if in a meeting — fragmentary, not essay-like. Never break character.'"
}}
"""


def build_persona(client: ClusterClient, char: dict) -> dict:
    scenes = _gather_scenes(char)
    dossier = json.dumps({k: v for k, v in char.items() if k != "appearances"}, indent=2)
    return client.chat_json(
        [{"role": "user", "content": PERSONA_PROMPT.format(
            dossier=dossier, scenes=scenes, char_id=char["id"],
        )}],
        max_tokens=2500,
        temperature=0.5,
    )


def _to_markdown(p: dict) -> str:
    prims = "\n".join(f"- **{k}:** {v}/10" for k, v in p["personality_primitives"].items())
    speech = "\n".join(f"- {s}" for s in p["speech_patterns"])
    catch = "\n".join(f"- _\"{c}\"_" for c in p["catchphrases"])
    eng = ", ".join(p["triggers"]["engages_when"])
    der = ", ".join(p["triggers"]["derails_to"])
    return f"""# {p['display_name']}

> {p['one_liner']}

**Role:** {p['role']}
**Core motivation:** {p['core_motivation']}

## Personality primitives
{prims}

## Speech patterns
{speech}

## Catchphrases
{catch}

## Triggers
- **Engages when:** {eng}
- **Derails to:** {der}

## Meeting behavior
{p['meeting_behavior']}

## System prompt
```
{p['system_prompt']}
```
"""


def _build_one(client: ClusterClient, char: dict) -> tuple[str, Exception | None]:
    out_json = PERSONAS / f"{char['id']}.json"
    out_md = PERSONAS / f"{char['id']}.md"
    if out_json.exists():
        return (char["id"], None)
    try:
        p = build_persona(client, char)
    except Exception as e:
        return (char["id"], e)
    out_json.write_text(json.dumps(p, indent=2))
    out_md.write_text(_to_markdown(p))
    return (char["id"], None)


def run(concurrency: int = 4) -> None:
    ensure_dirs()
    chars_file = CHARACTERS / "characters.json"
    if not chars_file.exists():
        raise SystemExit(f"missing {chars_file} — run `larp-pipeline characters` first")
    characters = json.loads(chars_file.read_text())
    client = ClusterClient()
    todo = [c for c in characters["characters"] if not (PERSONAS / f"{c['id']}.json").exists()]
    console.print(f"[bold]{len(todo)}/{len(characters['characters'])} personas to build[/bold]")
    if concurrency > 1 and todo:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = {ex.submit(_build_one, client, c): c for c in todo}
            for f in as_completed(futs):
                cid, err = f.result()
                if err:
                    console.print(f"[red]{cid} failed: {err}[/red]")
                else:
                    console.print(f"  [green]✓[/green] {cid}")
    else:
        for char in todo:
            cid, err = _build_one(client, char)
            if err:
                console.print(f"[red]{cid} failed: {err}[/red]")
            else:
                console.print(f"  [green]✓[/green] {cid}")
    console.print(f"[bold green]done[/bold green]")

#!/usr/bin/env python3
"""Stage data/ files into app/public/ for Vercel/static deployment.

Vercel serves files under `public/` as CDN static assets (no 50MB
function-bundle limit, unlike serverless function payloads). This script
copies all media + JSON bundles we need at runtime so the client can
fetch them directly without going through Node API routes.

Idempotent — re-run any time the underlying data changes.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data"
PUBLIC = REPO / "app" / "public"


def copy_if_newer(src: Path, dst: Path) -> bool:
    if not src.exists():
        return False
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return True


def stage_sources() -> int:
    """data/raw/<vid>/<vid>.mp4 → app/public/source/<vid>.mp4"""
    out = PUBLIC / "source"
    out.mkdir(parents=True, exist_ok=True)
    count = 0
    for d in sorted((DATA / "raw").glob("*/")):
        if not d.is_dir():
            continue
        vid = d.name
        src = d / f"{vid}.mp4"
        if not src.exists():
            continue
        if copy_if_newer(src, out / f"{vid}.mp4"):
            count += 1
    return count


def stage_clips() -> int:
    """Mirror data/clips/ → app/public/clips/ (per-char mp4s + _audio m4a)"""
    out = PUBLIC / "clips"
    count = 0
    for p in (DATA / "clips").rglob("*"):
        if not p.is_file():
            continue
        if p.name.startswith("."):
            continue
        rel = p.relative_to(DATA / "clips")
        if copy_if_newer(p, out / rel):
            count += 1
    return count


def stage_grunts() -> int:
    """data/grunts/<char>/*.mp3 + sprite.json → app/public/grunts/"""
    out = PUBLIC / "grunts"
    count = 0
    for p in (DATA / "grunts").rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(DATA / "grunts")
        if copy_if_newer(p, out / rel):
            count += 1
    return count


def stage_chats() -> int:
    """data/chats/<vid>.json → app/public/chats/<vid>.json"""
    out = PUBLIC / "chats"
    count = 0
    for p in sorted((DATA / "chats").glob("*.json")):
        if copy_if_newer(p, out / p.name):
            count += 1
    return count


def stage_thumbs() -> int:
    """data/raw/<vid>/<vid>.jpg → app/public/thumbs/<vid>.jpg"""
    out = PUBLIC / "thumbs"
    count = 0
    for d in sorted((DATA / "raw").glob("*/")):
        if not d.is_dir():
            continue
        vid = d.name
        src = d / f"{vid}.jpg"
        if not src.exists():
            continue
        if copy_if_newer(src, out / f"{vid}.jpg"):
            count += 1
    return count


def stage_bundles() -> None:
    """Collapse tile docs + characters + personas into single JSON bundles
    so the client can load them in one fetch each."""
    PUBLIC.mkdir(parents=True, exist_ok=True)
    # Tile docs bundle
    tile_docs = []
    for p in sorted((DATA / "tiles").glob("*.json")):
        tile_docs.append(json.loads(p.read_text()))
    (PUBLIC / "tiles.json").write_text(json.dumps({"tiles": tile_docs}))

    # Characters + personas + grunts sprite — matches the /api/characters
    # response shape so client code works unchanged.
    characters_path = DATA / "characters" / "characters.json"
    grunt_sprite_path = DATA / "grunts" / "sprite.json"
    personas_dir = DATA / "personas"

    characters = []
    if characters_path.exists():
        characters = json.loads(characters_path.read_text()).get("characters", [])
    sprite = {}
    if grunt_sprite_path.exists():
        sprite = json.loads(grunt_sprite_path.read_text())

    packs = []
    for c in characters:
        cid = c.get("id")
        if not cid:
            continue
        persona = None
        persona_file = personas_dir / f"{cid}.json"
        if persona_file.exists():
            persona = json.loads(persona_file.read_text())
        packs.append(
            {
                "character": c,
                "persona": persona,
                "grunts": sprite.get(cid, []),
            }
        )
    (PUBLIC / "characters.json").write_text(
        json.dumps(
            {
                "count": len(packs),
                "pipeline_ready": True,
                "packs": packs,
            }
        )
    )

    # Clip index bundle — same shape as /api/clips GET (keyed by char_id,
    # with listen-folding of variants under archetypes).
    clips_dir = DATA / "clips"
    char_ids = {c["id"] for c in characters}
    clips: dict[str, list] = {}
    for d in sorted(clips_dir.iterdir()) if clips_dir.exists() else []:
        if not d.is_dir() or d.name.startswith(("_", ".")):
            continue
        entry_list = []
        for f in sorted(d.iterdir()):
            if not f.name.endswith(".mp4"):
                continue
            m = f.stem.rsplit("_", 1)
            if len(m) != 2 or not m[1].isdigit():
                continue
            vid, tile_idx = m[0], int(m[1])
            entry_list.append(
                {
                    "vid": vid,
                    "tile_idx": tile_idx,
                    "video_url": f"/clips/{d.name}/{f.name}",
                    "audio_url": f"/clips/_audio/{vid}.m4a",
                }
            )
        if not entry_list:
            continue
        entry_list.sort(key=lambda x: (x["vid"], x["tile_idx"]))
        clips[d.name] = entry_list
        # Fold under archetype too.
        parts = d.name.split("_")
        for i in range(len(parts) - 1, 0, -1):
            prefix = "_".join(parts[:i])
            if prefix != d.name and prefix in char_ids:
                clips.setdefault(prefix, []).extend(entry_list)
                break
    (PUBLIC / "clips-index.json").write_text(json.dumps({"clips": clips}))


def main() -> int:
    if not DATA.exists():
        print(f"[err] data dir not found: {DATA}", file=sys.stderr)
        return 1
    print(f"staging {DATA} → {PUBLIC}")
    n_src = stage_sources()
    n_clips = stage_clips()
    n_grunts = stage_grunts()
    n_chats = stage_chats()
    n_thumbs = stage_thumbs()
    stage_bundles()
    print(f"  sources: +{n_src}")
    print(f"  clips:   +{n_clips}")
    print(f"  grunts:  +{n_grunts}")
    print(f"  chats:   +{n_chats}")
    print(f"  thumbs:  +{n_thumbs}")
    print(f"  bundles: tiles.json, characters.json, clips-index.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { DATA_DIR, loadCharacters } from "@/lib/data";

// Returns an index of available clips per character:
//   { clips: { [character_id]: [{ vid, tile_idx, video_url, audio_url }] } }
//
// Clips are also exposed under their archetype id when the variant id has the
// form "<archetype>_<suffix>" and <archetype> is itself a character — so tiles
// cast as the archetype (e.g. cold_boss) can pull clips cut for their variant
// (cold_boss_ryan). Without this fold, tiles fall back to thumbnails because
// the pipeline only cuts clips keyed to tile-doc (variant) ids.

export const dynamic = "force-dynamic";

type ClipEntry = {
  vid: string;
  tile_idx: number;
  video_url: string;
  audio_url: string;
};

export async function GET() {
  const clipsDir = path.join(DATA_DIR, "clips");
  let charDirs: string[];
  try {
    charDirs = await fs.readdir(clipsDir);
  } catch {
    return NextResponse.json({ clips: {} });
  }

  const characters = await loadCharacters();
  const characterIds = new Set(characters.map((c) => c.id));

  const clips: Record<string, ClipEntry[]> = {};
  for (const entry of charDirs) {
    if (entry.startsWith("_") || entry.startsWith(".")) continue;
    const dir = path.join(clipsDir, entry);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const files = await fs.readdir(dir);
    const list: ClipEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".mp4")) continue;
      const m = /^(.+)_(\d+)\.mp4$/.exec(f);
      if (!m) continue;
      const vid = m[1];
      const tile_idx = parseInt(m[2]);
      list.push({
        vid,
        tile_idx,
        video_url: `/api/clips/${entry}/${f}`,
        audio_url: `/api/clips/_audio/${vid}.m4a`,
      });
    }
    if (list.length === 0) continue;
    list.sort((a, b) => a.vid.localeCompare(b.vid) || a.tile_idx - b.tile_idx);

    // Expose under the variant id itself.
    clips[entry] = (clips[entry] ?? []).concat(list);

    // Also fold under the longest archetype prefix that is a known character
    // (e.g. "cold_boss_ryan" -> "cold_boss"). Skip the variant id itself.
    const parts = entry.split("_");
    for (let i = parts.length - 1; i > 0; i--) {
      const prefix = parts.slice(0, i).join("_");
      if (prefix !== entry && characterIds.has(prefix)) {
        clips[prefix] = (clips[prefix] ?? []).concat(list);
        break;
      }
    }
  }

  return NextResponse.json({ clips });
}

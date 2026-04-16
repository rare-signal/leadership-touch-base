import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/data";

// Returns an index of available clips per character:
//   { clips: { [character_id]: [{ vid, tile_idx, video_url, audio_url }] } }
//
// Used by the meeting UI to pick video loops per tile and master audio per
// currently-speaking character.

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
    if (list.length > 0) {
      list.sort((a, b) => a.vid.localeCompare(b.vid) || a.tile_idx - b.tile_idx);
      clips[entry] = list;
    }
  }

  return NextResponse.json({ clips });
}

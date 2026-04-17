import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/data";

// Returns the pre-generated chat pack for a meeting (produced by the
// `larp-pipeline chats` stage). The meeting UI draws ambient chats from
// this pool during a call; live LLM generation is a fallback when the
// pool is exhausted or the user addresses a character directly.
//
// Shape:
//   {
//     "video_id": "...",
//     "cast": ["cold_boss_ryan", "bro_coworker_charles", ...],
//     "chats": [
//       { "sender": "<id>", "audience": "room"|"dm_to_user"|"dm_cast_to_cast",
//         "target": "<id>|null", "text": "..." },
//       ...
//     ]
//   }

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ vid: string }> }
) {
  const { vid } = await params;
  if (!/^[A-Za-z0-9_-]{3,24}$/.test(vid)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const abs = path.join(DATA_DIR, "chats", `${vid}.json`);
  try {
    const raw = await fs.readFile(abs, "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    // No pack yet → empty pool. Client falls back to live generation.
    return NextResponse.json({ video_id: vid, cast: [], chats: [] });
  }
}

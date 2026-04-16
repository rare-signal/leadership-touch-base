import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadTileDoc, saveTileDoc } from "@/lib/data";

export const dynamic = "force-dynamic";

const TileBoxSchema = z.object({
  idx: z.number().int(),
  row: z.number().int(),
  col: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
  character_id: z.string().nullable().optional(),
});

// Simplified schema: the pipeline seeds geometry + layout, and the UI edits
// character_id per tile. We accept just the tiles + optional notes.
const PutSchema = z.object({
  tiles: z.array(TileBoxSchema),
  notes: z.string().optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ vid: string }> }
) {
  const { vid } = await params;
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(vid)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  let parsed;
  try {
    parsed = PutSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: "bad_request", detail: String(e) }, { status: 400 });
  }

  const current = await loadTileDoc(vid);
  if (!current) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Rebuild the character_id_by_tile mirror from the tiles' character_id.
  const idByTile: Record<string, string> = {};
  for (const t of parsed.tiles) {
    if (t.character_id) idByTile[String(t.idx)] = t.character_id;
  }

  const next = {
    ...current,
    tiles: parsed.tiles,
    character_id_by_tile: idByTile,
    notes: parsed.notes ?? current.notes,
  };
  await saveTileDoc(vid, next);
  return NextResponse.json({ ok: true, tiles: next });
}

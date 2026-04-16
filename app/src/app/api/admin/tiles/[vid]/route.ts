import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadTileDoc, saveTileDoc } from "@/lib/data";

export const dynamic = "force-dynamic";

const LAYOUTS = ["skip", "1x1", "1x2", "2x1", "2x2", "1x3", "3x1", "2x3", "3x2"] as const;

const TileBoxSchema = z.object({
  idx: z.number().int(),
  row: z.number().int(),
  col: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
});

const PutSchema = z.object({
  layout: z.enum(LAYOUTS),
  source_size: z.tuple([z.number().int(), z.number().int()]),
  content_bbox: z.tuple([
    z.number().int(),
    z.number().int(),
    z.number().int(),
    z.number().int(),
  ]),
  tiles: z.array(TileBoxSchema),
  character_id_by_tile: z.record(z.string(), z.string()),
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
  const next = {
    ...current,
    layout: parsed.layout,
    source_size: parsed.source_size,
    content_bbox: parsed.content_bbox,
    tiles: parsed.tiles,
    character_id_by_tile: parsed.character_id_by_tile,
    notes: parsed.notes ?? current.notes,
    confidence: current.confidence,
  };
  await saveTileDoc(vid, next);
  return NextResponse.json({ ok: true, tiles: next });
}

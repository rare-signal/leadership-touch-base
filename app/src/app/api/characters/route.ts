import { NextResponse } from "next/server";
import { loadCharacterPacks } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const packs = await loadCharacterPacks();
  return NextResponse.json({
    count: packs.length,
    pipeline_ready: packs.length > 0 && packs.every((p) => !!p.persona),
    packs,
  });
}

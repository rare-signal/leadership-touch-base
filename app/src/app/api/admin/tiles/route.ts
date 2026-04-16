import { NextResponse } from "next/server";
import { loadAllTileDocs, loadCharacters } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const [docs, characters] = await Promise.all([
    loadAllTileDocs(),
    loadCharacters(),
  ]);
  return NextResponse.json({
    tiles: docs,
    characters: characters.map((c) => ({
      id: c.id,
      display_name: c.display_name,
    })),
  });
}

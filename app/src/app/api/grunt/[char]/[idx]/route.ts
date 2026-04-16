import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, safeId } from "@/lib/data";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ char: string; idx: string }> }
) {
  const { char, idx } = await params;
  const safeChar = safeId(char);
  const safeIdx = /^\d+$/.test(idx) ? idx : "";
  if (!safeChar || !safeIdx) return new NextResponse("bad id", { status: 400 });
  const file = path.join(DATA_DIR, "grunts", safeChar, `${safeIdx}.mp3`);
  try {
    const buf = await fs.readFile(file);
    const body = new Uint8Array(buf);
    return new NextResponse(body, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}

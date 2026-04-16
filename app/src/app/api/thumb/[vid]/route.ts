import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/data";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ vid: string }> }
) {
  const { vid } = await params;
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(vid)) {
    return new NextResponse("bad id", { status: 400 });
  }
  const file = path.join(DATA_DIR, "raw", vid, `${vid}.jpg`);
  try {
    const buf = await fs.readFile(file);
    const body = new Uint8Array(buf);
    return new NextResponse(body, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}

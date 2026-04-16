import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import { DATA_DIR } from "@/lib/data";

// Serves per-character clip MP4s and master audio tracks from data/clips/.
// Path shape: /api/clips/<character_id_or_folder>/<filename>
// e.g.  /api/clips/cold_boss_ryan/0JQkAxmLzhM_1.mp4
//       /api/clips/_audio/0JQkAxmLzhM.m4a
//
// Supports HTTP range requests so <video> and <audio> can seek and stream.

const ALLOWED_EXT = new Set([".mp4", ".m4a", ".webm", ".mp3", ".ogg"]);

function contentType(ext: string): string {
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".m4a":
      return "audio/mp4";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segs } = await params;
  // Basic path safety: each segment must be a simple filename
  for (const s of segs) {
    if (!/^[A-Za-z0-9._\-]+$/.test(s)) {
      return new NextResponse("bad path", { status: 400 });
    }
  }
  const rel = segs.join("/");
  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return new NextResponse("bad extension", { status: 400 });
  }

  const abs = path.join(DATA_DIR, "clips", rel);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
  if (!stat.isFile()) return new NextResponse("not a file", { status: 404 });

  const range = req.headers.get("range");
  const total = stat.size;

  const headersBase: Record<string, string> = {
    "Content-Type": contentType(ext),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };

  if (!range) {
    // Full file — stream it.
    const nodeStream = createReadStream(abs);
    const web = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return new NextResponse(web, {
      status: 200,
      headers: {
        ...headersBase,
        "Content-Length": String(total),
      },
    });
  }

  // Parse "bytes=start-end"
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) return new NextResponse("bad range", { status: 416 });
  const start = m[1] ? parseInt(m[1]) : 0;
  const end = m[2] ? parseInt(m[2]) : total - 1;
  if (isNaN(start) || isNaN(end) || start > end || end >= total) {
    return new NextResponse("bad range", {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }
  const chunkLen = end - start + 1;
  const nodeStream = createReadStream(abs, { start, end });
  const web = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  return new NextResponse(web, {
    status: 206,
    headers: {
      ...headersBase,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(chunkLen),
    },
  });
}

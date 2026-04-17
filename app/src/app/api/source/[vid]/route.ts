import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import { DATA_DIR } from "@/lib/data";

// Streams the full raw source video at data/raw/<vid>/<vid>.mp4 with Range
// support. The meeting UI renders every tile by CSS-cropping the source to
// its bbox region (instead of requiring per-tile pre-cut clips), so that
// untagged tiles fill in too and bbox nudges in /admin/tiles apply to all
// tiles immediately without re-running the pipeline.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ vid: string }> }
) {
  const { vid } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(vid)) {
    return new NextResponse("bad vid", { status: 400 });
  }
  const abs = path.join(DATA_DIR, "raw", vid, `${vid}.mp4`);
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
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };

  if (!range) {
    const nodeStream = createReadStream(abs);
    const web = Readable.toWeb(
      nodeStream
    ) as unknown as ReadableStream<Uint8Array>;
    return new NextResponse(web, {
      status: 200,
      headers: { ...headersBase, "Content-Length": String(total) },
    });
  }

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
  const web = Readable.toWeb(
    nodeStream
  ) as unknown as ReadableStream<Uint8Array>;
  return new NextResponse(web, {
    status: 206,
    headers: {
      ...headersBase,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(chunkLen),
    },
  });
}

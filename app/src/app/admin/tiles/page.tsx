"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TileBox, TileDoc } from "@/lib/types";

type Roster = { id: string; display_name: string }[];

// Same target aspect the meeting grid renders every tile at — keeps the
// admin live preview visually identical to what /meeting will show.
const TILE_DISPLAY_ASPECT = 1.15;

export default function TilesAdminPage() {
  const [docs, setDocs] = useState<TileDoc[]>([]);
  const [roster, setRoster] = useState<Roster>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/tiles")
      .then((r) => r.json())
      .then((d) => {
        setDocs(d.tiles ?? []);
        setRoster(d.characters ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-8 text-sm text-zinc-400">Loading tiles…</div>;
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tile tagger</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Each video was seeded with a best-guess layout + character assignments
            from a visual pass. Confirm or correct each tile&apos;s character, then Save.
            Unassigned tiles (amber) won&apos;t be cut into clips.
          </p>
        </div>
        <Stats docs={docs} />
      </header>

      <div className="space-y-8">
        {docs.map((doc) => (
          <VideoCard
            key={doc.video_id}
            doc={doc}
            roster={roster}
            onSaved={(next) =>
              setDocs((ds) => ds.map((d) => (d.video_id === next.video_id ? next : d)))
            }
          />
        ))}
      </div>
    </main>
  );
}

function Stats({ docs }: { docs: TileDoc[] }) {
  const totalTiles = docs.reduce((acc, d) => acc + d.tiles.length, 0);
  const tagged = docs.reduce(
    (acc, d) => acc + d.tiles.filter((t) => t.character_id).length,
    0
  );
  const perChar: Record<string, number> = {};
  for (const d of docs) {
    for (const t of d.tiles) {
      if (t.character_id) perChar[t.character_id] = (perChar[t.character_id] ?? 0) + 1;
    }
  }
  const topChars = Object.entries(perChar)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  return (
    <div className="rounded-lg border bg-zinc-900/60 px-4 py-2 text-right">
      <div className="text-xs text-zinc-400">tiles tagged</div>
      <div className="text-lg font-semibold tabular-nums">
        {tagged}
        <span className="text-zinc-500">/{totalTiles}</span>
      </div>
      {topChars.length > 0 && (
        <div className="mt-1 text-[10px] text-zinc-500">
          {topChars.map(([cid, n]) => `${cid}:${n}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

function parseRC(layout: string): [number, number] {
  const m = layout.match(/^(\d+)x(\d+)$/);
  if (!m) return [1, 1];
  return [parseInt(m[1]), parseInt(m[2])];
}

function reflowTiles(
  bbox: [number, number, number, number],
  rows: number,
  cols: number,
  prev: TileBox[],
): TileBox[] {
  const [bx, by, bw, bh] = bbox;
  const tileW = Math.floor(bw / cols);
  const tileH = Math.floor(bh / rows);
  const margin = 6;
  const out: TileBox[] = [];
  let idx = 0;
  const prevById = new Map(prev.map((t) => [t.idx, t]));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const old = prevById.get(idx);
      out.push({
        idx,
        row: r,
        col: c,
        x: bx + c * tileW + margin,
        y: by + r * tileH + margin,
        w: tileW - margin * 2,
        h: tileH - margin * 2,
        character_id: old?.character_id ?? null,
      });
      idx++;
    }
  }
  return out;
}

function VideoCard({
  doc,
  roster,
  onSaved,
}: {
  doc: TileDoc;
  roster: Roster;
  onSaved: (next: TileDoc) => void;
}) {
  const [tiles, setTiles] = useState<TileBox[]>(doc.tiles);
  const [bbox, setBbox] = useState<[number, number, number, number]>(doc.content_bbox);
  const [layout, setLayout] = useState<string>(doc.layout);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () =>
      JSON.stringify(tiles) !== JSON.stringify(doc.tiles) ||
      JSON.stringify(bbox) !== JSON.stringify(doc.content_bbox) ||
      layout !== doc.layout,
    [tiles, bbox, layout, doc]
  );

  const setTileChar = useCallback((idx: number, cid: string | null) => {
    setTiles((ts) =>
      ts.map((t) => (t.idx === idx ? { ...t, character_id: cid } : t))
    );
  }, []);

  const nudgeBbox = useCallback(
    (dx: number, dy: number, dw: number, dh: number) => {
      setBbox(([x, y, w, h]) => {
        const next: [number, number, number, number] = [x + dx, y + dy, w + dw, h + dh];
        setTiles((prev) => reflowTiles(next, ...parseRC(layout), prev));
        return next;
      });
    },
    [layout]
  );

  const setBboxField = useCallback(
    (idx: 0 | 1 | 2 | 3, val: number) => {
      setBbox((prev) => {
        const next = [...prev] as [number, number, number, number];
        next[idx] = val;
        setTiles((p) => reflowTiles(next, ...parseRC(layout), p));
        return next;
      });
    },
    [layout]
  );

  const setLayoutAndReflow = useCallback(
    (next: string) => {
      setLayout(next);
      setTiles((p) => reflowTiles(bbox, ...parseRC(next), p));
    },
    [bbox]
  );

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/admin/tiles/${doc.video_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tiles,
          layout,
          content_bbox: bbox,
          notes: doc.notes,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.detail ?? j.error ?? `HTTP ${res.status}`);
      onSaved(j.tiles as TileDoc);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [doc, tiles, bbox, layout, onSaved]);

  const [sw, sh] = doc.source_size;
  const tagged = tiles.filter((t) => t.character_id).length;

  return (
    <section className="rounded-xl border bg-zinc-950 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            video_id
          </div>
          <code className="text-sm text-zinc-200">{doc.video_id}</code>
          <span className="ml-2 text-xs text-zinc-500">
            {sw}×{sh} · {doc.layout} · {tagged}/{tiles.length} tagged
          </span>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
              {tiles.length}-person meeting
            </span>
            {layout === "2x2" && (
              <span className="ml-1.5 text-zinc-500">
                (small grid — different bbox than 2x3)
              </span>
            )}
            {layout === "2x3" && (
              <span className="ml-1.5 text-zinc-500">
                (big grid — different bbox than 2x2)
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CopyStateButton
            videoId={doc.video_id}
            sourceSize={doc.source_size}
            layout={layout}
            bbox={bbox}
            tiles={tiles}
          />
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? "…" : saved && !dirty ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      <GeometryEditor
        bbox={bbox}
        layout={layout}
        sourceSize={[sw, sh]}
        onBboxField={setBboxField}
        onNudge={nudgeBbox}
        onLayoutChange={setLayoutAndReflow}
      />

      <LiveMeetingPreview
        videoId={doc.video_id}
        sourceSize={[sw, sh]}
        tiles={tiles}
        onNudge={nudgeBbox}
        layout={layout}
      />

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PreviewCanvas
          vid={doc.video_id}
          sourceSize={[sw, sh]}
          tiles={tiles}
          rosterById={Object.fromEntries(roster.map((r) => [r.id, r.display_name]))}
        />

        <div>
          {error && (
            <div className="mb-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
          {tiles.length === 0 ? (
            <p className="text-sm text-zinc-500">No tiles seeded for this video.</p>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-zinc-500">
                assign each tile to a character:
              </div>
              {tiles.map((t) => (
                <div
                  key={t.idx}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 ${
                    t.character_id
                      ? "border-sky-500/30 bg-sky-950/20"
                      : "border-amber-500/20 bg-amber-950/10"
                  }`}
                >
                  <div className="w-8 font-mono text-xs text-sky-400">
                    #{t.idx}
                  </div>
                  <div className="w-14 text-xs text-zinc-500">
                    r{t.row}c{t.col}
                  </div>
                  <select
                    value={t.character_id ?? ""}
                    onChange={(e) =>
                      setTileChar(t.idx, e.target.value || null)
                    }
                    className="flex-1 rounded-md border bg-zinc-950 px-2 py-1 text-sm"
                  >
                    <option value="">— none —</option>
                    {roster.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function GeometryEditor({
  bbox,
  layout,
  sourceSize,
  onBboxField,
  onNudge,
  onLayoutChange,
}: {
  bbox: [number, number, number, number];
  layout: string;
  sourceSize: [number, number];
  onBboxField: (idx: 0 | 1 | 2 | 3, val: number) => void;
  onNudge: (dx: number, dy: number, dw: number, dh: number) => void;
  onLayoutChange: (next: string) => void;
}) {
  const [bx, by, bw, bh] = bbox;
  const [sw, sh] = sourceSize;
  const labels: [string, number][] = [
    ["x", bx],
    ["y", by],
    ["w", bw],
    ["h", bh],
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
      <span className="mr-1 uppercase tracking-wide text-zinc-500">grid</span>
      <select
        value={layout}
        onChange={(e) => onLayoutChange(e.target.value)}
        className="rounded border bg-zinc-950 px-2 py-1 text-xs"
      >
        {["1x1", "1x2", "2x1", "2x2", "1x3", "3x1", "2x3", "3x2"].map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <span className="ml-3 uppercase tracking-wide text-zinc-500">bbox</span>
      {labels.map(([lbl, val], i) => (
        <label key={lbl} className="flex items-center gap-1">
          <span className="font-mono text-zinc-500">{lbl}</span>
          <input
            type="number"
            value={val}
            onChange={(e) => onBboxField(i as 0 | 1 | 2 | 3, parseInt(e.target.value) || 0)}
            className="w-16 rounded border bg-zinc-950 px-1.5 py-0.5 text-xs tabular-nums"
          />
        </label>
      ))}
      <span className="ml-2 text-[10px] text-zinc-600">
        of {sw}×{sh}
      </span>
      <div className="ml-3 flex items-center gap-1">
        <span className="text-[10px] uppercase text-zinc-500">nudge&nbsp;y</span>
        <button
          type="button"
          onClick={() => onNudge(0, -20, 0, 0)}
          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-xs hover:bg-zinc-700"
          title="move bbox up 20px"
        >
          ↑20
        </button>
        <button
          type="button"
          onClick={() => onNudge(0, 20, 0, 0)}
          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-xs hover:bg-zinc-700"
          title="move bbox down 20px"
        >
          ↓20
        </button>
        <span className="ml-2 text-[10px] uppercase text-zinc-500">h</span>
        <button
          type="button"
          onClick={() => onNudge(0, 0, 0, -20)}
          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-xs hover:bg-zinc-700"
          title="shrink height 20px"
        >
          −20
        </button>
        <button
          type="button"
          onClick={() => onNudge(0, 0, 0, 20)}
          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-xs hover:bg-zinc-700"
          title="grow height 20px"
        >
          +20
        </button>
      </div>
    </div>
  );
}

// Copies the current in-memory tile doc as a JSON snippet suitable for
// pasting back to the assistant. Includes source_size + content_bbox +
// per-tile x/y/w/h/character so defaults can be baked in without ambiguity.
function CopyStateButton({
  videoId,
  sourceSize,
  layout,
  bbox,
  tiles,
}: {
  videoId: string;
  sourceSize: [number, number];
  layout: string;
  bbox: [number, number, number, number];
  tiles: TileBox[];
}) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    const payload = {
      video_id: videoId,
      source_size: sourceSize,
      layout,
      content_bbox: bbox,
      tiles: tiles.map((t) => ({
        idx: t.idx,
        row: t.row,
        col: t.col,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
        character_id: t.character_id ?? null,
      })),
    };
    navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={onClick}
      title="Copy current state as JSON (for baking defaults)"
    >
      {copied ? "Copied ✓" : "Copy"}
    </Button>
  );
}

// A mini version of the meeting grid — one <video> per card, every tile
// canvas drawImage's its bbox region each rAF using the same fixed-aspect
// center-crop math as <ParticipantTile>. Nudging bbox values updates all
// tiles live so you can see exactly what /meeting will render.
function LiveMeetingPreview({
  videoId,
  sourceSize,
  tiles,
  onNudge,
  layout,
}: {
  videoId: string;
  sourceSize: [number, number];
  tiles: TileBox[];
  onNudge: (dx: number, dy: number, dw: number, dh: number) => void;
  layout: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!on) return;
    const v = videoRef.current;
    if (!v) return;
    const tryPlay = () => v.play().catch(() => {});
    v.addEventListener("loadedmetadata", tryPlay, { once: true });
    if (v.readyState >= 1) tryPlay();
    return () => v.removeEventListener("loadedmetadata", tryPlay);
  }, [on]);

  return (
    <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">
          live preview · {tiles.length}-person ({layout})
        </div>
        <div className="flex items-center gap-1">
          <NudgeGroup label="move ↕" onNudge={(dy) => onNudge(0, dy, 0, 0)} />
          <NudgeGroup label="height" onNudge={(d) => onNudge(0, 0, 0, d)} />
          <button
            type="button"
            onClick={() => setOn((x) => !x)}
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] hover:bg-zinc-700"
          >
            {on ? "Stop" : "Play"}
          </button>
        </div>
      </div>
      {on ? (
        <>
          <video
            ref={videoRef}
            src={`/api/source/${videoId}`}
            className="pointer-events-none fixed left-0 top-0 h-[1px] w-[1px] opacity-0"
            muted
            playsInline
            preload="auto"
          />
          <div className="flex flex-wrap gap-2">
            {tiles.map((t) => (
              <LiveTilePreview
                key={t.idx}
                videoRef={videoRef}
                sourceSize={sourceSize}
                tile={t}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="text-[11px] text-zinc-500">
          Click Play to load the source video and see each tile exactly as the
          meeting grid will render it. Nudge buttons above adjust the whole
          grid — tiles update live.
        </p>
      )}
    </div>
  );
}

function NudgeGroup({
  label,
  onNudge,
  step = 10,
}: {
  label: string;
  onNudge: (delta: number) => void;
  step?: number;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px]">
      <span className="mr-1 text-zinc-500">{label}</span>
      <button
        type="button"
        onClick={() => onNudge(-step)}
        className="rounded px-1 hover:bg-zinc-700"
        title={`${label} −${step}`}
      >
        −{step}
      </button>
      <button
        type="button"
        onClick={() => onNudge(+step)}
        className="rounded px-1 hover:bg-zinc-700"
        title={`${label} +${step}`}
      >
        +{step}
      </button>
    </div>
  );
}

function LiveTilePreview({
  videoRef,
  sourceSize,
  tile,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  sourceSize: [number, number];
  tile: TileBox;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  void sourceSize;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = Math.max(1, Math.round(tile.w));
    canvas.height = Math.max(1, Math.round(tile.w / TILE_DISPLAY_ASPECT));

    const srcAspect = tile.w / tile.h;
    let sx = tile.x;
    let sy = tile.y;
    let sw = tile.w;
    let sh = tile.h;
    if (srcAspect > TILE_DISPLAY_ASPECT) {
      const newW = tile.h * TILE_DISPLAY_ASPECT;
      sx = tile.x + (tile.w - newW) / 2;
      sw = newW;
    } else if (srcAspect < TILE_DISPLAY_ASPECT) {
      const newH = tile.w / TILE_DISPLAY_ASPECT;
      sy = tile.y + (tile.h - newH) / 2;
      sh = newH;
    }

    let raf = 0;
    const draw = () => {
      const v = videoRef.current;
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        try {
          ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        } catch {}
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tile.x, tile.y, tile.w, tile.h, videoRef]);

  return (
    <div
      className={`relative overflow-hidden rounded border ${
        tile.character_id ? "border-sky-500/60" : "border-amber-500/40"
      } bg-zinc-950`}
      style={{ width: 120, aspectRatio: TILE_DISPLAY_ASPECT }}
      title={`#${tile.idx} ${tile.character_id ?? "unassigned"}`}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <span className="absolute bottom-0 left-0 rounded-tr bg-black/70 px-1 text-[9px] text-zinc-200">
        #{tile.idx} {tile.character_id ?? "?"}
      </span>
    </div>
  );
}

function PreviewCanvas({
  vid,
  sourceSize,
  tiles,
  rosterById,
}: {
  vid: string;
  sourceSize: [number, number];
  tiles: TileBox[];
  rosterById: Record<string, string>;
}) {
  const [sw, sh] = sourceSize;
  return (
    <div className="relative overflow-hidden rounded-lg border bg-black">
      <img
        src={`/api/tiles/preview/${vid}`}
        alt={vid}
        className="block w-full h-auto"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ aspectRatio: `${sw} / ${sh}` }}
      >
        {tiles.map((t) => {
          const label = t.character_id
            ? rosterById[t.character_id] ?? t.character_id
            : "?";
          return (
            <div
              key={t.idx}
              className={`absolute rounded-[2px] border-2 ${
                t.character_id
                  ? "border-sky-400 bg-sky-400/10"
                  : "border-amber-400/80 bg-amber-400/10"
              }`}
              style={{
                left: `${(t.x / sw) * 100}%`,
                top: `${(t.y / sh) * 100}%`,
                width: `${(t.w / sw) * 100}%`,
                height: `${(t.h / sh) * 100}%`,
              }}
            >
              <span
                className={`absolute top-0 left-0 rounded-br px-1.5 py-0.5 text-[10px] font-semibold text-white ${
                  t.character_id ? "bg-sky-500/90" : "bg-amber-500/90"
                }`}
              >
                {t.idx}:{label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TileBox, TileDoc } from "@/lib/types";

type Roster = { id: string; display_name: string }[];

const LAYOUTS = [
  "skip",
  "1x1",
  "1x2",
  "2x1",
  "2x2",
  "1x3",
  "3x1",
  "2x3",
  "3x2",
] as const;

function rowsCols(layout: string): [number, number] | null {
  const m = layout.match(/^(\d+)x(\d+)$/);
  return m ? [parseInt(m[1]), parseInt(m[2])] : null;
}

/** Given a layout template + content_bbox, produce tile bboxes that evenly
 * divide the content_bbox. We leave a small internal margin so adjacent tile
 * crops don't bleed into each other's gutter. */
function tilesFromLayout(
  layout: string,
  bbox: [number, number, number, number]
): TileBox[] {
  const rc = rowsCols(layout);
  if (!rc) return [];
  const [rows, cols] = rc;
  const [bx, by, bw, bh] = bbox;
  const tileW = Math.floor(bw / cols);
  const tileH = Math.floor(bh / rows);
  const margin = 4;
  const out: TileBox[] = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        idx,
        row: r,
        col: c,
        x: bx + c * tileW + margin,
        y: by + r * tileH + margin,
        w: tileW - margin * 2,
        h: tileH - margin * 2,
      });
      idx++;
    }
  }
  return out;
}

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
            For each source video, pick the grid layout and assign a character
            to each tile. Saves to <code className="text-xs">data/tiles/&lt;vid&gt;.json</code>.
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
  const total = docs.length;
  const tagged = docs.filter(
    (d) =>
      d.layout !== "1x1" &&
      d.layout !== "skip" &&
      d.tiles.every((t) => d.character_id_by_tile?.[String(t.idx)])
  ).length;
  const skipped = docs.filter((d) => d.layout === "skip").length;
  return (
    <div className="rounded-lg border bg-zinc-900/60 px-4 py-2 text-right">
      <div className="text-xs text-zinc-400">progress</div>
      <div className="text-lg font-semibold tabular-nums">
        {tagged}
        <span className="text-zinc-500">/{total - skipped}</span>
      </div>
    </div>
  );
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
  const [layout, setLayout] = useState<string>(doc.layout);
  const [tiles, setTiles] = useState<TileBox[]>(doc.tiles);
  const [assignments, setAssignments] = useState<Record<string, string>>(
    doc.character_id_by_tile ?? {}
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    return (
      layout !== doc.layout ||
      JSON.stringify(tiles) !== JSON.stringify(doc.tiles) ||
      JSON.stringify(assignments) !== JSON.stringify(doc.character_id_by_tile ?? {})
    );
  }, [layout, tiles, assignments, doc]);

  const onPickLayout = useCallback(
    (next: string) => {
      setLayout(next);
      if (next === "skip") {
        setTiles([]);
        setAssignments({});
        return;
      }
      const nextTiles = tilesFromLayout(next, doc.content_bbox);
      setTiles(nextTiles);
      // Trim assignments that no longer correspond to an existing tile idx.
      const validIdx = new Set(nextTiles.map((t) => String(t.idx)));
      const trimmed: Record<string, string> = {};
      for (const [k, v] of Object.entries(assignments)) {
        if (validIdx.has(k)) trimmed[k] = v;
      }
      setAssignments(trimmed);
    },
    [doc.content_bbox, assignments]
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
          layout,
          source_size: doc.source_size,
          content_bbox: doc.content_bbox,
          tiles,
          character_id_by_tile: assignments,
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
  }, [doc, layout, tiles, assignments, onSaved]);

  const [sw, sh] = doc.source_size;

  return (
    <section className="rounded-xl border bg-zinc-950 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            video_id
          </div>
          <code className="text-sm text-zinc-200">{doc.video_id}</code>
          <span className="ml-2 text-xs text-zinc-500">
            {sw}×{sh}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={layout}
            onChange={(e) => onPickLayout(e.target.value)}
            className="rounded-md border bg-zinc-900 px-2 py-1 text-sm"
          >
            {LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? "…" : saved && !dirty ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PreviewCanvas
          vid={doc.video_id}
          sourceSize={[sw, sh]}
          tiles={tiles}
        />

        <div>
          {error && (
            <div className="mb-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
          {layout === "skip" ? (
            <p className="text-sm text-zinc-500">
              Skipped — not using this video as a clip source.
            </p>
          ) : tiles.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Pick a layout to generate tile bboxes.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-zinc-500">
                assign each tile to a character:
              </div>
              {tiles.map((t) => (
                <div
                  key={t.idx}
                  className="flex items-center gap-2 rounded-md border bg-zinc-900/60 px-3 py-2"
                >
                  <div className="w-8 font-mono text-xs text-sky-400">
                    #{t.idx}
                  </div>
                  <div className="text-xs text-zinc-500 w-20">
                    r{t.row}c{t.col}
                  </div>
                  <select
                    value={assignments[String(t.idx)] ?? ""}
                    onChange={(e) =>
                      setAssignments((a) => ({
                        ...a,
                        [String(t.idx)]: e.target.value,
                      }))
                    }
                    className="flex-1 rounded-md border bg-zinc-950 px-2 py-1 text-sm"
                  >
                    <option value="">— choose —</option>
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

function PreviewCanvas({
  vid,
  sourceSize,
  tiles,
}: {
  vid: string;
  sourceSize: [number, number];
  tiles: TileBox[];
}) {
  const [sw, sh] = sourceSize;
  // Render preview image; overlay tile bboxes scaled to the rendered img size.
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
        {tiles.map((t) => (
          <div
            key={t.idx}
            className="absolute rounded-[2px] border-2 border-sky-400 bg-sky-400/10"
            style={{
              left: `${(t.x / sw) * 100}%`,
              top: `${(t.y / sh) * 100}%`,
              width: `${(t.w / sw) * 100}%`,
              height: `${(t.h / sh) * 100}%`,
            }}
          >
            <span className="absolute -top-5 left-0 rounded bg-sky-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {t.idx}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

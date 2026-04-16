"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TileBox, TileDoc } from "@/lib/types";

type Roster = { id: string; display_name: string }[];

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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(tiles) !== JSON.stringify(doc.tiles),
    [tiles, doc.tiles]
  );

  const setTileChar = useCallback((idx: number, cid: string | null) => {
    setTiles((ts) =>
      ts.map((t) => (t.idx === idx ? { ...t, character_id: cid } : t))
    );
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/admin/tiles/${doc.video_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiles, notes: doc.notes }),
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
  }, [doc, tiles, onSaved]);

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
        </div>
        <div className="flex items-center gap-2">
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

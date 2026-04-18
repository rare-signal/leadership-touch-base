"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TileBox, TileDoc } from "@/lib/types";

// Tool for marking per-tile "listen" and "concurrence" time ranges within a
// source video. The meeting UI uses these to choreograph a "you unmute,
// everyone listens → you stop, everyone nods" sequence.
//
// Workflow:
//   1. Pick a video from the list
//   2. Scrub the source to a moment where tile N is silently listening
//   3. Click `Listen In` on tile N → stamps the current video time
//   4. Scrub forward 1-3s to the end of that listening shot
//   5. Click `Listen Out` on tile N
//   6. Repeat for `Concur In/Out` on a nodding moment
//   7. Repeat for every tile
//   8. Save — persists to data/tiles/<vid>.json via the admin API
//   9. Optional: Copy → JSON snippet for the assistant to bake in

const TILE_DISPLAY_ASPECT = 1.15;

export default function RangesAdminPage() {
  const [docs, setDocs] = useState<TileDoc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/tiles")
      .then((r) => r.json())
      .then((d) => setDocs(d.tiles ?? []));
  }, []);

  const current = docs.find((d) => d.video_id === selected) ?? null;

  return (
    <main className="mx-auto max-w-7xl p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Range marker</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Mark per-tile Listen + Concurrence time ranges within each source
          video. These drive the "you start talking → everyone listens" and
          "you stop talking → everyone nods" loops in the meeting UI.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-1">
        {docs
          .filter((d) => d.tiles.some((t) => t.character_id))
          .map((d) => {
            const total = d.tiles.length;
            const withListen = d.tiles.filter((t) => t.listen_range).length;
            const withConcur = d.tiles.filter((t) => t.concur_range).length;
            const active = selected === d.video_id;
            return (
              <button
                key={d.video_id}
                type="button"
                onClick={() => setSelected(d.video_id)}
                className={`rounded border px-2 py-1 text-[11px] font-mono ${
                  active
                    ? "border-sky-400 bg-sky-500/20 text-sky-200"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                }`}
                title={`${total} tiles · Listen ${withListen}/${total} · Concur ${withConcur}/${total}`}
              >
                {d.video_id}
                <span className="ml-1 text-zinc-500">
                  · {withListen}/{total}L · {withConcur}/{total}C
                </span>
              </button>
            );
          })}
      </div>

      {current ? (
        <RangeEditor
          key={current.video_id}
          doc={current}
          onSaved={(next) =>
            setDocs((ds) =>
              ds.map((d) => (d.video_id === next.video_id ? next : d))
            )
          }
        />
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-8 text-center text-zinc-400">
          Pick a video above.
        </div>
      )}
    </main>
  );
}

function fmt(t: number | undefined): string {
  if (t === undefined || !isFinite(t)) return "—";
  const s = t.toFixed(2);
  return `${s}s`;
}

function RangeEditor({
  doc,
  onSaved,
}: {
  doc: TileDoc;
  onSaved: (next: TileDoc) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sharedVideoRef = videoRef; // alias for clarity when passing down
  const [tiles, setTiles] = useState<TileBox[]>(doc.tiles);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewingTile, setPreviewingTile] = useState<{
    idx: number;
    kind: "listen" | "concur";
  } | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(tiles) !== JSON.stringify(doc.tiles),
    [tiles, doc.tiles]
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => setDuration(v.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, []);

  // Preview loop: if a tile's range is being previewed, seek back into the
  // range whenever the video ticks past its end.
  useEffect(() => {
    if (!previewingTile) return;
    const t = tiles.find((x) => x.idx === previewingTile.idx);
    if (!t) return;
    const range =
      previewingTile.kind === "listen" ? t.listen_range : t.concur_range;
    if (!range) return;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = range[0];
    v.play().catch(() => {});
    const tick = () => {
      if (!videoRef.current) return;
      if (videoRef.current.currentTime >= range[1]) {
        videoRef.current.currentTime = range[0];
      }
    };
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [previewingTile, tiles]);

  const stamp = (idx: number, kind: "listen" | "concur", edge: 0 | 1) => {
    const v = videoRef.current;
    if (!v) return;
    const t = v.currentTime;
    setTiles((prev) =>
      prev.map((tile) => {
        if (tile.idx !== idx) return tile;
        const key = kind === "listen" ? "listen_range" : "concur_range";
        const existing = tile[key] ?? [0, 0];
        const next: [number, number] =
          edge === 0 ? [t, existing[1]] : [existing[0], t];
        // Clamp: ensure start <= end
        if (next[0] > next[1]) next[1] = next[0];
        return { ...tile, [key]: next };
      })
    );
  };

  const clearRange = (idx: number, kind: "listen" | "concur") => {
    setTiles((prev) =>
      prev.map((tile) => {
        if (tile.idx !== idx) return tile;
        const next = { ...tile };
        if (kind === "listen") delete next.listen_range;
        else delete next.concur_range;
        return next;
      })
    );
  };

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration || 0, t));
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tiles/${doc.video_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tiles,
          layout: doc.layout,
          content_bbox: doc.content_bbox,
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
  };

  const copyJson = () => {
    const payload = {
      video_id: doc.video_id,
      tiles: tiles
        .filter((t) => t.listen_range || t.concur_range)
        .map((t) => ({
          idx: t.idx,
          character_id: t.character_id ?? null,
          listen_range: t.listen_range,
          concur_range: t.concur_range,
        })),
    };
    navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .catch(() => {});
  };

  return (
    <section className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        <video
          ref={videoRef}
          src={`/api/source/${doc.video_id}`}
          className="w-full rounded-lg bg-black"
          playsInline
          controls
        />
        <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              if (v.paused) v.play();
              else v.pause();
            }}
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <span className="font-mono tabular-nums">
            {fmt(currentTime)} / {fmt(duration)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={currentTime}
            onChange={(e) => seek(parseFloat(e.target.value))}
            className="flex-1"
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || saving}
          >
            {saving ? "…" : saved && !dirty ? "Saved" : "Save"}
          </Button>
          <Button size="sm" variant="secondary" onClick={copyJson}>
            Copy JSON
          </Button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>

      <div className="space-y-2">
        {/* Every on-screen tile needs its own listen/concur loop — untagged
            tiles (Corey, Igas, etc. from the background) are still rendered
            in the meeting grid and need to participate in the choreography. */}
        {tiles.map((t) => (
          <TileRangeRow
            key={t.idx}
            tile={t}
            videoRef={sharedVideoRef}
            currentTime={currentTime}
            onStamp={(kind, edge) => stamp(t.idx, kind, edge)}
            onClear={(kind) => clearRange(t.idx, kind)}
            onSeekTo={seek}
            onPreview={(kind) =>
              setPreviewingTile((cur) =>
                cur && cur.idx === t.idx && cur.kind === kind
                  ? null
                  : { idx: t.idx, kind }
              )
            }
            previewing={
              previewingTile && previewingTile.idx === t.idx
                ? previewingTile.kind
                : null
            }
          />
        ))}
      </div>
    </section>
  );
}

function TileThumb({
  videoRef,
  tile,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  tile: TileBox;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = Math.max(1, Math.round(tile.w));
    canvas.height = Math.max(1, Math.round(tile.h));
    let raf = 0;
    const draw = () => {
      const v = videoRef.current;
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        try {
          ctx.drawImage(
            v,
            tile.x,
            tile.y,
            tile.w,
            tile.h,
            0,
            0,
            canvas.width,
            canvas.height
          );
        } catch {}
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tile.x, tile.y, tile.w, tile.h, videoRef]);
  return (
    <div
      className="relative flex-shrink-0 overflow-hidden rounded border border-zinc-700 bg-zinc-900"
      style={{ width: 60, aspectRatio: `${tile.w} / ${tile.h}` }}
      title={`#${tile.idx} · row ${tile.row} col ${tile.col}`}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

function TileRangeRow({
  tile,
  videoRef,
  currentTime,
  onStamp,
  onClear,
  onSeekTo,
  onPreview,
  previewing,
}: {
  tile: TileBox;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  onStamp: (kind: "listen" | "concur", edge: 0 | 1) => void;
  onClear: (kind: "listen" | "concur") => void;
  onSeekTo: (t: number) => void;
  onPreview: (kind: "listen" | "concur") => void;
  previewing: "listen" | "concur" | null;
}) {
  const listen = tile.listen_range;
  const concur = tile.concur_range;

  return (
    <div className="flex gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 p-2 text-xs">
      <TileThumb videoRef={videoRef} tile={tile} />
      <div className="min-w-0 flex-1">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-sky-300">
          #{tile.idx}
        </span>
        <span className="text-[10px] text-zinc-500">
          r{tile.row}c{tile.col}
        </span>
        <span className="text-zinc-200">
          {tile.character_id ?? (
            <span className="text-zinc-500 italic">untagged (background)</span>
          )}
        </span>
        <span className="ml-auto text-[10px] text-zinc-500">
          t = {currentTime.toFixed(2)}s
        </span>
      </div>
      <RangeLine
        label="Listen"
        range={listen}
        color="sky"
        onIn={() => onStamp("listen", 0)}
        onOut={() => onStamp("listen", 1)}
        onClear={() => onClear("listen")}
        onSeekStart={() => (listen ? onSeekTo(listen[0]) : undefined)}
        onSeekEnd={() => (listen ? onSeekTo(listen[1]) : undefined)}
        onPreview={() => onPreview("listen")}
        previewing={previewing === "listen"}
      />
      <RangeLine
        label="Concur"
        range={concur}
        color="emerald"
        onIn={() => onStamp("concur", 0)}
        onOut={() => onStamp("concur", 1)}
        onClear={() => onClear("concur")}
        onSeekStart={() => (concur ? onSeekTo(concur[0]) : undefined)}
        onSeekEnd={() => (concur ? onSeekTo(concur[1]) : undefined)}
        onPreview={() => onPreview("concur")}
        previewing={previewing === "concur"}
      />
      </div>
    </div>
  );
}

function RangeLine({
  label,
  range,
  color,
  onIn,
  onOut,
  onClear,
  onSeekStart,
  onSeekEnd,
  onPreview,
  previewing,
}: {
  label: string;
  range: [number, number] | undefined;
  color: "sky" | "emerald";
  onIn: () => void;
  onOut: () => void;
  onClear: () => void;
  onSeekStart: () => void;
  onSeekEnd: () => void;
  onPreview: () => void;
  previewing: boolean;
}) {
  const colorClass = color === "sky" ? "text-sky-400" : "text-emerald-400";
  const dur = range ? (range[1] - range[0]).toFixed(2) : null;
  return (
    <div className="mt-1 flex items-center gap-1">
      <span className={`w-14 text-[10px] font-semibold uppercase ${colorClass}`}>
        {label}
      </span>
      <button
        type="button"
        onClick={onIn}
        className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 hover:bg-zinc-700"
        title="Mark In (stamp current video time)"
      >
        In
      </button>
      <button
        type="button"
        onClick={onOut}
        className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 hover:bg-zinc-700"
        title="Mark Out (stamp current video time)"
      >
        Out
      </button>
      <span className="ml-1 font-mono tabular-nums text-zinc-400">
        {range ? (
          <>
            <button
              type="button"
              className="underline decoration-dotted hover:text-zinc-200"
              onClick={onSeekStart}
              title="Seek to start"
            >
              {range[0].toFixed(2)}s
            </button>
            <span className="mx-0.5">→</span>
            <button
              type="button"
              className="underline decoration-dotted hover:text-zinc-200"
              onClick={onSeekEnd}
              title="Seek to end"
            >
              {range[1].toFixed(2)}s
            </button>
            <span className="ml-1 text-zinc-500">({dur}s)</span>
          </>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </span>
      {range && (
        <>
          <button
            type="button"
            onClick={onPreview}
            className={`ml-auto rounded border px-1.5 py-0.5 ${
              previewing
                ? "border-amber-500 bg-amber-500/20 text-amber-200"
                : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
            }`}
            title="Loop this range on the video player"
          >
            {previewing ? "Stop" : "Loop"}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-red-400 hover:bg-zinc-700"
            title="Clear range"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

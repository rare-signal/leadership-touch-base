"use client";

import { RefObject, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { CharacterPack } from "@/lib/types";

type Bbox = { x: number; y: number; w: number; h: number };

type Props = {
  pack: CharacterPack | null;
  masterVideoRef: RefObject<HTMLVideoElement | null>;
  bbox: Bbox;
  displayAspect: number;
  active: boolean;
};

export function ParticipantTile({
  pack,
  masterVideoRef,
  bbox,
  displayAspect,
  active,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Every tile draws its bbox region from the shared master <video> onto a
  // <canvas> on every animation frame. One decode, six identical frames —
  // zero drift possible because all tiles read from the same video element.
  //
  // The canvas has a fixed target aspect (displayAspect) so all tiles look
  // identical in shape across meetings. We manually center-crop the source
  // bbox to that aspect before drawing — tall-portrait bboxes get a slice
  // of top/bottom trimmed, wider bboxes get a slice of left/right trimmed.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Give the canvas enough resolution to render crisp at typical cell
    // widths (~400px). We scale the smaller dim down from bbox.w.
    canvas.width = Math.max(1, Math.round(bbox.w));
    canvas.height = Math.max(1, Math.round(bbox.w / displayAspect));

    const srcAspect = bbox.w / bbox.h;
    let sx = bbox.x;
    let sy = bbox.y;
    let sw = bbox.w;
    let sh = bbox.h;
    if (srcAspect > displayAspect) {
      // Source is wider than target — crop left/right.
      const newW = bbox.h * displayAspect;
      sx = bbox.x + (bbox.w - newW) / 2;
      sw = newW;
    } else if (srcAspect < displayAspect) {
      // Source is taller than target — crop top/bottom.
      const newH = bbox.w / displayAspect;
      sy = bbox.y + (bbox.h - newH) / 2;
      sh = newH;
    }

    let raf = 0;
    const draw = () => {
      const v = masterVideoRef.current;
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        try {
          ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        } catch {
          // drawImage can throw briefly during source swap; skip frame.
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [bbox.x, bbox.y, bbox.w, bbox.h, displayAspect, masterVideoRef]);

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden rounded-lg bg-[#1a1a1a] border",
        "transition-all duration-150",
        active
          ? "ring-[3px] ring-[#5EDC62] border-[#5EDC62] shadow-[0_0_32px_-10px_rgba(94,220,98,0.6)]"
          : "border-white/5"
      )}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
      />

      {active && (
        <div className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-[#5EDC62]/90 px-2 py-0.5 text-[10px] font-semibold text-black">
          <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
          speaking
        </div>
      )}
    </div>
  );
}

export function UserTile({
  name,
  aspectRatio,
}: {
  name: string;
  aspectRatio?: number;
}) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      className="relative overflow-hidden rounded-xl bg-zinc-800 border border-zinc-700"
      style={{ aspectRatio: aspectRatio ?? 16 / 9 }}
    >
      <div className="absolute inset-0 grid place-items-center">
        <div className="grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-2xl font-semibold text-white">
          {initials}
        </div>
      </div>
      <div className="absolute bottom-2 left-2 rounded-md bg-black/70 px-2 py-1 text-xs font-medium text-white backdrop-blur">
        {name} (you)
      </div>
    </div>
  );
}

// Small round avatar for a cast member. Uses their first pre-cut clip as a
// video source, paused at frame 0 — no new asset pipeline required. The
// `<video>` acts as a still image once `currentTime` is pinned.
export function CastAvatar({
  clipUrl,
  displayName,
  size = 28,
  dm,
}: {
  clipUrl?: string;
  displayName: string;
  size?: number;
  dm?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const initials = displayName.slice(0, 1).toUpperCase();

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !clipUrl) return;
    const pin = () => {
      try {
        v.currentTime = 0.2;
        v.pause();
      } catch {}
    };
    v.addEventListener("loadedmetadata", pin, { once: true });
    if (v.readyState >= 1) pin();
    return () => v.removeEventListener("loadedmetadata", pin);
  }, [clipUrl]);

  return (
    <div
      className={`relative flex-shrink-0 overflow-hidden rounded-full border ${
        dm ? "border-amber-400/60" : "border-zinc-700"
      } bg-zinc-800`}
      style={{ width: size, height: size }}
      title={displayName}
    >
      {clipUrl ? (
        <video
          ref={videoRef}
          src={clipUrl}
          className="absolute inset-0 h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-zinc-300">
          {initials}
        </div>
      )}
    </div>
  );
}

// A shared webcam stream hook — getUserMedia once per component, reused by
// the floating PIP and the "joined the grid" version without requesting
// camera permission twice.
function useWebcamStream() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    let s: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480 }, audio: false })
      .then((got) => {
        if (cancelled) {
          got.getTracks().forEach((t) => t.stop());
          return;
        }
        s = got;
        setStream(got);
      })
      .catch(() => {
        if (!cancelled) setDenied(true);
      });
    return () => {
      cancelled = true;
      if (s) s.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return { stream, denied };
}

export function WebcamPIP({
  muted = false,
  videoOff = false,
  onClick,
}: {
  muted?: boolean;
  videoOff?: boolean;
  onClick?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { stream, denied } = useWebcamStream();

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    v.play().catch(() => {});
  }, [stream]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`absolute bottom-4 right-4 z-10 w-[180px] overflow-hidden rounded-lg border-2 bg-[#1a1a1a] shadow-2xl ring-1 ring-black/40 transition-transform hover:scale-[1.03] ${
        muted ? "border-red-500/80" : "border-white/15"
      } ${onClick ? "cursor-pointer" : "cursor-default"}`}
      style={{ aspectRatio: 4 / 3 }}
      title={onClick ? "Join the grid" : undefined}
    >
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full -scale-x-100 object-cover transition-opacity ${
          stream && !videoOff ? "opacity-100" : "opacity-0"
        }`}
        muted
        playsInline
        autoPlay
      />
      {(!stream || videoOff) && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-[#2D8CFF] to-indigo-600 text-xl font-semibold text-white">
            YO
          </div>
        </div>
      )}
      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
        {muted && <span className="text-red-400">🔇</span>}
        <span>You {denied ? "(camera off)" : ""}</span>
      </div>
    </button>
  );
}

// Full-size user tile that lives inside the meeting grid (when you click the
// PIP to promote yourself alongside the cast). Uses the same webcam stream.
export function UserGridTile({
  muted = false,
  videoOff = false,
  onClick,
}: {
  muted?: boolean;
  videoOff?: boolean;
  onClick?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { stream, denied } = useWebcamStream();
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    v.play().catch(() => {});
  }, [stream]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-full w-full overflow-hidden rounded-lg border bg-[#1a1a1a] transition-all cursor-pointer hover:brightness-110 ${
        muted ? "border-red-500/70" : "border-white/10"
      }`}
      title={onClick ? "Drop back to PIP" : undefined}
    >
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full -scale-x-100 object-cover transition-opacity ${
          stream && !videoOff ? "opacity-100" : "opacity-0"
        }`}
        muted
        playsInline
        autoPlay
      />
      {(!stream || videoOff) && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-[#2D8CFF] to-indigo-600 text-2xl font-semibold text-white">
            YO
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">
        {muted && <span className="text-red-400">🔇</span>}
        <span>You {denied ? "(camera off)" : ""}</span>
      </div>
    </button>
  );
}

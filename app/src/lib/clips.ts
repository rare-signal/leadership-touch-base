"use client";

import { useEffect, useState } from "react";

export type Clip = {
  vid: string;
  tile_idx: number;
  video_url: string;
  audio_url: string;
};

export type ClipIndex = Record<string, Clip[]>;

let _cached: ClipIndex | null = null;
let _inflight: Promise<ClipIndex> | null = null;

export function fetchClipIndex(): Promise<ClipIndex> {
  if (_cached) return Promise.resolve(_cached);
  if (_inflight) return _inflight;
  _inflight = fetch("/api/clips")
    .then((r) => r.json())
    .then((d) => {
      _cached = (d.clips ?? {}) as ClipIndex;
      return _cached;
    });
  return _inflight;
}

export function useClipIndex(): ClipIndex | null {
  const [idx, setIdx] = useState<ClipIndex | null>(_cached);
  useEffect(() => {
    if (_cached) {
      setIdx(_cached);
      return;
    }
    let cancelled = false;
    fetchClipIndex().then((d) => {
      if (!cancelled) setIdx(d);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return idx;
}

export function pickRandomClip(index: ClipIndex | null, characterId: string): Clip | null {
  if (!index) return null;
  const pool = index[characterId];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

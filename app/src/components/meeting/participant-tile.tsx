"use client";

import Image from "next/image";
import { cn } from "@/lib/utils";
import type { CharacterPack } from "@/lib/types";

type Props = {
  pack: CharacterPack;
  active: boolean;
  captionText?: string;
};

export function ParticipantTile({ pack, active, captionText }: Props) {
  const thumbVid =
    pack.character.thumb_video_id ?? pack.character.appearances[0]?.video_id;
  const thumb = thumbVid ? `/api/thumb/${thumbVid}` : null;

  return (
    <div
      className={cn(
        "relative aspect-video overflow-hidden rounded-xl bg-zinc-900 border",
        "transition-all duration-200",
        active
          ? "ring-4 ring-sky-400/80 border-sky-400 shadow-[0_0_40px_-10px_rgba(56,189,248,0.6)]"
          : "border-zinc-800"
      )}
    >
      {thumb ? (
        <Image
          src={thumb}
          alt={pack.character.display_name}
          fill
          sizes="(max-width: 768px) 50vw, 25vw"
          className="object-cover opacity-80"
          unoptimized
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-4xl font-semibold text-zinc-500">
          {pack.character.display_name.slice(0, 1)}
        </div>
      )}

      {/* caption bubble */}
      {captionText && (
        <div className="absolute inset-x-3 bottom-10 rounded-lg bg-black/80 px-3 py-2 text-sm text-white backdrop-blur">
          {captionText}
        </div>
      )}

      {/* nameplate */}
      <div className="absolute bottom-2 left-2 rounded-md bg-black/70 px-2 py-1 text-xs font-medium text-white backdrop-blur">
        {pack.character.display_name}
        {pack.persona ? (
          <span className="ml-1 opacity-60">· {pack.persona.role}</span>
        ) : null}
      </div>

      {active && (
        <div className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-sky-500/90 px-2 py-0.5 text-[10px] font-semibold text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
          speaking
        </div>
      )}
    </div>
  );
}

export function UserTile({ name }: { name: string }) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div className="relative aspect-video overflow-hidden rounded-xl bg-zinc-800 border border-zinc-700">
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

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Out-of-meeting splash. Intentionally minimal: one click to join, no forms.
// Meeting topic, name, and cast-source rotation are handled inside /meeting.
export default function Lobby() {
  const router = useRouter();
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    // Static deploy: read the staged bundle directly. `/api/characters`
    // only exists in dev — it gets moved aside by scripts/build-static.mjs
    // because `output: "export"` can't ship its force-dynamic handler.
    // Ready = the bundle exists AND has at least one character pack.
    fetch("/characters.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setReady(Array.isArray(d.packs) && d.packs.length > 0))
      .catch(() => setReady(false));
  }, []);

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-5xl font-semibold tracking-tight">LARP Meeting</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Join a Zoom call with the cast of{" "}
          <a
            href="https://www.youtube.com/@VersoJobs/shorts"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            @VersoJobs
          </a>
          . Unofficial tribute.
        </p>
        <Button
          onClick={() => router.push("/meeting")}
          disabled={ready === false}
          className="mt-8 w-full h-12 text-base"
        >
          {ready === null ? "Loading…" : "Join a meeting"}
        </Button>
        <p className="mt-6 text-xs text-muted-foreground">
          Full shorts are re-hosted for frame-synced playback. All content
          © @VersoJobs, used in good faith under fair use for commentary
          and parody. Rights holder? Open an issue on{" "}
          <a
            href="https://github.com/rare-signal/leadership-touch-base"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            GitHub
          </a>{" "}
          and it comes down.
        </p>
      </div>
    </main>
  );
}

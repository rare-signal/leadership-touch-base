"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function Lobby() {
  const router = useRouter();
  const [topic, setTopic] = useState("Q2 planning for the LARP growth initiative");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<{ count: number; ready: boolean } | null>(null);

  useEffect(() => {
    setApiKey(localStorage.getItem("anthropic_key") ?? "");
    fetch("/api/characters")
      .then((r) => r.json())
      .then((d) => setStatus({ count: d.count, ready: d.pipeline_ready }))
      .catch(() => setStatus({ count: 0, ready: false }));
  }, []);

  const join = () => {
    if (apiKey) localStorage.setItem("anthropic_key", apiKey);
    const params = new URLSearchParams({ topic });
    router.push(`/meeting?${params.toString()}`);
  };

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-8 text-center">
          <h1 className="text-5xl font-semibold tracking-tight">LARP Meeting</h1>
          <p className="mt-3 text-muted-foreground">
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
        </div>

        <div className="rounded-xl border bg-card/50 p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">Meeting topic</label>
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What's this meeting about?"
              rows={2}
              className="resize-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">
              Anthropic API key{" "}
              <span className="opacity-60">
                (stored in this browser only; used to power the cast's replies)
              </span>
            </label>
            <Input
              type="password"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <Button
            onClick={join}
            disabled={!topic.trim() || !status?.ready}
            className="w-full h-12 text-base"
          >
            Join meeting
          </Button>

          <div className="pt-2 text-xs text-center text-muted-foreground">
            {status === null && "Loading cast..."}
            {status && status.ready && (
              <>Cast ready · {status.count} characters ingested</>
            )}
            {status && !status.ready && (
              <>
                Pipeline still running. Run{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  cd pipeline && uv run larp-pipeline all
                </code>{" "}
                to populate the cast.
              </>
            )}
          </div>
        </div>

        <p className="mt-6 text-xs text-center text-muted-foreground">
          No videos are redistributed. Short audio ad-libs used under fair use for commentary and parody.
        </p>
      </div>
    </main>
  );
}

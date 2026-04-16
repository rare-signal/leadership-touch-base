"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ParticipantTile, UserTile } from "./participant-tile";
import type { CharacterPack, ChatMessage } from "@/lib/types";

type Props = { topic: string };

// Match the YouTube-shorts zoom-grid vibe — 5 cast + 1 "you" = 6 tiles.
const MAX_CAST = 5;

function rankCast(packs: CharacterPack[]): CharacterPack[] {
  // Prefer cast with a persona (needed) and more source-video appearances.
  // Tie-break by having grunt clips (nicer first-impression).
  const withPersona = packs.filter((p) => p.persona);
  return [...withPersona]
    .sort((a, b) => {
      const apA = a.character.appearances?.length ?? 0;
      const apB = b.character.appearances?.length ?? 0;
      if (apB !== apA) return apB - apA;
      const gA = a.grunts?.length ?? 0;
      const gB = b.grunts?.length ?? 0;
      return gB - gA;
    })
    .slice(0, MAX_CAST);
}

export function MeetingRoom({ topic }: Props) {
  const router = useRouter();
  const [packs, setPacks] = useState<CharacterPack[]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/characters")
      .then((r) => r.json())
      .then((d) => setPacks(d.packs ?? []));
  }, []);

  const cast = useMemo(() => rankCast(packs), [packs]);
  const castReady = cast.length > 0;

  // Auto-scroll chat to latest.
  useEffect(() => {
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [history, pending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: Date.now(),
    };
    setHistory((h) => [...h, userMsg]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          history: [...history, userMsg],
          user_message: text,
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      }
      await consumeSSE(res.body, {
        onSpeaker: (charId, grunt) => {
          setActiveIds((s) => new Set(s).add(charId));
          setPending((p) => ({ ...p, [charId]: "" }));
          if (grunt) playGrunt(charId, grunt.url);
        },
        onDelta: (charId, text) => {
          setPending((p) => ({ ...p, [charId]: (p[charId] ?? "") + text }));
        },
        onCharacterDone: (charId) => {
          setPending((p) => {
            const text = p[charId] ?? "";
            setHistory((h) => [
              ...h,
              {
                id: crypto.randomUUID(),
                role: "character",
                character_id: charId,
                text,
                timestamp: Date.now(),
              },
            ]);
            const { [charId]: _, ...rest } = p;
            return rest;
          });
          setTimeout(() => {
            setActiveIds((s) => {
              const n = new Set(s);
              n.delete(charId);
              return n;
            });
          }, 800);
        },
        onError: (msg) => setError(msg),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b bg-zinc-950/90 px-4 py-3 backdrop-blur">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">LARP Meeting</div>
          <div className="text-sm font-medium truncate max-w-xl">{topic}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs text-red-400">
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            REC
          </div>
          <Button variant="destructive" size="sm" onClick={() => router.push("/")}>
            Leave
          </Button>
        </div>
      </header>

      {/* Body: grid (left) + chat aside (right) */}
      <div className="flex flex-1 min-h-0">
        <section className="flex-1 overflow-auto p-4">
          {!castReady ? (
            <PipelineEmpty />
          ) : (
            <div className="mx-auto grid h-full max-w-6xl auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3">
              {cast.map((pack) => (
                <ParticipantTile
                  key={pack.character.id}
                  pack={pack}
                  active={activeIds.has(pack.character.id)}
                  captionText={pending[pack.character.id]}
                />
              ))}
              <UserTile name="You" />
            </div>
          )}
        </section>

        <aside className="hidden w-[360px] flex-col border-l bg-zinc-950/60 md:flex">
          <div className="border-b px-4 py-3 text-sm font-medium text-zinc-200">
            Chat
          </div>
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {history.length === 0 && Object.keys(pending).length === 0 ? (
              <p className="px-1 pt-1 text-xs text-zinc-500">
                Break the ice — say hi, ask a question, kick off the agenda.
              </p>
            ) : (
              <>
                {history.map((m) => (
                  <MessageBubble key={m.id} msg={m} packs={packs} />
                ))}
                {Object.entries(pending).map(([cid, text]) => (
                  <MessageBubble
                    key={`pending-${cid}`}
                    msg={{
                      id: `pending-${cid}`,
                      role: "character",
                      character_id: cid,
                      text: text || "…",
                      timestamp: Date.now(),
                    }}
                    packs={packs}
                    pending
                  />
                ))}
              </>
            )}
          </div>
          <div className="border-t p-3">
            {error && (
              <div className="mb-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Say something…"
                disabled={sending || !castReady}
                className="h-10"
              />
              <Button
                onClick={send}
                disabled={sending || !input.trim() || !castReady}
                className="h-10"
              >
                {sending ? "…" : "Send"}
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function MessageBubble({
  msg,
  packs,
  pending,
}: {
  msg: ChatMessage;
  packs: CharacterPack[];
  pending?: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[260px] rounded-2xl rounded-tr-sm bg-emerald-600 px-3 py-2 text-sm text-white">
          {msg.text}
        </div>
      </div>
    );
  }
  const pack = packs.find((p) => p.character.id === msg.character_id);
  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[280px] rounded-2xl rounded-tl-sm px-3 py-2 ${
          pending ? "bg-zinc-800/60" : "bg-zinc-800"
        }`}
      >
        <div className="mb-1 text-[11px] font-semibold text-sky-400">
          {pack?.character.display_name ?? msg.character_id}
        </div>
        <div className="text-sm text-zinc-100">{msg.text}</div>
      </div>
    </div>
  );
}

function PipelineEmpty() {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-md rounded-xl border bg-zinc-900/60 p-8 text-center">
        <h2 className="text-lg font-semibold">Cast still warming up</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Personas aren't generated yet. From the repo root run:
        </p>
        <pre className="mt-3 rounded bg-black px-3 py-2 text-left text-xs text-zinc-300">
cd pipeline && uv run larp-pipeline all
        </pre>
      </div>
    </div>
  );
}

// --- helpers ---

const audioCache = new Map<string, HTMLAudioElement>();
function playGrunt(charId: string, url: string) {
  const key = `${charId}:${url}`;
  if (!audioCache.has(key)) {
    const a = new Audio(url);
    a.preload = "auto";
    audioCache.set(key, a);
  }
  const el = audioCache.get(key)!;
  el.currentTime = 0;
  el.play().catch(() => {});
}

type SSEHandlers = {
  onSpeaker: (charId: string, grunt: { url: string; text: string } | null) => void;
  onDelta: (charId: string, text: string) => void;
  onCharacterDone: (charId: string) => void;
  onError: (msg: string) => void;
};

async function consumeSSE(body: ReadableStream<Uint8Array>, h: SSEHandlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = frame.split("\n");
      let event = "message";
      let data = "";
      for (const l of lines) {
        if (l.startsWith("event:")) event = l.slice(6).trim();
        else if (l.startsWith("data:")) data += l.slice(5).trim();
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        switch (event) {
          case "speaker": h.onSpeaker(payload.character_id, payload.grunt); break;
          case "delta": h.onDelta(payload.character_id, payload.text); break;
          case "character_done": h.onCharacterDone(payload.character_id); break;
          case "error": h.onError(payload.message); break;
        }
      } catch {
        // ignore malformed frames
      }
    }
  }
}

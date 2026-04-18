/**
 * POST /api/turn
 * Body: { topic, history, user_message }
 * Returns an SSE stream: events "speaker", "delta", "character_done", "done".
 *
 * Director (JSON mode) picks 1-2 characters -> each streams their reply.
 * Backed by a local LLM cluster (see lib/cluster.ts).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { loadCharacterPacks } from "@/lib/data";
import { chatJson, streamChat } from "@/lib/cluster";
import type { ChatMessage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  topic: z.string().min(1).max(500),
  history: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["user", "character"]),
        character_id: z.string().optional(),
        text: z.string(),
        timestamp: z.number(),
        audience: z.enum(["room", "dm"]).optional(),
        dm_character_id: z.string().optional(),
      })
    )
    .max(100),
  user_message: z.string().min(1).max(2000).optional(),
  user_name: z.string().min(1).max(80).optional(),
  // "ambient" = unprompted turn (no user message). Server will pick a speaker
  // who breaks the silence or sends a DM.
  ambient: z.boolean().optional(),
  // Restrict the director's cast to the characters actually visible in the
  // current meeting (derived client-side from the source video's tagged
  // tiles). Prevents Chaos Agent from speaking when only Ryan/Charles/Braxton
  // are on screen.
  cast_ids: z.array(z.string()).max(20).optional(),
});

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

type Pick = {
  id: string;
  direction: string;
  audience?: "room" | "dm";
};

async function pickSpeakers(
  topic: string,
  history: ChatMessage[],
  user: string | undefined,
  userName: string | undefined,
  ambient: boolean,
  cast: { id: string; display_name: string; one_liner: string }[]
): Promise<Pick[]> {
  const historyText = history
    .map((m) => {
      const who = m.role === "user" ? userName || "USER" : m.character_id;
      const tag = m.audience === "dm" ? " [DM]" : "";
      return `${who}${tag}: ${m.text}`;
    })
    .join("\n");

  const nameLine = userName ? `USER'S NAME: ${userName}` : "";
  const ambientPrompt = ambient
    ? `No one has spoken in a moment. Pick exactly ONE character to break the silence — they might continue the meeting topic, derail it, or send the user a private DM (a secret aside). Return audience: "dm" when it's a direct message to the user only, otherwise "room". DMs should feel gossipy or conspiratorial — the kind of thing you only tell the user, not the whole meeting.`
    : `The user just spoke. Pick 1-2 characters who would plausibly jump in next. Prefer variety — don't repeat whoever just spoke unless they're the obvious responder. If the user asked someone by name, pick them. Audience is almost always "room" for replies to the user.`;

  const prompt = `You are the director of a mock Zoom meeting populated by recurring LARP comedy characters.

MEETING TOPIC: ${topic}
${nameLine}

CAST (id — one-liner):
${cast.map((c) => `- ${c.id} — ${c.display_name}: ${c.one_liner}`).join("\n")}

TRANSCRIPT SO FAR:
${historyText || "(just started)"}

${ambient ? "" : `USER JUST SAID: "${user ?? ""}"\n`}
${ambientPrompt}

Return JSON ONLY: {"speakers": [{"id": "<character_id>", "direction": "one-sentence direction", "audience": "room"|"dm"}]}.`;

  try {
    const parsed = await chatJson<{ speakers: Pick[] }>(
      [{ role: "user", content: prompt }],
      { max_tokens: 500, temperature: 0.4 }
    );
    const valid =
      parsed.speakers?.filter((s) => cast.some((c) => c.id === s.id)) ?? [];
    const trimmed = valid.slice(0, ambient ? 1 : 2);
    if (trimmed.length > 0) return trimmed;
    return [{ id: cast[0].id, direction: "respond naturally", audience: "room" }];
  } catch {
    return [{ id: cast[0].id, direction: "respond naturally", audience: "room" }];
  }
}

export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = BodySchema.parse(await req.json());
  } catch (err) {
    return new Response(JSON.stringify({ error: "bad_request", detail: String(err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const packs = await loadCharacterPacks();
  let withPersonas = packs.filter((p) => p.persona);
  if (withPersonas.length === 0) {
    return new Response(
      JSON.stringify({
        error: "pipeline_not_ready",
        message:
          "No personas generated yet — run `cd pipeline && uv run larp-pipeline all`.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  // If the client pinned the cast to a specific meeting, narrow to those.
  if (parsed.cast_ids && parsed.cast_ids.length > 0) {
    const allow = new Set(parsed.cast_ids);
    const narrowed = withPersonas.filter((p) => allow.has(p.character.id));
    if (narrowed.length > 0) withPersonas = narrowed;
  }

  const cast = withPersonas.map((p) => ({
    id: p.character.id,
    display_name: p.character.display_name,
    one_liner: p.persona!.one_liner,
  }));

  const ambient = !!parsed.ambient;
  if (!ambient && !parsed.user_message) {
    return new Response(
      JSON.stringify({ error: "bad_request", detail: "user_message required unless ambient" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const userName = parsed.user_name?.trim() || undefined;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const picks = await pickSpeakers(
          parsed.topic,
          parsed.history,
          parsed.user_message,
          userName,
          ambient,
          cast
        );
        for (const pick of picks) {
          const pack = withPersonas.find((p) => p.character.id === pick.id)!;
          const persona = pack.persona!;
          const grunt = pack.grunts[Math.floor(Math.random() * pack.grunts.length)];
          const gruntUrl = grunt
            ? `/api/grunt/${pick.id}/${grunt.path.split("/").pop()?.replace(/\.mp3$/, "")}`
            : null;
          const audience: "room" | "dm" = pick.audience === "dm" ? "dm" : "room";
          controller.enqueue(
            sseFrame("speaker", {
              character_id: pick.id,
              display_name: pack.character.display_name,
              audience,
              grunt: grunt ? { url: gruntUrl, text: grunt.text } : null,
            })
          );

          // DMs should NOT include prior DMs from other characters in this
          // speaker's view — and "room" messages see only room messages.
          const visible = parsed.history.filter((m) => {
            if (m.audience === "dm") {
              // Only the DMing character (and the user, client-side) see it.
              return m.character_id === pick.id || m.role === "user";
            }
            return true;
          });
          const historyText = visible
            .map((m) => {
              const who = m.role === "user" ? userName || "USER" : m.character_id;
              const tag = m.audience === "dm" ? " [DM]" : "";
              return `${who}${tag}: ${m.text}`;
            })
            .join("\n");

          const userLine = ambient
            ? `(no direct message — this is an unprompted beat${
                audience === "dm" ? "; you are sending a secret DM to the user" : ""
              })`
            : `USER JUST SAID: "${parsed.user_message}"`;

          const nameDirective = userName
            ? `The user's name is "${userName}". You may address them by name when it fits.`
            : `The user hasn't shared their name.`;
          const audienceDirective =
            audience === "dm"
              ? `You are sending a DIRECT MESSAGE to the user only. Speak as if the rest of the room can't hear. Gossip, conspire, confess, or vent.`
              : `You're speaking aloud in the meeting. Everyone hears.`;

          const userPrompt = `MEETING TOPIC: ${parsed.topic}

${nameDirective}

${audienceDirective}

CRITICAL: You are ${pack.character.display_name}. Speak as yourself in FIRST PERSON ("I", "me", "my"). Never refer to yourself by name in the third person. Other participants may say your name; you do not.

RECENT TRANSCRIPT:
${historyText || "(just started)"}

${userLine}

DIRECTOR NOTE FOR YOU: ${pick.direction}

Respond in character in 1-3 sentences. Meeting speech, not prose.`;

          for await (const delta of streamChat(
            [
              { role: "system", content: persona.system_prompt },
              { role: "user", content: userPrompt },
            ],
            { max_tokens: 250, temperature: 0.8 }
          )) {
            controller.enqueue(
              sseFrame("delta", { character_id: pick.id, text: delta })
            );
          }
          controller.enqueue(
            sseFrame("character_done", { character_id: pick.id, audience })
          );
        }
        controller.enqueue(sseFrame("done", {}));
      } catch (err) {
        controller.enqueue(sseFrame("error", { message: String(err) }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

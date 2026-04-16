/**
 * POST /api/turn
 * Body: { topic, history, user_message }
 * Returns an SSE stream: events "speaker", "delta", "character_done", "done".
 *
 * Director (JSON mode) picks 1-2 characters -> each streams their reply.
 * Backed by David's local LLM cluster (see lib/cluster.ts).
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
      })
    )
    .max(100),
  user_message: z.string().min(1).max(2000),
});

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

async function pickSpeakers(
  topic: string,
  history: ChatMessage[],
  user: string,
  cast: { id: string; display_name: string; one_liner: string }[]
) {
  const historyText = history
    .map((m) => `${m.role === "user" ? "USER" : m.character_id}: ${m.text}`)
    .join("\n");
  const prompt = `You are the director of a mock Zoom meeting populated by recurring LARP comedy characters. The user just spoke. Pick 1-2 characters who would plausibly jump in next. Prefer variety — don't repeat whoever just spoke unless they're the obvious responder. If the user asked someone by name, pick them.

MEETING TOPIC: ${topic}

CAST (id — one-liner):
${cast.map((c) => `- ${c.id} — ${c.display_name}: ${c.one_liner}`).join("\n")}

TRANSCRIPT SO FAR:
${historyText || "(just started)"}

USER JUST SAID: "${user}"

Return JSON ONLY: {"speakers": [{"id": "<character_id>", "direction": "one-sentence direction for their reaction"}]}. Usually 1 speaker; sometimes 2 for a quick back-and-forth.`;

  try {
    const parsed = await chatJson<{
      speakers: { id: string; direction: string }[];
    }>([{ role: "user", content: prompt }], { max_tokens: 500, temperature: 0.4 });
    const valid = parsed.speakers?.filter((s) => cast.some((c) => c.id === s.id)) ?? [];
    return valid.slice(0, 2).length > 0
      ? valid.slice(0, 2)
      : [{ id: cast[0].id, direction: "respond naturally" }];
  } catch {
    return [{ id: cast[0].id, direction: "respond naturally" }];
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
  const withPersonas = packs.filter((p) => p.persona);
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

  const cast = withPersonas.map((p) => ({
    id: p.character.id,
    display_name: p.character.display_name,
    one_liner: p.persona!.one_liner,
  }));

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const picks = await pickSpeakers(
          parsed.topic,
          parsed.history,
          parsed.user_message,
          cast
        );
        for (const pick of picks) {
          const pack = withPersonas.find((p) => p.character.id === pick.id)!;
          const persona = pack.persona!;
          const grunt = pack.grunts[Math.floor(Math.random() * pack.grunts.length)];
          const gruntUrl = grunt
            ? `/api/grunt/${pick.id}/${grunt.path.split("/").pop()?.replace(/\.mp3$/, "")}`
            : null;
          controller.enqueue(
            sseFrame("speaker", {
              character_id: pick.id,
              display_name: pack.character.display_name,
              grunt: grunt ? { url: gruntUrl, text: grunt.text } : null,
            })
          );

          const historyText = parsed.history
            .map((m) => `${m.role === "user" ? "USER" : m.character_id}: ${m.text}`)
            .join("\n");
          const userPrompt = `MEETING TOPIC: ${parsed.topic}

RECENT TRANSCRIPT:
${historyText || "(just started)"}

USER JUST SAID: "${parsed.user_message}"

DIRECTOR NOTE FOR YOU: ${pick.direction}

Respond in character in 1-3 sentences. Meeting speech, not prose.`;

          for await (const delta of streamChat(
            [
              { role: "system", content: persona.system_prompt },
              { role: "user", content: userPrompt },
            ],
            { max_tokens: 250, temperature: 0.75 }
          )) {
            controller.enqueue(
              sseFrame("delta", { character_id: pick.id, text: delta })
            );
          }
          controller.enqueue(sseFrame("character_done", { character_id: pick.id }));
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

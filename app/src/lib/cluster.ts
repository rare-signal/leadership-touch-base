/** OpenAI-compatible client for a local LLM cluster.
 *
 * Used by /api/turn for director calls and streaming character responses.
 * Matches the Python `larp_pipeline.llm` client: same endpoints, same models,
 * same fallback order. Configure via LARP_LLM_ENDPOINTS env var (see
 * .env.example) — defaults to localhost for a safe public clone.
 */

const DEFAULT_ENDPOINTS = ["http://127.0.0.1:1234"];

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\n]/).map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
}

export function clusterEndpoints(): string[] {
  const env = parseList(process.env.LARP_LLM_ENDPOINTS);
  return env.length ? env : DEFAULT_ENDPOINTS;
}

export const DEFAULT_MODEL =
  process.env.LARP_LLM_MODEL ?? "your-chat-model";

export const FALLBACK_MODEL =
  process.env.LARP_LLM_MODEL_FALLBACK ?? "your-fallback-model";

const API_KEY = process.env.LARP_LLM_API_KEY ?? "";

// In-process memo of the last good endpoint so we don't wait on timeouts every request.
let lastGood: string | null = null;

type Msg = { role: "system" | "user" | "assistant"; content: string };

export type ChatOpts = {
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  model?: string;
  json_mode?: boolean;
};

function headers(): HeadersInit {
  const h: HeadersInit = { "Content-Type": "application/json" };
  if (API_KEY) (h as Record<string, string>).Authorization = `Bearer ${API_KEY}`;
  return h;
}

async function pickEndpoints(): Promise<string[]> {
  const all = clusterEndpoints();
  if (lastGood && all.includes(lastGood)) {
    return [lastGood, ...all.filter((e) => e !== lastGood)];
  }
  return all;
}

export async function chat(messages: Msg[], opts: ChatOpts = {}): Promise<string> {
  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    messages,
    max_tokens: opts.max_tokens ?? 1024,
    temperature: opts.temperature ?? 0.6,
    stream: false,
    // LM Studio uses json_schema not json_object; rely on prompt + regex instead.
  };
  let lastErr: unknown = null;
  for (const ep of await pickEndpoints()) {
    try {
      const r = await fetch(`${ep}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`${ep} -> HTTP ${r.status}`);
      const data = (await r.json()) as {
        choices: { message: { content: string } }[];
      };
      lastGood = ep;
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      lastErr = e;
    }
  }
  if ((opts.model ?? DEFAULT_MODEL) !== FALLBACK_MODEL) {
    return chat(messages, { ...opts, model: FALLBACK_MODEL });
  }
  throw new Error(`all endpoints failed; last=${String(lastErr)}`);
}

/** Stream tokens from the cluster as an async iterable of text deltas. */
export async function* streamChat(
  messages: Msg[],
  opts: ChatOpts = {}
): AsyncGenerator<string, void, void> {
  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    messages,
    max_tokens: opts.max_tokens ?? 400,
    temperature: opts.temperature ?? 0.7,
    stream: true,
  };
  let chosen: string | null = null;
  let lastErr: unknown = null;
  for (const ep of await pickEndpoints()) {
    try {
      const r = await fetch(`${ep}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok || !r.body) throw new Error(`${ep} -> HTTP ${r.status}`);
      chosen = ep;
      lastGood = ep;
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const obj = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
            };
            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // ignore keepalive / malformed
          }
        }
      }
      return;
    } catch (e) {
      lastErr = e;
      if (chosen) throw e;
    }
  }
  if ((opts.model ?? DEFAULT_MODEL) !== FALLBACK_MODEL) {
    yield* streamChat(messages, { ...opts, model: FALLBACK_MODEL });
    return;
  }
  throw new Error(`stream failed on all endpoints; last=${String(lastErr)}`);
}

export async function chatJson<T = unknown>(
  messages: Msg[],
  opts: ChatOpts = {}
): Promise<T> {
  let text = await chat(messages, { ...opts, json_mode: true });
  text = text.trim();
  if (text.startsWith("```")) text = text.replace(/^```(json)?/, "").replace(/```$/, "").trim();
  if (!text.startsWith("{")) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
  }
  return JSON.parse(text) as T;
}

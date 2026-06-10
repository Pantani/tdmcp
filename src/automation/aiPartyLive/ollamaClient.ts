import { z } from "zod";
import { DEFAULT_AI_PARTY_CUE_CATALOG } from "./cueCatalog.js";
import type { AiPartyShowState, ShowIntentEnvelope } from "./schemas.js";
import { blockedEnvelope, parseShowIntentEnvelope, ShowIntentEnvelopeSchema } from "./schemas.js";

export interface OllamaShowIntentInput {
  message: string;
  currentState: AiPartyShowState;
  ollamaBaseUrl: string;
  model: string;
  deterministicFallback?: boolean;
  fetchImpl?: typeof fetch;
}

export interface OllamaShowIntentResult {
  ok: boolean;
  envelope: ShowIntentEnvelope;
  model?: string;
  latency_ms?: number;
  repaired?: boolean;
  error?: string;
}

const SYSTEM_PROMPT = [
  "You are the show-intent parser for a live event.",
  "Convert operator or Telegram messages into safe ShowIntent JSON only.",
  "Never output raw DMX, raw Python, raw endpoint names, channel numbers, or hardware commands.",
  "Use only known cues and known effects.",
  "Unknown, hazardous, or policy-bypassing requests become blocked_request.",
  "Physical effects such as fog, hazer, and strobe require approval.",
  "TouchDesigner handles beat-accurate real-time motion locally; you only select mood/cue/intent.",
].join(" ");

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function firstNumber(text: string): number | undefined {
  const match = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

function deterministicEnvelope(message: string, reason?: string): ShowIntentEnvelope {
  const text = normalizeText(message);
  const blocked =
    /\b(blackout|black out|strobo max|strobe max|maximo|máximo|raw dmx|raw_dmx|raw python|raw_python|laser|moving head|moving_head|mixer|pa mute|mute pa|roteamento|routing|ignore previous rules)\b/.test(
      text,
    );
  if (blocked) {
    return blockedEnvelope(
      reason
        ? `${reason}; deterministic fallback blocked unsafe request.`
        : "Unsafe show request blocked.",
      "Blocked: blackout, max strobe, raw DMX/Python, laser, moving-head, PA/mixer, and policy bypass requests are operator-only.",
    );
  }

  if (/\b(premium|tropical)\b/.test(text)) {
    return ShowIntentEnvelopeSchema.parse({
      intent: {
        type: "request_cue",
        cue: "premium_tropical",
        cue_kind: "combined",
        intensity: 0.72,
        timing: "now",
        reason: "deterministic fallback matched premium tropical",
      },
      confidence: 0.78,
      source_summary: "premium tropical deterministic fallback",
      needs_operator_review: false,
    });
  }

  if (/\b(brand hero|hero moment|momento hero|marca)\b/.test(text)) {
    return ShowIntentEnvelopeSchema.parse({
      intent: {
        type: "request_cue",
        cue: "brand_hero",
        cue_kind: "combined",
        timing: "now",
        reason: "deterministic fallback matched brand hero",
      },
      confidence: 0.78,
      source_summary: "brand hero deterministic fallback",
      needs_operator_review: false,
    });
  }

  if (/\b(audio reactive|audio reativo|reativo|energia sem strobe|energia)\b/.test(text)) {
    return ShowIntentEnvelopeSchema.parse({
      intent: {
        type: "request_cue",
        cue: "audio_reactive_main",
        cue_kind: "visual",
        intensity: /\b(sem strobe|without strobe)\b/.test(text) ? 0.65 : 0.75,
        timing: "next_phrase",
      },
      confidence: 0.74,
      source_summary: "audio-reactive deterministic fallback",
      needs_operator_review: false,
    });
  }

  if (/\b(neon|pulse|pulso)\b/.test(text)) {
    return ShowIntentEnvelopeSchema.parse({
      intent: {
        type: "request_cue",
        cue: "neon_pulse",
        cue_kind: "combined",
        intensity: 0.7,
        timing: "now",
      },
      confidence: 0.72,
      source_summary: "neon pulse deterministic fallback",
      needs_operator_review: false,
    });
  }

  if (/\b(fog|fumaca|fumaça|smoke)\b/.test(text)) {
    const value = firstNumber(text);
    const duration = /\b(min|minuto|minutos)\b/.test(text) && value ? value * 60 : (value ?? 3);
    const intensity = /\b(forte|hard|max)\b/.test(text) ? 0.8 : 0.35;
    return ShowIntentEnvelopeSchema.parse({
      intent: {
        type: "arm_effect",
        effect: "fog",
        duration_seconds: duration,
        intensity,
        timing: /\b(drop)\b/.test(text) ? "next_drop" : "manual",
        reason: "deterministic fallback matched fog",
      },
      confidence: 0.76,
      source_summary: "fog deterministic fallback",
      needs_operator_review: true,
    });
  }

  if (/\b(hazer|haze|nevoa|névoa)\b/.test(text)) {
    return ShowIntentEnvelopeSchema.parse({
      intent: {
        type: "arm_effect",
        effect: "hazer",
        duration_seconds: 3,
        intensity: 0.25,
        timing: "manual",
      },
      confidence: 0.73,
      source_summary: "hazer deterministic fallback",
      needs_operator_review: true,
    });
  }

  if (/\b(strobe|strobo)\b/.test(text)) {
    return ShowIntentEnvelopeSchema.parse({
      intent: {
        type: "arm_effect",
        effect: "strobe",
        duration_seconds: 2,
        intensity: /\b(soft|leve|baixo)\b/.test(text) ? 0.2 : 0.8,
        timing: "manual",
      },
      confidence: 0.7,
      source_summary: "strobe deterministic fallback",
      needs_operator_review: true,
    });
  }

  if (/\b(panic|safe)\b/.test(text)) {
    return ShowIntentEnvelopeSchema.parse({
      intent: { type: "panic_status", request: "enter_panic_safe" },
      confidence: 0.8,
      source_summary: "panic deterministic fallback",
      needs_operator_review: false,
    });
  }

  return ShowIntentEnvelopeSchema.parse({
    intent: {
      type: "log_note",
      note: `Unmapped AI party command held as note: ${message}`,
      tags: ["ai_party_live", "unmapped"],
    },
    confidence: 0.55,
    source_summary: "unmapped deterministic fallback",
    needs_operator_review: true,
  });
}

function extractContent(raw: unknown): string {
  const parsed = z
    .object({
      message: z.object({ content: z.string().optional() }).optional(),
      response: z.string().optional(),
      output: z.string().optional(),
      model: z.string().optional(),
      total_duration: z.number().optional(),
    })
    .passthrough()
    .parse(raw);
  return parsed.message?.content ?? parsed.response ?? parsed.output ?? "";
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("model did not return valid JSON");
  }
}

function promptFor(input: OllamaShowIntentInput, repairText?: string): string {
  const catalog = DEFAULT_AI_PARTY_CUE_CATALOG.map((cue) => ({
    name: cue.name,
    kind: cue.kind,
    risk: cue.risk,
    preapproved: cue.preapproved,
  }));
  return JSON.stringify(
    {
      task: repairText
        ? "Repair the previous output so it is valid ShowIntent envelope JSON only."
        : "Parse the user/operator message into one ShowIntent envelope JSON object.",
      current_state: input.currentState,
      cue_catalog: catalog,
      safety_summary: {
        raw_dmx: "blocked",
        raw_python: "blocked",
        blackout: "blocked",
        freeze: "blocked",
        laser: "blocked",
        moving_head: "blocked",
        pa_mixer: "blocked",
        fog: "approval, max 3s, max 0.45",
        strobe: "approval, max 0.25",
      },
      user_message: input.message,
      invalid_previous_output: repairText,
      output_schema_hint: {
        intent: "ShowIntent",
        confidence: "0..1",
        source_summary: "short string",
        needs_operator_review: "boolean",
      },
    },
    null,
    2,
  );
}

async function callOllama(input: OllamaShowIntentInput, repairText?: string): Promise<unknown> {
  const fetcher = input.fetchImpl ?? fetch;
  const body = {
    model: input.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: promptFor(input, repairText) },
    ],
    stream: false,
    format: z.toJSONSchema(ShowIntentEnvelopeSchema),
    options: { temperature: 0.1 },
  };
  const res = await fetcher(`${input.ollamaBaseUrl.replace(/\/+$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`Ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function parseOllamaShowIntent(
  input: OllamaShowIntentInput,
): Promise<OllamaShowIntentResult> {
  const started = Date.now();
  if (!input.model.trim()) {
    return {
      ok: false,
      envelope: input.deterministicFallback
        ? deterministicEnvelope(input.message, "OLLAMA_MODEL is not configured")
        : blockedEnvelope("OLLAMA_MODEL is not configured"),
      latency_ms: Date.now() - started,
      error: "OLLAMA_MODEL is not configured",
    };
  }

  try {
    const raw = await callOllama(input);
    let envelope: ShowIntentEnvelope;
    try {
      envelope = parseShowIntentEnvelope(parseJsonText(extractContent(raw)));
      if (envelope.intent.type !== "blocked_request") {
        return { ok: true, envelope, model: input.model, latency_ms: Date.now() - started };
      }
    } catch {
      envelope = blockedEnvelope(
        "The local LLM returned invalid JSON.",
        "The local LLM returned invalid JSON; attempting one repair pass.",
      );
    }
    const repaired = await callOllama(input, JSON.stringify(raw).slice(0, 4000));
    const repairedEnvelope = parseShowIntentEnvelope(parseJsonText(extractContent(repaired)));
    return {
      ok: repairedEnvelope.intent.type !== "blocked_request",
      envelope: repairedEnvelope,
      model: input.model,
      latency_ms: Date.now() - started,
      repaired: true,
      error:
        repairedEnvelope.intent.type === "blocked_request"
          ? repairedEnvelope.intent.operator_message
          : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      envelope: input.deterministicFallback
        ? deterministicEnvelope(input.message, message)
        : blockedEnvelope(message, "The local LLM is unavailable. Nothing was dispatched."),
      model: input.model,
      latency_ms: Date.now() - started,
      error: message,
    };
  }
}

export { deterministicEnvelope as deterministicShowIntentEnvelope };

import { z } from "zod";
import type { ShowIntent } from "./showDirectorSchema.js";
import { ShowIntentSchema } from "./showDirectorSchema.js";

const NonEmptyString = z.string().trim().min(1);
const Confidence = z.number().min(0).max(1).default(1);

export const AiPartyTextEventSchema = z.object({
  type: z.enum(["operator_text", "voice_transcript"]),
  text: NonEmptyString,
  confidence: Confidence.optional(),
  speaker: z.string().trim().optional(),
});

export const AiPartyDashboardActionSchema = z.object({
  type: z.literal("dashboard_action"),
  action: z.enum(["approve", "cancel", "panic_status"]),
  approval_id: z.string().trim().optional(),
  operator: z.string().trim().optional(),
});

export const AiPartyAudioSectionSchema = z.object({
  type: z.literal("audio_section"),
  section: z.enum(["doors", "intro", "build", "drop", "breakdown", "closing"]),
  energy: z.number().min(0).max(1).default(0.5),
  palette: z.array(NonEmptyString).max(8).optional(),
});

export const AiPartyScriptedIntentSchema = z.object({
  type: z.literal("scripted_intent"),
  label: z.string().trim().optional(),
  intent: ShowIntentSchema,
});

export const AiPartyFanInEventSchema = z.discriminatedUnion("type", [
  AiPartyTextEventSchema,
  AiPartyDashboardActionSchema,
  AiPartyAudioSectionSchema,
  AiPartyScriptedIntentSchema,
]);

export type AiPartyFanInEvent = z.infer<typeof AiPartyFanInEventSchema>;

export interface AiPartyFanInOptions {
  lowConfidenceThreshold?: number;
}

export type AiPartyFanInResult =
  | {
      ok: true;
      source_type: AiPartyFanInEvent["type"];
      confidence: number;
      intent: ShowIntent;
      rationale: string;
      warnings: string[];
    }
  | {
      ok: false;
      source_type?: AiPartyFanInEvent["type"];
      issues: string[];
    };

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function numberInText(text: string): number | undefined {
  const match = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!match?.[1]) return undefined;
  const n = Number(match[1].replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function durationSeconds(text: string, fallback: number): number {
  const n = numberInText(text);
  if (n === undefined) return fallback;
  return /\b(min|mins|minuto|minutos)\b/.test(text) ? n * 60 : n;
}

function intensity(text: string, fallback: number): number {
  const n = numberInText(text);
  if (/\b(intensidade|intensity)\b/.test(text) && n !== undefined && n <= 1) return n;
  if (/\b(forte|strong|hard|max|chaotic|caotico|caotica|pesado)\b/.test(text)) return 0.8;
  if (/\b(leve|soft|baixo|low|subtle|sutil)\b/.test(text)) return 0.25;
  return fallback;
}

function lowConfidenceIntent(text: string): ShowIntent {
  return {
    type: "log_note",
    note: `Low-confidence AI party request held for operator review: ${text}`,
    tags: ["producer_demo", "low_confidence", "needs_operator_review"],
  };
}

function unmappedIntent(text: string): ShowIntent {
  return {
    type: "log_note",
    note: `Unmapped AI party request held for operator review: ${text}`,
    tags: ["producer_demo", "needs_operator_review"],
  };
}

function effectIntent(text: string): ShowIntent | undefined {
  const defaultDuration = /\b(strobe|strobo|flash)\b/.test(text) ? 5 : 3;
  const effect = /\b(moving head|moving heads|moving_head|pan tilt|pantilt)\b/.test(text)
    ? "moving_head"
    : /\b(laser|lasers)\b/.test(text)
      ? "laser"
      : /\b(mixer gain|ganho|volume do mixer|aumenta o volume)\b/.test(text)
        ? "mixer_gain"
        : /\b(pa mute|mute pa|mutar pa|silenciar pa)\b/.test(text)
          ? "pa_mute"
          : /\b(audio routing|roteamento|routing|rota de audio)\b/.test(text)
            ? "audio_routing"
            : /\b(blackout|black out|apaga tudo|apagar tudo)\b/.test(text)
              ? "blackout"
              : /\b(freeze|congela|congelar)\b/.test(text)
                ? "freeze"
                : /\b(strobe|strobo|flash)\b/.test(text)
                  ? "strobe"
                  : /\b(hazer|haze|nevoa|nevoa)\b/.test(text)
                    ? "hazer"
                    : /\b(fog|fumaca|fumaça|smoke)\b/.test(text)
                      ? "fog"
                      : undefined;
  if (!effect) return undefined;
  return {
    type: "arm_effect",
    effect,
    duration_seconds: durationSeconds(text, defaultDuration),
    intensity: intensity(text, effect === "strobe" ? 0.4 : 0.35),
  };
}

function cueOrMoodIntent(text: string): ShowIntent | undefined {
  if (/\b(doors|preflight|abertura|entrada|lobby)\b/.test(text)) {
    return {
      type: "request_cue",
      cue: "doors_idle",
      scene_id: "doors_preflight",
      preapproved: true,
    };
  }
  if (/\b(band intro|intro da banda|banda|band a|artist intro)\b/.test(text)) {
    return { type: "request_cue", cue: "band_intro", scene_id: "band_a_intro", preapproved: true };
  }
  if (/\b(closing|credits|creditos|encerramento)\b/.test(text)) {
    return {
      type: "request_cue",
      cue: "credits_log",
      scene_id: "closing_audit",
      preapproved: true,
    };
  }
  if (/\b(red|vermelho)\b/.test(text) && /\b(chaos|chaotic|caotico|caotica|intenso)\b/.test(text)) {
    return {
      type: "change_mood",
      mood: "red_chaotic_bounded",
      palette: ["red", "deep_blue", "white"],
      intensity: Math.min(intensity(text, 0.65), 0.8),
    };
  }
  if (/\b(drop|high energy|energia|core|audio reactive|audio reativo)\b/.test(text)) {
    return {
      type: "change_mood",
      mood: "high_energy_audio_reactive",
      palette: ["cyan", "magenta", "white"],
      intensity: Math.min(intensity(text, 0.72), 0.9),
    };
  }
  if (/\b(panic status|status do panic|estado do panic)\b/.test(text)) {
    return { type: "panic_status" };
  }
  return undefined;
}

function normalizeTextEvent(
  event: z.infer<typeof AiPartyTextEventSchema>,
  threshold: number,
): AiPartyFanInResult {
  const confidence = event.confidence ?? (event.type === "voice_transcript" ? 0.8 : 1);
  if (confidence < threshold) {
    return {
      ok: true,
      source_type: event.type,
      confidence,
      intent: lowConfidenceIntent(event.text),
      rationale: "low-confidence transcript is held as a log note for operator review",
      warnings: ["low_confidence"],
    };
  }

  const text = normalizeText(event.text);
  const intent = effectIntent(text) ?? cueOrMoodIntent(text) ?? unmappedIntent(event.text.trim());
  return {
    ok: true,
    source_type: event.type,
    confidence,
    intent,
    rationale:
      intent.type === "log_note"
        ? "request was not mapped to an executable show intent"
        : `mapped ${event.type} to ${intent.type}`,
    warnings: intent.type === "log_note" ? ["needs_operator_review"] : [],
  };
}

function normalizeDashboardAction(
  event: z.infer<typeof AiPartyDashboardActionSchema>,
): AiPartyFanInResult {
  if (event.action === "panic_status") {
    return {
      ok: true,
      source_type: event.type,
      confidence: 1,
      intent: { type: "panic_status" },
      rationale: "dashboard requested panic status only",
      warnings: [],
    };
  }
  if (!event.approval_id?.trim()) {
    return { ok: false, source_type: event.type, issues: ["approval_id is required"] };
  }
  if (event.action === "approve" && !event.operator?.trim()) {
    return { ok: false, source_type: event.type, issues: ["operator is required to approve"] };
  }
  return {
    ok: true,
    source_type: event.type,
    confidence: 1,
    intent:
      event.action === "approve"
        ? {
            type: "approve_effect",
            approval_id: event.approval_id,
            operator: event.operator ?? "",
          }
        : {
            type: "cancel_effect",
            approval_id: event.approval_id,
            operator: event.operator,
          },
    rationale: `dashboard ${event.action} action became a show-director control intent`,
    warnings: [],
  };
}

function normalizeAudioSection(
  event: z.infer<typeof AiPartyAudioSectionSchema>,
): AiPartyFanInResult {
  const mood =
    event.section === "drop"
      ? "high_energy_audio_reactive"
      : event.section === "breakdown"
        ? "low_density_breakdown"
        : `${event.section}_section`;
  return {
    ok: true,
    source_type: event.type,
    confidence: 1,
    intent: {
      type: "change_mood",
      mood,
      palette: event.palette,
      intensity: event.energy,
    },
    rationale: "audio section updates mood only; beat-tight timing remains inside TouchDesigner",
    warnings: ["audio_timing_stays_local"],
  };
}

export function normalizeAiPartyEvent(
  raw: unknown,
  options: AiPartyFanInOptions = {},
): AiPartyFanInResult {
  const parsed = AiPartyFanInEventSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  const threshold = options.lowConfidenceThreshold ?? 0.6;
  switch (parsed.data.type) {
    case "operator_text":
    case "voice_transcript":
      return normalizeTextEvent(parsed.data, threshold);
    case "dashboard_action":
      return normalizeDashboardAction(parsed.data);
    case "audio_section":
      return normalizeAudioSection(parsed.data);
    case "scripted_intent":
      return {
        ok: true,
        source_type: parsed.data.type,
        confidence: 1,
        intent: parsed.data.intent,
        rationale: "scripted POC intent passed through unchanged",
        warnings: [],
      };
  }
}

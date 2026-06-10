import { type ShowIntentEnvelope, ShowIntentEnvelopeSchema } from "./schemas.js";

export interface ParsedAiPartyTelegramCommand {
  rawText: string;
  replyOnly?: boolean;
  demo?: boolean;
  approvalAction?: "approve" | "reject";
  approvalId?: string;
  envelope?: ShowIntentEnvelope;
}

function numberAt(tokens: string[], index: number, fallback: number): number {
  const value = Number(tokens[index]);
  return Number.isFinite(value) ? value : fallback;
}

function envelope(intent: ShowIntentEnvelope["intent"], summary: string, review = false) {
  return ShowIntentEnvelopeSchema.parse({
    intent,
    confidence: 1,
    source_summary: summary,
    needs_operator_review: review,
  });
}

export function parseAiPartyTelegramCommand(rawText: string): ParsedAiPartyTelegramCommand {
  const text = rawText.trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  const command = tokens[0]?.split("@")[0]?.toLowerCase();
  const rest = tokens.slice(1);

  if (!command?.startsWith("/")) {
    return { rawText: text };
  }
  if (command === "/start" || command === "/help" || command === "/status" || command === "/cues") {
    return { rawText: text, replyOnly: true };
  }
  if (command === "/demo") return { rawText: text, demo: true };
  if (command === "/approve") {
    return { rawText: text, approvalAction: "approve", approvalId: rest[0] };
  }
  if (command === "/reject" || command === "/deny") {
    return { rawText: text, approvalAction: "reject", approvalId: rest[0] };
  }
  if (command === "/panic") {
    return {
      rawText: text,
      envelope: envelope({ type: "panic_status", request: "enter_panic_safe" }, "telegram panic"),
    };
  }
  if (command === "/cue") {
    const cue = rest[0] ?? "";
    return {
      rawText: text,
      envelope: envelope(
        { type: "request_cue", cue, cue_kind: cue === "panic_safe" ? "safe_state" : "combined" },
        `telegram cue ${cue}`,
      ),
    };
  }
  if (command === "/mood") {
    const intensity = Math.min(0.85, numberAt(rest, rest.length - 1, 0.55));
    const moodTokens = rest.filter((token) => !/^\d+(?:\.\d+)?$/.test(token));
    return {
      rawText: text,
      envelope: envelope(
        { type: "change_mood", mood: moodTokens.join(" ") || "balanced", intensity },
        "telegram mood",
      ),
    };
  }
  if (command === "/fog" || command === "/hazer" || command === "/strobe") {
    const effect = command.slice(1) as "fog" | "hazer" | "strobe";
    return {
      rawText: text,
      envelope: envelope(
        {
          type: "arm_effect",
          effect,
          duration_seconds: numberAt(rest, 0, effect === "strobe" ? 2 : 3),
          intensity: numberAt(rest, 1, effect === "strobe" ? 0.2 : 0.35),
          timing: "manual",
          reason: "telegram command",
        },
        `telegram ${effect}`,
        true,
      ),
    };
  }

  return { rawText: text };
}

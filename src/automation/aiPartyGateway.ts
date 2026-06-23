import { z } from "zod";
import { normalizeAiPartyEvent } from "./aiPartyFanIn.js";
import {
  createShowDirectorState,
  type ShowActionPlan,
  type ShowDirectorState,
  ShowDirectorStateSchema,
  submitShowIntent,
} from "./showDirectorRuntime.js";
import {
  type EffectPolicy,
  EffectPolicySchema,
  type PolicyDecision,
  ShowEffectSchema,
  type ShowIntent,
  ShowIntentSchema,
} from "./showDirectorSchema.js";

const NonEmptyString = z.string().trim().min(1);
const ChatIdSchema = z.union([z.string().trim().min(1), z.number().int()]);

export const AiPartyChatRoleSchema = z.enum(["operator", "crew", "audience"]);
export type AiPartyChatRole = z.infer<typeof AiPartyChatRoleSchema>;

export const AiPartyUserRoleSchema = z.enum(["foh", "operator", "crew", "audience", "unknown"]);
export type AiPartyUserRole = z.infer<typeof AiPartyUserRoleSchema>;

export const AiPartyMessageSchema = z.object({
  message_id: NonEmptyString.default("manual_0001"),
  chat_id: ChatIdSchema.optional(),
  chat_role: AiPartyChatRoleSchema.default("operator"),
  user_id: ChatIdSchema.optional(),
  user_role: AiPartyUserRoleSchema.default("operator"),
  username: z.string().trim().optional(),
  text: NonEmptyString,
  received_at: z.string().trim().optional(),
});
export type AiPartyMessage = z.infer<typeof AiPartyMessageSchema>;

export const AiPartyShowStateSchema = z
  .object({
    current_scene: z.string().trim().optional(),
    next_scene: z.string().trim().optional(),
    panic: z.boolean().default(false),
    pending_approvals: z.array(NonEmptyString).default([]),
    recent_effects: z
      .array(
        z.object({
          effect: ShowEffectSchema,
          at: z.string().trim(),
        }),
      )
      .default([]),
  })
  .default({ panic: false, pending_approvals: [], recent_effects: [] });
export type AiPartyShowState = z.infer<typeof AiPartyShowStateSchema>;

export const HermesShowCandidateSchema = z.object({
  intent: ShowIntentSchema,
  confidence: z.number().min(0).max(1).default(1),
  rationale: NonEmptyString.default("deterministic fallback parser"),
  operator_reply: z.string().trim().optional(),
});
export type HermesShowCandidate = z.infer<typeof HermesShowCandidateSchema>;

export const DEFAULT_AI_PARTY_PREAPPROVED_CUES = [
  "doors_idle",
  "ai_intro_text",
  "band_intro",
  "music_reactive_main",
  "audience_mood_shift",
  "policy_demo",
  "recap_log",
] as const;

export const AiPartyGatewaySchema = z.object({
  message: AiPartyMessageSchema,
  hermes: z.unknown().optional().describe("Optional raw Hermes structured response."),
  show_state: AiPartyShowStateSchema,
  state: ShowDirectorStateSchema.optional(),
  policy: EffectPolicySchema.optional(),
  preapproved_cues: z.array(NonEmptyString).default([...DEFAULT_AI_PARTY_PREAPPROVED_CUES]),
  min_confidence: z.number().min(0).max(1).default(0.55),
});
export type AiPartyGatewayInput = z.input<typeof AiPartyGatewaySchema>;
export type AiPartyGatewayArgs = z.infer<typeof AiPartyGatewaySchema>;

export interface AiPartyGatewayResult {
  dryRun: true;
  source: "hermes" | "fallback" | "blocked";
  message: AiPartyMessage;
  hermes?: HermesShowCandidate;
  decision: PolicyDecision;
  plan: ShowActionPlan[];
  approval?: unknown;
  state: ShowDirectorState;
  telegram_reply: string;
}

interface ParsedFallback {
  candidate: HermesShowCandidate;
  command: string;
}

const INTENSITY_WORDS: Record<string, number> = {
  low: 0.25,
  light: 0.35,
  soft: 0.35,
  medium: 0.5,
  normal: 0.5,
  high: 0.75,
  heavy: 0.85,
  full: 1,
};

function commandToken(text: string): { command: string; rest: string[] } | undefined {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first?.startsWith("/")) return undefined;
  const command = first.split("@")[0]?.toLowerCase() ?? first.toLowerCase();
  return { command, rest: tokens.slice(1) };
}

function isIntensityToken(token: string): boolean {
  return /^\d{1,3}%?$/.test(token) || INTENSITY_WORDS[token.toLowerCase()] !== undefined;
}

function intensityFromTokens(tokens: string[], fallback: number): number {
  const found = tokens.find(isIntensityToken);
  if (!found) return fallback;
  const word = INTENSITY_WORDS[found.toLowerCase()];
  if (word !== undefined) return word;
  const normalized = found.endsWith("%") ? found.slice(0, -1) : found;
  const value = Number.parseInt(normalized, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function durationSecondsFromTokens(tokens: string[], fallback?: number): number | undefined {
  const found = tokens.find((token) => /^\d+(s|sec|secs|second|seconds)?$/i.test(token));
  if (!found) return fallback;
  const match = found.match(/^(\d+)/);
  if (!match?.[1]) return fallback;
  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

function wordsWithoutControls(tokens: string[]): string[] {
  return tokens.filter((token) => !isIntensityToken(token) && !/^\d+(s|sec|secs)?$/i.test(token));
}

function normalizedSceneId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function operatorName(message: AiPartyMessage): string {
  if (message.username?.trim()) return message.username.trim();
  if (message.user_id !== undefined) return String(message.user_id);
  return message.user_role;
}

function isPreapprovedCue(cue: string, cues: string[]): boolean {
  return cues.includes(cue);
}

function fallbackForCommand(
  message: AiPartyMessage,
  command: string,
  rest: string[],
  preapprovedCues: string[],
): HermesShowCandidate | undefined {
  if (command === "/status" || command === "/panic") {
    return {
      intent: { type: "panic_status" },
      confidence: 1,
      rationale: `${command} is status-only in Telegram; local panic remains local`,
      operator_reply: "Panic/status check requested. Telegram will not trigger local panic.",
    };
  }

  if (command === "/approve") {
    const approvalId = rest[0];
    if (!approvalId) return undefined;
    return {
      intent: { type: "approve_effect", approval_id: approvalId, operator: operatorName(message) },
      confidence: 1,
      rationale: "operator approved a queued effect",
    };
  }

  if (command === "/deny" || command === "/cancel") {
    const approvalId = rest[0];
    if (!approvalId) return undefined;
    return {
      intent: { type: "cancel_effect", approval_id: approvalId, operator: operatorName(message) },
      confidence: 1,
      rationale: "operator cancelled a queued effect",
    };
  }

  if (command === "/fog" || command === "/hazer" || command === "/strobe") {
    const effect = command.slice(1) as "fog" | "hazer" | "strobe";
    return {
      intent: {
        type: "arm_effect",
        effect,
        duration_seconds: durationSecondsFromTokens(rest, effect === "strobe" ? undefined : 3),
        intensity: intensityFromTokens(rest, effect === "strobe" ? 0.35 : 0.35),
      },
      confidence: 0.9,
      rationale: `operator requested a bounded ${effect} cue`,
    };
  }

  if (command === "/mood" || command === "/lights" || command === "/vibe" || command === "/vote") {
    const moodTokens = wordsWithoutControls(rest);
    const mood = moodTokens.length > 0 ? moodTokens.join(" ") : "balanced";
    const audienceCap = message.chat_role === "audience" ? 0.4 : 1;
    const intensity = Math.min(intensityFromTokens(rest, 0.5), audienceCap);
    return {
      intent: { type: "change_mood", mood, intensity },
      confidence: command === "/lights" ? 0.72 : 0.9,
      rationale:
        command === "/lights"
          ? "lighting request is reduced to a safe visual mood until fixture policy exists"
          : "mood request maps to bounded visual parameters",
    };
  }

  if (command === "/cue") {
    const cue = rest[0];
    if (!cue) return undefined;
    return {
      intent: {
        type: "request_cue",
        cue,
        preapproved: isPreapprovedCue(cue, preapprovedCues),
      },
      confidence: 0.92,
      rationale: "operator requested a named cue",
    };
  }

  if (command === "/band") {
    const bandName = rest[0] === "start" ? rest.slice(1).join(" ") : rest.join(" ");
    const sceneId = bandName ? `band_${normalizedSceneId(bandName)}` : undefined;
    return {
      intent: {
        type: "request_cue",
        cue: "band_intro",
        scene_id: sceneId,
        preapproved: isPreapprovedCue("band_intro", preapprovedCues),
      },
      confidence: 0.9,
      rationale: bandName
        ? `band intro requested for ${bandName}`
        : "band intro requested without a band name",
      operator_reply: bandName ? `Arming intro cue for ${bandName}.` : undefined,
    };
  }

  if (command === "/announce") {
    const text = rest.join(" ").trim();
    if (!text) return undefined;
    return {
      intent: { type: "announce", text },
      confidence: 0.88,
      rationale: "operator requested a PA or screen announcement",
    };
  }

  if (command === "/message") {
    const note = rest.join(" ").trim();
    if (!note) return undefined;
    return {
      intent: { type: "log_note", note, tags: ["telegram", message.chat_role] },
      confidence: 0.8,
      rationale: "audience message captured as a show note",
    };
  }

  return undefined;
}

export function fallbackHermesCandidate(args: AiPartyGatewayArgs): ParsedFallback | undefined {
  const parsed = commandToken(args.message.text);
  if (!parsed) {
    const normalized = normalizeAiPartyEvent({
      type: "operator_text",
      text: args.message.text,
      confidence: args.message.chat_role === "audience" ? 0.7 : 0.85,
    });
    if (normalized.ok && normalized.intent.type !== "log_note") {
      return {
        command: "message",
        candidate: {
          intent: normalized.intent,
          confidence: normalized.confidence,
          rationale: normalized.rationale,
        },
      };
    }
    return {
      command: "message",
      candidate: {
        intent: {
          type: "log_note",
          note: args.message.text,
          tags: ["telegram", args.message.chat_role],
        },
        confidence: args.message.chat_role === "audience" ? 0.7 : 0.85,
        rationale: "plain Telegram text is captured as a show note",
      },
    };
  }
  const candidate = fallbackForCommand(
    args.message,
    parsed.command,
    parsed.rest,
    args.preapproved_cues,
  );
  return candidate ? { command: parsed.command, candidate } : undefined;
}

function authorized(
  message: AiPartyMessage,
  intent: ShowIntent,
): { ok: true } | { ok: false; reason: string } {
  if (message.chat_role !== "audience") return { ok: true };
  if (
    intent.type === "change_mood" ||
    intent.type === "log_note" ||
    intent.type === "panic_status"
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `audience chat may suggest mood or notes, not ${intent.type}`,
  };
}

function auditId(state: ShowDirectorState): string {
  return `audit_${String(state.audit_log.length + 1).padStart(4, "0")}`;
}

function addGatewayAudit(
  state: ShowDirectorState,
  decision: PolicyDecision,
  status: "blocked" | "invalid",
): ShowDirectorState {
  const next = ShowDirectorStateSchema.parse(state);
  next.audit_log.push({
    id: auditId(next),
    at: new Date().toISOString(),
    status,
    intent_type: decision.intent_type,
    effect: decision.effect,
    decision: decision.decision,
    reason: decision.reason,
  });
  return next;
}

function blockedResult(
  args: AiPartyGatewayArgs,
  reason: string,
  status: "blocked" | "invalid" = "blocked",
  intent?: ShowIntent,
): AiPartyGatewayResult {
  const decision: PolicyDecision = {
    decision: "block",
    reason,
    intent_type: intent?.type ?? "telegram_message",
    effect: intent?.type === "arm_effect" ? intent.effect : undefined,
    limits_applied: [],
    requires_operator: false,
  };
  const state = addGatewayAudit(args.state ?? createShowDirectorState(), decision, status);
  const result: AiPartyGatewayResult = {
    dryRun: true,
    source: "blocked",
    message: args.message,
    decision,
    plan: [],
    state,
    telegram_reply: "",
  };
  return { ...result, telegram_reply: formatAiPartyTelegramReply(result) };
}

function decisionLabel(decision: PolicyDecision): string {
  if (decision.decision === "allow") return "ALLOW";
  if (decision.decision === "require_approval") return "QUEUED";
  return "BLOCKED";
}

function describePlan(plan: ShowActionPlan[]): string {
  if (plan.length === 0) return "No executable plan was produced.";
  return plan
    .map((item) => {
      if (item.kind === "cue") return `cue ${item.cue}`;
      if (item.kind === "mood") return `mood ${item.mood} intensity ${item.intensity}`;
      if (item.kind === "announcement") return `announcement "${item.text}"`;
      if (item.kind === "effect") return `${item.effect} effect for operator ${item.operator}`;
      return `log note "${item.note}"`;
    })
    .join("; ");
}

export function formatAiPartyTelegramReply(result: AiPartyGatewayResult): string {
  const audit = result.state.audit_log.at(-1)?.id;
  const base = `${decisionLabel(result.decision)} ${result.decision.intent_type}: ${
    result.decision.reason
  }`;
  const approval =
    result.approval && typeof result.approval === "object" && "id" in result.approval
      ? ` Approval: ${String(result.approval.id)}.`
      : "";
  const plan = ` Plan: ${describePlan(result.plan)}`;
  const suffix = audit ? ` Audit: ${audit}.` : "";
  return `${base}.${approval}${plan}${suffix}`;
}

export function runAiPartyGateway(input: AiPartyGatewayInput): AiPartyGatewayResult {
  const args = AiPartyGatewaySchema.parse(input);
  const state = args.state ?? createShowDirectorState();

  let source: "hermes" | "fallback" = "fallback";
  let candidate: HermesShowCandidate | undefined;

  if (args.hermes !== undefined) {
    const hermes = HermesShowCandidateSchema.safeParse(args.hermes);
    if (!hermes.success) {
      const issues = hermes.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      return blockedResult(args, `Malformed Hermes output: ${issues}`, "invalid");
    }
    source = "hermes";
    candidate = hermes.data;
  } else {
    candidate = fallbackHermesCandidate(args)?.candidate;
  }

  if (!candidate) {
    return blockedResult(args, `Unsupported Telegram command: ${args.message.text}`);
  }

  if (candidate.confidence < args.min_confidence) {
    return blockedResult(
      args,
      `Hermes confidence ${candidate.confidence} is below ${args.min_confidence}`,
      "blocked",
      candidate.intent,
    );
  }

  const permission = authorized(args.message, candidate.intent);
  if (!permission.ok) {
    return blockedResult(args, permission.reason, "blocked", candidate.intent);
  }

  const submitted = submitShowIntent(
    state,
    candidate.intent,
    args.policy as EffectPolicy | undefined,
  );
  const result: AiPartyGatewayResult = {
    dryRun: true,
    source,
    message: args.message,
    hermes: candidate,
    decision: submitted.decision,
    plan: submitted.plan,
    approval: submitted.approval,
    state: submitted.state,
    telegram_reply: "",
  };
  return { ...result, telegram_reply: formatAiPartyTelegramReply(result) };
}

import { z } from "zod";
import type { ShowIntent } from "../showDirectorSchema.js";
import { ShowEffectSchema, ShowIntentSchema } from "../showDirectorSchema.js";

const NonEmptyString = z.string().trim().min(1);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;

export const AI_PARTY_TIMELINE_SCENES = [
  "doors",
  "warmup",
  "build",
  "drop",
  "breakdown",
  "closing",
] as const;

export const AiPartyTimelineSceneSchema = z.enum(AI_PARTY_TIMELINE_SCENES);
export type AiPartyTimelineScene = z.infer<typeof AiPartyTimelineSceneSchema>;

export const AiPartyTimelineStateSchema = z.object({
  scenes: z.array(AiPartyTimelineSceneSchema).min(1),
  current_scene: AiPartyTimelineSceneSchema,
  next_scene: AiPartyTimelineSceneSchema.optional(),
  current_index: z.number().int().nonnegative(),
});
export type AiPartyTimelineState = z.infer<typeof AiPartyTimelineStateSchema>;

export const ShowIntentEnvelopeSchema = z.object({
  intent: ShowIntentSchema,
  confidence: z.number().min(0).max(1),
  source_summary: NonEmptyString,
  needs_operator_review: z.boolean(),
});
export type ShowIntentEnvelope = z.infer<typeof ShowIntentEnvelopeSchema>;

export const AiPartyPolicyDecisionSchema = z.object({
  decision: z.enum(["allow", "approval_required", "block"]),
  reason: NonEmptyString,
  risk_level: z.enum(["safe", "approval", "blocked"]),
  requires_hardware_gate: z.boolean(),
  plan: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("cue"),
        cue: NonEmptyString,
        intensity: z.number().min(0).max(1).optional(),
      }),
      z.object({
        kind: z.literal("mood"),
        mood: NonEmptyString,
        intensity: z.number().min(0).max(1),
        duration_seconds: z.number().positive().optional(),
      }),
      z.object({
        kind: z.literal("announcement"),
        text: NonEmptyString,
        tone: z.enum(["neutral", "premium", "hype", "calm"]).optional(),
      }),
      z.object({
        kind: z.literal("physical_effect"),
        effect: ShowEffectSchema,
        duration_seconds: z.number().positive(),
        intensity: z.number().min(0).max(1),
      }),
      z.object({
        kind: z.literal("panic_safe"),
      }),
      z.object({
        kind: z.literal("log_note"),
        note: NonEmptyString,
        tags: z.array(NonEmptyString).default([]),
      }),
    ]),
  ),
  operator_message: NonEmptyString,
});
export type AiPartyPolicyDecision = z.infer<typeof AiPartyPolicyDecisionSchema>;
export type AiPartyDispatchAction = AiPartyPolicyDecision["plan"][number];

export const AiPartyDispatchResultSchema = z.object({
  id: NonEmptyString,
  at: z.string().regex(ISO_TIME),
  mode: z.enum(["simulation", "touchdesigner", "hardware"]),
  hardware_sent: z.boolean(),
  actions: z.array(z.unknown()),
  message: NonEmptyString,
});
export type AiPartyDispatchResult = z.infer<typeof AiPartyDispatchResultSchema>;

export const AiPartyShowStateSchema = z.object({
  mode: z.enum(["rehearsal", "show"]),
  panic: z.boolean(),
  current_mood: NonEmptyString,
  current_cue: NonEmptyString,
  current_intensity: z.number().min(0).max(1),
  crowd_energy: z.number().min(0).max(1).optional(),
  music_section: z
    .enum(["idle", "doors", "warmup", "build", "drop", "breakdown", "closing", "unknown"])
    .optional(),
  timeline: AiPartyTimelineStateSchema,
  timeline_scene_id: z.string().optional(),
  next_scene_id: z.string().optional(),
  llm_status: z.enum(["unknown", "ok", "error"]),
  td_status: z.enum(["unknown", "ok", "error"]),
  telegram_status: z.enum(["disabled", "ok", "error"]),
  hardware_enabled: z.boolean(),
  dmx_live_enabled: z.boolean(),
  recent_effects: z
    .array(z.object({ effect: ShowEffectSchema, at: z.string().regex(ISO_TIME) }))
    .default([]),
  pending_approvals_count: z.number().int().nonnegative(),
  last_intent: z.unknown().optional(),
  last_policy: AiPartyPolicyDecisionSchema.optional(),
  last_dispatch: AiPartyDispatchResultSchema.optional(),
  last_error: z.string().optional(),
  last_source: z.string().optional(),
  llm_latency_ms: z.number().nonnegative().optional(),
});
export type AiPartyShowState = z.infer<typeof AiPartyShowStateSchema>;

export const AiPartyApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "dispatched",
  "simulated",
]);
export type AiPartyApprovalStatus = z.infer<typeof AiPartyApprovalStatusSchema>;

export const AiPartyApprovalSchema = z.object({
  id: NonEmptyString,
  created_at: z.string().regex(ISO_TIME),
  source: z.enum(["dashboard", "telegram", "llm", "demo_script"]),
  raw_text: z.string(),
  parsed_intent: ShowIntentSchema,
  policy_result: AiPartyPolicyDecisionSchema,
  status: AiPartyApprovalStatusSchema,
  operator: z.string().optional(),
  approved_at: z.string().regex(ISO_TIME).optional(),
  rejected_at: z.string().regex(ISO_TIME).optional(),
  dispatched_at: z.string().regex(ISO_TIME).optional(),
  rejection_reason: z.string().optional(),
});
export type AiPartyApproval = z.infer<typeof AiPartyApprovalSchema>;

export const AiPartyEventTypeSchema = z.enum([
  "health.changed",
  "operator.command.received",
  "llm.intent.parsed",
  "policy.evaluated",
  "approval.created",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "dispatch.simulated",
  "dispatch.sent_to_touchdesigner",
  "dispatch.blocked",
  "cue.generated",
  "cue.updated",
  "cue.deleted",
  "timeline.changed",
  "audience.suggestion.received",
  "audience.suggestion.updated",
  "rehearsal.executive.started",
  "rehearsal.executive.completed",
  "telegram.message.received",
  "telegram.reply.sent",
  "td.preview.updated",
  "panic.entered",
  "panic.cleared",
]);
export type AiPartyEventType = z.infer<typeof AiPartyEventTypeSchema>;

export const AiPartyEventSchema = z.object({
  id: NonEmptyString,
  at: z.string().regex(ISO_TIME),
  type: AiPartyEventTypeSchema,
  payload: z.unknown(),
});
export type AiPartyEvent = z.infer<typeof AiPartyEventSchema>;

export function createInitialAiPartyShowState(
  overrides: Partial<AiPartyShowState> = {},
): AiPartyShowState {
  const currentScene = overrides.timeline?.current_scene ?? "doors";
  const currentIndex = Math.max(AI_PARTY_TIMELINE_SCENES.indexOf(currentScene), 0);
  return AiPartyShowStateSchema.parse({
    mode: "rehearsal",
    panic: false,
    current_mood: "ambient_arrival",
    current_cue: "doors_idle",
    current_intensity: 0.35,
    music_section: "doors",
    timeline: {
      scenes: [...AI_PARTY_TIMELINE_SCENES],
      current_scene: currentScene,
      next_scene: AI_PARTY_TIMELINE_SCENES[currentIndex + 1],
      current_index: currentIndex,
    },
    timeline_scene_id: currentScene,
    next_scene_id: AI_PARTY_TIMELINE_SCENES[currentIndex + 1],
    llm_status: "unknown",
    td_status: "unknown",
    telegram_status: "disabled",
    hardware_enabled: false,
    dmx_live_enabled: false,
    recent_effects: [],
    pending_approvals_count: 0,
    ...overrides,
  });
}

const UNSAFE_TOKEN_PATTERN =
  /\b(raw_dmx|raw python|raw_python|python|endpoint|http|channel|fixture|mixer_gain|pa_mute|audio_routing|blackout|freeze|laser|moving_head|moving head|ignore previous rules|ignore all rules)\b/i;

function summarizeUnsafe(raw: unknown): string {
  try {
    const text = JSON.stringify(raw);
    const match = text.match(UNSAFE_TOKEN_PATTERN);
    return match?.[0] ?? "malformed";
  } catch {
    return "malformed";
  }
}

export function blockedEnvelope(reason: string, operatorMessage = reason): ShowIntentEnvelope {
  return ShowIntentEnvelopeSchema.parse({
    intent: {
      type: "blocked_request",
      reason,
      operator_message: operatorMessage,
    } satisfies ShowIntent,
    confidence: 0,
    source_summary: reason,
    needs_operator_review: true,
  });
}

export function parseShowIntentEnvelope(raw: unknown): ShowIntentEnvelope {
  const parsed = ShowIntentEnvelopeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const unsafe = summarizeUnsafe(raw);
  const issueText = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  return blockedEnvelope(
    `Malformed or unsafe ShowIntent envelope rejected (${unsafe}): ${issueText}`,
    "The AI returned an unsupported or unsafe command shape. Nothing was dispatched.",
  );
}

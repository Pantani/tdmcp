import { z } from "zod";

export const ShowDecisionSchema = z.enum(["allow", "require_approval", "block"]);

export type ShowDecision = z.infer<typeof ShowDecisionSchema>;

export const ShowEffectSchema = z.enum([
  "fog",
  "hazer",
  "strobe",
  "blackout",
  "freeze",
  "moving_head",
  "laser",
  "mixer_gain",
  "pa_mute",
  "audio_routing",
]);

export type ShowEffect = z.infer<typeof ShowEffectSchema>;

const NonEmptyString = z.string().trim().min(1);

export const ShowIntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("announce"),
    text: NonEmptyString,
    voice: z.string().trim().optional(),
  }),
  z.object({
    type: z.literal("change_mood"),
    mood: NonEmptyString,
    palette: z.array(NonEmptyString).max(8).optional(),
    intensity: z.number().min(0).max(1).default(0.5),
  }),
  z.object({
    type: z.literal("request_cue"),
    cue: NonEmptyString,
    scene_id: z.string().trim().optional(),
    preapproved: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("arm_effect"),
    effect: ShowEffectSchema,
    duration_seconds: z.number().positive().optional(),
    intensity: z.number().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal("approve_effect"),
    approval_id: NonEmptyString,
    operator: NonEmptyString,
  }),
  z.object({
    type: z.literal("cancel_effect"),
    approval_id: NonEmptyString,
    operator: z.string().trim().optional(),
  }),
  z.object({
    type: z.literal("panic_status"),
  }),
  z.object({
    type: z.literal("log_note"),
    note: NonEmptyString,
    tags: z.array(NonEmptyString).max(16).default([]),
  }),
]);

export type ShowIntent = z.infer<typeof ShowIntentSchema>;

export const EffectPolicyEntrySchema = z.object({
  effect: ShowEffectSchema,
  decision: ShowDecisionSchema.default("block"),
  max_duration_seconds: z.number().positive().optional(),
  max_intensity: z.number().min(0).max(1).optional(),
  cooldown_seconds: z.number().nonnegative().optional(),
  operator_only: z.boolean().default(false),
  reason: z.string().trim().optional(),
});

export type EffectPolicyEntry = z.infer<typeof EffectPolicyEntrySchema>;

export const EffectPolicySchema = z.object({
  effects: z.array(EffectPolicyEntrySchema).default([]),
});

export type EffectPolicy = z.infer<typeof EffectPolicySchema>;

export const PolicyDecisionSchema = z.object({
  decision: ShowDecisionSchema,
  reason: z.string(),
  intent_type: z.string(),
  effect: ShowEffectSchema.optional(),
  limits_applied: z.array(z.string()).default([]),
  requires_operator: z.boolean().default(false),
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface ShowIntentEvaluationContext {
  recent_effects?: Array<{ effect: ShowEffect; at: string | Date }>;
  now?: Date;
}

export type ParsedShowIntent =
  | { ok: true; intent: ShowIntent; decision: PolicyDecision }
  | { ok: false; decision: PolicyDecision; issues: string[] };

const DEFAULT_EFFECT_POLICIES: EffectPolicyEntry[] = [
  {
    effect: "fog",
    decision: "require_approval",
    max_duration_seconds: 3,
    max_intensity: 0.5,
    cooldown_seconds: 60,
    operator_only: false,
    reason: "fog requires operator approval and a short bounded cue",
  },
  {
    effect: "hazer",
    decision: "require_approval",
    max_duration_seconds: 3,
    max_intensity: 0.5,
    cooldown_seconds: 60,
    operator_only: false,
    reason: "hazer requires operator approval and a short bounded cue",
  },
  {
    effect: "strobe",
    decision: "require_approval",
    max_duration_seconds: 5,
    max_intensity: 0.4,
    cooldown_seconds: 120,
    operator_only: false,
    reason: "strobe requires operator approval and strict limits",
  },
  {
    effect: "blackout",
    decision: "block",
    operator_only: true,
    reason: "blackout is operator-only",
  },
  {
    effect: "freeze",
    decision: "block",
    operator_only: true,
    reason: "freeze is operator-only",
  },
  {
    effect: "moving_head",
    decision: "block",
    operator_only: true,
    reason: "moving heads are operator-only until venue validation",
  },
  {
    effect: "laser",
    decision: "block",
    operator_only: true,
    reason: "laser output is operator-only",
  },
  {
    effect: "mixer_gain",
    decision: "block",
    operator_only: true,
    reason: "mixer gain is operator-only",
  },
  {
    effect: "pa_mute",
    decision: "block",
    operator_only: true,
    reason: "PA mute is operator-only",
  },
  {
    effect: "audio_routing",
    decision: "block",
    operator_only: true,
    reason: "audio routing is operator-only",
  },
];

export const DEFAULT_EFFECT_POLICY: EffectPolicy = {
  effects: DEFAULT_EFFECT_POLICIES,
};

function policyMap(policy: EffectPolicy): Map<ShowEffect, EffectPolicyEntry> {
  return new Map(policy.effects.map((entry) => [entry.effect, entry]));
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

function malformedDecision(issues: string[]): PolicyDecision {
  return {
    decision: "block",
    reason: `Malformed show intent: ${issues.join("; ")}`,
    intent_type: "unknown",
    limits_applied: [],
    requires_operator: false,
  };
}

export function evaluateShowIntent(
  intent: ShowIntent,
  policy: EffectPolicy = DEFAULT_EFFECT_POLICY,
  context: ShowIntentEvaluationContext = {},
): PolicyDecision {
  if (intent.type === "announce" || intent.type === "change_mood" || intent.type === "log_note") {
    const limits = intent.type === "change_mood" ? ["intensity<=1"] : [];
    return {
      decision: "allow",
      reason: `${intent.type} is a low-risk show-director intent`,
      intent_type: intent.type,
      limits_applied: limits,
      requires_operator: false,
    };
  }

  if (intent.type === "request_cue") {
    return {
      decision: intent.preapproved ? "allow" : "require_approval",
      reason: intent.preapproved
        ? "pre-approved visual cue may be selected in dry-run"
        : "cue is not pre-approved and requires operator approval",
      intent_type: intent.type,
      limits_applied: ["preapproved_visual_cues_only"],
      requires_operator: !intent.preapproved,
    };
  }

  if (
    intent.type === "approve_effect" ||
    intent.type === "cancel_effect" ||
    intent.type === "panic_status"
  ) {
    return {
      decision: "allow",
      reason: `${intent.type} records operator/control state and does not drive hardware`,
      intent_type: intent.type,
      limits_applied: [],
      requires_operator: false,
    };
  }

  const entry = policyMap(policy).get(intent.effect);
  if (!entry) {
    return {
      decision: "block",
      reason: `${intent.effect} has no policy entry`,
      intent_type: intent.type,
      effect: intent.effect,
      limits_applied: [],
      requires_operator: false,
    };
  }

  const limits: string[] = [];
  if (entry.max_duration_seconds !== undefined) {
    limits.push(`duration_seconds<=${entry.max_duration_seconds}`);
  }
  if (entry.max_intensity !== undefined) limits.push(`intensity<=${entry.max_intensity}`);
  if (entry.cooldown_seconds !== undefined)
    limits.push(`cooldown_seconds>=${entry.cooldown_seconds}`);

  if (entry.cooldown_seconds !== undefined) {
    const cooldownSeconds = entry.cooldown_seconds;
    const nowMs = (context.now ?? new Date()).getTime();
    const recent = context.recent_effects?.some((event) => {
      if (event.effect !== intent.effect) return false;
      const atMs = event.at instanceof Date ? event.at.getTime() : Date.parse(event.at);
      return Number.isFinite(atMs) && nowMs - atMs < cooldownSeconds * 1000;
    });
    if (recent) {
      return {
        decision: "block",
        reason: `${intent.effect} is within cooldown window`,
        intent_type: intent.type,
        effect: intent.effect,
        limits_applied: limits,
        requires_operator: entry.decision === "require_approval",
      };
    }
  }

  if (entry.operator_only) {
    return {
      decision: "block",
      reason: entry.reason ?? `${intent.effect} is operator-only`,
      intent_type: intent.type,
      effect: intent.effect,
      limits_applied: limits,
      requires_operator: true,
    };
  }

  if (
    entry.max_duration_seconds !== undefined &&
    (intent.duration_seconds === undefined || intent.duration_seconds > entry.max_duration_seconds)
  ) {
    return {
      decision: "block",
      reason: `${intent.effect} duration exceeds policy limit`,
      intent_type: intent.type,
      effect: intent.effect,
      limits_applied: limits,
      requires_operator: entry.decision === "require_approval",
    };
  }

  if (
    entry.max_intensity !== undefined &&
    (intent.intensity === undefined || intent.intensity > entry.max_intensity)
  ) {
    return {
      decision: "block",
      reason:
        intent.intensity === undefined
          ? `${intent.effect} intensity is required by policy`
          : `${intent.effect} intensity exceeds policy limit`,
      intent_type: intent.type,
      effect: intent.effect,
      limits_applied: limits,
      requires_operator: entry.decision === "require_approval",
    };
  }

  return {
    decision: entry.decision,
    reason: entry.reason ?? `${intent.effect} policy decision is ${entry.decision}`,
    intent_type: intent.type,
    effect: intent.effect,
    limits_applied: limits,
    requires_operator: entry.decision === "require_approval",
  };
}

export function parseShowIntent(raw: unknown, policy?: EffectPolicy): ParsedShowIntent {
  const parsed = ShowIntentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(formatIssue);
    return {
      ok: false,
      decision: malformedDecision(issues),
      issues,
    };
  }

  const decision = evaluateShowIntent(parsed.data, policy);
  return { ok: true, intent: parsed.data, decision };
}

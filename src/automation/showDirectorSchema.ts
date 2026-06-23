import { z } from "zod";
import {
  computeMixerCatalogHash,
  type MixerSceneManifest,
  sceneExcludesAllForbiddenDeltas,
} from "./mixerSceneCatalog.js";

export const ShowDecisionSchema = z.enum(["allow", "require_approval", "block"]);

export type ShowDecision = z.infer<typeof ShowDecisionSchema>;

export const ShowEffectSchema = z.enum([
  "fog",
  "hazer",
  "strobe",
  "confetti_sim",
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

/**
 * Soundcraft Ui24R mixer adapter target. The LLM/voice layer may suggest these
 * fields, but they are untrusted for live authority — the catalog is the
 * source of truth, matched by `scene_id`.
 */
export const ShowMixerAdapterTargetSchema = z.object({
  kind: z.literal("soundcraft_ui24r"),
  mixer_id: NonEmptyString,
});

/**
 * `arm_mixer_scene` — a new ShowIntent variant, kept separate from `arm_effect`.
 * It prepares a predeclared Ui24R show/snapshot/cue recall for operator approval.
 *
 * The catalog (matched by `scene_id`) is the source of truth; the optional
 * show/snapshot/cue name fields and `setlist_ref` are advisory only and never
 * resolved by fuzzy live matching. A request with no resolvable `scene_id`
 * (or an unresolved `setlist_ref`) is blocked by policy, never armed.
 */
export const MixerSceneIntentSchema = z.object({
  type: z.literal("arm_mixer_scene"),
  adapter_target: ShowMixerAdapterTargetSchema,
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("show"),
      scene_id: NonEmptyString.optional(),
      show_name: NonEmptyString.optional(),
      setlist_ref: NonEmptyString.optional(),
    }),
    z.object({
      kind: z.literal("snapshot"),
      scene_id: NonEmptyString.optional(),
      show_name: NonEmptyString.optional(),
      snapshot_name: NonEmptyString.optional(),
      setlist_ref: NonEmptyString.optional(),
    }),
    z.object({
      kind: z.literal("cue"),
      scene_id: NonEmptyString.optional(),
      show_name: NonEmptyString.optional(),
      cue_name: NonEmptyString.optional(),
      setlist_ref: NonEmptyString.optional(),
    }),
  ]),
  request: z
    .object({
      source: z
        .enum(["voice", "chatgpt", "setlist", "td_audio_analysis", "operator", "scheduler"])
        .optional(),
      raw_text: z.string().trim().optional(),
      reason: z.string().trim().optional(),
      requested_for: z.string().trim().optional(),
    })
    .optional(),
});

export type MixerSceneIntent = z.infer<typeof MixerSceneIntentSchema>;

export const ShowIntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("announce"),
    text: NonEmptyString,
    tone: z.enum(["neutral", "premium", "hype", "calm"]).optional(),
    voice: z.string().trim().optional(),
  }),
  z.object({
    type: z.literal("change_mood"),
    mood: NonEmptyString,
    palette: z.array(NonEmptyString).max(8).optional(),
    intensity: z.number().min(0).max(1).default(0.5),
    duration_seconds: z.number().positive().optional(),
    reason: z.string().trim().optional(),
  }),
  z.object({
    type: z.literal("request_cue"),
    cue: NonEmptyString,
    cue_kind: z.enum(["visual", "lighting", "combined", "safe_state"]).optional(),
    intensity: z.number().min(0).max(1).optional(),
    timing: z.enum(["now", "next_drop", "next_phrase", "manual"]).optional(),
    reason: z.string().trim().optional(),
    scene_id: z.string().trim().optional(),
    preapproved: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("arm_effect"),
    effect: ShowEffectSchema,
    duration_seconds: z.number().positive().optional(),
    intensity: z.number().min(0).max(1).optional(),
    timing: z.enum(["now", "next_drop", "next_phrase", "manual"]).optional(),
    reason: z.string().trim().optional(),
  }),
  MixerSceneIntentSchema,
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
    request: z
      .enum(["status", "enter_panic_safe", "clear_panic_after_operator_confirmation"])
      .optional(),
  }),
  z.object({
    type: z.literal("log_note"),
    note: NonEmptyString,
    tags: z.array(NonEmptyString).max(16).default([]),
  }),
  z.object({
    type: z.literal("blocked_request"),
    reason: NonEmptyString,
    operator_message: NonEmptyString,
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
  /** Resolved catalog scene ID when the intent is `arm_mixer_scene`. */
  scene_id: z.string().optional(),
  /** Catalog hash bound into a mixer-scene decision (operator-attested). */
  catalog_hash: z.string().optional(),
  limits_applied: z.array(z.string()).default([]),
  requires_operator: z.boolean().default(false),
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface ShowIntentEvaluationContext {
  recent_effects?: Array<{ effect: ShowEffect; at: string | Date }>;
  now?: Date;
  /**
   * Trusted venue mixer-scene manifest. Required to ever return
   * `require_approval` for an `arm_mixer_scene` intent; absent → `block`.
   */
  mixer_scene_manifest?: MixerSceneManifest;
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
    effect: "confetti_sim",
    decision: "require_approval",
    max_duration_seconds: 3,
    max_intensity: 1,
    cooldown_seconds: 60,
    operator_only: false,
    reason: "confetti simulation requires operator approval in the producer POC",
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

const MIXER_SCENE_OPERATION_BY_TARGET = {
  show: "recall_show",
  snapshot: "recall_snapshot",
  cue: "recall_cue",
} as const;

function blockMixerScene(reason: string): PolicyDecision {
  return {
    decision: "block",
    reason,
    intent_type: "arm_mixer_scene",
    limits_applied: ["catalog_backed_scene_ids_only"],
    requires_operator: true,
  };
}

/**
 * MixerScenePolicy. A catalog-backed mixer scene request returns
 * `require_approval`; it NEVER returns `allow` in the dry-run MVP. Every other
 * outcome — missing config, unknown target, unresolved `setlist_ref`,
 * unsupported target, changed catalog hash, unsafe scene diff — returns
 * `block`. Hard denies cannot be softened by caller-supplied input.
 */
export function evaluateMixerSceneIntent(
  intent: MixerSceneIntent,
  manifest?: MixerSceneManifest,
): PolicyDecision {
  if (!manifest) {
    return blockMixerScene("mixer scene manifest is not configured");
  }

  // Re-derive the canonical catalog hash and reject any drift from the
  // operator-attested `policy_hash`. A changed catalog hard-blocks.
  const computedHash = computeMixerCatalogHash(manifest.scenes);
  if (computedHash !== manifest.policy_hash) {
    return blockMixerScene(
      `mixer scene catalog hash changed (declared ${manifest.policy_hash}, computed ${computedHash})`,
    );
  }

  const sceneId = intent.target.scene_id;
  if (!sceneId) {
    if (intent.target.setlist_ref) {
      return blockMixerScene(
        `unresolved setlist_ref "${intent.target.setlist_ref}": no predeclared scene_id`,
      );
    }
    return blockMixerScene("mixer scene request has no predeclared scene_id");
  }

  const scene = manifest.scenes.find((entry) => entry.scene_id === sceneId);
  if (!scene) {
    return blockMixerScene(`unknown mixer scene_id "${sceneId}"`);
  }

  if (scene.adapter_target.kind !== intent.adapter_target.kind) {
    return blockMixerScene(`unsupported adapter kind "${intent.adapter_target.kind}"`);
  }
  if (scene.adapter_target.mixer_id !== intent.adapter_target.mixer_id) {
    return blockMixerScene(
      `unknown mixer_id "${intent.adapter_target.mixer_id}" for scene "${sceneId}"`,
    );
  }

  // The requested target kind must match the catalog operation (no live retype).
  if (MIXER_SCENE_OPERATION_BY_TARGET[intent.target.kind] !== scene.operation) {
    return blockMixerScene(
      `unsupported target: scene "${sceneId}" is ${scene.operation}, not ${intent.target.kind}`,
    );
  }

  // Hard safety gate: scene must PROVE it excludes all forbidden mixer deltas.
  if (!sceneExcludesAllForbiddenDeltas(scene)) {
    return blockMixerScene(`unsafe scene diff: "${sceneId}" does not exclude all forbidden deltas`);
  }

  // If a setlist_ref is present it must be in the scene's allowed sections.
  if (
    intent.target.setlist_ref &&
    !scene.allowed_setlist_sections.includes(intent.target.setlist_ref)
  ) {
    return blockMixerScene(
      `unresolved setlist_ref "${intent.target.setlist_ref}" for scene "${sceneId}"`,
    );
  }

  return {
    decision: "require_approval",
    reason: `mixer scene "${sceneId}" (${scene.label}) requires operator approval before any dispatch`,
    intent_type: "arm_mixer_scene",
    scene_id: sceneId,
    catalog_hash: manifest.policy_hash,
    limits_applied: ["catalog_backed_scene_ids_only", "never_auto_allow", "dry_run_only"],
    requires_operator: true,
  };
}

export function evaluateShowIntent(
  intent: ShowIntent,
  policy: EffectPolicy = DEFAULT_EFFECT_POLICY,
  context: ShowIntentEvaluationContext = {},
): PolicyDecision {
  if (intent.type === "blocked_request") {
    return {
      decision: "block",
      reason: intent.reason,
      intent_type: intent.type,
      limits_applied: ["blocked_request_from_parser"],
      requires_operator: true,
    };
  }

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

  if (intent.type === "arm_mixer_scene") {
    return evaluateMixerSceneIntent(intent, context.mixer_scene_manifest);
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

export function parseShowIntent(
  raw: unknown,
  policy?: EffectPolicy,
  context: ShowIntentEvaluationContext = {},
): ParsedShowIntent {
  const parsed = ShowIntentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(formatIssue);
    return {
      ok: false,
      decision: malformedDecision(issues),
      issues,
    };
  }

  const decision = evaluateShowIntent(parsed.data, policy, context);
  return { ok: true, intent: parsed.data, decision };
}

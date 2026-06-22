import { z } from "zod";
import type { MixerSceneManifest } from "./mixerSceneCatalog.js";
import {
  DEFAULT_EFFECT_POLICY,
  type EffectPolicy,
  EffectPolicySchema,
  evaluateShowIntent,
  type MixerSceneIntent,
  type PolicyDecision,
  PolicyDecisionSchema,
  parseShowIntent,
  type ShowEffect,
  ShowEffectSchema,
  type ShowIntent,
  ShowIntentSchema,
  ShowMixerAdapterTargetSchema,
} from "./showDirectorSchema.js";

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;

export const ShowActionPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cue"),
    cue: z.string().min(1),
    scene_id: z.string().optional(),
    dry_run_only: z.literal(true),
  }),
  z.object({
    kind: z.literal("mood"),
    mood: z.string().min(1),
    palette: z.array(z.string()).optional(),
    intensity: z.number().min(0).max(1),
    dry_run_only: z.literal(true),
  }),
  z.object({
    kind: z.literal("announcement"),
    text: z.string().min(1),
    voice: z.string().optional(),
    dry_run_only: z.literal(true),
  }),
  z.object({
    kind: z.literal("effect"),
    effect: ShowEffectSchema,
    duration_seconds: z.number().positive().optional(),
    intensity: z.number().min(0).max(1).optional(),
    operator: z.string().min(1),
    dry_run_only: z.literal(true),
  }),
  z.object({
    kind: z.literal("log_note"),
    note: z.string().min(1),
    tags: z.array(z.string()).default([]),
    dry_run_only: z.literal(true),
  }),
  z.object({
    kind: z.literal("mixer_scene"),
    action: z.literal("arm"),
    adapter_target: ShowMixerAdapterTargetSchema,
    mixer_scene: z.object({
      kind: z.enum(["show", "snapshot", "cue"]),
      scene_id: z.string().min(1),
      show_name: z.string().min(1),
      snapshot_name: z.string().min(1).optional(),
      cue_name: z.string().min(1).optional(),
      label: z.string().min(1),
    }),
    catalog_hash: z.string().min(1),
    approval_id: z.string().min(1),
    operator: z.string().min(1),
    dry_run_only: z.literal(true),
  }),
]);

export type ShowActionPlan = z.infer<typeof ShowActionPlanSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "cancelled"]);

/**
 * Generic approval target. Old effect approvals stay valid (they always carried
 * a top-level `effect`); mixer-scene approvals carry a `mixer_scene` target with
 * the exact adapter + catalog scene + catalog hash shown to the operator.
 */
export const ShowApprovalTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effect"), effect: ShowEffectSchema }),
  z.object({
    kind: z.literal("mixer_scene"),
    adapter_target: ShowMixerAdapterTargetSchema,
    scene_id: z.string().min(1),
    catalog_hash: z.string().min(1),
  }),
]);

export type ShowApprovalTarget = z.infer<typeof ShowApprovalTargetSchema>;

export const ShowApprovalSchema = z.object({
  id: z.string().min(1),
  status: ApprovalStatusSchema,
  /** Legacy/optional: present for effect approvals; absent for mixer scenes. */
  effect: ShowEffectSchema.optional(),
  /** Generic target. Defaults are not applied; old states omit it. */
  target: ShowApprovalTargetSchema.optional(),
  intent: z.unknown(),
  decision: z.unknown(),
  requested_at: z.string().regex(ISO_TIME),
  resolved_at: z.string().regex(ISO_TIME).optional(),
  operator: z.string().optional(),
});

export type ShowApproval = z.infer<typeof ShowApprovalSchema>;

export const ShowAuditEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().regex(ISO_TIME),
  status: z.enum(["allowed", "blocked", "queued", "approved", "cancelled", "invalid"]),
  intent_type: z.string(),
  effect: ShowEffectSchema.optional(),
  decision: z.string(),
  reason: z.string(),
  approval_id: z.string().optional(),
  operator: z.string().optional(),
});

export type ShowAuditEntry = z.infer<typeof ShowAuditEntrySchema>;

export const ShowDirectorStateSchema = z.object({
  approvals: z.array(ShowApprovalSchema).default([]),
  audit_log: z.array(ShowAuditEntrySchema).default([]),
});

export type ShowDirectorState = z.infer<typeof ShowDirectorStateSchema>;

export type ResolveApprovalResult =
  | { ok: true; state: ShowDirectorState; approval: ShowApproval; plan: ShowActionPlan[] }
  | { ok: false; state: ShowDirectorState; reason: string; plan: [] };

export interface SubmitShowIntentResult {
  state: ShowDirectorState;
  decision: PolicyDecision;
  plan: ShowActionPlan[];
  approval?: ShowApproval;
  ok?: boolean;
  reason?: string;
}

/**
 * Runtime options threaded through submit/approve. The mixer-scene manifest is
 * required for any `arm_mixer_scene` decision; when absent, mixer-scene policy
 * blocks (it never auto-allows and never fuzzy-matches live).
 */
export interface ShowDirectorOptions {
  policy?: EffectPolicy;
  mixerSceneManifest?: MixerSceneManifest;
}

function cloneState(state: ShowDirectorState): ShowDirectorState {
  return ShowDirectorStateSchema.parse(state);
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function idFor(prefix: string, count: number): string {
  return `${prefix}_${String(count + 1).padStart(4, "0")}`;
}

export function createShowDirectorState(): ShowDirectorState {
  return { approvals: [], audit_log: [] };
}

function auditEntry(
  state: ShowDirectorState,
  status: ShowAuditEntry["status"],
  decision: PolicyDecision,
  opts: { approval_id?: string; operator?: string } = {},
): ShowAuditEntry {
  return {
    id: idFor("audit", state.audit_log.length),
    at: nowIso(),
    status,
    intent_type: decision.intent_type,
    effect: decision.effect,
    decision: decision.decision,
    reason: decision.reason,
    approval_id: opts.approval_id,
    operator: opts.operator,
  };
}

function failedDecision(intentType: string, reason: string, effect?: ShowEffect): PolicyDecision {
  return {
    decision: "block",
    reason,
    intent_type: intentType,
    effect,
    limits_applied: [],
    requires_operator: false,
  };
}

function recordResolutionFailure(
  state: ShowDirectorState,
  intentType: string,
  reason: string,
  opts: { approval_id?: string; operator?: string; effect?: ShowEffect; invalid?: boolean } = {},
): void {
  state.audit_log.push(
    auditEntry(
      state,
      opts.invalid ? "invalid" : "blocked",
      failedDecision(intentType, reason, opts.effect),
      {
        approval_id: opts.approval_id,
        operator: opts.operator,
      },
    ),
  );
}

function activePolicy(policy?: EffectPolicy): EffectPolicy {
  return EffectPolicySchema.parse(policy ?? DEFAULT_EFFECT_POLICY);
}

function cooldownDecision(
  state: ShowDirectorState,
  intent: ShowIntent,
  policy?: EffectPolicy,
): PolicyDecision | undefined {
  if (intent.type !== "arm_effect") return undefined;
  const policyEntry = activePolicy(policy).effects.find((item) => item.effect === intent.effect);
  if (!policyEntry?.cooldown_seconds) return undefined;
  const cooldownSeconds = policyEntry.cooldown_seconds;

  const nowMs = Date.now();
  const recent = [...state.audit_log].reverse().find((audit) => {
    if (audit.effect !== intent.effect) return false;
    if (audit.status !== "allowed" && audit.status !== "approved") return false;
    const atMs = Date.parse(audit.at);
    return Number.isFinite(atMs) && nowMs - atMs < cooldownSeconds * 1000;
  });
  if (!recent) return undefined;

  return {
    decision: "block",
    reason: `${intent.effect} is within cooldown window`,
    intent_type: intent.type,
    effect: intent.effect,
    limits_applied: [`cooldown_seconds>=${cooldownSeconds}`],
    requires_operator: true,
  };
}

function planForAllowedIntent(intent: ShowIntent, operator?: string): ShowActionPlan[] {
  switch (intent.type) {
    case "announce":
      return [{ kind: "announcement", text: intent.text, voice: intent.voice, dry_run_only: true }];
    case "change_mood":
      return [
        {
          kind: "mood",
          mood: intent.mood,
          palette: intent.palette,
          intensity: intent.intensity,
          dry_run_only: true,
        },
      ];
    case "request_cue":
      return [
        {
          kind: "cue",
          cue: intent.cue,
          scene_id: intent.scene_id,
          dry_run_only: true,
        },
      ];
    case "arm_effect":
      return operator
        ? [
            {
              kind: "effect",
              effect: intent.effect,
              duration_seconds: intent.duration_seconds,
              intensity: intent.intensity,
              operator,
              dry_run_only: true,
            },
          ]
        : [];
    case "log_note":
      return [{ kind: "log_note", note: intent.note, tags: intent.tags, dry_run_only: true }];
    default:
      return [];
  }
}

/**
 * Build the approved dry-run mixer-scene plan from the catalog (source of
 * truth). Returns `undefined` if the scene id no longer resolves or the catalog
 * hash drifted — the caller treats that as a failed resolution.
 */
function planForMixerScene(
  intent: MixerSceneIntent,
  manifest: MixerSceneManifest,
  approvalId: string,
  operator: string,
): Extract<ShowActionPlan, { kind: "mixer_scene" }> | undefined {
  const sceneId = intent.target.scene_id;
  if (!sceneId) return undefined;
  const scene = manifest.scenes.find((entry) => entry.scene_id === sceneId);
  if (!scene) return undefined;
  return {
    kind: "mixer_scene",
    action: "arm",
    adapter_target: scene.adapter_target,
    mixer_scene: {
      kind: intent.target.kind,
      scene_id: scene.scene_id,
      show_name: scene.show_name,
      snapshot_name: scene.snapshot_name,
      cue_name: scene.cue_name,
      label: scene.label,
    },
    catalog_hash: manifest.policy_hash,
    approval_id: approvalId,
    operator,
    dry_run_only: true,
  };
}

function controlIntentDecision(intent: ShowIntent): PolicyDecision {
  return {
    decision: "allow",
    reason: `${intent.type} records operator/control state and does not drive hardware`,
    intent_type: intent.type,
    limits_applied: [],
    requires_operator: false,
  };
}

export function submitShowIntent(
  state: ShowDirectorState,
  rawIntent: unknown,
  policy?: EffectPolicy,
  opts: Pick<ShowDirectorOptions, "mixerSceneManifest"> = {},
): SubmitShowIntentResult {
  const next = cloneState(state);
  const parsed = parseShowIntent(rawIntent, activePolicy(policy), {
    mixer_scene_manifest: opts.mixerSceneManifest,
  });
  if (!parsed.ok) {
    next.audit_log.push(auditEntry(next, "invalid", parsed.decision));
    return { state: next, decision: parsed.decision, plan: [] };
  }

  if (parsed.intent.type === "approve_effect") {
    const approved = approveShowIntent(next, parsed.intent.approval_id, parsed.intent.operator, {
      policy,
      mixerSceneManifest: opts.mixerSceneManifest,
    });
    if (!approved.ok) {
      return { ...approved, decision: failedDecision(parsed.intent.type, approved.reason) };
    }
    return { ...approved, decision: controlIntentDecision(parsed.intent) };
  }

  if (parsed.intent.type === "cancel_effect") {
    const cancelled = cancelShowIntent(next, parsed.intent.approval_id, parsed.intent.operator);
    if (!cancelled.ok) {
      return { ...cancelled, decision: failedDecision(parsed.intent.type, cancelled.reason) };
    }
    return { ...cancelled, decision: controlIntentDecision(parsed.intent) };
  }

  const cooldown = cooldownDecision(next, parsed.intent, policy);
  if (cooldown) {
    next.audit_log.push(auditEntry(next, "blocked", cooldown));
    return { state: next, decision: cooldown, plan: [] };
  }

  if (parsed.decision.decision === "allow") {
    const plan = planForAllowedIntent(
      parsed.intent,
      parsed.intent.type === "arm_effect" ? "policy" : undefined,
    );
    next.audit_log.push(auditEntry(next, "allowed", parsed.decision));
    return { state: next, decision: parsed.decision, plan };
  }

  // Mixer scenes never auto-allow; a valid request queues a generic approval.
  if (parsed.decision.decision === "require_approval" && parsed.intent.type === "arm_mixer_scene") {
    const sceneId = parsed.decision.scene_id;
    const catalogHash = parsed.decision.catalog_hash;
    // Decision invariants are guaranteed by the policy, but stay fail-forward.
    if (!sceneId || !catalogHash) {
      next.audit_log.push(auditEntry(next, "blocked", parsed.decision));
      return { state: next, decision: parsed.decision, plan: [] };
    }
    const approval: ShowApproval = {
      id: idFor("approval", next.approvals.length),
      status: "pending",
      target: {
        kind: "mixer_scene",
        adapter_target: parsed.intent.adapter_target,
        scene_id: sceneId,
        catalog_hash: catalogHash,
      },
      intent: parsed.intent,
      decision: parsed.decision,
      requested_at: nowIso(),
    };
    next.approvals.push(approval);
    next.audit_log.push(auditEntry(next, "queued", parsed.decision, { approval_id: approval.id }));
    return { state: next, decision: parsed.decision, plan: [], approval };
  }

  if (parsed.decision.decision === "require_approval" && parsed.intent.type === "arm_effect") {
    const approval: ShowApproval = {
      id: idFor("approval", next.approvals.length),
      status: "pending",
      effect: parsed.intent.effect,
      target: { kind: "effect", effect: parsed.intent.effect },
      intent: parsed.intent,
      decision: parsed.decision,
      requested_at: nowIso(),
    };
    next.approvals.push(approval);
    next.audit_log.push(auditEntry(next, "queued", parsed.decision, { approval_id: approval.id }));
    return { state: next, decision: parsed.decision, plan: [], approval };
  }

  next.audit_log.push(auditEntry(next, "blocked", parsed.decision));
  return { state: next, decision: parsed.decision, plan: [] };
}

/**
 * Resolve a queued mixer-scene approval. Re-runs MixerScenePolicy with the
 * manifest immediately before producing the plan (catalog hash + scene safety
 * are re-validated), so a drifted catalog or removed scene fails the approval
 * instead of dispatching. Never claims hardware changed — emits a dry-run plan.
 */
function resolveMixerSceneApproval(
  next: ShowDirectorState,
  idx: number,
  approval: ShowApproval,
  intent: MixerSceneIntent,
  operator: string,
  opts: ShowDirectorOptions,
): ResolveApprovalResult {
  const manifest = opts.mixerSceneManifest;
  const decision = evaluateShowIntent(intent, activePolicy(opts.policy), {
    mixer_scene_manifest: manifest,
  });
  if (decision.decision !== "require_approval") {
    const reason = `approval ${approval.id} no longer approvable: ${decision.reason}`;
    recordResolutionFailure(next, "approve_effect", reason, {
      approval_id: approval.id,
      operator,
    });
    return { ok: false, state: next, reason, plan: [] };
  }

  // The operator approved a specific catalog snapshot. Re-running the policy is
  // not enough: if the catalog body was edited and re-hashed after the request
  // was queued, the current manifest is self-consistent and still returns
  // require_approval — so compare the reviewed hash against the current one and
  // reject on drift, otherwise a changed-but-valid catalog could be armed under
  // an old approval.
  const reviewedHash =
    approval.target?.kind === "mixer_scene" ? approval.target.catalog_hash : undefined;
  if (reviewedHash && decision.catalog_hash && reviewedHash !== decision.catalog_hash) {
    const reason = `approval ${approval.id} catalog drifted since review (reviewed ${reviewedHash}, current ${decision.catalog_hash})`;
    recordResolutionFailure(next, "approve_effect", reason, {
      approval_id: approval.id,
      operator,
    });
    return { ok: false, state: next, reason, plan: [] };
  }

  // manifest is guaranteed by the require_approval decision, but stay defensive.
  const plan = manifest ? planForMixerScene(intent, manifest, approval.id, operator) : undefined;
  if (!plan) {
    const reason = `approval ${approval.id} mixer scene could not be resolved from the catalog`;
    recordResolutionFailure(next, "approve_effect", reason, {
      approval_id: approval.id,
      operator,
    });
    return { ok: false, state: next, reason, plan: [] };
  }

  const resolved: ShowApproval = {
    ...approval,
    status: "approved",
    resolved_at: nowIso(),
    operator,
  };
  next.approvals[idx] = resolved;
  next.audit_log.push(
    auditEntry(next, "approved", decision, { approval_id: approval.id, operator }),
  );
  return { ok: true, state: next, approval: resolved, plan: [plan] };
}

export function approveShowIntent(
  state: ShowDirectorState,
  approvalId: string,
  operator: string,
  opts: ShowDirectorOptions = {},
): ResolveApprovalResult {
  const policy = opts.policy;
  const next = cloneState(state);
  const normalizedOperator = operator.trim();
  if (!normalizedOperator) {
    const reason = "operator is required";
    recordResolutionFailure(next, "approve_effect", reason, {
      approval_id: approvalId,
      operator,
      invalid: true,
    });
    return { ok: false, state: next, reason, plan: [] };
  }
  const idx = next.approvals.findIndex((approval) => approval.id === approvalId);
  const approval = idx >= 0 ? next.approvals[idx] : undefined;
  if (!approval) {
    const reason = `approval ${approvalId} not found`;
    recordResolutionFailure(next, "approve_effect", reason, {
      approval_id: approvalId,
      operator: normalizedOperator,
      invalid: true,
    });
    return { ok: false, state: next, reason, plan: [] };
  }
  if (approval.status !== "pending") {
    const reason = `approval ${approvalId} is ${approval.status}`;
    recordResolutionFailure(next, "approve_effect", reason, {
      approval_id: approvalId,
      operator: normalizedOperator,
      effect: approval.effect,
    });
    return {
      ok: false,
      state: next,
      reason,
      plan: [],
    };
  }

  const intent = ShowIntentSchema.safeParse(approval.intent);
  if (intent.success && intent.data.type === "arm_mixer_scene") {
    return resolveMixerSceneApproval(next, idx, approval, intent.data, normalizedOperator, opts);
  }
  if (!intent.success || intent.data.type !== "arm_effect") {
    const reason = `approval ${approvalId} has invalid intent`;
    recordResolutionFailure(next, "approve_effect", reason, {
      approval_id: approvalId,
      operator: normalizedOperator,
      effect: approval.effect,
      invalid: true,
    });
    return {
      ok: false,
      state: next,
      reason,
      plan: [],
    };
  }
  const cooldown = cooldownDecision(next, intent.data, policy);
  if (cooldown) {
    recordResolutionFailure(next, "approve_effect", cooldown.reason, {
      approval_id: approvalId,
      operator: normalizedOperator,
      effect: intent.data.effect,
    });
    return { ok: false, state: next, reason: cooldown.reason, plan: [] };
  }

  const decision = evaluateShowIntent(intent.data, activePolicy(policy));
  if (decision.decision !== "require_approval") {
    const reason = `approval ${approvalId} no longer requires approval`;
    recordResolutionFailure(next, "approve_effect", reason, {
      approval_id: approvalId,
      operator: normalizedOperator,
      effect: intent.data.effect,
    });
    return {
      ok: false,
      state: next,
      reason,
      plan: [],
    };
  }

  const resolved: ShowApproval = {
    ...approval,
    status: "approved",
    resolved_at: nowIso(),
    operator: normalizedOperator,
  };
  next.approvals[idx] = resolved;
  const plan = planForAllowedIntent(intent.data, normalizedOperator);
  next.audit_log.push(
    auditEntry(next, "approved", decision, {
      approval_id: approvalId,
      operator: normalizedOperator,
    }),
  );
  return { ok: true, state: next, approval: resolved, plan };
}

export function cancelShowIntent(
  state: ShowDirectorState,
  approvalId: string,
  operator?: string,
): ResolveApprovalResult {
  const next = cloneState(state);
  const idx = next.approvals.findIndex((approval) => approval.id === approvalId);
  const approval = idx >= 0 ? next.approvals[idx] : undefined;
  if (!approval) {
    const reason = `approval ${approvalId} not found`;
    recordResolutionFailure(next, "cancel_effect", reason, {
      approval_id: approvalId,
      operator,
      invalid: true,
    });
    return { ok: false, state: next, reason, plan: [] };
  }
  if (approval.status !== "pending") {
    const reason = `approval ${approvalId} is ${approval.status}`;
    recordResolutionFailure(next, "cancel_effect", reason, {
      approval_id: approvalId,
      operator,
      effect: approval.effect,
    });
    return {
      ok: false,
      state: next,
      reason,
      plan: [],
    };
  }

  const decision = PolicyDecisionSchema.safeParse(approval.decision);
  if (!decision.success) {
    const reason = `approval ${approvalId} has invalid decision`;
    recordResolutionFailure(next, "cancel_effect", reason, {
      approval_id: approvalId,
      operator,
      effect: approval.effect,
      invalid: true,
    });
    return {
      ok: false,
      state: next,
      reason,
      plan: [],
    };
  }

  const resolved: ShowApproval = {
    ...approval,
    status: "cancelled",
    resolved_at: nowIso(),
    operator,
  };
  next.approvals[idx] = resolved;
  next.audit_log.push(
    auditEntry(next, "cancelled", decision.data, { approval_id: approvalId, operator }),
  );
  return { ok: true, state: next, approval: resolved, plan: [] };
}

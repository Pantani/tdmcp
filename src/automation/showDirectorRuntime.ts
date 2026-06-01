import { z } from "zod";
import {
  type EffectPolicy,
  evaluateShowIntent,
  type PolicyDecision,
  PolicyDecisionSchema,
  parseShowIntent,
  ShowEffectSchema,
  type ShowIntent,
  ShowIntentSchema,
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
]);

export type ShowActionPlan = z.infer<typeof ShowActionPlanSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "cancelled"]);

export const ShowApprovalSchema = z.object({
  id: z.string().min(1),
  status: ApprovalStatusSchema,
  effect: ShowEffectSchema,
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

export interface SubmitShowIntentResult {
  state: ShowDirectorState;
  decision: PolicyDecision;
  plan: ShowActionPlan[];
  approval?: ShowApproval;
}

export type ResolveApprovalResult =
  | { ok: true; state: ShowDirectorState; approval: ShowApproval; plan: ShowActionPlan[] }
  | { ok: false; state: ShowDirectorState; reason: string; plan: [] };

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

export function submitShowIntent(
  state: ShowDirectorState,
  rawIntent: unknown,
  policy?: EffectPolicy,
): SubmitShowIntentResult {
  const next = cloneState(state);
  const parsed = parseShowIntent(rawIntent, policy);
  if (!parsed.ok) {
    next.audit_log.push(auditEntry(next, "invalid", parsed.decision));
    return { state: next, decision: parsed.decision, plan: [] };
  }

  if (parsed.decision.decision === "allow") {
    const plan = planForAllowedIntent(parsed.intent);
    next.audit_log.push(auditEntry(next, "allowed", parsed.decision));
    return { state: next, decision: parsed.decision, plan };
  }

  if (parsed.decision.decision === "require_approval" && parsed.intent.type === "arm_effect") {
    const approval: ShowApproval = {
      id: idFor("approval", next.approvals.length),
      status: "pending",
      effect: parsed.intent.effect,
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

export function approveShowIntent(
  state: ShowDirectorState,
  approvalId: string,
  operator: string,
  policy?: EffectPolicy,
): ResolveApprovalResult {
  const next = cloneState(state);
  const idx = next.approvals.findIndex((approval) => approval.id === approvalId);
  const approval = idx >= 0 ? next.approvals[idx] : undefined;
  if (!approval)
    return { ok: false, state: next, reason: `approval ${approvalId} not found`, plan: [] };
  if (approval.status !== "pending") {
    return {
      ok: false,
      state: next,
      reason: `approval ${approvalId} is ${approval.status}`,
      plan: [],
    };
  }

  const intent = ShowIntentSchema.safeParse(approval.intent);
  if (!intent.success || intent.data.type !== "arm_effect") {
    return {
      ok: false,
      state: next,
      reason: `approval ${approvalId} has invalid intent`,
      plan: [],
    };
  }
  const decision = evaluateShowIntent(intent.data, policy);
  if (decision.decision !== "require_approval") {
    return {
      ok: false,
      state: next,
      reason: `approval ${approvalId} no longer requires approval`,
      plan: [],
    };
  }

  const resolved: ShowApproval = {
    ...approval,
    status: "approved",
    resolved_at: nowIso(),
    operator,
  };
  next.approvals[idx] = resolved;
  const plan = planForAllowedIntent(intent.data, operator);
  next.audit_log.push(
    auditEntry(next, "approved", decision, { approval_id: approvalId, operator }),
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
  if (!approval)
    return { ok: false, state: next, reason: `approval ${approvalId} not found`, plan: [] };
  if (approval.status !== "pending") {
    return {
      ok: false,
      state: next,
      reason: `approval ${approvalId} is ${approval.status}`,
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
  const decision = PolicyDecisionSchema.parse(approval.decision);
  next.audit_log.push(
    auditEntry(next, "cancelled", decision, { approval_id: approvalId, operator }),
  );
  return { ok: true, state: next, approval: resolved, plan: [] };
}

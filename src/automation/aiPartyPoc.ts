import { z } from "zod";
import {
  AiPartyFanInEventSchema,
  type AiPartyFanInResult,
  normalizeAiPartyEvent,
} from "./aiPartyFanIn.js";
import { type SimulatedEffectEvent, simulateShowActionPlan } from "./effectSimulator.js";
import type { ShowActionPlan, ShowDirectorState } from "./showDirectorRuntime.js";
import {
  approveShowIntent,
  createShowDirectorState,
  ShowDirectorStateSchema,
  submitShowIntent,
} from "./showDirectorRuntime.js";
import type { ShowIntent } from "./showDirectorSchema.js";
import {
  DEFAULT_EFFECT_POLICY,
  EffectPolicySchema,
  ShowIntentSchema,
} from "./showDirectorSchema.js";

const ProducerPocRowSchema = z.object({
  label: z.string().trim().min(1),
  intent: ShowIntentSchema,
  expected_decision: z.enum(["allow", "require_approval", "block"]).optional(),
});

export const AiPartyPocEventSchema = z.union([AiPartyFanInEventSchema, ProducerPocRowSchema]);

export const AiPartyPocRunSchema = z.object({
  events: z.array(AiPartyPocEventSchema).optional(),
  policy: EffectPolicySchema.default(DEFAULT_EFFECT_POLICY),
  state: ShowDirectorStateSchema.optional(),
  auto_approve_effects: z.boolean().default(false),
  operator: z.string().trim().min(1).default("producer-poc-operator"),
});

export type AiPartyPocRunInput = z.input<typeof AiPartyPocRunSchema>;
export type AiPartyPocRunArgs = z.infer<typeof AiPartyPocRunSchema>;

export interface AiPartyPocStep {
  label: string;
  fan_in?: AiPartyFanInResult;
  intent?: ShowIntent;
  expected_decision?: string;
  decision?: string;
  reason?: string;
  approval_id?: string;
  plan: ShowActionPlan[];
  simulated_effects: SimulatedEffectEvent[];
  auto_approved?: boolean;
  warnings: string[];
}

export interface AiPartyPocRunResult {
  dryRun: true;
  hardware: "simulated_only";
  summary: {
    steps: number;
    allowed: number;
    queued: number;
    blocked: number;
    invalid: number;
    approved: number;
    simulated_effects: number;
    hardware_plans: 0;
  };
  dashboard: {
    mode: "producer_poc";
    pending_approvals: number;
    audit_entries: number;
    last_decision?: string;
    last_reason?: string;
    panic_visible: true;
    physical_effects_connected: false;
  };
  steps: AiPartyPocStep[];
  state: ShowDirectorState;
}

const DEFAULT_EVENTS: z.infer<typeof AiPartyPocEventSchema>[] = [
  {
    label: "doors_preflight",
    intent: {
      type: "request_cue",
      cue: "doors_idle",
      scene_id: "doors_preflight",
      preapproved: true,
    },
    expected_decision: "allow",
  },
  {
    type: "operator_text",
    text: "Arm intro for Band A",
  },
  {
    label: "fog_queue",
    intent: { type: "arm_effect", effect: "fog", duration_seconds: 3, intensity: 0.35 },
    expected_decision: "require_approval",
  },
  {
    type: "audio_section",
    section: "drop",
    energy: 0.72,
    palette: ["cyan", "magenta", "white"],
  },
  {
    type: "voice_transcript",
    text: "make it red and chaotic",
    confidence: 0.86,
  },
  {
    label: "safety_bad_fog",
    intent: { type: "arm_effect", effect: "fog", duration_seconds: 30, intensity: 0.8 },
    expected_decision: "block",
  },
  {
    type: "operator_text",
    text: "raise mixer gain hard",
  },
  {
    label: "closing_log",
    intent: {
      type: "log_note",
      note: "Producer rehearsal completed: cue flow, approval queue, blocked hazards and panic recovery demonstrated.",
      tags: ["producer_demo", "dry_run", "safety"],
    },
    expected_decision: "allow",
  },
];

function eventLabel(event: z.infer<typeof AiPartyPocEventSchema>, index: number): string {
  if ("label" in event && typeof event.label === "string" && event.label.trim()) return event.label;
  if ("type" in event) return `${event.type}_${String(index + 1).padStart(2, "0")}`;
  return `step_${String(index + 1).padStart(2, "0")}`;
}

function intentFromEvent(event: z.infer<typeof AiPartyPocEventSchema>): {
  intent?: ShowIntent;
  fanIn?: AiPartyFanInResult;
  expectedDecision?: string;
  warnings: string[];
} {
  if (!("type" in event) && "intent" in event) {
    return {
      intent: event.intent,
      expectedDecision: event.expected_decision,
      warnings: [],
    };
  }
  const fanIn = normalizeAiPartyEvent(event);
  if (!fanIn.ok) return { fanIn, warnings: [] };
  return { intent: fanIn.intent, fanIn, warnings: fanIn.warnings };
}

export function runAiPartyPoc(raw: AiPartyPocRunInput = {}): AiPartyPocRunResult {
  const args = AiPartyPocRunSchema.parse(raw);
  const events = args.events ?? DEFAULT_EVENTS;
  let state = args.state ?? createShowDirectorState();
  const steps: AiPartyPocStep[] = [];

  for (const [index, event] of events.entries()) {
    const label = eventLabel(event, index);
    const normalized = intentFromEvent(event);
    if (!normalized.intent) {
      steps.push({
        label,
        fan_in: normalized.fanIn,
        expected_decision: normalized.expectedDecision,
        plan: [],
        simulated_effects: [],
        warnings: normalized.fanIn?.ok === false ? normalized.fanIn.issues : [],
      });
      continue;
    }

    const submitted = submitShowIntent(state, normalized.intent, args.policy);
    state = submitted.state;
    let plan = submitted.plan;
    const simulated: SimulatedEffectEvent[] = [];
    let autoApproved = false;

    if (args.auto_approve_effects && submitted.approval?.status === "pending") {
      const resolved = approveShowIntent(state, submitted.approval.id, args.operator, {
        policy: args.policy,
      });
      if (resolved.ok) {
        state = resolved.state;
        plan = resolved.plan;
        simulated.push(...simulateShowActionPlan(plan, { idPrefix: `${label}_sim` }));
        autoApproved = true;
      }
    } else {
      simulated.push(...simulateShowActionPlan(plan, { idPrefix: `${label}_sim` }));
    }

    steps.push({
      label,
      fan_in: normalized.fanIn,
      intent: normalized.intent,
      expected_decision: normalized.expectedDecision,
      decision: submitted.decision.decision,
      reason: submitted.decision.reason,
      approval_id: submitted.approval?.id,
      plan,
      simulated_effects: simulated,
      auto_approved: autoApproved || undefined,
      warnings: normalized.warnings,
    });
  }

  const statuses = state.audit_log.map((entry) => entry.status);
  const last = state.audit_log.at(-1);
  const simulatedCount = steps.reduce((sum, step) => sum + step.simulated_effects.length, 0);
  return {
    dryRun: true,
    hardware: "simulated_only",
    summary: {
      steps: steps.length,
      allowed: statuses.filter((status) => status === "allowed").length,
      queued: statuses.filter((status) => status === "queued").length,
      blocked: statuses.filter((status) => status === "blocked").length,
      invalid: statuses.filter((status) => status === "invalid").length,
      approved: statuses.filter((status) => status === "approved").length,
      simulated_effects: simulatedCount,
      hardware_plans: 0,
    },
    dashboard: {
      mode: "producer_poc",
      pending_approvals: state.approvals.filter((approval) => approval.status === "pending").length,
      audit_entries: state.audit_log.length,
      last_decision: last?.decision,
      last_reason: last?.reason,
      panic_visible: true,
      physical_effects_connected: false,
    },
    steps,
    state,
  };
}

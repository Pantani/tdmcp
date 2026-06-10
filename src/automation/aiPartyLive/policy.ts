import {
  DEFAULT_EFFECT_POLICY,
  evaluateShowIntent,
  type ShowEffect,
  type ShowIntent,
} from "../showDirectorSchema.js";
import { type AiPartyCue, DEFAULT_AI_PARTY_CUE_CATALOG, findAiPartyCue } from "./cueCatalog.js";
import type { AiPartyDispatchAction, AiPartyPolicyDecision, AiPartyShowState } from "./schemas.js";

const BLOCKED_EFFECTS = new Set<ShowEffect>([
  "blackout",
  "freeze",
  "laser",
  "moving_head",
  "mixer_gain",
  "pa_mute",
  "audio_routing",
]);

const PROMPT_INJECTION =
  /\b(ignore previous rules|ignore all rules|override safety|bypass policy|forget instructions)\b/i;
const RAW_CONTROL =
  /\b(raw_dmx|raw dmx|raw_python|raw python|python script|arbitrary endpoint|fixture channel|channel number|dmx channel|mixer gain|pa mute|audio routing|laser|moving head|blackout|freeze)\b/i;

function decision(args: AiPartyPolicyDecision): AiPartyPolicyDecision {
  return args;
}

function block(reason: string, operatorMessage = reason): AiPartyPolicyDecision {
  return decision({
    decision: "block",
    reason,
    risk_level: "blocked",
    requires_hardware_gate: false,
    plan: [],
    operator_message: operatorMessage,
  });
}

function allow(
  reason: string,
  plan: AiPartyDispatchAction[],
  operatorMessage = reason,
): AiPartyPolicyDecision {
  return decision({
    decision: "allow",
    reason,
    risk_level: "safe",
    requires_hardware_gate: plan.some((item) => item.kind === "physical_effect"),
    plan,
    operator_message: operatorMessage,
  });
}

function approvalRequired(
  reason: string,
  plan: AiPartyDispatchAction[],
  operatorMessage = reason,
): AiPartyPolicyDecision {
  return decision({
    decision: "approval_required",
    reason,
    risk_level: "approval",
    requires_hardware_gate: plan.some((item) => item.kind === "physical_effect"),
    plan,
    operator_message: operatorMessage,
  });
}

function scanSafetyText(intent: ShowIntent, rawText?: string): AiPartyPolicyDecision | undefined {
  const haystack = `${rawText ?? ""}\n${JSON.stringify(intent)}`;
  if (PROMPT_INJECTION.test(haystack)) {
    return block(
      "Prompt injection attempt blocked by local policy.",
      "Blocked: prompt injection or safety-policy bypass language was detected.",
    );
  }
  if (RAW_CONTROL.test(haystack) && intent.type !== "blocked_request") {
    return block(
      "Raw hardware/control surface request blocked by local policy.",
      "Blocked: raw DMX, Python, endpoint, fixture, PA/mixer, blackout, freeze, laser, and moving-head requests are operator-only.",
    );
  }
  return undefined;
}

function cueDecision(cue: AiPartyCue, intensity?: number): AiPartyPolicyDecision {
  const plan: AiPartyDispatchAction[] =
    cue.kind === "safe_state"
      ? [{ kind: "panic_safe" }]
      : [{ kind: "cue", cue: cue.name, intensity }];
  if (cue.preapproved && cue.risk === "safe" && cue.kind !== "physical_effect") {
    return allow(`Cue ${cue.name} is preapproved and safe.`, plan, `Allowed cue: ${cue.label}.`);
  }
  return approvalRequired(
    `Cue ${cue.name} is approval-gated.`,
    plan,
    `Approval required for cue: ${cue.label}.`,
  );
}

function effectPlan(
  effect: ShowEffect,
  duration: number,
  intensity: number,
): AiPartyDispatchAction[] {
  return [{ kind: "physical_effect", effect, duration_seconds: duration, intensity }];
}

function evaluateEffect(
  intent: Extract<ShowIntent, { type: "arm_effect" }>,
  state: AiPartyShowState,
): AiPartyPolicyDecision {
  if (BLOCKED_EFFECTS.has(intent.effect)) {
    return block(
      `${intent.effect} is operator-only and cannot be dispatched by the AI POC.`,
      `Blocked: ${intent.effect} is operator-only.`,
    );
  }

  const duration = intent.duration_seconds ?? 0;
  const intensity = intent.intensity ?? 0;
  if (intent.effect === "fog" && duration > 3) {
    return block(
      "Fog duration exceeds the POC max of 3 seconds.",
      "Blocked: fog is limited to 3 seconds.",
    );
  }
  if (intent.effect === "fog" && intensity > 0.45) {
    return block(
      "Fog intensity exceeds the POC max of 0.45.",
      "Blocked: fog intensity is limited to 0.45.",
    );
  }
  if (intent.effect === "hazer" && duration > 3) {
    return block(
      "Hazer duration exceeds the POC max of 3 seconds.",
      "Blocked: hazer is limited to 3 seconds.",
    );
  }
  if (intent.effect === "strobe" && intensity > 0.25) {
    return block(
      "Strobe intensity exceeds the POC max of 0.25.",
      "Blocked: strobe intensity is limited to 0.25.",
    );
  }
  if (duration <= 0 || intensity <= 0) {
    return block(
      `${intent.effect} requires a bounded duration and intensity.`,
      `Blocked: ${intent.effect} needs explicit bounded duration and intensity.`,
    );
  }

  const runtimeDecision = evaluateShowIntent(intent, DEFAULT_EFFECT_POLICY, {
    recent_effects: state.recent_effects,
  });
  if (
    runtimeDecision.decision === "block" &&
    runtimeDecision.limits_applied.some((limit) => limit.startsWith("cooldown_seconds>="))
  ) {
    return block(runtimeDecision.reason, `Blocked: ${intent.effect} is within cooldown window.`);
  }

  return approvalRequired(
    `${intent.effect} is a hazardous or physical effect and requires operator approval.`,
    effectPlan(intent.effect, duration, intensity),
    `Approval required: ${intent.effect} ${duration}s @ ${intensity}.`,
  );
}

export function evaluateAiPartyPolicy(
  intent: ShowIntent,
  state: AiPartyShowState,
  rawText?: string,
  catalog: readonly AiPartyCue[] = DEFAULT_AI_PARTY_CUE_CATALOG,
): AiPartyPolicyDecision {
  const scanned = scanSafetyText(intent, rawText);
  if (scanned) return scanned;

  switch (intent.type) {
    case "announce":
      return allow("Announcement is low-risk.", [
        { kind: "announcement", text: intent.text, tone: intent.tone },
      ]);
    case "change_mood":
      if (intent.intensity > 0.85) {
        return block("Mood intensity exceeds the automatic max of 0.85.");
      }
      return allow(`Mood ${intent.mood} is within safe intensity.`, [
        {
          kind: "mood",
          mood: intent.mood,
          intensity: intent.intensity,
          duration_seconds: intent.duration_seconds,
        },
      ]);
    case "request_cue": {
      const cue = findAiPartyCue(intent.cue, catalog);
      if (!cue) {
        return block(
          `Unknown cue ${intent.cue}.`,
          `Unknown cue "${intent.cue}". Use /cues or the dashboard cue deck.`,
        );
      }
      return cueDecision(cue, intent.intensity);
    }
    case "arm_effect":
      return evaluateEffect(intent, state);
    case "log_note":
      return allow("Log note records context only.", [
        { kind: "log_note", note: intent.note, tags: intent.tags },
      ]);
    case "panic_status":
      if (intent.request === "enter_panic_safe") {
        return allow("Panic safe bypasses LLM dispatch and forces local safe state.", [
          { kind: "panic_safe" },
        ]);
      }
      if (intent.request === "clear_panic_after_operator_confirmation" && state.panic) {
        return approvalRequired("Clearing panic requires operator confirmation.", []);
      }
      return allow("Panic status is informational.", []);
    case "blocked_request":
      return block(intent.reason, intent.operator_message);
    case "approve_effect":
    case "cancel_effect":
      return allow(`${intent.type} records an operator approval decision.`, []);
  }
}

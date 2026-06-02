import { describe, expect, it } from "vitest";
import {
  approveShowIntent,
  cancelShowIntent,
  createShowDirectorState,
  submitShowIntent,
} from "../../src/automation/showDirectorRuntime.js";
import {
  evaluateShowIntent,
  parseShowIntent,
  ShowIntentSchema,
} from "../../src/automation/showDirectorSchema.js";

describe("showDirectorSchema", () => {
  it("allows low-risk show intents inside the approved visual surface", () => {
    const intent = ShowIntentSchema.parse({
      type: "change_mood",
      mood: "red chaotic",
      palette: ["#ff0033", "#220000"],
      intensity: 0.8,
    });

    const decision = evaluateShowIntent(intent);

    expect(decision.decision).toBe("allow");
    expect(decision.limits_applied).toContain("intensity<=1");
  });

  it("requires approval for bounded fog requests instead of executing them directly", () => {
    const intent = ShowIntentSchema.parse({
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    const decision = evaluateShowIntent(intent);

    expect(decision.decision).toBe("require_approval");
    expect(decision.reason).toContain("approval");
    expect(decision.limits_applied).toContain("duration_seconds<=3");
  });

  it("blocks dangerous effect requests that exceed the default policy", () => {
    const intent = ShowIntentSchema.parse({
      type: "arm_effect",
      effect: "strobe",
      duration_seconds: 30,
      intensity: 1,
    });

    const decision = evaluateShowIntent(intent);

    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("duration");
  });

  it("blocks capped effects when intensity is omitted", () => {
    const intent = ShowIntentSchema.parse({
      type: "arm_effect",
      effect: "strobe",
      duration_seconds: 5,
    });

    const decision = evaluateShowIntent(intent);

    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("intensity is required");
  });

  it("blocks effects inside a supplied recent-effect cooldown context", () => {
    const now = new Date("2026-06-01T20:00:00.000Z");
    const intent = ShowIntentSchema.parse({
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    const decision = evaluateShowIntent(intent, undefined, {
      now,
      recent_effects: [{ effect: "fog", at: new Date(now.getTime() - 30_000) }],
    });

    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("cooldown");
    expect(decision.limits_applied).toContain("cooldown_seconds>=60");
  });

  it("requires approval for cue requests unless they are explicitly pre-approved", () => {
    const intent = ShowIntentSchema.parse({
      type: "request_cue",
      cue: "band_intro",
    });

    const decision = evaluateShowIntent(intent);

    expect(decision.decision).toBe("require_approval");
    expect(decision.reason).toContain("not pre-approved");
  });

  it("blocks blackout, mixer and PA intents by default", () => {
    const effects = ["blackout", "mixer_gain", "pa_mute", "audio_routing"] as const;

    for (const effect of effects) {
      const decision = evaluateShowIntent({
        type: "arm_effect",
        effect,
        duration_seconds: 1,
      });
      expect(decision.decision).toBe("block");
      expect(decision.reason).toContain("operator-only");
    }
  });

  it("never turns malformed LLM output into an executable intent", () => {
    const parsed = parseShowIntent({
      type: "arm_effect",
      effect: "fog",
      duration_seconds: "thirty",
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.decision.decision).toBe("block");
    expect(parsed.decision.reason).toContain("Malformed");
    expect(parsed.decision.reason).toContain("duration_seconds");
  });
});

describe("showDirectorRuntime", () => {
  it("turns an allowed pre-approved cue into an abstract execution plan", () => {
    const state = createShowDirectorState();

    const result = submitShowIntent(state, {
      type: "request_cue",
      cue: "band_intro",
      preapproved: true,
    });

    expect(result.decision.decision).toBe("allow");
    expect(result.plan).toEqual([
      {
        kind: "cue",
        cue: "band_intro",
        dry_run_only: true,
      },
    ]);
    expect(result.state.audit_log[0]?.status).toBe("allowed");
  });

  it("queues approval-gated fog without producing a hardware execution plan", () => {
    const state = createShowDirectorState();

    const result = submitShowIntent(state, {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    expect(result.decision.decision).toBe("require_approval");
    expect(result.plan).toEqual([]);
    expect(result.approval?.effect).toBe("fog");
    expect(result.state.approvals).toHaveLength(1);
    expect(result.state.audit_log[0]?.status).toBe("queued");
  });

  it("approves a queued effect into an operator-approved abstract effect plan", () => {
    const queued = submitShowIntent(createShowDirectorState(), {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    const approved = approveShowIntent(queued.state, queued.approval?.id ?? "", "operator-a");

    expect(approved.ok).toBe(true);
    expect(approved.plan[0]).toMatchObject({
      kind: "effect",
      effect: "fog",
      dry_run_only: true,
      operator: "operator-a",
    });
    expect(approved.state.approvals[0]?.status).toBe("approved");
    expect(approved.state.audit_log.at(-1)?.status).toBe("approved");
  });

  it("rejects empty effect approval operators and records the failed resolution", () => {
    const queued = submitShowIntent(createShowDirectorState(), {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    const approved = approveShowIntent(queued.state, queued.approval?.id ?? "", "");

    expect(approved.ok).toBe(false);
    if (approved.ok) throw new Error("expected approval to fail");
    expect(approved.reason).toContain("operator");
    expect(approved.state.approvals[0]?.status).toBe("pending");
    expect(approved.state.audit_log.at(-1)).toMatchObject({
      status: "invalid",
      intent_type: "approve_effect",
      approval_id: "approval_0001",
      operator: "",
    });
  });

  it("submits an approve_effect intent as an approval state transition", () => {
    const queued = submitShowIntent(createShowDirectorState(), {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    const approved = submitShowIntent(queued.state, {
      type: "approve_effect",
      approval_id: queued.approval?.id,
      operator: "operator-a",
    });

    expect(approved.decision.decision).toBe("allow");
    expect(approved.plan[0]).toMatchObject({
      kind: "effect",
      effect: "fog",
      dry_run_only: true,
      operator: "operator-a",
    });
    expect(approved.state.approvals[0]?.status).toBe("approved");
  });

  it("does not report allow for failed approve_effect submissions", () => {
    const failed = submitShowIntent(createShowDirectorState(), {
      type: "approve_effect",
      approval_id: "missing",
      operator: "operator-a",
    });

    expect(failed.ok).toBe(false);
    expect(failed.decision.decision).toBe("block");
    expect(failed.decision.reason).toContain("not found");
    expect(failed.state.audit_log.at(-1)?.status).toBe("invalid");
  });

  it("turns a policy-allowed effect into a dry-run plan with a policy operator marker", () => {
    const allowed = submitShowIntent(
      createShowDirectorState(),
      {
        type: "arm_effect",
        effect: "fog",
        duration_seconds: 3,
        intensity: 0.4,
      },
      {
        effects: [
          {
            effect: "fog",
            decision: "allow",
            max_duration_seconds: 3,
            max_intensity: 0.5,
            operator_only: false,
          },
        ],
      },
    );

    expect(allowed.decision.decision).toBe("allow");
    expect(allowed.plan).toEqual([
      {
        kind: "effect",
        effect: "fog",
        duration_seconds: 3,
        intensity: 0.4,
        operator: "policy",
        dry_run_only: true,
      },
    ]);
  });

  it("cancels a queued approval and records the operator decision", () => {
    const queued = submitShowIntent(createShowDirectorState(), {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    const cancelled = cancelShowIntent(queued.state, queued.approval?.id ?? "", "operator-a");

    expect(cancelled.ok).toBe(true);
    expect(cancelled.state.approvals[0]?.status).toBe("cancelled");
    expect(cancelled.state.audit_log.at(-1)?.status).toBe("cancelled");
  });

  it("records failed direct cancellation attempts in the audit log", () => {
    const cancelled = cancelShowIntent(createShowDirectorState(), "missing", "operator-a");

    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error("expected cancellation to fail");
    expect(cancelled.reason).toContain("not found");
    expect(cancelled.state.audit_log.at(-1)).toMatchObject({
      status: "invalid",
      intent_type: "cancel_effect",
      approval_id: "missing",
      operator: "operator-a",
    });
  });

  it("submits a cancel_effect intent as a cancellation state transition", () => {
    const queued = submitShowIntent(createShowDirectorState(), {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    const cancelled = submitShowIntent(queued.state, {
      type: "cancel_effect",
      approval_id: queued.approval?.id,
      operator: "operator-a",
    });

    expect(cancelled.decision.decision).toBe("allow");
    expect(cancelled.plan).toEqual([]);
    expect(cancelled.state.approvals[0]?.status).toBe("cancelled");
    expect(cancelled.state.audit_log.at(-1)?.status).toBe("cancelled");
  });

  it("does not report allow for failed cancel_effect submissions", () => {
    const failed = submitShowIntent(createShowDirectorState(), {
      type: "cancel_effect",
      approval_id: "missing",
      operator: "operator-a",
    });

    expect(failed.ok).toBe(false);
    expect(failed.decision.decision).toBe("block");
    expect(failed.decision.reason).toContain("not found");
    expect(failed.state.audit_log.at(-1)?.status).toBe("invalid");
  });

  it("returns a structured cancellation error for persisted approvals with invalid decisions", () => {
    const queued = submitShowIntent(createShowDirectorState(), {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });
    const approval = queued.state.approvals[0];
    expect(approval).toBeDefined();
    const corrupted = {
      ...queued.state,
      approvals: approval
        ? [
            {
              ...approval,
              decision: { decision: "nonsense" },
            },
          ]
        : [],
    };

    const cancelled = cancelShowIntent(corrupted, queued.approval?.id ?? "", "operator-a");

    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error("expected cancellation to fail");
    expect(cancelled.reason).toContain("invalid decision");
    expect(cancelled.state.approvals[0]?.status).toBe("pending");
    expect(cancelled.state.audit_log.at(-1)).toMatchObject({
      status: "invalid",
      intent_type: "cancel_effect",
      approval_id: "approval_0001",
      operator: "operator-a",
    });
  });

  it("blocks same-effect approvals inside the configured cooldown window", () => {
    const first = submitShowIntent(createShowDirectorState(), {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });
    const approved = approveShowIntent(first.state, first.approval?.id ?? "", "operator-a");
    expect(approved.ok).toBe(true);

    const second = submitShowIntent(approved.state, {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });

    expect(second.decision.decision).toBe("block");
    expect(second.decision.reason).toContain("cooldown");
    expect(second.state.audit_log.at(-1)).toMatchObject({
      status: "blocked",
      effect: "fog",
    });
  });
});

import { describe, expect, it } from "vitest";
import { runAiPartyPoc } from "../../src/automation/aiPartyPoc.js";
import { simulateShowActionPlan } from "../../src/automation/effectSimulator.js";

describe("effectSimulator", () => {
  it("turns approved dry-run effects into simulated-only visual events", () => {
    const simulated = simulateShowActionPlan([
      {
        kind: "effect",
        effect: "fog",
        duration_seconds: 3,
        intensity: 0.35,
        operator: "operator-a",
        dry_run_only: true,
      },
    ]);

    expect(simulated).toEqual([
      expect.objectContaining({
        effect: "fog",
        visual_cue: "fog_sim_short",
        hardware_connected: false,
        dry_run_only: true,
        safe_state: "simulated_only",
      }),
    ]);
  });
});

describe("aiPartyPoc", () => {
  it("runs the default producer POC without producing hardware plans", () => {
    const result = runAiPartyPoc();

    expect(result.dryRun).toBe(true);
    expect(result.hardware).toBe("simulated_only");
    expect(result.summary.steps).toBeGreaterThanOrEqual(7);
    expect(result.summary.hardware_plans).toBe(0);
    expect(result.summary.queued).toBeGreaterThanOrEqual(1);
    expect(result.summary.blocked).toBeGreaterThanOrEqual(1);
    expect(result.dashboard.panic_visible).toBe(true);
    expect(result.dashboard.physical_effects_connected).toBe(false);
  });

  it("can auto-approve queued effects into simulated visual events", () => {
    const result = runAiPartyPoc({ auto_approve_effects: true, operator: "front-of-house" });

    expect(result.summary.approved).toBeGreaterThanOrEqual(1);
    expect(result.summary.simulated_effects).toBeGreaterThanOrEqual(1);
    expect(result.steps.some((step) => step.simulated_effects[0]?.effect === "fog")).toBe(true);
    expect(result.dashboard.pending_approvals).toBe(0);
  });

  it("accepts custom text events for the rehearsal path", () => {
    const result = runAiPartyPoc({
      events: [
        { type: "operator_text", text: "Arm intro for Band A" },
        { type: "voice_transcript", text: "make it red and chaotic", confidence: 0.9 },
        { type: "operator_text", text: "fog for 30 seconds strong" },
      ],
    });

    expect(result.steps.map((step) => step.intent?.type)).toEqual([
      "request_cue",
      "change_mood",
      "arm_effect",
    ]);
    expect(result.summary.blocked).toBe(1);
  });
});

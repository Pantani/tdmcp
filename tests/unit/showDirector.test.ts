import { describe, expect, it } from "vitest";
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
  });
});

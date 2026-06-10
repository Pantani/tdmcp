import { describe, expect, it } from "vitest";
import { normalizeAiPartyEvent } from "../../src/automation/aiPartyFanIn.js";

describe("aiPartyFanIn", () => {
  it("maps producer text requests to pre-approved cues", () => {
    const result = normalizeAiPartyEvent({ type: "operator_text", text: "Arm intro for Band A" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected fan-in success");
    expect(result.intent).toMatchObject({
      type: "request_cue",
      cue: "band_intro",
      scene_id: "band_a_intro",
      preapproved: true,
    });
  });

  it("maps voice mood requests to bounded visual mood changes", () => {
    const result = normalizeAiPartyEvent({
      type: "voice_transcript",
      text: "make it red and chaotic",
      confidence: 0.9,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected fan-in success");
    expect(result.intent).toMatchObject({
      type: "change_mood",
      mood: "red_chaotic_bounded",
      palette: ["red", "deep_blue", "white"],
    });
  });

  it("keeps low-confidence transcripts as log notes instead of executable intents", () => {
    const result = normalizeAiPartyEvent({
      type: "voice_transcript",
      text: "blackout everything",
      confidence: 0.2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected fan-in success");
    expect(result.intent.type).toBe("log_note");
    expect(result.warnings).toContain("low_confidence");
  });

  it("maps hazardous text to policy-checkable effect intents", () => {
    const result = normalizeAiPartyEvent({ type: "operator_text", text: "raise mixer gain hard" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected fan-in success");
    expect(result.intent).toMatchObject({
      type: "arm_effect",
      effect: "mixer_gain",
      intensity: 0.8,
    });
  });

  it("requires operator data for approval actions", () => {
    const result = normalizeAiPartyEvent({
      type: "dashboard_action",
      action: "approve",
      approval_id: "approval_0001",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fan-in failure");
    expect(result.issues).toContain("operator is required to approve");
  });
});

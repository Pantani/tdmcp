import { describe, expect, it } from "vitest";
import {
  computeMixerCatalogHash,
  DEMO_MIXER_SCENE_MANIFEST,
  type MixerSceneManifest,
} from "../../src/automation/mixerSceneCatalog.js";
import {
  approveShowIntent,
  cancelShowIntent,
  createShowDirectorState,
  submitShowIntent,
} from "../../src/automation/showDirectorRuntime.js";
import {
  evaluateMixerSceneIntent,
  evaluateShowIntent,
  type MixerSceneIntent,
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

const ADAPTER_TARGET = { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" } as const;

function snapshotIntent(overrides: Partial<MixerSceneIntent> = {}): MixerSceneIntent {
  return {
    type: "arm_mixer_scene",
    adapter_target: ADAPTER_TARGET,
    target: { kind: "snapshot", scene_id: "band_a_intro" },
    ...overrides,
  };
}

describe("mixer scene policy (arm_mixer_scene)", () => {
  it("requires approval for a catalog-backed snapshot scene and never auto-allows", () => {
    const decision = evaluateMixerSceneIntent(snapshotIntent(), DEMO_MIXER_SCENE_MANIFEST);
    expect(decision.decision).toBe("require_approval");
    expect(decision.intent_type).toBe("arm_mixer_scene");
    expect(decision.scene_id).toBe("band_a_intro");
    expect(decision.catalog_hash).toBe(DEMO_MIXER_SCENE_MANIFEST.policy_hash);
    expect(decision.limits_applied).toContain("never_auto_allow");
    expect(decision.limits_applied).toContain("dry_run_only");
  });

  it("requires approval for a catalog-backed show recall", () => {
    const decision = evaluateMixerSceneIntent(
      {
        type: "arm_mixer_scene",
        adapter_target: ADAPTER_TARGET,
        target: { kind: "show", scene_id: "house_default" },
      },
      DEMO_MIXER_SCENE_MANIFEST,
    );
    expect(decision.decision).toBe("require_approval");
    expect(decision.scene_id).toBe("house_default");
  });

  it("blocks when no mixer scene manifest is configured", () => {
    const decision = evaluateMixerSceneIntent(snapshotIntent(), undefined);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("not configured");
  });

  it("blocks an unknown scene id", () => {
    const decision = evaluateMixerSceneIntent(
      snapshotIntent({ target: { kind: "snapshot", scene_id: "ghost" } }),
      DEMO_MIXER_SCENE_MANIFEST,
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("unknown mixer scene_id");
  });

  it("blocks a request with no predeclared scene id", () => {
    const decision = evaluateMixerSceneIntent(
      snapshotIntent({ target: { kind: "snapshot", show_name: "AI Party Demo" } }),
      DEMO_MIXER_SCENE_MANIFEST,
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("no predeclared scene_id");
  });

  it("blocks an unresolved setlist_ref", () => {
    const decision = evaluateMixerSceneIntent(
      snapshotIntent({
        target: { kind: "snapshot", scene_id: "band_a_intro", setlist_ref: "not_a_section" },
      }),
      DEMO_MIXER_SCENE_MANIFEST,
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("unresolved setlist_ref");
  });

  it("blocks an unsupported target kind (cue against a snapshot scene)", () => {
    const decision = evaluateMixerSceneIntent(
      snapshotIntent({ target: { kind: "cue", scene_id: "band_a_intro" } }),
      DEMO_MIXER_SCENE_MANIFEST,
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("unsupported target");
  });

  it("blocks an unknown mixer id for a known scene", () => {
    const decision = evaluateMixerSceneIntent(
      snapshotIntent({ adapter_target: { kind: "soundcraft_ui24r", mixer_id: "monitor-desk" } }),
      DEMO_MIXER_SCENE_MANIFEST,
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("unknown mixer_id");
  });

  it("blocks when the catalog hash has drifted from the attested policy_hash", () => {
    const tampered: MixerSceneManifest = {
      ...DEMO_MIXER_SCENE_MANIFEST,
      policy_hash: "stale-attested-hash",
    };
    const decision = evaluateMixerSceneIntent(snapshotIntent(), tampered);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("catalog hash changed");
  });

  it("blocks an unsafe scene that does not exclude all forbidden deltas", () => {
    const unsafeScenes = [
      {
        ...DEMO_MIXER_SCENE_MANIFEST.scenes[0],
        forbidden_delta_check: { excludes_all_forbidden: true, verified: ["gain"] },
      },
    ];
    const unsafeManifest: MixerSceneManifest = {
      ...DEMO_MIXER_SCENE_MANIFEST,
      scenes: unsafeScenes as never,
      policy_hash: computeMixerCatalogHash(unsafeScenes as never),
    };
    const decision = evaluateMixerSceneIntent(snapshotIntent(), unsafeManifest);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("unsafe scene diff");
  });

  it("keeps mixer_gain, pa_mute and audio_routing blocked as arm_effect operations", () => {
    for (const effect of ["mixer_gain", "pa_mute", "audio_routing"] as const) {
      const decision = evaluateShowIntent({ type: "arm_effect", effect, duration_seconds: 1 });
      expect(decision.decision).toBe("block");
      expect(decision.reason).toContain("operator-only");
    }
  });
});

describe("mixer scene runtime (arm_mixer_scene)", () => {
  const opts = { mixerSceneManifest: DEMO_MIXER_SCENE_MANIFEST };

  it("queues a generic mixer_scene approval without a hardware plan", () => {
    const result = submitShowIntent(createShowDirectorState(), snapshotIntent(), undefined, opts);
    expect(result.decision.decision).toBe("require_approval");
    expect(result.plan).toEqual([]);
    expect(result.approval?.target).toMatchObject({
      kind: "mixer_scene",
      scene_id: "band_a_intro",
      catalog_hash: DEMO_MIXER_SCENE_MANIFEST.policy_hash,
    });
    expect(result.approval?.effect).toBeUndefined();
    expect(result.state.audit_log.at(-1)?.status).toBe("queued");
  });

  it("blocks an unconfigured mixer scene submission with no approval queued", () => {
    const result = submitShowIntent(createShowDirectorState(), snapshotIntent());
    expect(result.decision.decision).toBe("block");
    expect(result.approval).toBeUndefined();
    expect(result.state.approvals).toHaveLength(0);
    expect(result.state.audit_log.at(-1)?.status).toBe("blocked");
  });

  it("approves a queued mixer scene into a dry-run-only plan with hardware_changed never asserted", () => {
    const queued = submitShowIntent(createShowDirectorState(), snapshotIntent(), undefined, opts);
    const approved = approveShowIntent(
      queued.state,
      queued.approval?.id ?? "",
      "front-of-house",
      opts,
    );

    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("expected approval to succeed");
    expect(approved.plan[0]).toMatchObject({
      kind: "mixer_scene",
      action: "arm",
      adapter_target: ADAPTER_TARGET,
      mixer_scene: { scene_id: "band_a_intro", show_name: "AI Party Demo", label: "Band A Intro" },
      operator: "front-of-house",
      dry_run_only: true,
    });
    expect(approved.state.approvals[0]?.status).toBe("approved");
    expect(approved.state.audit_log.at(-1)?.status).toBe("approved");
  });

  it("re-runs policy on approval and refuses when the catalog drifted after queuing", () => {
    const queued = submitShowIntent(createShowDirectorState(), snapshotIntent(), undefined, opts);
    const drifted: MixerSceneManifest = {
      ...DEMO_MIXER_SCENE_MANIFEST,
      policy_hash: "drifted-after-queue",
    };
    const approved = approveShowIntent(queued.state, queued.approval?.id ?? "", "front-of-house", {
      mixerSceneManifest: drifted,
    });

    expect(approved.ok).toBe(false);
    if (approved.ok) throw new Error("expected approval to fail on drift");
    expect(approved.reason).toContain("no longer approvable");
    expect(approved.state.approvals[0]?.status).toBe("pending");
  });

  it("refuses approval when the catalog was edited and re-hashed after the operator reviewed it", () => {
    const queued = submitShowIntent(createShowDirectorState(), snapshotIntent(), undefined, opts);
    // The operator reviewed DEMO. Now the catalog body is edited AND re-hashed
    // consistently, so the manifest is self-consistent and the policy still
    // returns require_approval — but the hash differs from what was reviewed.
    const editedScenes = DEMO_MIXER_SCENE_MANIFEST.scenes.map((scene) =>
      scene.scene_id === "band_a_intro" ? { ...scene, label: `${scene.label} (edited)` } : scene,
    );
    const rehashed: MixerSceneManifest = {
      ...DEMO_MIXER_SCENE_MANIFEST,
      scenes: editedScenes,
      policy_hash: computeMixerCatalogHash(editedScenes),
    };
    expect(rehashed.policy_hash).not.toBe(DEMO_MIXER_SCENE_MANIFEST.policy_hash);

    const approved = approveShowIntent(queued.state, queued.approval?.id ?? "", "front-of-house", {
      mixerSceneManifest: rehashed,
    });

    expect(approved.ok).toBe(false);
    if (approved.ok) throw new Error("expected approval to fail on re-hash drift");
    expect(approved.reason).toContain("catalog drifted since review");
    expect(approved.state.approvals[0]?.status).toBe("pending");
  });

  it("fails closed when a restored mixer-scene approval lost its reviewed catalog target", () => {
    const queued = submitShowIntent(createShowDirectorState(), snapshotIntent(), undefined, opts);
    const tampered = structuredClone(queued.state);
    const restored = tampered.approvals[0];
    if (!restored) throw new Error("expected a queued approval");
    // Simulate a restored/malformed approval whose reviewed mixer_scene target is gone.
    (restored as { target?: unknown }).target = undefined;
    const approved = approveShowIntent(tampered, queued.approval?.id ?? "", "front-of-house", opts);

    expect(approved.ok).toBe(false);
    if (approved.ok) throw new Error("expected fail-closed approval");
    expect(approved.reason).toContain("missing reviewed mixer scene catalog metadata");
    expect(approved.state.approvals[0]?.status).toBe("pending");
  });

  it("submits an approve_effect transition that resolves a queued mixer scene", () => {
    const queued = submitShowIntent(createShowDirectorState(), snapshotIntent(), undefined, opts);
    const approved = submitShowIntent(
      queued.state,
      { type: "approve_effect", approval_id: queued.approval?.id, operator: "front-of-house" },
      undefined,
      opts,
    );

    expect(approved.decision.decision).toBe("allow");
    expect(approved.plan[0]).toMatchObject({
      kind: "mixer_scene",
      action: "arm",
      mixer_scene: { scene_id: "band_a_intro" },
      dry_run_only: true,
    });
    expect(approved.state.approvals[0]?.status).toBe("approved");
  });

  it("preserves backwards-compatible effect approvals alongside mixer scene approvals", () => {
    const effectQueued = submitShowIntent(createShowDirectorState(), {
      type: "arm_effect",
      effect: "fog",
      duration_seconds: 3,
      intensity: 0.4,
    });
    expect(effectQueued.approval?.target).toMatchObject({ kind: "effect", effect: "fog" });
    expect(effectQueued.approval?.effect).toBe("fog");

    const mixerQueued = submitShowIntent(effectQueued.state, snapshotIntent(), undefined, opts);
    expect(mixerQueued.state.approvals).toHaveLength(2);
    expect(mixerQueued.state.approvals[0]?.effect).toBe("fog");
    expect(mixerQueued.state.approvals[1]?.target?.kind).toBe("mixer_scene");
  });
});

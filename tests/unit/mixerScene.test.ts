import { describe, expect, it } from "vitest";
import {
  createDryRunMixerSceneAdapter,
  type MixerScenePlan,
  notConfiguredMixerBackend,
} from "../../src/automation/mixerSceneAdapter.js";
import {
  computeMixerCatalogHash,
  DEMO_MIXER_SCENE_MANIFEST,
  loadMixerSceneManifest,
  type MixerSceneManifest,
  sceneExcludesAllForbiddenDeltas,
} from "../../src/automation/mixerSceneCatalog.js";

const ALL_FORBIDDEN = [
  "gain",
  "pa_mute",
  "routing",
  "patch",
  "channel_strip",
  "mute_group",
  "phantom_power",
] as const;

function snapshotScene(overrides: Record<string, unknown> = {}) {
  return {
    scene_id: "band_a_intro",
    label: "Band A Intro",
    adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
    operation: "recall_snapshot",
    show_name: "AI Party Demo",
    snapshot_name: "Band A Intro",
    allowed_setlist_sections: ["band_a_intro"],
    last_validated_at: "2026-06-03T18:00:00.000Z",
    rollback_target: "house_default",
    safety_notes: "FX only; no forbidden deltas.",
    forbidden_delta_check: {
      excludes_all_forbidden: true,
      verified: [...ALL_FORBIDDEN],
      evidence: "bench diff",
    },
    ...overrides,
  };
}

function manifestWith(scenes: Record<string, unknown>[]): MixerSceneManifest {
  // Build with a placeholder hash, then re-derive the canonical hash so the
  // manifest is valid by construction.
  const body = { venue: "Test", catalog_version: "v1", policy_hash: "x", scenes };
  const hash = computeMixerCatalogHash(scenes as never);
  return { ...body, policy_hash: hash } as MixerSceneManifest;
}

describe("mixerSceneCatalog", () => {
  it("loads the built-in demo manifest with a matching catalog hash", () => {
    const loaded = loadMixerSceneManifest(DEMO_MIXER_SCENE_MANIFEST);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("expected demo manifest to load");
    expect(loaded.catalog_hash).toBe(DEMO_MIXER_SCENE_MANIFEST.policy_hash);
    expect(loaded.manifest.scenes.map((s) => s.scene_id)).toContain("band_a_intro");
  });

  it("blocks a manifest whose declared policy_hash drifts from the catalog body", () => {
    const tampered = { ...DEMO_MIXER_SCENE_MANIFEST, policy_hash: "deadbeef" };
    const loaded = loadMixerSceneManifest(tampered);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected hash mismatch to block");
    expect(loaded.issues.join(" ")).toContain("catalog hash mismatch");
  });

  it("detects a changed catalog body via a different hash", () => {
    const original = computeMixerCatalogHash([snapshotScene()] as never);
    const mutated = computeMixerCatalogHash([
      snapshotScene({ safety_notes: "edited after attestation" }),
    ] as never);
    expect(mutated).not.toBe(original);
  });

  it("rejects manifests with duplicate scene ids", () => {
    const loaded = loadMixerSceneManifest(manifestWith([snapshotScene(), snapshotScene()]));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected duplicate scene id to block");
    expect(loaded.issues.join(" ")).toContain("duplicate scene_id");
  });

  it("only treats a scene as safe when it proves it excludes every forbidden delta", () => {
    const complete = snapshotScene();
    const partial = snapshotScene({
      forbidden_delta_check: { excludes_all_forbidden: true, verified: ["gain", "pa_mute"] },
    });
    const flagged = snapshotScene({
      forbidden_delta_check: { excludes_all_forbidden: false, verified: [...ALL_FORBIDDEN] },
    });
    const loaded = loadMixerSceneManifest(manifestWith([complete]));
    if (!loaded.ok) throw new Error("setup failed");
    const completeEntry = loaded.manifest.scenes[0];
    expect(completeEntry && sceneExcludesAllForbiddenDeltas(completeEntry)).toBe(true);

    const partialLoaded = loadMixerSceneManifest(manifestWith([partial]));
    if (!partialLoaded.ok) throw new Error("setup failed");
    const partialEntry = partialLoaded.manifest.scenes[0];
    expect(partialEntry && sceneExcludesAllForbiddenDeltas(partialEntry)).toBe(false);

    const flaggedLoaded = loadMixerSceneManifest(manifestWith([flagged]));
    if (!flaggedLoaded.ok) throw new Error("setup failed");
    const flaggedEntry = flaggedLoaded.manifest.scenes[0];
    expect(flaggedEntry && sceneExcludesAllForbiddenDeltas(flaggedEntry)).toBe(false);
  });

  it("requires snapshot_name for recall_snapshot and cue_name for recall_cue", () => {
    const badSnapshot = loadMixerSceneManifest({
      venue: "Test",
      catalog_version: "v1",
      policy_hash: "x",
      scenes: [snapshotScene({ snapshot_name: undefined })],
    });
    expect(badSnapshot.ok).toBe(false);
    if (badSnapshot.ok) throw new Error("expected snapshot validation to block");
    expect(badSnapshot.issues.join(" ")).toContain("recall_snapshot requires snapshot_name");

    const badCue = loadMixerSceneManifest({
      venue: "Test",
      catalog_version: "v1",
      policy_hash: "x",
      scenes: [snapshotScene({ scene_id: "c", operation: "recall_cue", snapshot_name: undefined })],
    });
    expect(badCue.ok).toBe(false);
    if (badCue.ok) throw new Error("expected cue validation to block");
    expect(badCue.issues.join(" ")).toContain("recall_cue requires cue_name");
  });
});

function approvedPlan(overrides: Partial<MixerScenePlan> = {}): MixerScenePlan {
  return {
    kind: "mixer_scene",
    action: "arm",
    adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
    mixer_scene: {
      kind: "snapshot",
      scene_id: "band_a_intro",
      show_name: "AI Party Demo",
      snapshot_name: "Band A Intro",
      label: "Band A Intro",
    },
    catalog_hash: DEMO_MIXER_SCENE_MANIFEST.policy_hash,
    approval_id: "approval_0001",
    operator: "front-of-house",
    dry_run_only: true,
    ...overrides,
  };
}

describe("DryRunMixerSceneAdapter", () => {
  it("arms an approved plan and reports hardware_changed:false", () => {
    const adapter = createDryRunMixerSceneAdapter();
    const result = adapter.dispatch({
      plan: approvedPlan(),
      manifest: DEMO_MIXER_SCENE_MANIFEST,
    });

    expect(result.backend).toBe("dry_run");
    expect(result.ok).toBe(true);
    expect(result.hardware_changed).toBe(false);
    expect(result.state).toBe("simulated");
    expect(result.scene_id).toBe("band_a_intro");
    expect(result.message).toContain("no hardware contacted");
  });

  it("never reports confirmed and never changes hardware on a duplicate idempotency key", () => {
    const adapter = createDryRunMixerSceneAdapter();
    const result = adapter.dispatch({
      plan: approvedPlan(),
      manifest: DEMO_MIXER_SCENE_MANIFEST,
      dispatchedKeys: new Set(["approval_0001"]),
    });

    expect(result.ok).toBe(false);
    expect(result.hardware_changed).toBe(false);
    expect(result.state).toBe("unknown");
    expect(result.message).toContain("duplicate idempotency key");
  });

  it("fails when the plan's catalog hash drifts from the manifest", () => {
    const adapter = createDryRunMixerSceneAdapter();
    const result = adapter.dispatch({
      plan: approvedPlan({ catalog_hash: "stale-hash" }),
      manifest: DEMO_MIXER_SCENE_MANIFEST,
    });

    expect(result.ok).toBe(false);
    expect(result.hardware_changed).toBe(false);
    expect(result.state).toBe("failed");
    expect(result.message).toContain("catalog hash changed");
  });

  it("fails on a missing target scene without contacting hardware", () => {
    const adapter = createDryRunMixerSceneAdapter();
    const result = adapter.dispatch({
      plan: approvedPlan({
        mixer_scene: {
          kind: "snapshot",
          scene_id: "ghost_scene",
          show_name: "AI Party Demo",
          snapshot_name: "x",
          label: "x",
        },
      }),
      manifest: DEMO_MIXER_SCENE_MANIFEST,
    });

    expect(result.ok).toBe(false);
    expect(result.hardware_changed).toBe(false);
    expect(result.message).toContain("missing target scene");
  });

  it("rejects a non-mixer-scene plan", () => {
    const adapter = createDryRunMixerSceneAdapter();
    // Deliberately wrong plan shape: a log_note plan is not a mixer scene.
    const wrongPlan = { kind: "log_note", note: "x", tags: [], dry_run_only: true } as unknown;
    const result = adapter.dispatch({
      plan: wrongPlan as MixerScenePlan,
      manifest: DEMO_MIXER_SCENE_MANIFEST,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("approved mixer_scene plan");
  });

  it("does not construct a live backend in the MVP", () => {
    const companion = notConfiguredMixerBackend("companion");
    expect(companion.ok).toBe(false);
    expect(companion.hardware_changed).toBe(false);
    expect(companion.state).toBe("unknown");
    expect(companion.message).toContain("not available in the dry-run MVP");
  });
});

/**
 * Mixer-scene adapter boundary (Milestone 5, dry-run MVP).
 *
 * Defines the adapter interface every backend (dry-run now; Companion / direct
 * Node later, both quarantined) must satisfy, plus the dry-run backend that
 * consumes an APPROVED mixer-scene plan and returns `hardware_changed: false`.
 *
 * NON-GOALS honored here: no Soundcraft / Companion / WebSocket / HTTP / Node /
 * TouchDesigner client is constructed; approval never implies hardware changed;
 * there is no raw command path. The dry-run backend performs zero I/O.
 */
import { z } from "zod";
import {
  computeMixerCatalogHash,
  type MixerSceneManifest,
  sceneExcludesAllForbiddenDeltas,
} from "./mixerSceneCatalog.js";
import { type ShowActionPlan, ShowActionPlanSchema } from "./showDirectorRuntime.js";

/** Backend identifiers. Only `dry_run` is shippable in the MVP. */
export const MixerAdapterBackendSchema = z.enum(["dry_run", "companion", "direct_node"]);
export type MixerAdapterBackend = z.infer<typeof MixerAdapterBackendSchema>;

/**
 * Precise dispatch states. The dry-run backend only ever reports `simulated`.
 * Live backends add sent/acknowledged/confirmed/unknown — `confirmed` requires
 * readback or operator confirmation and is never claimed in dry-run.
 */
export const MixerDispatchStateSchema = z.enum([
  "simulated",
  "sent",
  "acknowledged",
  "confirmed",
  "failed",
  "unknown",
]);
export type MixerDispatchState = z.infer<typeof MixerDispatchStateSchema>;

export const MixerAdapterResultSchema = z.object({
  backend: MixerAdapterBackendSchema,
  ok: z.boolean(),
  /** Whether real mixer hardware changed. Dry-run is ALWAYS false. */
  hardware_changed: z.boolean(),
  state: MixerDispatchStateSchema,
  scene_id: z.string().min(1).optional(),
  catalog_hash: z.string().min(1).optional(),
  /** Idempotency key derived from the approval; one key → at most one send. */
  idempotency_key: z.string().min(1).optional(),
  operator: z.string().min(1).optional(),
  message: z.string(),
});
export type MixerAdapterResult = z.infer<typeof MixerAdapterResultSchema>;

export type MixerScenePlan = Extract<ShowActionPlan, { kind: "mixer_scene" }>;

export interface MixerAdapterDispatchInput {
  plan: MixerScenePlan;
  /** The trusted manifest the plan must still resolve against. */
  manifest: MixerSceneManifest;
  /** Approval ids already dispatched (idempotency); one key → one send. */
  dispatchedKeys?: ReadonlySet<string>;
}

/**
 * The adapter boundary. A backend NEVER receives a raw command — only an
 * approved, catalog-resolved mixer-scene plan plus the manifest to revalidate.
 */
export interface MixerSceneAdapter {
  readonly backend: MixerAdapterBackend;
  dispatch(input: MixerAdapterDispatchInput): MixerAdapterResult;
}

function fail(
  backend: MixerAdapterBackend,
  state: MixerDispatchState,
  message: string,
  extra: Partial<MixerAdapterResult> = {},
): MixerAdapterResult {
  return MixerAdapterResultSchema.parse({
    backend,
    ok: false,
    hardware_changed: false,
    state,
    message,
    ...extra,
  });
}

/**
 * Dry-run backend. Validates the approved plan against the catalog and returns
 * a deterministic `hardware_changed: false` result. It surfaces (but never
 * dispatches) the failure cases a live backend must handle: missing target,
 * policy hash mismatch, unsafe scene, and duplicate idempotency keys.
 */
export class DryRunMixerSceneAdapter implements MixerSceneAdapter {
  readonly backend: MixerAdapterBackend = "dry_run";

  dispatch(input: MixerAdapterDispatchInput): MixerAdapterResult {
    const parsedPlan = ShowActionPlanSchema.safeParse(input.plan);
    if (!parsedPlan.success || parsedPlan.data.kind !== "mixer_scene") {
      return fail("dry_run", "failed", "dry-run adapter requires an approved mixer_scene plan");
    }
    const plan = parsedPlan.data;
    const idempotencyKey = plan.approval_id;
    const base = {
      scene_id: plan.mixer_scene.scene_id,
      catalog_hash: plan.catalog_hash,
      idempotency_key: idempotencyKey,
      operator: plan.operator,
    };

    // One idempotency key → at most one (simulated) send.
    if (input.dispatchedKeys?.has(idempotencyKey)) {
      return fail("dry_run", "unknown", `duplicate idempotency key ${idempotencyKey}`, base);
    }

    // Re-validate the catalog hash; a drifted catalog stops the dispatch.
    const computedHash = computeMixerCatalogHash(input.manifest.scenes);
    if (computedHash !== input.manifest.policy_hash || computedHash !== plan.catalog_hash) {
      return fail("dry_run", "failed", "catalog hash changed since approval", base);
    }

    const scene = input.manifest.scenes.find(
      (entry) => entry.scene_id === plan.mixer_scene.scene_id,
    );
    if (!scene) {
      return fail("dry_run", "failed", `missing target scene ${plan.mixer_scene.scene_id}`, base);
    }
    if (!sceneExcludesAllForbiddenDeltas(scene)) {
      return fail(
        "dry_run",
        "failed",
        `scene ${scene.scene_id} no longer excludes forbidden deltas`,
        base,
      );
    }

    return MixerAdapterResultSchema.parse({
      backend: "dry_run",
      ok: true,
      hardware_changed: false,
      state: "simulated",
      ...base,
      message: `dry-run armed mixer scene "${scene.scene_id}" (${scene.label}); no hardware contacted`,
    });
  }
}

/** Construct the dry-run backend. The only backend available in the MVP. */
export function createDryRunMixerSceneAdapter(): MixerSceneAdapter {
  return new DryRunMixerSceneAdapter();
}

/**
 * Future live backends are intentionally NOT constructed in this slice.
 * Requesting one returns a not-configured result instead of building a client.
 */
export function notConfiguredMixerBackend(backend: MixerAdapterBackend): MixerAdapterResult {
  return fail(
    backend,
    "unknown",
    `${backend} backend is not available in the dry-run MVP (bench validation required)`,
  );
}

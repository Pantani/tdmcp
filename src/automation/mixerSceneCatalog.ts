/**
 * Trusted venue mixer-scene catalog + safety manifest (Milestone 5, dry-run MVP).
 *
 * Every AI-armable Soundcraft Ui24R mixer scene MUST be a predeclared catalog
 * entry. The LLM may never invent or live-match show/snapshot/cue names — only
 * the entries listed here (or in an operator-loaded manifest) are armable, and
 * the catalog hash is re-validated before every policy decision so a tampered
 * or drifted catalog hard-blocks instead of arming.
 *
 * This module constructs NO hardware client and performs NO I/O. It is a pure,
 * deterministic, offline-testable schema + loader, mirroring the house
 * `showDirectorSchema` / `setlistSchema` style.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

/** Ui24R recall operations the catalog may declare. No gain/mute/routing here. */
export const MixerSceneOperationSchema = z.enum(["recall_show", "recall_snapshot", "recall_cue"]);
export type MixerSceneOperation = z.infer<typeof MixerSceneOperationSchema>;

/**
 * Forbidden mixer deltas. A catalog entry is only AI-armable if it can PROVE it
 * excludes every one of these. `forbidden_delta_check` records that proof.
 */
export const ForbiddenMixerDeltaSchema = z.enum([
  "gain",
  "pa_mute",
  "routing",
  "patch",
  "channel_strip",
  "mute_group",
  "phantom_power",
]);
export type ForbiddenMixerDelta = z.infer<typeof ForbiddenMixerDeltaSchema>;

// Derived from the schema so a new forbidden delta added to the enum is always
// verified by sceneExcludesAllForbiddenDeltas — no silent drift between the two.
const ALL_FORBIDDEN_DELTAS: readonly ForbiddenMixerDelta[] = ForbiddenMixerDeltaSchema.options;

/** Adapter target the catalog entry is bench-bound to. */
export const MixerAdapterTargetSchema = z.object({
  kind: z.literal("soundcraft_ui24r"),
  mixer_id: NonEmptyString,
});
export type MixerAdapterTarget = z.infer<typeof MixerAdapterTargetSchema>;

/**
 * The forbidden-delta result. `excludes_all_forbidden` must be `true` AND the
 * `verified` list must cover every forbidden delta for the scene to be armable.
 */
export const ForbiddenDeltaResultSchema = z.object({
  excludes_all_forbidden: z.boolean(),
  verified: z.array(ForbiddenMixerDeltaSchema).default([]),
  evidence: z.string().trim().optional(),
});
export type ForbiddenDeltaResult = z.infer<typeof ForbiddenDeltaResultSchema>;

/** One predeclared, bench-validated Ui24R scene. */
export const MixerSceneCatalogEntrySchema = z
  .object({
    /** Stable, AI-facing scene ID. The only thing the LLM may reference. */
    scene_id: NonEmptyString,
    /** Operator display label shown in the approval surface. */
    label: NonEmptyString,
    adapter_target: MixerAdapterTargetSchema,
    operation: MixerSceneOperationSchema,
    /** Ui24R show this entry lives in. */
    show_name: NonEmptyString,
    /** Snapshot name (required for recall_snapshot). */
    snapshot_name: NonEmptyString.optional(),
    /** Cue name (required for recall_cue). */
    cue_name: NonEmptyString.optional(),
    /** Setlist sections this scene may be armed in (e.g. "band_a_intro"). */
    allowed_setlist_sections: z.array(NonEmptyString).default([]),
    /** ISO timestamp of the last rehearsal/bench validation. */
    last_validated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T/),
    /** Scene ID an operator recalls to manually recover from this scene. */
    rollback_target: NonEmptyString,
    /** Free-text safety notes for the operator surface. */
    safety_notes: NonEmptyString,
    /** Proof the scene excludes all forbidden mixer deltas. */
    forbidden_delta_check: ForbiddenDeltaResultSchema,
  })
  .superRefine((entry, ctx) => {
    if (entry.operation === "recall_snapshot" && !entry.snapshot_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot_name"],
        message: "recall_snapshot requires snapshot_name",
      });
    }
    if (entry.operation === "recall_cue" && !entry.cue_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cue_name"],
        message: "recall_cue requires cue_name",
      });
    }
  });
export type MixerSceneCatalogEntry = z.infer<typeof MixerSceneCatalogEntrySchema>;

/**
 * A trusted venue manifest. `policy_hash` is the operator-attested hash of the
 * catalog body; the loader re-derives the canonical hash and refuses to load if
 * it drifts, so a changed catalog is detected deterministically and hard-blocks.
 */
export const MixerSceneManifestSchema = z.object({
  venue: NonEmptyString,
  catalog_version: NonEmptyString,
  /** Operator-declared hash of the canonical catalog body. */
  policy_hash: NonEmptyString,
  scenes: z.array(MixerSceneCatalogEntrySchema).min(1),
});
export type MixerSceneManifest = z.infer<typeof MixerSceneManifestSchema>;

export type LoadMixerSceneManifestResult =
  | { ok: true; manifest: MixerSceneManifest; catalog_hash: string }
  | { ok: false; issues: string[] };

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

/**
 * Deterministic catalog hash over the scene bodies (not the declared
 * `policy_hash`). Stable key ordering makes it reproducible offline so any
 * mutation of the armable scene set changes the hash.
 */
export function computeMixerCatalogHash(scenes: readonly MixerSceneCatalogEntry[]): string {
  const canonical = scenes
    .map((scene) => MixerSceneCatalogEntrySchema.parse(scene))
    .map((scene) => ({
      scene_id: scene.scene_id,
      label: scene.label,
      adapter_target: scene.adapter_target,
      operation: scene.operation,
      show_name: scene.show_name,
      snapshot_name: scene.snapshot_name ?? null,
      cue_name: scene.cue_name ?? null,
      allowed_setlist_sections: [...scene.allowed_setlist_sections].sort(),
      last_validated_at: scene.last_validated_at,
      rollback_target: scene.rollback_target,
      safety_notes: scene.safety_notes,
      forbidden_delta_check: {
        excludes_all_forbidden: scene.forbidden_delta_check.excludes_all_forbidden,
        verified: [...scene.forbidden_delta_check.verified].sort(),
        evidence: scene.forbidden_delta_check.evidence ?? null,
      },
    }))
    .sort((a, b) => a.scene_id.localeCompare(b.scene_id));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** True only when the scene proves it excludes EVERY forbidden mixer delta. */
export function sceneExcludesAllForbiddenDeltas(entry: MixerSceneCatalogEntry): boolean {
  const check = entry.forbidden_delta_check;
  if (!check.excludes_all_forbidden) return false;
  const verified = new Set(check.verified);
  return ALL_FORBIDDEN_DELTAS.every((delta) => verified.has(delta));
}

/**
 * Validate + load a manifest. Re-derives the canonical catalog hash and refuses
 * to load when the declared `policy_hash` drifts from it — a changed catalog is
 * a hard error, never silently armed.
 */
export function loadMixerSceneManifest(raw: unknown): LoadMixerSceneManifestResult {
  const parsed = MixerSceneManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(formatIssue) };
  }

  const ids = new Set<string>();
  for (const scene of parsed.data.scenes) {
    if (ids.has(scene.scene_id)) {
      return { ok: false, issues: [`duplicate scene_id ${scene.scene_id}`] };
    }
    ids.add(scene.scene_id);
  }

  const catalogHash = computeMixerCatalogHash(parsed.data.scenes);
  if (catalogHash !== parsed.data.policy_hash) {
    return {
      ok: false,
      issues: [
        `catalog hash mismatch: declared ${parsed.data.policy_hash} but computed ${catalogHash}`,
      ],
    };
  }

  return { ok: true, manifest: parsed.data, catalog_hash: catalogHash };
}

export function findMixerScene(
  manifest: MixerSceneManifest,
  sceneId: string,
): MixerSceneCatalogEntry | undefined {
  return manifest.scenes.find((scene) => scene.scene_id === sceneId);
}

/**
 * Built-in demo manifest used by offline tests/CLI examples. Mirrors the
 * approved dry-run plan in the spec ("AI Party Demo" / "Band A Intro"). The
 * declared `policy_hash` is the canonical hash of its own scene bodies.
 */
const DEMO_SCENES: MixerSceneCatalogEntry[] = [
  MixerSceneCatalogEntrySchema.parse({
    scene_id: "band_a_intro",
    label: "Band A Intro",
    adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
    operation: "recall_snapshot",
    show_name: "AI Party Demo",
    snapshot_name: "Band A Intro",
    allowed_setlist_sections: ["band_a_intro", "warmup"],
    last_validated_at: "2026-06-03T18:00:00.000Z",
    rollback_target: "house_default",
    safety_notes:
      "Recalls FX/scene only. No gain, mute, routing, or phantom changes. Bench-validated.",
    forbidden_delta_check: {
      excludes_all_forbidden: true,
      verified: [
        "gain",
        "pa_mute",
        "routing",
        "patch",
        "channel_strip",
        "mute_group",
        "phantom_power",
      ],
      evidence: "Snapshot diff exported 2026-06-03; touches FX returns only.",
    },
  }),
  MixerSceneCatalogEntrySchema.parse({
    scene_id: "house_default",
    label: "House Default",
    adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
    operation: "recall_show",
    show_name: "AI Party Demo",
    allowed_setlist_sections: ["doors", "warmup", "closing"],
    last_validated_at: "2026-06-03T18:00:00.000Z",
    rollback_target: "house_default",
    safety_notes: "Neutral house show. Operator-recoverable baseline. Bench-validated.",
    forbidden_delta_check: {
      excludes_all_forbidden: true,
      verified: [
        "gain",
        "pa_mute",
        "routing",
        "patch",
        "channel_strip",
        "mute_group",
        "phantom_power",
      ],
      evidence: "Show recall verified to leave input gains and routing untouched.",
    },
  }),
];

export const DEMO_MIXER_SCENE_MANIFEST: MixerSceneManifest = MixerSceneManifestSchema.parse({
  venue: "AI Party Demo Venue",
  catalog_version: "2026-06-04",
  policy_hash: computeMixerCatalogHash(DEMO_SCENES),
  scenes: DEMO_SCENES,
});

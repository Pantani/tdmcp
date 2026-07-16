import { z } from "zod";
import {
  type CanonicalPlacement,
  MAX_EXPLICIT_PLACEMENTS,
  MAX_SELECTION_PLACEMENTS,
  normalizedTdPathSchema,
  placementTupleSchema,
  type RepositionContextRequest,
  type RepositionRequest,
  repositionContextSchema,
  repositionRequestSchema,
} from "../td-client/editorPlacementValidators.js";

export {
  type CanonicalPlacement,
  canonicalPlacementSchema,
  MAX_EXPLICIT_PLACEMENTS,
  MAX_PLACEMENT_COORDINATE,
  MAX_SELECTION_PLACEMENTS,
  normalizedTdPathSchema,
  placementCoordinateSchema,
  placementTupleSchema,
  type RepositionContext,
  type RepositionContextRequest,
  type RepositionFailureReceipt,
  type RepositionReceipt,
  type RepositionRequest,
  repositionContextNodeSchema,
  repositionContextRequestSchema,
  repositionContextSchema,
  repositionEditorContextSchema,
  repositionFailureReceiptSchema,
  repositionReceiptSchema,
  repositionRequestSchema,
} from "../td-client/editorPlacementValidators.js";

export const explicitPositionsSchema = z
  .record(normalizedTdPathSchema, placementTupleSchema)
  .superRefine((positions, refineCtx) => {
    const count = Object.keys(positions).length;
    if (count < 1 || count > MAX_EXPLICIT_PLACEMENTS) {
      refineCtx.addIssue({
        code: "custom",
        message: `positions supports 1 to ${MAX_EXPLICIT_PLACEMENTS} operators`,
      });
    }
  });

export const explicitPlacementOptionsSchema = z
  .object({
    root_path: normalizedTdPathSchema,
    positions: explicitPositionsSchema,
    target_source: z.enum(["provided_paths", "active_selection"]).default("provided_paths"),
    include_docked: z.boolean().default(true),
    idempotency_key: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()
  .superRefine((value, refineCtx) => {
    const paths = Object.keys(value.positions);
    if (paths.includes("/")) {
      refineCtx.addIssue({
        code: "custom",
        path: ["positions"],
        message: "The TouchDesigner root cannot be repositioned.",
      });
    }
    if (value.target_source === "active_selection" && paths.length > MAX_SELECTION_PLACEMENTS) {
      refineCtx.addIssue({
        code: "custom",
        path: ["positions"],
        message: `active_selection supports at most ${MAX_SELECTION_PLACEMENTS} operators`,
      });
    }
  });

export type ExplicitPlacementOptions = z.input<typeof explicitPlacementOptionsSchema>;

function comparePaths(left: CanonicalPlacement, right: CanonicalPlacement): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function canonicalizeExplicitPlacement(
  unvalidated: ExplicitPlacementOptions,
): RepositionContextRequest & { idempotency_key: string } {
  const parsed = explicitPlacementOptionsSchema.parse(unvalidated);
  const positions = Object.entries(parsed.positions)
    .map(([path, [x, y]]) => ({ path, x, y }))
    .sort(comparePaths);
  return {
    root_path: parsed.root_path,
    target_source: parsed.target_source,
    include_docked: parsed.include_docked,
    positions,
    idempotency_key: parsed.idempotency_key,
  };
}

export function buildRepositionRequest(
  canonical: RepositionContextRequest & { idempotency_key: string },
  unvalidatedContext: unknown,
): RepositionRequest {
  const context = repositionContextSchema.parse(unvalidatedContext);
  if (
    context.root_path !== canonical.root_path ||
    context.target_source !== canonical.target_source ||
    context.include_docked !== canonical.include_docked
  ) {
    throw new Error("The reposition context does not match the canonical request.");
  }
  const requestedPaths = canonical.positions.map(({ path }) => path);
  if (
    requestedPaths.length !== context.requested_paths.length ||
    requestedPaths.some((path, index) => path !== context.requested_paths[index])
  ) {
    throw new Error("The reposition context path set does not match the canonical request.");
  }
  return repositionRequestSchema.parse({
    root_path: canonical.root_path,
    target_source: canonical.target_source,
    include_docked: canonical.include_docked,
    positions: canonical.positions,
    fingerprint: context.fingerprint,
    editor_context: context.editor_context,
    idempotency_key: canonical.idempotency_key,
  });
}

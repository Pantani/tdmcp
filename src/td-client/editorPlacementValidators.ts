import { z } from "zod";

export const MAX_EXPLICIT_PLACEMENTS = 256;
export const MAX_SELECTION_PLACEMENTS = 64;
export const MAX_PLACEMENT_COORDINATE = 1_000_000;

export const normalizedTdPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => {
    if (!value.startsWith("/") || /[\0\r\n]/.test(value)) return false;
    if (value !== "/" && value.endsWith("/")) return false;
    const parts = value.split("/").slice(1);
    return value === "/" || parts.every((part) => part !== "" && part !== "." && part !== "..");
  }, "Operator paths must be normalized absolute TouchDesigner paths.");

export const placementCoordinateSchema = z
  .number()
  .int()
  .safe()
  .min(-MAX_PLACEMENT_COORDINATE)
  .max(MAX_PLACEMENT_COORDINATE);

export const placementTupleSchema = z.tuple([placementCoordinateSchema, placementCoordinateSchema]);

export const canonicalPlacementSchema = z
  .object({
    path: normalizedTdPathSchema.refine((value) => value !== "/"),
    x: placementCoordinateSchema,
    y: placementCoordinateSchema,
  })
  .strict();

export const repositionEditorContextSchema = z
  .object({
    owner_path: normalizedTdPathSchema,
    current_path: normalizedTdPathSchema,
    selected_paths: z.array(normalizedTdPathSchema).min(1).max(MAX_SELECTION_PLACEMENTS),
  })
  .strict();

export const repositionContextRequestSchema = z
  .object({
    root_path: normalizedTdPathSchema,
    target_source: z.enum(["provided_paths", "active_selection"]),
    include_docked: z.boolean(),
    positions: z.array(canonicalPlacementSchema).min(1).max(MAX_EXPLICIT_PLACEMENTS),
  })
  .strict();

export const repositionContextNodeSchema = z
  .object({
    path: normalizedTdPathSchema,
    position: placementTupleSchema,
    host_path: normalizedTdPathSchema.optional(),
    source: z.enum(["explicit", "docked_carry"]),
  })
  .strict();

export const repositionContextSchema = z
  .object({
    root_path: normalizedTdPathSchema,
    target_source: z.enum(["provided_paths", "active_selection"]),
    include_docked: z.boolean(),
    requested_paths: z.array(normalizedTdPathSchema).min(1).max(MAX_EXPLICIT_PLACEMENTS),
    nodes: z.array(repositionContextNodeSchema).min(1).max(1_024),
    editor_context: repositionEditorContextSchema.nullable(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const repositionRequestSchema = repositionContextRequestSchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  editor_context: repositionEditorContextSchema.nullable(),
  idempotency_key: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

const repositionPathResultSchema = z
  .object({
    path: normalizedTdPathSchema,
    source: z.enum(["explicit", "docked_carry"]),
    host_path: normalizedTdPathSchema.optional(),
    requested: placementTupleSchema,
    previous: placementTupleSchema,
    final: placementTupleSchema,
    status: z.enum(["applied", "unchanged"]),
  })
  .strict();

const repositionCountsSchema = z
  .object({
    explicit: z.number().int().min(1).max(MAX_EXPLICIT_PLACEMENTS),
    docked_carried: z.number().int().min(0).max(1_024),
    applied: z.number().int().min(0).max(1_024),
    unchanged: z.number().int().min(0).max(1_024),
    failed: z.literal(0),
  })
  .strict();

export const repositionReceiptSchema = z
  .object({
    mode: z.literal("explicit"),
    status: z.enum(["applied", "unchanged", "replayed"]),
    idempotency_key: z.string().min(16).max(128),
    root_path: normalizedTdPathSchema,
    target_source: z.enum(["provided_paths", "active_selection"]),
    fingerprint_before: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint_after: z.string().regex(/^[a-f0-9]{64}$/),
    editor_context: repositionEditorContextSchema.optional(),
    paths: z.array(repositionPathResultSchema).min(1).max(1_024),
    counts: repositionCountsSchema,
    rollback: z
      .object({
        attempted: z.literal(false),
        succeeded: z.literal(true),
        errors: z.tuple([]),
      })
      .strict(),
    warnings: z.array(z.string().max(160)).max(64),
    undo_label: z.string().max(256).optional(),
    undo_wrapper_label: z.string().max(256).optional(),
  })
  .strict();

const repositionFailurePathSchema = repositionPathResultSchema.omit({ status: true }).extend({
  status: z.enum(["failed", "unchanged"]),
  rollback: z.enum(["restored", "failed", "not_needed"]),
});

export const repositionFailureReceiptSchema = z
  .object({
    mode: z.literal("explicit"),
    status: z.literal("failed"),
    idempotency_key: z.string().min(16).max(128),
    root_path: normalizedTdPathSchema,
    target_source: z.enum(["provided_paths", "active_selection"]),
    paths: z.array(repositionFailurePathSchema).max(1_024),
    counts: z
      .object({
        explicit: z.number().int().min(1).max(MAX_EXPLICIT_PLACEMENTS),
        docked_carried: z.number().int().min(0).max(1_024),
        applied: z.literal(0),
        unchanged: z.number().int().min(0).max(1_024),
        failed: z.number().int().min(1).max(1_024),
      })
      .strict(),
    rollback: z
      .object({
        attempted: z.literal(true),
        succeeded: z.boolean(),
        errors: z
          .array(
            z
              .object({
                path: normalizedTdPathSchema,
                message: z.string().max(160),
              })
              .strict(),
          )
          .max(64),
      })
      .strict(),
    error: z
      .object({
        code: z.string().min(1).max(64),
        message: z.string().min(1).max(160),
      })
      .strict(),
    warnings: z.array(z.string().max(160)).max(64),
  })
  .strict();

export type CanonicalPlacement = z.infer<typeof canonicalPlacementSchema>;
export type RepositionContextRequest = z.infer<typeof repositionContextRequestSchema>;
export type RepositionContext = z.infer<typeof repositionContextSchema>;
export type RepositionRequest = z.infer<typeof repositionRequestSchema>;
export type RepositionReceipt = z.infer<typeof repositionReceiptSchema>;
export type RepositionFailureReceipt = z.infer<typeof repositionFailureReceiptSchema>;

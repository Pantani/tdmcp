import { z } from "zod";

/** Standard response envelope every bridge endpoint returns. */
export const ApiEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string() }).optional(),
});
export type ApiEnvelope = z.infer<typeof ApiEnvelopeSchema>;

export const NodeRefSchema = z.object({
  path: z.string(),
  type: z.string().default(""),
  name: z.string().default(""),
  /** Stable runtime operator identity when the bridge can expose it. */
  operator_id: z.string().optional(),
  /** Parameters that could not be applied at create time (unknown name or bad value). */
  parameter_warnings: z.array(z.string()).optional(),
  /** True when an identically-named+typed operator already existed and was reused (idempotent create). */
  already_existed: z.boolean().optional(),
  nodeX: z.number().optional(),
  nodeY: z.number().optional(),
  viewer: z.boolean().optional(),
});
export type TdNodeRef = z.infer<typeof NodeRefSchema>;

/** Operator flags reported in a node detail (all optional; family-dependent). */
export const NodeFlagsSchema = z.object({
  bypass: z.boolean().optional(),
  render: z.boolean().optional(),
  display: z.boolean().optional(),
  lock: z.boolean().optional(),
  allowCooking: z.boolean().optional(),
  cloneImmune: z.boolean().optional(),
  is_clone: z.boolean().optional(),
  clone: z.string().nullable().optional(),
});
export type TdNodeFlags = z.infer<typeof NodeFlagsSchema>;

/** One index-aware input wire on a node: which slot, from which op's output. */
export const NodeWireSchema = z.object({
  in_index: z.number().int().nullable(),
  from: z.string(),
  out_index: z.number().int(),
});
export type TdNodeWire = z.infer<typeof NodeWireSchema>;

export const NodeDetailSchema = NodeRefSchema.extend({
  parameters: z.record(z.string(), z.unknown()).default({}),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  family: z.string().optional(),
  errors: z.array(z.string()).optional(),
  // --- NEW (node_flags_in_detail): cosmetic + behavioral signals for a faithful round-trip ---
  flags: NodeFlagsSchema.optional(),
  wires_in: z.array(NodeWireSchema).optional(),
  nodeX: z.number().optional(),
  nodeY: z.number().optional(),
  comment: z.string().optional(),
  color: z.array(z.number()).optional(),
  tags: z.array(z.string()).optional(),
});
export type TdNodeDetail = z.infer<typeof NodeDetailSchema>;

export const NodeListSchema = z.object({ nodes: z.array(NodeRefSchema).default([]) });
export type TdNodeList = z.infer<typeof NodeListSchema>;

export const TdOperatorFamilySchema = z.enum(["TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP"]);
export type TdOperatorFamily = z.infer<typeof TdOperatorFamilySchema>;

export const NodeSearchHitSchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.string(),
  family: TdOperatorFamilySchema,
});
export type TdNodeSearchHit = z.infer<typeof NodeSearchHitSchema>;

export const BoundedSearchMetadataSchema = z.object({
  scanned: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  scan_truncated: z.boolean(),
  count_complete: z.boolean(),
  stop_reason: z.enum(["completed", "node_scan_limit", "parameter_scan_limit", "time_limit"]),
});
export type TdBoundedSearchMetadata = z.infer<typeof BoundedSearchMetadataSchema>;

export const NodeSearchResultSchema = z.object({
  root: z.string(),
  nodes: z.array(NodeSearchHitSchema),
  metadata: BoundedSearchMetadataSchema,
});
export type TdNodeSearchResult = z.infer<typeof NodeSearchResultSchema>;

export const ParameterSearchModeSchema = z.enum([
  "CONSTANT",
  "EXPRESSION",
  "EXPORT",
  "BIND",
  "UNKNOWN",
]);
export type TdParameterSearchMode = z.infer<typeof ParameterSearchModeSchema>;

export const ParameterSearchHitSchema = z.object({
  op: z.string(),
  type: z.string(),
  family: z.enum(["TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP", "UNKNOWN"]),
  par: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  expr: z.string().optional(),
  mode: ParameterSearchModeSchema,
  non_default: z.boolean(),
  redacted: z.literal(true).optional(),
  value_truncated: z.literal(true).optional(),
  expr_truncated: z.literal(true).optional(),
});
export type TdParameterSearchHit = z.infer<typeof ParameterSearchHitSchema>;

export const ParameterSearchResultSchema = z.object({
  root_path: z.string(),
  max_depth: z.number().int().min(1).max(32),
  results: z.array(ParameterSearchHitSchema),
  scanned_nodes: z.number().int().nonnegative(),
  scanned_parameters: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200),
  truncated: z.boolean(),
  scan_truncated: z.boolean(),
  count_complete: z.boolean(),
  unreadable_parameters: z.number().int().nonnegative(),
  skipped_parameters: z.number().int().nonnegative(),
  redacted_parameters: z.number().int().nonnegative(),
  stop_reason: z.enum(["completed", "node_scan_limit", "parameter_scan_limit", "time_limit"]),
  elapsed_ms: z.number().int().nonnegative(),
});
export type TdParameterSearchResult = z.infer<typeof ParameterSearchResultSchema>;

export const InfoSchema = z.object({
  td_version: z.string().optional(),
  python_version: z.string().optional(),
  build: z.string().optional(),
  bridge_version: z.string().optional(),
  project: z.string().optional(),
});
export type TdInfo = z.infer<typeof InfoSchema>;

export const HealthSchema = z.object({
  state: z.string(),
  status: z.string().optional(),
  timestamp: z.string().optional(),
  started_at: z.string().optional(),
  uptime_seconds: z.number().optional(),
  heartbeat: z
    .object({
      last_seen_at: z.string().nullable().optional(),
      age_seconds: z.number().nullable().optional(),
      stale: z.boolean().optional(),
      stale_after_seconds: z.number().optional(),
    })
    .optional(),
  performance: z
    .object({
      available: z.boolean().default(false),
      cook_time_ms: z.number().nullable().optional(),
      cook_count: z.number().int().nullable().optional(),
      cook_frame: z.number().int().nullable().optional(),
      dropped_frames: z.number().int().nullable().optional(),
      fps: z.number().nullable().optional(),
      gpu_memory_mb: z.number().nullable().optional(),
      gpu_memory_total_mb: z.number().nullable().optional(),
      gpu_memory_free_mb: z.number().nullable().optional(),
    })
    .optional(),
  degraded_signals: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  touchdesigner: InfoSchema.optional(),
});
export type TdHealth = z.infer<typeof HealthSchema>;

export const NodeErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
  type: z.string().optional(),
});
export type TdNodeError = z.infer<typeof NodeErrorSchema>;

export const NodeErrorsSchema = z.object({ errors: z.array(NodeErrorSchema).default([]) });
export type TdNodeErrors = z.infer<typeof NodeErrorsSchema>;

export const PreviewSchema = z.object({
  path: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.string().default("png"),
  base64: z.string(),
});
export type TdPreview = z.infer<typeof PreviewSchema>;

/** One channel's summary over the sampled grid; null when every sample was NaN/Inf. */
const ChannelStatSchema = z.object({
  min: z.number().nullable(),
  max: z.number().nullable(),
  mean: z.number().nullable(),
});

/** Cheap N×N RGBA sampling of a TOP: samples[row][col] = [r,g,b,a] with NaN/Inf → null. */
export const SampleGridSchema = z.object({
  path: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  grid: z.number().int().positive(),
  samples: z.array(z.array(z.array(z.number().nullable()))),
  stats: z.object({
    r: ChannelStatSchema,
    g: ChannelStatSchema,
    b: ChannelStatSchema,
    a: ChannelStatSchema,
  }),
});
export type TdSampleGrid = z.infer<typeof SampleGridSchema>;

/** Returned when a capture was deferred by delay_frames; collect it later by job_id. */
export const CapturingJobSchema = z.object({
  status: z.literal("capturing"),
  job_id: z.string(),
  delay_frames: z.number().int().nonnegative(),
  wait_ms: z.number().int().nonnegative(),
});
export type TdCapturingJob = z.infer<typeof CapturingJobSchema>;

/** Advanced capture result: an image, a sample grid, or a deferred-job ticket. */
export const AdvancedCaptureSchema = z.union([CapturingJobSchema, SampleGridSchema, PreviewSchema]);
export type TdAdvancedCapture = z.infer<typeof AdvancedCaptureSchema>;

/** Result of collecting a deferred capture job. */
export const PreviewJobSchema = z.object({
  status: z.enum(["pending", "ready", "error", "expired"]),
  job_id: z.string(),
  preview: z.union([PreviewSchema, SampleGridSchema]).optional(),
  error: z.string().optional(),
});
export type TdPreviewJob = z.infer<typeof PreviewJobSchema>;

/** Result of pointing the Network Editor at some operators (a UI-only follow move). */
const EditorFocusSnapshotSchema = z.object({
  owner: z.string().nullable(),
  current: z.string().nullable(),
  selected: z.array(z.string()).default([]),
  viewport: z
    .object({ x: z.number().optional(), y: z.number().optional(), zoom: z.number().optional() })
    .nullable(),
});

export const EditorFocusSchema = z
  .object({
    operation_id: z.string().optional(),
    status: z
      .enum(["scheduled", "applied", "suppressed", "cancelled", "failed", "expired"])
      .optional(),
    action: z.enum(["create", "edit", "inspect", "view", "layout", "delete"]).optional(),
    animate: z.boolean().default(true),
    requested_paths: z.array(z.string()).default([]),
    resolved_paths: z.array(z.string()).default([]),
    missing_paths: z.array(z.string()).default([]),
    focused: z.array(z.string()).default([]),
    pane: z.string().nullable().optional(),
    pane_strategy: z
      .enum(["owner_active", "owner_existing", "active", "first_compatible"])
      .nullable()
      .optional(),
    framing: z
      .object({
        requested: z.enum(["auto", "selection", "owner", "none"]),
        applied: z.enum(["selection", "owner", "none"]).nullable(),
        animation: z.enum(["scheduled", "stepped", "instant", "none"]).nullable(),
      })
      .optional(),
    previous: EditorFocusSnapshotSchema.nullable().optional(),
    final: EditorFocusSnapshotSchema.nullable().optional(),
    suppression_reason: z
      .enum([
        "follow_disabled",
        "perform_mode",
        "ui_unavailable",
        "no_network_editor",
        "target_not_found",
        "different_parents",
        "superseded",
      ])
      .nullable()
      .optional(),
    highlight: z
      .object({
        status: z.literal("held"),
        token: z.null(),
        reason: z.string(),
      })
      .optional(),
    warnings: z.array(z.string()).default([]),
    undo_label: z.null().optional(),
  })
  .superRefine((receipt, ctx) => {
    if (receipt.status === "applied" && receipt.final == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["final"],
        message: "Applied editor follow requires final UI readback.",
      });
    }
  });
export type TdEditorFocus = z.infer<typeof EditorFocusSchema>;

const EditorInsertEdgeSchema = z
  .object({
    from_path: z.string(),
    out_index: z.number().int().nonnegative(),
    to_path: z.string(),
    in_index: z.number().int().nonnegative(),
  })
  .strict();

export const EditorInsertResultSchema = z
  .object({
    status: z.enum(["applied", "replayed"]),
    idempotency_key: z.string().min(16).max(128),
    context: z
      .object({
        owner_path: z.string(),
        selected_path: z.string(),
        current_path: z.string(),
      })
      .strict(),
    node: z
      .object({
        path: z.string(),
        type: z.string(),
        name: z.string(),
        nodeX: z.number().int(),
        nodeY: z.number().int(),
        viewer: z.boolean().optional(),
      })
      .strict(),
    before: z.object({ edges: z.array(EditorInsertEdgeSchema).max(128) }).strict(),
    after: z.object({ edges: z.array(EditorInsertEdgeSchema).max(128) }).strict(),
    rollback: z.object({ attempted: z.boolean(), succeeded: z.boolean() }).strict(),
    warnings: z.array(z.string()).max(64),
    undo_label: z.string().max(256).optional(),
  })
  .strict();
export type TdEditorInsertResult = z.infer<typeof EditorInsertResultSchema>;

export const ExecResultSchema = z.object({
  result: z.unknown().optional(),
  stdout: z.string().optional(),
  printed: z.array(z.string()).optional(),
});
export type TdExecResult = z.infer<typeof ExecResultSchema>;

export const MethodResultSchema = z.object({ result: z.unknown() });
export type TdMethodResult = z.infer<typeof MethodResultSchema>;

export const DeleteResultSchema = z.object({
  deleted: z.string().optional(),
  bypassed: z.string().optional(),
  mode: z.enum(["delete", "bypass"]).default("delete"),
  decision: z.enum(["Delete", "Bypass", "Keep"]),
  original_path: z.string(),
  final_path: z.string().nullable(),
  action_applied: z.enum(["delete", "bypass", "keep"]),
  applied: z.boolean(),
  request_id: z.string().nullable().optional(),
  confirmation_policy: z.enum(["native", "yolo", "explicit_mode"]),
  undo_label: z.string().optional(),
});
export type TdDeleteResult = z.infer<typeof DeleteResultSchema>;

export const InteractionStateSchema = z.enum([
  "pending",
  "resolved",
  "expired",
  "cancelled",
  "failed",
]);
export const InteractionStatusSchema = z.object({
  request_id: z.string(),
  kind: z.enum([
    "delete_node",
    "save_overwrite",
    "artifact_overwrite",
    "oauth_client_consent",
    "visual_parameter_apply",
  ]),
  state: InteractionStateSchema,
  choices: z.array(z.string()),
  created_at: z.number(),
  expires_at: z.number(),
  consumed: z.boolean(),
  result: z.object({ choice: z.string(), reason: z.string(), at: z.number() }).nullable(),
  accepted: z.boolean().optional(),
  deduplicated: z.boolean().optional(),
});
export type TdInteractionStatus = z.infer<typeof InteractionStatusSchema>;

const VisualParameterTargetSchema = z
  .object({
    id: z.string().regex(/^t[1-6]$/),
    path: z.string().min(1).max(240),
    parameter: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    type: z.enum(["Float", "Int"]),
    mode: z.literal("CONSTANT"),
    value: z.number().finite(),
    minimum: z.number().finite(),
    maximum: z.number().finite(),
  })
  .strict();

export const VisualParameterInspectionSchema = z
  .object({
    scope_path: z.string().min(1).max(240),
    output_top_path: z.string().min(1).max(240),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    targets: z.array(VisualParameterTargetSchema).min(1).max(6),
  })
  .strict();
export type TdVisualParameterInspection = z.infer<typeof VisualParameterInspectionSchema>;

const VisualUndoFields = {
  replayed: z.boolean(),
  undo_label: z.string().max(256).optional(),
  undo_wrapper_label: z.string().max(256).optional(),
};

export const VisualParameterCommitSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("conflict"),
      reason: z.string().max(64).optional(),
      ...VisualUndoFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.string().max(64).optional(),
      ...VisualUndoFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("committed"),
      applied: z.literal(true),
      verified: z.literal(true),
      final_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      restore_token: z.string().min(43).max(128),
      readback: z
        .array(
          z
            .object({
              target_id: z.string().regex(/^t[1-6]$/),
              value: z.number().finite(),
            })
            .strict(),
        )
        .min(1)
        .max(3),
      ...VisualUndoFields,
    })
    .strict(),
]);
export type TdVisualParameterCommit = z.infer<typeof VisualParameterCommitSchema>;

export const VisualParameterRestoreSchema = z
  .object({
    restored: z.boolean(),
    verified: z.boolean(),
    restored_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reason: z.string().max(64).nullable().optional(),
    ...VisualUndoFields,
  })
  .strict();
export type TdVisualParameterRestore = z.infer<typeof VisualParameterRestoreSchema>;

export const OAuthConsentConsumeSchema = z.object({
  request_id: z.string(),
  state: InteractionStateSchema,
  accepted: z.boolean(),
  decision: z.enum(["Allow", "Deny"]),
  error: z.string().nullable().optional(),
});
export type TdOAuthConsentConsume = z.infer<typeof OAuthConsentConsumeSchema>;

export const InteractionSummarySchema = z
  .object({
    pending_count: z.number().int().nonnegative(),
    pending_limit: z.number().int().positive(),
    active: z.boolean(),
    delivery_configured: z.boolean(),
  })
  .strict();
export type TdInteractionSummary = z.infer<typeof InteractionSummarySchema>;

const NullableTextSchema = z.string().nullable().optional();
const NullableNumberOrTextSchema = z.union([z.number(), z.string()]).nullable().optional();
export const EditorContextSchema = z.object({
  project: z.object({
    name: NullableTextSchema,
    folder: NullableTextSchema,
    save_version: NullableNumberOrTextSchema,
    save_build: NullableNumberOrTextSchema,
  }),
  touchdesigner: z.object({
    build: NullableNumberOrTextSchema,
    version: NullableNumberOrTextSchema,
  }),
  perform_mode: z.boolean().nullable(),
  ui_available: z.boolean(),
  panes: z.array(
    z.object({
      type: NullableTextSchema,
      active: z.boolean(),
      name: z.string().optional(),
      owner: z.string().optional(),
    }),
  ),
  active_network_editor: z
    .object({
      pane: z.record(z.string(), z.unknown()),
      owner: z.string().nullable(),
      current: z.string().nullable(),
      selected: z.array(z.string()),
      rollover_operator: z.string().nullable(),
      rollover_parameter: z.object({ name: z.string(), owner: z.string().optional() }).nullable(),
      viewport: z
        .object({ x: z.number().optional(), y: z.number().optional(), zoom: z.number().optional() })
        .nullable(),
    })
    .nullable(),
  warnings: z.array(z.string()),
});
export type TdEditorContext = z.infer<typeof EditorContextSchema>;

export const ProjectSaveResultSchema = z.object({
  requested_path: z.string().nullable().optional(),
  final_path: z.string().nullable(),
  decision: z.string(),
  verified_exists: z.boolean(),
  saved: z.boolean(),
  action_applied: z.boolean(),
  request_id: z.string().optional(),
  project: z.record(z.string(), z.unknown()).optional(),
});
export type TdProjectSaveResult = z.infer<typeof ProjectSaveResultSchema>;

export const ToxExportPhaseSchema = z.object({
  name: z.string(),
  status: z.enum(["pending", "pass", "fail"]),
  duration_ms: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export const ToxExportResultSchema = z.object({
  operation_id: z.string(),
  status: z.enum([
    "queued",
    "snapshotting",
    "sanitizing",
    "saving",
    "restoring",
    "verifying",
    "promoting",
    "cancel_requested",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ]),
  verdict: z.enum(["PASS", "FAIL", "UNVERIFIED"]).nullable().optional(),
  source_path: z.string().optional(),
  target_path: z.string().optional(),
  mode: z.enum(["as_is", "portable"]).optional(),
  decision: z.enum(["Overwrite", "Keep", "not_required"]).optional(),
  interaction_id: z.string().nullable().optional(),
  action_applied: z.boolean(),
  phases: z.array(ToxExportPhaseSchema).default([]),
  live_state: z
    .object({
      snapshot_count: z.number().int().nonnegative(),
      restored: z.boolean(),
      verified: z.boolean(),
    })
    .optional(),
  cleanup: z.object({ temp_removed: z.boolean(), pending: z.boolean() }).optional(),
  verification: z
    .object({
      level: z.string(),
      portable_links_at_save: z.number().int().nonnegative().nullable().optional(),
    })
    .optional(),
  artifact: z
    .object({
      path: z.string(),
      size_bytes: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      td_build: z.union([z.string(), z.number()]).nullable().optional(),
      td_version: z.union([z.string(), z.number()]).nullable().optional(),
    })
    .nullable()
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
  deduplicated: z.boolean().optional(),
  accepted: z.boolean().optional(),
  idempotency_key: z.string().optional(),
});
export type TdToxExportResult = z.infer<typeof ToxExportResultSchema>;

const ToxRoundtripCheckSchema = z.object({
  name: z.enum([
    "artifact_hash",
    "load",
    "root_type",
    "node_bounds",
    "node_count",
    "type_counts",
    "custom_parameters",
    "connectors",
    "external_references",
    "cook_errors",
    "cleanup",
  ]),
  verdict: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
  code: z.string().max(64),
  summary: z.string().max(256),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

export const ToxRoundtripResultSchema = z.object({
  operation_id: z.string().min(16).max(128),
  status: z.enum([
    "queued",
    "hashing",
    "loading",
    "settling",
    "inspecting",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ]),
  verdict: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
  artifact: z
    .object({
      path: z.string().max(4096),
      size_bytes: z
        .number()
        .int()
        .min(0)
        .max(256 * 1024 * 1024),
      sha256: z.string().max(64),
    })
    .partial(),
  runtime: z.object({
    td_version: z.string().max(64).optional(),
    td_build: z.union([z.string().max(64), z.number().int()]).optional(),
    frames_waited: z.number().int().min(0).max(120),
  }),
  observed: z
    .object({
      root_type: z.string().max(128).optional(),
      node_count: z.number().int().min(0).max(2000).optional(),
      type_counts: z.record(z.string(), z.number().int()).optional(),
      custom_parameters: z
        .array(
          z.object({
            page: z.string().max(128),
            name: z.string().max(128),
            style: z.string().max(128),
          }),
        )
        .max(256)
        .optional(),
      connectors: z.object({ inputs: z.number().int(), outputs: z.number().int() }).optional(),
      external_references: z
        .object({
          total: z.number().int().nonnegative(),
          classifications: z.record(z.string(), z.number().int().nonnegative()),
          fingerprints: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(200),
          truncated: z.boolean(),
        })
        .optional(),
      cook_error_count: z.number().int().nonnegative().optional(),
      cook_errors: z.array(z.string().max(256)).max(100).optional(),
      cook_errors_truncated: z.boolean().optional(),
    })
    .passthrough(),
  checks: z.array(ToxRoundtripCheckSchema).max(16),
  cleanup: z.object({
    attempted: z.boolean(),
    removed: z.boolean(),
    verified: z.boolean(),
    scratch_path: z.string().max(4096).nullable().optional(),
  }),
  error: z
    .object({
      code: z.string().max(64),
      phase: z.string().max(64),
      message: z.string().max(256),
      retryable: z.boolean(),
    })
    .nullable(),
});
export type TdToxRoundtripResult = z.infer<typeof ToxRoundtripResultSchema>;

const PackageClassificationSchema = z.enum([
  "aligned_owned",
  "renamed_owned",
  "missing_live",
  "foreign_target",
  "marker_missing",
  "marker_unreadable",
  "marker_mismatch",
  "duplicate_owned",
]);

export const PackageNamespacePlanSchema = z.object({
  status: z.literal("planned"),
  plan_id: z.string().min(16).max(128),
  expires_at: z.number(),
  package_id: z.string(),
  scope: z.enum(["user", "project"]),
  intent: z.enum(["prune", "replace"]),
  classification: PackageClassificationSchema,
  actionable: z.boolean(),
  resolved_target_path: z.string().nullable(),
  marker: z.object({ matched: z.boolean(), schema_version: z.number().int().nullable() }),
  candidates: z.array(
    z.object({
      path: z.string(),
      marker_status: z.enum(["match", "missing", "unreadable", "mismatch", "foreign"]),
      marker_schema_version: z.number().int().nullable(),
    }),
  ),
  warnings: z.array(z.string()),
  deduplicated: z.boolean(),
});
export type TdPackageNamespacePlan = z.infer<typeof PackageNamespacePlanSchema>;

export const PackageNamespaceApplyResultSchema = z.object({
  status: z.enum(["applied", "kept", "replayed"]),
  plan_id: z.string(),
  package_id: z.string(),
  classification: z.enum(["aligned_owned", "renamed_owned"]),
  resolved_target_path: z.string(),
  decision: z.enum(["Keep", "Bypass", "Delete"]),
  action_applied: z.enum(["keep", "bypass", "delete"]),
  final_path: z.string().nullable(),
  confirmation_policy: z.enum(["explicit_mode", "native", "yolo"]),
  request_id: z.string().nullable(),
  marker: z.object({ matched: z.literal(true), schema_version: z.number().int().nullable() }),
  warnings: z.array(z.string()),
  undo_label: z.string().optional(),
});
export type TdPackageNamespaceApplyResult = z.infer<typeof PackageNamespaceApplyResultSchema>;

export const CustomParameterLifecycleResultSchema = z.object({
  status: z.enum([
    "applied",
    "unchanged",
    "replayed",
    "held",
    "failed",
    "rolled_back",
    "partial_failure",
  ]),
  comp_path: z.string(),
  results: z.array(z.record(z.string(), z.unknown())),
  rollback: z.object({ attempted: z.boolean(), succeeded: z.boolean() }),
  warnings: z.array(z.string()),
  request_fingerprint: z.string(),
  undo_label: z.string().optional(),
  replayed: z.boolean().optional(),
  remediation: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type TdCustomParameterLifecycleResult = z.infer<typeof CustomParameterLifecycleResultSchema>;

export const PulseParameterResultSchema = z.object({
  path: z.string(),
  parameter: z.string(),
  style: z.string(),
  pulsed: z.boolean(),
  undo_label: z.string().optional(),
});
export type TdPulseParameterResult = z.infer<typeof PulseParameterResultSchema>;

export const ParameterMenuSchema = z.object({
  path: z.string(),
  parameter: z.string(),
  style: z.string(),
  names: z.array(z.string()).max(64),
  labels: z.array(z.string()).max(64),
  current: z.string().nullable(),
});
export type TdParameterMenu = z.infer<typeof ParameterMenuSchema>;

const MetadataFieldResultSchema = z.object({
  requested: z.unknown(),
  actual: z.unknown().optional(),
  status: z.string(),
  error: z.string().optional(),
});
export const EditNodeMetadataResultSchema = z.object({
  original_path: z.string(),
  final_path: z.string().nullable(),
  applied: z.boolean(),
  rolled_back: z.boolean(),
  fields: z.record(z.string(), MetadataFieldResultSchema),
  error: z.string().optional(),
  undo_label: z.string().optional(),
});
export type TdEditNodeMetadataResult = z.infer<typeof EditNodeMetadataResultSchema>;

export const AnnotationEditInputSchema = z
  .object({
    title: z.string().max(512).optional(),
    body: z.string().max(8192).optional(),
    color: z
      .tuple([
        z.number().finite().min(0).max(1),
        z.number().finite().min(0).max(1),
        z.number().finite().min(0).max(1),
        z.number().finite().min(0).max(1),
      ])
      .optional(),
    x: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    y: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    w: z.number().int().min(10).max(1_000_000).optional(),
    h: z.number().int().min(10).max(1_000_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one annotation field is required.",
  });
export type TdAnnotationEditInput = z.infer<typeof AnnotationEditInputSchema>;

const AnnotationEditFieldResultSchema = z.object({
  status: z.enum(["applied", "unchanged", "unsupported", "failed"]),
  requested: z.unknown(),
  actual: z.unknown().optional(),
  binding: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  rollback: z.enum(["not_needed", "restored", "failed"]).optional(),
});

export const AnnotationEditResultSchema = z.object({
  action: z.literal("edit"),
  original_path: z.string(),
  final_path: z.string().nullable(),
  node_type: z.string(),
  applied: z.boolean(),
  rolled_back: z.boolean(),
  fields: z.record(z.string(), AnnotationEditFieldResultSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  undo_label: z.string().optional(),
  undo_wrapper_label: z.string().optional(),
});
export type TdAnnotationEditResult = z.infer<typeof AnnotationEditResultSchema>;

const AnnotationLayoutRectSchema = z.object({
  path: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

export const AnnotationLayoutContextSchema = z.object({
  root_path: z.string(),
  recursive: z.boolean(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  networks: z
    .array(
      z.object({
        path: z.string(),
        nodes: z.array(AnnotationLayoutRectSchema).max(512),
        annotations: z
          .array(
            AnnotationLayoutRectSchema.extend({
              enclosed_paths: z.array(z.string()).max(512),
            }),
          )
          .max(64),
        docked: z.array(AnnotationLayoutRectSchema.extend({ host_path: z.string() })).max(1024),
        edges: z.array(z.object({ from: z.string(), to: z.string() })).max(4096),
      }),
    )
    .max(16),
});
export type TdAnnotationLayoutContext = z.infer<typeof AnnotationLayoutContextSchema>;

export const AnnotationLayoutApplyResultSchema = z.object({
  applied: z.boolean(),
  rolled_back: z.boolean(),
  root_path: z.string().optional(),
  fingerprint: z.string().optional(),
  moved: z.number().int().nonnegative(),
  resized_annotations: z.number().int().nonnegative(),
  networks: z.number().int().nonnegative().optional(),
  rollback_errors: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  undo_label: z.string().optional(),
  undo_wrapper_label: z.string().optional(),
});
export type TdAnnotationLayoutApplyResult = z.infer<typeof AnnotationLayoutApplyResultSchema>;

const WorkspacePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.startsWith("/") && !/[\0\r\n]/.test(value));
const WorkspaceIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const WorkspaceFingerprintSchema = z
  .object({
    pane_count: z.number().int().min(0).max(16),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const WorkspaceCleanupSchema = z
  .object({
    attempted: z.boolean(),
    owned_pane_closed: z.boolean(),
    source_restored: z.boolean(),
    baseline_verified: z.boolean(),
  })
  .strict();

function validateActiveWorkspaceReceipt(
  receipt: {
    status: string;
    source_pane: unknown;
    owned_pane: unknown;
    baseline: unknown;
    workspace: unknown;
  },
  refineCtx: z.RefinementCtx,
) {
  if (
    receipt.status === "active" &&
    (!receipt.source_pane || !receipt.owned_pane || !receipt.baseline || !receipt.workspace)
  ) {
    refineCtx.addIssue({
      code: "custom",
      message: "active requires source, owned, baseline and workspace readback",
    });
  }
}

function validateVerifiedWorkspaceCleanup(
  receipt: {
    status: string;
    cleanup: z.infer<typeof WorkspaceCleanupSchema>;
  },
  refineCtx: z.RefinementCtx,
) {
  if (receipt.status !== "restored" && receipt.status !== "expired") return;
  const cleanup = receipt.cleanup;
  if (
    cleanup.attempted &&
    cleanup.owned_pane_closed &&
    cleanup.source_restored &&
    cleanup.baseline_verified
  ) {
    return;
  }
  refineCtx.addIssue({
    code: "custom",
    message: `${receipt.status} requires verified later-frame cleanup`,
  });
}

function validateCancelledWorkspaceReceipt(
  receipt: {
    status: string;
    source_pane: unknown;
    owned_pane: unknown;
    baseline: unknown;
    workspace: unknown;
    cleanup: z.infer<typeof WorkspaceCleanupSchema>;
  },
  refineCtx: z.RefinementCtx,
) {
  if (receipt.status !== "cancelled") return;
  if (receipt.cleanup.attempted && !receipt.cleanup.baseline_verified) {
    refineCtx.addIssue({
      code: "custom",
      message: "post-apply cancelled requires verified later-frame cleanup",
    });
  }
  if (
    !receipt.cleanup.attempted &&
    (receipt.source_pane || receipt.owned_pane || receipt.baseline || receipt.workspace)
  ) {
    refineCtx.addIssue({
      code: "custom",
      message: "pre-apply cancelled cannot claim an applied workspace snapshot",
    });
  }
}

/** Strict, bounded receipt for the main-thread temporary workspace lifecycle. */
export const ArtistWorkspaceReceiptSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    action: z.enum(["open", "status", "restore", "cancel"]),
    status: z.enum([
      "scheduled",
      "active",
      "restore_scheduled",
      "cancel_scheduled",
      "cleanup_scheduled",
      "restored",
      "cancelled",
      "expired",
      "suppressed",
      "conflicted",
      "failed",
    ]),
    deduplicated: z.boolean(),
    created_at: z.number().finite().nonnegative(),
    expires_at: z.number().finite().nonnegative().nullable(),
    targets: z
      .object({
        network_path: WorkspacePathSchema.nullable(),
        viewer_path: WorkspacePathSchema.nullable(),
        viewer_mode: z.enum(["top_output", "panel_controls"]).nullable(),
        split_ratio: z.number().finite().min(0.35).max(0.75).nullable(),
      })
      .strict(),
    source_pane: z
      .object({
        id: z.number().int().nonnegative(),
        name: z.string().max(256).nullable(),
        type: z.literal("NETWORKEDITOR"),
      })
      .strict()
      .nullable(),
    owned_pane: z
      .object({
        id: z.number().int().nonnegative(),
        name: z.string().min(1).max(256),
        type: z.enum(["TOPVIEWER", "PANEL"]),
      })
      .strict()
      .nullable(),
    baseline: WorkspaceFingerprintSchema.nullable(),
    workspace: WorkspaceFingerprintSchema.nullable(),
    cleanup: WorkspaceCleanupSchema,
    reason: z
      .enum([
        "perform_mode",
        "ui_unavailable",
        "no_active_network_editor",
        "source_pane_unavailable",
        "target_not_found",
        "wrong_target_family",
        "cross_project",
        "pane_limit",
        "workspace_capacity",
        "stale_target",
        "artist_layout_changed",
        "owned_pane_missing",
        "scheduling_error",
        "apply_timeout",
        "lease_expired",
        "client_cancelled",
        "callback_error",
      ])
      .nullable(),
    warnings: z.array(z.string().max(512)).max(16),
    undo_label: z.null(),
  })
  .strict()
  .superRefine((receipt, refineCtx) => {
    validateActiveWorkspaceReceipt(receipt, refineCtx);
    validateVerifiedWorkspaceCleanup(receipt, refineCtx);
    validateCancelledWorkspaceReceipt(receipt, refineCtx);
  });
export type TdArtistWorkspaceReceipt = z.infer<typeof ArtistWorkspaceReceiptSchema>;

export type TdArtistWorkspaceRequest =
  | {
      action: "open";
      network_path: string;
      viewer_path: string;
      viewer_mode: "top_output" | "panel_controls";
      split_ratio?: number;
      lease_seconds?: number;
    }
  | { action: "status"; workspace_id: string }
  | { action: "restore" | "cancel"; workspace_id: string };

export const ConnectionSchema = z.object({
  source_path: z.string(),
  source_output: z.number().int().default(0),
  target_path: z.string(),
  target_input: z.number().int().default(0),
});
export type TdConnection = z.infer<typeof ConnectionSchema>;

export const TopologySchema = z.object({
  nodes: z.array(NodeRefSchema).default([]),
  connections: z.array(ConnectionSchema).default([]),
});
export type TdTopology = z.infer<typeof TopologySchema>;

export const PerformanceSchema = z.object({
  nodes: z
    .array(
      z.object({
        path: z.string(),
        cook_time_ms: z.number().default(0),
        cook_count: z.number().optional(),
      }),
    )
    .default([]),
  total_cook_time_ms: z.number().optional(),
  gpu_memory_mb: z.number().optional(),
});
export type TdPerformance = z.infer<typeof PerformanceSchema>;

export const BatchOpResultSchema = z.object({
  action: z.string(),
  ok: z.boolean(),
  path: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export const BatchResultSchema = z.object({ results: z.array(BatchOpResultSchema).default([]) });
export type TdBatchResult = z.infer<typeof BatchResultSchema>;

/** Input shape for creating a node (used by the client and Layer 3 tool). */
export const CreateNodeInputSchema = z
  .object({
    parent_path: z.string(),
    type: z.string(),
    name: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    placement: z.enum(["auto", "explicit"]).optional(),
    node_x: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
    node_y: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
    viewer: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.placement === "explicit" &&
      (value.node_x === undefined || value.node_y === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "placement='explicit' requires both node_x and node_y",
        path: ["placement"],
      });
    }
    if (
      value.placement !== "explicit" &&
      (value.node_x !== undefined || value.node_y !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "node_x/node_y require placement='explicit'",
        path: ["placement"],
      });
    }
  });
export type CreateNodeInput = z.infer<typeof CreateNodeInputSchema>;

/** One parameter to pulse in the same bridge tick immediately before an advanced capture. */
export const PrePulseSchema = z.object({ path: z.string(), par: z.string() });
export type PrePulse = z.infer<typeof PrePulseSchema>;

/** Options for TouchDesignerClient.captureAdvanced (pre-pulses + optional deferred capture). */
export interface CaptureAdvancedInput {
  width?: number;
  height?: number;
  sampleGrid?: number;
  prePulses?: PrePulse[];
  delayFrames?: number;
}

/** A single atomic operation accepted by `POST /api/batch`. */
export const BatchOperationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    parent_path: z.string(),
    type: z.string(),
    name: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    action: z.literal("update"),
    path: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
  z.object({
    action: z.literal("delete"),
    path: z.string(),
    mode: z.enum(["delete", "bypass"]).optional(),
    confirmation_policy: z.literal("yolo").optional(),
  }),
  z.object({
    action: z.literal("connect"),
    source_path: z.string(),
    target_path: z.string(),
    source_output: z.number().int().default(0),
    target_input: z.number().int().default(0),
  }),
]);
export type TdBatchOperation = z.infer<typeof BatchOperationSchema>;

// --- First-class wiring endpoints (POST /api/connect, /api/disconnect) ---
export const ConnectResultSchema = z.object({
  source_path: z.string(),
  target_path: z.string(),
  requested_input: z.number().int().optional(),
  actual_input: z.number().int().optional(),
  source_output: z.number().int().default(0),
  connected: z.boolean().default(true),
});
export type TdConnectResult = z.infer<typeof ConnectResultSchema>;

export const DisconnectResultSchema = z.object({
  to_path: z.string(),
  from_path: z.string().nullable().optional(),
  to_input: z.number().int().nullable().optional(),
  removed: z.array(z.object({ input: z.number().int(), from: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});
export type TdDisconnectResult = z.infer<typeof DisconnectResultSchema>;

// --- Parameter-change watches (opt-in; survive ALLOW_EXEC=0) ---
// Response envelope for POST/DELETE /api/params/watch: a single watch's state.
// `pars` is null for a watch-all subscription, or the sorted names being watched.
export const ParamWatchResultSchema = z.object({
  path: z.string(),
  pars: z.array(z.string()).nullable().default(null),
  watching: z.boolean(),
});
export type TdParamWatchResult = z.infer<typeof ParamWatchResultSchema>;

// GET /api/params/watch: every active watch.
export const ParamWatchListSchema = z.object({
  watches: z
    .array(z.object({ path: z.string(), pars: z.array(z.string()).nullable().default(null) }))
    .default([]),
  count: z.number().int().default(0),
});
export type TdParamWatchList = z.infer<typeof ParamWatchListSchema>;

// The `param.changed` event payload the bridge broadcasts on the WebSocket stream
// for a watched operator's parameter. Validated where events are parsed so a
// consumer gets a typed shape, not a raw wire object.
export const ParamChangedEventSchema = z.object({
  path: z.string(),
  par: z.string(),
  prev: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  frame: z.number().int().nullable().default(null),
});
export type TdParamChangedEvent = z.infer<typeof ParamChangedEventSchema>;

// --- Param-mode + DAT-text endpoints (survive ALLOW_EXEC=0) ---
export const ParamModeEntrySchema = z.object({
  name: z.string(),
  mode: z.string(),
  value: z.unknown().optional(),
  expr: z.string().optional(),
  bind_expr: z.string().optional(),
  export_op: z.string().optional(),
});
export const ParamModesSchema = z.object({
  path: z.string(),
  type: z.string().default(""),
  name: z.string().default(""),
  parameters: z.array(ParamModeEntrySchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type TdParamModes = z.infer<typeof ParamModesSchema>;

// Batched read_parameter_modes — per-item envelope adds an optional `error`
// field for the isolate-per-item-failure path (bridge keeps `continue_on_error`
// true by default).
export const ParamModesBatchItemSchema = z.object({
  path: z.string(),
  type: z.string().default(""),
  name: z.string().default(""),
  parameters: z.array(ParamModeEntrySchema).default([]),
  warnings: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export const ParamModesBatchSchema = z.object({
  items: z.array(ParamModesBatchItemSchema).default([]),
});
export type TdParamModesBatchItem = z.infer<typeof ParamModesBatchItemSchema>;
export type TdParamModesBatch = z.infer<typeof ParamModesBatchSchema>;

export const SetParamModeResultSchema = z.object({
  path: z.string(),
  param: z.string(),
  mode: z.string(),
  readback_mode: z.string().default(""),
  readback_expr: z.string().default(""),
});
export type TdSetParamModeResult = z.infer<typeof SetParamModeResultSchema>;

export const DatTextSchema = z.object({
  path: z.string(),
  text: z.string().default(""),
  is_table: z.boolean().default(false),
  num_rows: z.number().int().default(0),
  num_cols: z.number().int().default(0),
});
export type TdDatText = z.infer<typeof DatTextSchema>;

export const DatTextWriteSchema = z.object({
  path: z.string(),
  old_length: z.number().int().default(0),
  new_length: z.number().int().default(0),
});
export type TdDatTextWrite = z.infer<typeof DatTextWriteSchema>;

// --- Structured bridge logs (GET /api/logs) ---
export const BridgeLogLineSchema = z.object({
  source: z.string().default(""),
  message: z.string().default(""),
  absframe: z.number().int().optional(),
  frame: z.number().int().optional(),
  severity: z.string().default(""),
  type: z.string().default(""),
});
export const BridgeLogsSchema = z.object({
  lines: z.array(BridgeLogLineSchema).default([]),
  count: z.number().int().default(0),
  error_dat: z.string().optional(),
  available: z.boolean().default(true),
  warnings: z.array(z.string()).default([]),
});
export type TdBridgeLogs = z.infer<typeof BridgeLogsSchema>;

// --- Timeline transport (POST /api/transport) ---
// Matches transport_service.control()'s return shape: {action, play, frame, rate,
// startFrame, endFrame, fps}. Kept identical to the legacy exec-script stdout so
// the Node-side tool can collapse both branches into one result handler.
export const TransportStateSchema = z.object({
  action: z.string(),
  play: z.boolean(),
  frame: z.number().int(),
  rate: z.number(),
  startFrame: z.number().int(),
  endFrame: z.number().int(),
  fps: z.number(),
});
export type TdTransportState = z.infer<typeof TransportStateSchema>;

// --- System info (GET /api/system) ---
// Combined gpu/monitors/performMode snapshot for inspect_gpu_and_displays. Every
// section is optional so a subset request (?include=gpu) or a forward-compat
// older bridge that omits a field still parses cleanly. Section-level errors
// surface as {error} dicts (mirrors the legacy exec-stdout shape).
const SystemMonitorSchema = z.object({
  index: z.number().int(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  refreshRate: z.number().nullable().optional(),
  isPrimary: z.boolean().nullable().optional(),
  left: z.number().nullable().optional(),
  top: z.number().nullable().optional(),
});
export const SystemInfoSchema = z.object({
  gpu: z
    .object({
      name: z.string().nullable().optional(),
      driver: z.string().nullable().optional(),
      memory: z.union([z.number(), z.string()]).nullable().optional(),
      error: z.string().optional(),
    })
    .optional(),
  monitors: z.union([z.array(SystemMonitorSchema), z.object({ error: z.string() })]).optional(),
  performMode: z
    .union([z.boolean(), z.object({ error: z.string() })])
    .nullable()
    .optional(),
});
export type TdSystemInfo = z.infer<typeof SystemInfoSchema>;

// --- Perform-mode write (POST /api/perform) — survives ALLOW_EXEC=0 ---
// Superset of the legacy PerformModeReport (adds project_perform_mode_set) so
// the rewired tool produces the same artist-visible summary on either path.
export const PerformModeStateSchema = z.object({
  enabled: z.boolean(),
  was: z.boolean(),
  stored: z.boolean(),
  ui_perform_mode_set: z.boolean(),
  project_perform_mode_set: z.boolean(),
  warnings: z.array(z.string()).default([]),
});
export type TdPerformModeState = z.infer<typeof PerformModeStateSchema>;

// --- Project analysis (GET /api/projects/<path>/analysis) ---
// Diagnostic walk for analyze_project. Survives ALLOW_EXEC=0. Mirrors the legacy
// exec-stdout shape so the tool can keep its one result handler. Every list is
// optional + defaultable for forward-compat with older/newer bridges.
export const ProjectAnalysisSchema = z.object({
  path: z.string().optional(),
  recursive: z.boolean().optional(),
  counts: z
    .object({
      nodes: z.number().int().optional(),
      by_family: z.record(z.string(), z.number()).optional(),
    })
    .optional(),
  unused: z
    .array(
      z.object({
        path: z.string(),
        type: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  broken_file_deps: z
    .array(
      z.object({
        path: z.string(),
        par: z.string(),
        file: z.string(),
      }),
    )
    .optional(),
  orphan_comps: z
    .array(
      z.object({
        path: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  dependency_map: z.record(z.string(), z.array(z.string())).optional(),
  warnings: z.array(z.string()).optional(),
  fatal: z.string().optional(),
});
export type TdProjectAnalysis = z.infer<typeof ProjectAnalysisSchema>;

// --- Quarantine project load (POST /api/project/load) ---
// First-class loader for the Project RAG quarantine analyzer. `errors` /
// `preview_b64` are reported off the actually-loaded project, so the analyzer
// can use them directly instead of separate errors/preview round-trips.
export const ProjectLoadSchema = z.object({
  root_path: z.string(),
  node_count: z.number().int().default(0),
  errors: z
    .array(
      z.object({
        path: z.string().optional(),
        message: z.string(),
        level: z.string().optional(),
      }),
    )
    .default([]),
  preview_b64: z.string().optional(),
});
export type TdProjectLoad = z.infer<typeof ProjectLoadSchema>;

// --- Node save (POST /api/nodes/<path>/save) — survives ALLOW_EXEC=0 ---
// A COMP saves to a .tox component file; a TOP saves to an image. Only image
// operators expose width/height, so dimensions are optional and gated by
// `has_dimensions`. `saved` is the canonical path TD wrote (COMP.save returns the
// path string; TOP.save returns a FileSaveStatus, normalized bridge-side).
export const SaveNodeSchema = z.object({
  path: z.string(),
  saved: z.string(),
  has_dimensions: z.boolean().default(false),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});
export type TdSaveNode = z.infer<typeof SaveNodeSchema>;

// --- Node/subtree duplicate (POST /api/duplicate) — survives ALLOW_EXEC=0 ---
// `parent.copy(src[, name])` preserves the source's internal wires + params.
export const DuplicateNodeSchema = z.object({
  source: z.string(),
  copy: z.string(),
  parent: z.string().optional(),
});
export type TdDuplicateNode = z.infer<typeof DuplicateNodeSchema>;

// --- Creatable-operator truth list (GET /api/optypes) — survives ALLOW_EXEC=0 ---
// Ground-truth from the live TD: every lowercase `td` attribute that is a subclass
// of a family base class (TOP/CHOP/SOP/DAT/COMP/MAT/POP) is a creatable optype.
export const OpTypesSchema = z.object({
  optypes: z.array(z.string()).default([]),
  families: z.record(z.string(), z.array(z.string())).default({}),
  count: z.number().int().default(0),
  td_version: z.string().optional(),
  build: z.string().optional(),
});
export type TdOpTypes = z.infer<typeof OpTypesSchema>;

// --- Custom-parameter readout (GET /api/nodes/<path>/custom_params) ---
// Structured endpoint for serialize_network + inspect_component. Every field
// optional so older bridges (or per-par failures) round-trip cleanly. ``value``
// and ``default`` are unknown because TD pars span Float/Int/Toggle/Menu/Str
// and we preserve the bridge's native type without coercion.
export const CustomParamSchema = z.object({
  name: z.string(),
  label: z.string().nullable().optional(),
  page: z.string().nullable().optional(),
  style: z.string().nullable().optional(),
  default: z.unknown().optional(),
  value: z.unknown().optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  options: z.array(z.string()).nullable().optional(),
});
export const CustomParamsSchema = z.object({
  params: z.array(CustomParamSchema).default([]),
  warnings: z.array(z.string()).default([]),
  fatal: z.string().optional(),
});
export type TdCustomParams = z.infer<typeof CustomParamsSchema>;

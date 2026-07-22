import { z } from "zod";

export const OPERATION_PLAN_SCHEMA_VERSION = 1 as const;
export const MAX_OPERATION_INTENTS = 32;
export const MAX_OPERATION_CREATES = 16;
export const MAX_OPERATION_PARAMETER_WRITES = 128;
export const MAX_OPERATION_METADATA_WRITES = 128;
export const MAX_OPERATION_AFFECTED_PATHS = 64;
export const MAX_OPERATION_BODY_BYTES = 128 * 1024;

export const inertOperationTypeSchema = z.enum([
  "baseCOMP",
  "constantCHOP",
  "constantTOP",
  "nullCHOP",
  "nullDAT",
  "nullSOP",
  "nullTOP",
  "textDAT",
]);

export const operationIntentKindSchema = z.enum([
  "create_operator",
  "set_constant_parameters",
  "edit_metadata",
  "connect",
  "disconnect",
  "create_annotation",
]);

export const operationPlanErrorCodeSchema = z.enum([
  "invalid_operation_plan",
  "unsupported_intent",
  "unsupported_operator_type",
  "operation_capacity",
  "preview_expired",
  "preview_instance_mismatch",
  "stale_plan",
  "operation_busy",
  "perform_mode",
  "ui_unavailable",
  "undo_unavailable",
  "undo_busy",
  "idempotency_conflict",
  "apply_failed",
  "verification_failed",
  "rollback_failed",
  "journal_registration_failed",
  "outcome_unknown",
  "unverified_live_boundary",
  "operation_authority",
  "receipt_unavailable",
]);

const normalizedPathSchema = z
  .string()
  .min(2)
  .max(1_024)
  .refine((value) => {
    if (!value.startsWith("/") || value.endsWith("/") || /[\0\r\n]/.test(value)) return false;
    return value
      .split("/")
      .slice(1)
      .every((part) => /^[A-Za-z0-9_]+$/.test(part));
  }, "Expected a normalized, non-root absolute TouchDesigner path.");

const safeNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const aliasSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/);
const parameterNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const boundedCoordinateSchema = z.number().int().safe().min(-1_000_000).max(1_000_000);
const connectorIndexSchema = z.number().int().min(0).max(255);
const safeBooleanSchema = z.boolean();
const colorSchema = z.tuple([
  z.number().finite().min(0).max(1),
  z.number().finite().min(0).max(1),
  z.number().finite().min(0).max(1),
]);

const positionSchema = z
  .object({
    x: boundedCoordinateSchema,
    y: boundedCoordinateSchema,
  })
  .strict();

export const operationTargetSchema = z.union([
  z.object({ path: normalizedPathSchema }).strict(),
  z.object({ ref: aliasSchema }).strict(),
]);

const boundedJsonValueSchema = z.unknown().superRefine((value, context) => {
  const issue = validateBoundedJson(value, 0);
  if (issue !== undefined) context.addIssue({ code: "custom", message: issue });
});

const createOperatorIntentSchema = z
  .object({
    kind: z.literal("create_operator"),
    ref: aliasSchema,
    type: inertOperationTypeSchema,
    name: safeNameSchema,
    parent: operationTargetSchema,
    position: positionSchema,
    viewer: safeBooleanSchema.optional(),
  })
  .strict();

const setConstantParametersIntentSchema = z
  .object({
    kind: z.literal("set_constant_parameters"),
    target: operationTargetSchema,
    values: z.record(parameterNameSchema, boundedJsonValueSchema),
  })
  .strict()
  .refine((value) => {
    const count = Object.keys(value.values).length;
    return count >= 1 && count <= 32;
  }, "Parameter writes must contain 1 to 32 entries.");

const editMetadataIntentSchema = z
  .object({
    kind: z.literal("edit_metadata"),
    target: operationTargetSchema,
    position: positionSchema.optional(),
    color: colorSchema.optional(),
    comment: utf8BoundedString(2_048, true).optional(),
    viewer: safeBooleanSchema.optional(),
    bypass: safeBooleanSchema.optional(),
    display: safeBooleanSchema.optional(),
    render: safeBooleanSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.position !== undefined ||
      value.color !== undefined ||
      value.comment !== undefined ||
      value.viewer !== undefined ||
      value.bypass !== undefined ||
      value.display !== undefined ||
      value.render !== undefined,
    "edit_metadata requires at least one writable field.",
  );

const edgeFields = {
  source: operationTargetSchema,
  source_output: connectorIndexSchema,
  target: operationTargetSchema,
  target_input: connectorIndexSchema,
};

const connectIntentSchema = z.object({ kind: z.literal("connect"), ...edgeFields }).strict();
const disconnectIntentSchema = z.object({ kind: z.literal("disconnect"), ...edgeFields }).strict();

const annotationBoundsSchema = z
  .object({
    x: boundedCoordinateSchema,
    y: boundedCoordinateSchema,
    w: boundedCoordinateSchema.positive(),
    h: boundedCoordinateSchema.positive(),
  })
  .strict();

const createAnnotationIntentSchema = z
  .object({
    kind: z.literal("create_annotation"),
    ref: aliasSchema,
    name: safeNameSchema,
    parent: operationTargetSchema,
    bounds: annotationBoundsSchema,
    title: utf8BoundedString(512, true).optional(),
    body: utf8BoundedString(8_192, true).optional(),
    color: colorSchema.optional(),
  })
  .strict();

export const operationIntentSchema = z.discriminatedUnion("kind", [
  createOperatorIntentSchema,
  setConstantParametersIntentSchema,
  editMetadataIntentSchema,
  connectIntentSchema,
  disconnectIntentSchema,
  createAnnotationIntentSchema,
]);

const expectedEditorContextSchema = z
  .object({
    owner_path: normalizedPathSchema,
    current_path: normalizedPathSchema,
    selected_paths: z.array(normalizedPathSchema).min(1).max(64),
  })
  .strict();

const operationPlanObjectSchema = z
  .object({
    schema_version: z.literal(OPERATION_PLAN_SCHEMA_VERSION),
    label: z
      .string()
      .min(1)
      .refine(
        (value) =>
          utf8Bytes(value) <= 96 && !hasControlCharacter(value) && !hasLoneSurrogate(value),
        "Label must be at most 96 UTF-8 bytes and contain no controls.",
      ),
    owner_path: normalizedPathSchema,
    expected_context: expectedEditorContextSchema.optional(),
    intents: z.array(operationIntentSchema).min(1).max(MAX_OPERATION_INTENTS),
  })
  .strict();

export const operationPlanSchema = operationPlanObjectSchema.superRefine((plan, context) => {
  validatePlanSemantics(plan, context);
  if (serializedBytes(plan) > MAX_OPERATION_BODY_BYTES) {
    context.addIssue({ code: "custom", message: "Operation plan exceeds 128 KiB." });
  }
});

export const operationCommitSchema = operationPlanObjectSchema
  .extend({
    preview_token: z.string().min(1).max(1_024),
    idempotency_key: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()
  .superRefine((commit, context) => {
    validatePlanSemantics(commit, context);
    if (serializedBytes(commit) > MAX_OPERATION_BODY_BYTES) {
      context.addIssue({ code: "custom", message: "Operation commit exceeds 128 KiB." });
    }
  });

const operationEffectSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_OPERATION_INTENTS - 1),
    kind: operationIntentKindSchema,
    target_paths: z.array(normalizedPathSchema).min(1).max(2),
    field_names: z.array(z.string().min(1).max(128)).min(1).max(32),
    summary: z.string().min(1).max(256),
  })
  .strict();

const operationCountsSchema = z
  .object({
    intents: z.number().int().min(1).max(MAX_OPERATION_INTENTS),
    creates: z.number().int().min(0).max(MAX_OPERATION_CREATES),
    parameter_writes: z.number().int().min(0).max(MAX_OPERATION_PARAMETER_WRITES),
    metadata_writes: z.number().int().min(0).max(MAX_OPERATION_PARAMETER_WRITES),
    connects: z.number().int().min(0).max(MAX_OPERATION_INTENTS),
    disconnects: z.number().int().min(0).max(MAX_OPERATION_INTENTS),
  })
  .strict();

export const operationPreviewSchema = z
  .object({
    status: z.literal("preview"),
    schema_version: z.literal(OPERATION_PLAN_SCHEMA_VERSION),
    bridge_instance_id: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    preview_token: z.string().min(1).max(1_024),
    expires_at: z.iso.datetime({ offset: true }),
    plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
    owner_path: normalizedPathSchema,
    label: z.string().min(1).max(96),
    effects: z.array(operationEffectSchema).min(1).max(MAX_OPERATION_INTENTS),
    affected_paths: z.array(normalizedPathSchema).min(1).max(MAX_OPERATION_AFFECTED_PATHS),
    counts: operationCountsSchema,
    risk: z.literal("bounded_graph_mutation"),
    rollback_coverage: z.enum(["unverified_for_allowlist", "complete_for_allowlist"]),
    journal_eligible: z.boolean(),
    warnings: z.array(z.string().max(256)).max(16),
  })
  .strict()
  .superRefine((preview, context) => {
    const claimsComplete = preview.rollback_coverage === "complete_for_allowlist";
    if (claimsComplete !== preview.journal_eligible) {
      context.addIssue({
        code: "custom",
        message: "Rollback and journal eligibility claims must be promoted together.",
      });
    }
  });

const operationResultSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_OPERATION_INTENTS - 1),
    kind: operationIntentKindSchema,
    status: z.enum(["applied", "unchanged", "rolled_back", "rollback_failed"]),
    final_paths: z.array(normalizedPathSchema).min(1).max(MAX_OPERATION_AFFECTED_PATHS),
  })
  .strict();

const rollbackSchema = z
  .object({
    attempted: z.boolean(),
    succeeded: z.boolean(),
    errors: z
      .array(
        z
          .object({
            index: z
              .number()
              .int()
              .min(0)
              .max(MAX_OPERATION_INTENTS - 1),
            code: z.string().min(1).max(64),
            message: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

const journalSchema = z
  .object({
    registered: z.boolean(),
    operation_id: z.string().min(1).max(128).nullable(),
    label: z.string().min(1).max(128).nullable(),
    native_stack_delta: z.union([z.literal(0), z.literal(1)]),
    observed_state: z.enum(["applied", "undone", "redone", "drifted", "unknown"]),
  })
  .strict();

const operationCommitReceiptObjectSchema = z
  .object({
    status: z.enum([
      "applied",
      "replayed",
      "failed_rolled_back",
      "failed_rollback",
      "outcome_unknown",
    ]),
    operation_id: z.string().min(1).max(128),
    receipt_capability: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    bridge_instance_id: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
    owner_path: normalizedPathSchema,
    affected_paths: z.array(normalizedPathSchema).min(1).max(MAX_OPERATION_AFFECTED_PATHS),
    results: z.array(operationResultSchema).max(MAX_OPERATION_INTENTS),
    verification: z
      .object({
        status: z.enum(["PASS", "FAIL"]),
        snapshot: z.enum(["before", "after", "unknown"]),
      })
      .strict(),
    rollback: rollbackSchema,
    journal: journalSchema,
    warnings: z.array(z.string().max(256)).max(16),
    error: z
      .object({
        code: operationPlanErrorCodeSchema,
        message: z.string().min(1).max(256),
      })
      .strict()
      .optional(),
  })
  .strict();

type ReceiptLike = z.infer<typeof operationCommitReceiptObjectSchema>;

export const operationCommitReceiptSchema =
  operationCommitReceiptObjectSchema.superRefine(validateReceiptSemantics);

export const operationReceiptRequestSchema = z
  .object({
    schema_version: z.literal(OPERATION_PLAN_SCHEMA_VERSION),
    operation_id: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    receipt_capability: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const operationObservationSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      state: z.enum(["applied", "undone", "redone", "drifted"]),
      verification: z.enum(["PASS", "FAIL"]),
      snapshot: z.enum(["before", "after", "unknown"]),
    })
    .strict()
    .superRefine((observation, context) => {
      const coherent =
        (observation.state === "undone" &&
          observation.verification === "PASS" &&
          observation.snapshot === "before") ||
        ((observation.state === "applied" || observation.state === "redone") &&
          observation.verification === "PASS" &&
          observation.snapshot === "after") ||
        (observation.state === "drifted" &&
          observation.verification === "FAIL" &&
          observation.snapshot === "unknown");
      if (!coherent) {
        context.addIssue({ code: "custom", message: "Operation observation is incoherent." });
      }
    }),
  z
    .object({
      available: z.literal(false),
      state: z.literal("unknown"),
      verification: z.literal("UNVERIFIED"),
      snapshot: z.literal("unknown"),
      reason: z.enum(["not_applicable", "journal_unavailable"]),
    })
    .strict(),
]);

export const operationReceiptEnvelopeSchema = z
  .object({
    status: z.literal("receipt"),
    receipt: operationCommitReceiptSchema,
    observation: operationObservationSchema,
  })
  .strict();

export const operationPlanErrorSchema = z
  .object({
    code: operationPlanErrorCodeSchema,
    message: z.string().min(1).max(256),
  })
  .strict();

type PlanLike = z.infer<typeof operationPlanObjectSchema>;
type OperationTarget = z.infer<typeof operationTargetSchema>;
type PlanIntent = PlanLike["intents"][number];
type NonCreateIntent = Exclude<PlanIntent, { kind: "create_operator" | "create_annotation" }>;
type SemanticState = {
  aliases: Map<string, { path: string; type: string }>;
  createdPaths: Set<string>;
  creates: number;
  parameterWrites: number;
  metadataWrites: number;
};

function validateReceiptSemantics(receipt: ReceiptLike, context: z.RefinementCtx): void {
  if (!hasConsistentReceiptError(receipt)) {
    context.addIssue({ code: "custom", message: "Receipt error fields are inconsistent." });
  }
  if (!hasConsistentJournal(receipt)) {
    context.addIssue({ code: "custom", message: "Journal fields are internally inconsistent." });
  }
  for (const issue of receiptStructureIssues(receipt)) {
    context.addIssue({ code: "custom", message: issue });
  }
  const statusIssue = receiptStatusIssue(receipt);
  if (statusIssue !== undefined) context.addIssue({ code: "custom", message: statusIssue });
}

function hasConsistentReceiptError(receipt: ReceiptLike): boolean {
  const successful = receipt.status === "applied" || receipt.status === "replayed";
  return successful === (receipt.error === undefined);
}

function hasConsistentJournal(receipt: ReceiptLike): boolean {
  if (receipt.journal.registered) {
    return (
      receipt.journal.operation_id === receipt.operation_id &&
      receipt.journal.label !== null &&
      receipt.journal.native_stack_delta === 1
    );
  }
  return (
    receipt.journal.operation_id === null &&
    receipt.journal.label === null &&
    receipt.journal.native_stack_delta === 0 &&
    receipt.journal.observed_state === "unknown"
  );
}

function receiptStructureIssues(receipt: ReceiptLike): string[] {
  return [...receiptResultIssues(receipt), ...receiptRollbackIssues(receipt)];
}

function receiptResultIssues(receipt: ReceiptLike): string[] {
  const issues: string[] = [];
  const resultIndexes = receipt.results.map((result) => result.index);
  if (new Set(resultIndexes).size !== resultIndexes.length) {
    issues.push("Receipt result indexes must be unique.");
  }
  if ([...resultIndexes].sort((a, b) => a - b).some((index, position) => index !== position)) {
    issues.push("Receipt result indexes must be contiguous from zero.");
  }
  if (new Set(receipt.affected_paths).size !== receipt.affected_paths.length) {
    issues.push("Receipt affected paths must be unique.");
  }
  const affected = new Set(receipt.affected_paths);
  if (receipt.results.some((result) => result.final_paths.some((path) => !affected.has(path)))) {
    issues.push("Receipt final paths must be included in affected paths.");
  }
  if (
    receipt.results.some((result) => new Set(result.final_paths).size !== result.final_paths.length)
  ) {
    issues.push("Receipt final paths must be unique per result.");
  }
  return issues;
}

function receiptRollbackIssues(receipt: ReceiptLike): string[] {
  const issues: string[] = [];
  const resultIndexes = receipt.results.map((result) => result.index);
  const errorIndexes = receipt.rollback.errors.map((error) => error.index);
  if (new Set(errorIndexes).size !== errorIndexes.length) {
    issues.push("Rollback error indexes must be unique.");
  }
  if ((!receipt.rollback.attempted || receipt.rollback.succeeded) && errorIndexes.length > 0) {
    issues.push("Successful or unattempted rollback cannot report errors.");
  }
  const knownResults = new Set(resultIndexes);
  if (errorIndexes.some((index) => !knownResults.has(index))) {
    issues.push("Rollback errors must reference a reported result index.");
  }
  const failedIndexes = receipt.results
    .filter((result) => result.status === "rollback_failed")
    .map((result) => result.index)
    .sort((a, b) => a - b);
  if (
    receipt.status === "failed_rollback" &&
    errorIndexes.sort((a, b) => a - b).join(",") !== failedIndexes.join(",")
  ) {
    issues.push("Rollback errors must exactly match rollback-failed results.");
  }
  return issues;
}

function receiptStatusIssue(receipt: ReceiptLike): string | undefined {
  const contract = receiptStatusContracts[receipt.status];
  return contract.isValid(receipt) ? undefined : contract.issue;
}

const receiptStatusContracts: Record<
  ReceiptLike["status"],
  { isValid: (receipt: ReceiptLike) => boolean; issue: string }
> = {
  applied: {
    isValid: isAppliedReceipt,
    issue: "Applied receipt safety claims are invalid.",
  },
  replayed: {
    isValid: isReplayedReceipt,
    issue: "Replayed receipt safety claims are invalid.",
  },
  failed_rolled_back: {
    isValid: isRolledBackFailure,
    issue: "Rolled-back failure safety claims are invalid.",
  },
  failed_rollback: {
    isValid: isRollbackFailure,
    issue: "Rollback failure claims are invalid.",
  },
  outcome_unknown: {
    isValid: isUnknownOutcome,
    issue: "Unknown outcome claims are invalid.",
  },
};

function resultsHaveStatuses(receipt: ReceiptLike, statuses: readonly string[]): boolean {
  return receipt.results.every((result) => statuses.includes(result.status));
}

function isAppliedReceipt(receipt: ReceiptLike): boolean {
  return (
    receipt.results.length > 0 &&
    receipt.verification.status === "PASS" &&
    receipt.verification.snapshot === "after" &&
    !receipt.rollback.attempted &&
    receipt.rollback.succeeded &&
    receipt.rollback.errors.length === 0 &&
    receipt.journal.registered &&
    receipt.journal.observed_state === "applied" &&
    resultsHaveStatuses(receipt, ["applied", "unchanged"])
  );
}

function isReplayedReceipt(receipt: ReceiptLike): boolean {
  const expectedSnapshot =
    receipt.journal.observed_state === "undone"
      ? "before"
      : receipt.journal.observed_state === "applied" || receipt.journal.observed_state === "redone"
        ? "after"
        : undefined;
  return (
    receipt.results.length > 0 &&
    receipt.verification.status === "PASS" &&
    receipt.verification.snapshot === expectedSnapshot &&
    !receipt.rollback.attempted &&
    receipt.rollback.succeeded &&
    receipt.rollback.errors.length === 0 &&
    receipt.journal.registered &&
    ["applied", "undone", "redone"].includes(receipt.journal.observed_state) &&
    resultsHaveStatuses(receipt, ["applied", "unchanged"])
  );
}

function isRolledBackFailure(receipt: ReceiptLike): boolean {
  return (
    receipt.results.length > 0 &&
    receipt.verification.status === "PASS" &&
    receipt.verification.snapshot === "before" &&
    receipt.rollback.attempted &&
    receipt.rollback.succeeded &&
    receipt.rollback.errors.length === 0 &&
    !receipt.journal.registered &&
    resultsHaveStatuses(receipt, ["rolled_back", "unchanged"])
  );
}

function isRollbackFailure(receipt: ReceiptLike): boolean {
  return (
    receipt.results.length > 0 &&
    receipt.verification.status === "FAIL" &&
    receipt.rollback.attempted &&
    !receipt.rollback.succeeded &&
    receipt.rollback.errors.length > 0 &&
    !receipt.journal.registered &&
    resultsHaveStatuses(receipt, ["rolled_back", "rollback_failed", "unchanged"])
  );
}

function isUnknownOutcome(receipt: ReceiptLike): boolean {
  return (
    receipt.verification.status === "FAIL" &&
    receipt.verification.snapshot === "unknown" &&
    !receipt.rollback.attempted &&
    !receipt.rollback.succeeded &&
    receipt.rollback.errors.length === 0 &&
    !receipt.journal.registered &&
    receipt.results.length === 0
  );
}

function validatePlanSemantics(plan: PlanLike, context: z.RefinementCtx): void {
  if (plan.expected_context !== undefined) validateExpectedContext(plan, context);
  const state = collectPlanSemantics(plan, context);
  validateAggregateCapacities(state, context);
  rejectDirectCreatedPaths(plan, state.createdPaths, context);
}

function collectPlanSemantics(plan: PlanLike, context: z.RefinementCtx): SemanticState {
  const state: SemanticState = {
    aliases: new Map(),
    createdPaths: new Set(),
    creates: 0,
    parameterWrites: 0,
    metadataWrites: 0,
  };
  for (const [index, intent] of plan.intents.entries()) {
    if (intent.kind === "create_operator" || intent.kind === "create_annotation") {
      state.creates += 1;
      validateCreate(intent, plan.owner_path, state.aliases, state.createdPaths, index, context);
      continue;
    }
    validateNonCreateIntent(intent, plan.owner_path, state.aliases, index, context);
    countIntentWrites(intent, state);
  }
  return state;
}

function validateNonCreateIntent(
  intent: NonCreateIntent,
  ownerPath: string,
  aliases: SemanticState["aliases"],
  index: number,
  context: z.RefinementCtx,
): void {
  const targets = "source" in intent ? [intent.source, intent.target] : [intent.target];
  const resolved = targets.map((target) => resolveTarget(target, aliases, index, context));
  for (const [targetIndex, target] of targets.entries()) {
    if ("path" in target && parentPath(resolved[targetIndex] ?? "") !== ownerPath) {
      addIssue(context, index, `Target ${targetIndex} is outside the immediate owner network.`);
    }
  }
  const isEdge = intent.kind === "connect" || intent.kind === "disconnect";
  if (isEdge && parentPath(resolved[0] ?? "") !== parentPath(resolved[1] ?? "")) {
    addIssue(context, index, "Edge endpoints must have the same exact parent.");
  }
}

function countIntentWrites(intent: NonCreateIntent, state: SemanticState): void {
  if (intent.kind === "set_constant_parameters") {
    state.parameterWrites += Object.keys(intent.values).length;
  }
  if (intent.kind === "edit_metadata") {
    state.metadataWrites += Object.keys(intent).filter(
      (field) => field !== "kind" && field !== "target",
    ).length;
  }
}

function validateAggregateCapacities(state: SemanticState, context: z.RefinementCtx): void {
  if (state.creates > MAX_OPERATION_CREATES) {
    context.addIssue({ code: "custom", message: "Plan exceeds 16 creates." });
  }
  if (state.parameterWrites > MAX_OPERATION_PARAMETER_WRITES) {
    context.addIssue({ code: "custom", message: "Plan exceeds 128 parameter writes." });
  }
  if (state.metadataWrites > MAX_OPERATION_METADATA_WRITES) {
    context.addIssue({ code: "custom", message: "Plan exceeds 128 metadata writes." });
  }
}

function rejectDirectCreatedPaths(
  plan: PlanLike,
  createdPaths: Set<string>,
  context: z.RefinementCtx,
): void {
  for (const [index, intent] of plan.intents.entries()) {
    if (intent.kind === "create_operator" || intent.kind === "create_annotation") continue;
    const targets = "source" in intent ? [intent.source, intent.target] : [intent.target];
    if (targets.some((target) => "path" in target && createdPaths.has(target.path))) {
      addIssue(context, index, "Same-plan created operators must be addressed by ref.");
    }
  }
}

function validateExpectedContext(plan: PlanLike, context: z.RefinementCtx): void {
  const expected = plan.expected_context;
  if (expected === undefined) return;
  if (expected.owner_path !== plan.owner_path) {
    context.addIssue({ code: "custom", message: "Expected context owner must match plan owner." });
  }
  const unique = new Set(expected.selected_paths);
  if (unique.size !== expected.selected_paths.length) {
    context.addIssue({ code: "custom", message: "Expected selection cannot contain duplicates." });
  }
  if (
    parentPath(expected.current_path) !== plan.owner_path ||
    expected.selected_paths.some((path) => parentPath(path) !== plan.owner_path)
  ) {
    context.addIssue({
      code: "custom",
      message: "Expected context paths must be immediate owner children.",
    });
  }
}

function validateCreate(
  intent: Extract<PlanLike["intents"][number], { kind: "create_operator" | "create_annotation" }>,
  ownerPath: string,
  aliases: Map<string, { path: string; type: string }>,
  createdPaths: Set<string>,
  index: number,
  context: z.RefinementCtx,
): void {
  if (aliases.has(intent.ref)) addIssue(context, index, "Create aliases must be unique.");
  const parent = resolveTarget(intent.parent, aliases, index, context);
  if ("path" in intent.parent && parent !== ownerPath) {
    addIssue(context, index, "An existing create parent must equal owner_path.");
  }
  if ("ref" in intent.parent && aliases.get(intent.parent.ref)?.type !== "baseCOMP") {
    addIssue(context, index, "An alias parent must be a prior created baseCOMP.");
  }
  const path = `${parent}/${intent.name}`.replace("//", "/");
  if (createdPaths.has(path)) addIssue(context, index, "Deterministic create path is duplicated.");
  aliases.set(intent.ref, {
    path,
    type: intent.kind === "create_operator" ? intent.type : "annotateCOMP",
  });
  createdPaths.add(path);
}

function resolveTarget(
  target: OperationTarget,
  aliases: Map<string, { path: string; type: string }>,
  index: number,
  context: z.RefinementCtx,
): string {
  if ("path" in target) return target.path;
  const resolved = aliases.get(target.ref);
  if (resolved === undefined) {
    addIssue(context, index, "Alias references must point to a prior create.");
    return `/__invalid__/${target.ref}`;
  }
  return resolved.path;
}

function addIssue(context: z.RefinementCtx, index: number, message: string): void {
  context.addIssue({ code: "custom", path: ["intents", index], message });
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function utf8BoundedString(maxBytes: number, allowControls = false) {
  return z
    .string()
    .refine(
      (value) =>
        utf8Bytes(value) <= maxBytes &&
        !hasLoneSurrogate(value) &&
        (allowControls || !hasControlCharacter(value)),
      `Text must be at most ${maxBytes} UTF-8 bytes.`,
    );
}

function validateBoundedJson(value: unknown, depth: number): string | undefined {
  if (depth > 4) return "Parameter value exceeds JSON nesting depth.";
  if (value === null || typeof value === "boolean") return undefined;
  if (typeof value === "number") return validateJsonNumber(value);
  if (typeof value === "string") return validateJsonString(value);
  if (Array.isArray(value)) return validateJsonArray(value, depth);
  if (isPlainJsonObject(value)) return validateJsonObject(value, depth);
  return "Parameter value must be a plain bounded JSON value.";
}

function validateJsonNumber(value: number): string | undefined {
  return Number.isFinite(value) && Math.abs(value) <= 1e15
    ? undefined
    : "Parameter number is not finite and bounded.";
}

function validateJsonString(value: string): string | undefined {
  return utf8Bytes(value) <= 2_048 && !hasControlCharacter(value) && !hasLoneSurrogate(value)
    ? undefined
    : "Parameter string is too long or contains control characters.";
}

function validateJsonArray(value: unknown[], depth: number): string | undefined {
  if (value.length > 32) return "Parameter array exceeds 32 entries.";
  const nestedIssue = firstNestedJsonIssue(value, depth);
  if (nestedIssue !== undefined) return nestedIssue;
  return serializedBytes(value) <= 4_096 ? undefined : "Parameter value exceeds 4 KiB.";
}

function validateJsonObject(value: Record<string, unknown>, depth: number): string | undefined {
  const entries = Object.entries(value);
  if (
    entries.length > 32 ||
    entries.some(([key]) => utf8Bytes(key) > 128 || hasLoneSurrogate(key))
  ) {
    return "Parameter object exceeds its bounded field contract.";
  }
  const nestedIssue = firstNestedJsonIssue(
    entries.map(([, item]) => item),
    depth,
  );
  if (nestedIssue !== undefined) return nestedIssue;
  return serializedBytes(value) <= 4_096 ? undefined : "Parameter value exceeds 4 KiB.";
}

function firstNestedJsonIssue(values: unknown[], depth: number): string | undefined {
  for (const value of values) {
    const issue = validateBoundedJson(value, depth + 1);
    if (issue !== undefined) return issue;
  }
  return undefined;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export type OperationPlan = z.infer<typeof operationPlanSchema>;
export type OperationCommit = z.infer<typeof operationCommitSchema>;
export type OperationPreview = z.infer<typeof operationPreviewSchema>;
export type OperationCommitReceipt = z.infer<typeof operationCommitReceiptSchema>;
export type OperationReceiptRequest = z.infer<typeof operationReceiptRequestSchema>;
export type OperationObservation = z.infer<typeof operationObservationSchema>;
export type OperationReceiptEnvelope = z.infer<typeof operationReceiptEnvelopeSchema>;
export type OperationPlanError = z.infer<typeof operationPlanErrorSchema>;

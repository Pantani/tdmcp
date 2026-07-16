import { createHash } from "node:crypto";
import { z } from "zod";

const tdPathSchema = z.string().min(1).max(1024).startsWith("/");
const opaqueIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PackageReconcileChoiceSchema = z.enum(["Keep", "Bypass", "Delete"]);
export type PackageReconcileChoice = z.infer<typeof PackageReconcileChoiceSchema>;

export const PackageReconcileRecordSchema = z.object({
  id: z.string().min(1).max(128),
  sourceUrl: z.string().url().max(2048),
  ref: z.string().min(1).max(256),
  scope: z.enum(["user", "project"]),
  bridgeTargetPath: tdPathSchema.optional(),
  stagedPath: z.string().min(1).optional(),
});
export type PackageReconcileRecord = z.infer<typeof PackageReconcileRecordSchema>;

function refineDryRunPlan(value: { dryRun: boolean; planId?: string }, ctx: z.RefinementCtx): void {
  if (value.dryRun && value.planId !== undefined) {
    ctx.addIssue({ code: "custom", path: ["planId"], message: "dry-run rejects planId" });
  }
  if (!value.dryRun && value.planId === undefined) {
    ctx.addIssue({ code: "custom", path: ["planId"], message: "apply requires planId" });
  }
}

function refineNativeDelete(
  value: {
    dryRun: boolean;
    choice: PackageReconcileChoice;
    confirmationPolicy: "native" | "yolo";
    interactionId?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    value.choice === "Delete" &&
    !value.dryRun &&
    value.confirmationPolicy === "native" &&
    value.interactionId === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["interactionId"],
      message: "native Delete requires interactionId",
    });
  }
}

function refineYoloDelete(
  value: {
    dryRun: boolean;
    choice: PackageReconcileChoice;
    confirmationPolicy: "native" | "yolo";
    interactionId?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    value.choice === "Delete" &&
    !value.dryRun &&
    value.confirmationPolicy === "yolo" &&
    value.interactionId !== undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["interactionId"],
      message: "YOLO Delete rejects interactionId",
    });
  }
}

export const ReconcilePackageNamespaceInputSchema = z
  .object({
    packageId: z.string().min(1).max(128),
    projectPath: tdPathSchema.default("/project1"),
    scope: z.enum(["user", "project"]),
    intent: z.enum(["prune", "replace"]).default("prune"),
    dryRun: z.boolean().default(true),
    choice: PackageReconcileChoiceSchema.default("Keep"),
    planId: opaqueIdSchema.optional(),
    confirmationPolicy: z.enum(["native", "yolo"]).default("native"),
    interactionId: opaqueIdSchema.optional(),
  })
  .strict()
  .superRefine(refineDryRunPlan)
  .superRefine(refineNativeDelete)
  .superRefine(refineYoloDelete);
export type ReconcilePackageNamespaceInput = z.infer<typeof ReconcilePackageNamespaceInputSchema>;

export const PackageNamespacePlanSchema = z.object({
  status: z.literal("planned"),
  plan_id: opaqueIdSchema,
  expires_at: z.number().finite(),
  package_id: z.string().min(1).max(128),
  scope: z.enum(["user", "project"]),
  intent: z.enum(["prune", "replace"]),
  classification: z.enum([
    "aligned_owned",
    "renamed_owned",
    "missing_live",
    "foreign_target",
    "marker_missing",
    "marker_unreadable",
    "marker_mismatch",
    "duplicate_owned",
  ]),
  actionable: z.boolean(),
  resolved_target_path: tdPathSchema.nullable(),
  marker: z.object({
    matched: z.boolean(),
    schema_version: z.number().int().nullable(),
  }),
  candidates: z
    .array(
      z.object({
        path: tdPathSchema,
        marker_status: z.enum(["match", "missing", "unreadable", "mismatch", "foreign"]),
        marker_schema_version: z.number().int().nullable(),
      }),
    )
    .max(64),
  warnings: z.array(z.string().max(512)).max(32),
  deduplicated: z.boolean(),
});
export type PackageNamespacePlan = z.infer<typeof PackageNamespacePlanSchema>;

export const PackageNamespaceApplyResultSchema = z.object({
  status: z.enum(["applied", "kept", "replayed"]),
  plan_id: opaqueIdSchema,
  package_id: z.string().min(1).max(128),
  classification: z.enum(["aligned_owned", "renamed_owned"]),
  resolved_target_path: tdPathSchema,
  decision: PackageReconcileChoiceSchema,
  action_applied: z.enum(["keep", "bypass", "delete"]),
  final_path: tdPathSchema.nullable(),
  confirmation_policy: z.enum(["explicit_mode", "native", "yolo"]),
  request_id: opaqueIdSchema.nullable(),
  marker: z.object({ matched: z.literal(true), schema_version: z.number().int().nullable() }),
  warnings: z.array(z.string().max(512)).max(32),
  undo_label: z.string().max(256).optional(),
});
export type PackageNamespaceApplyResult = z.infer<typeof PackageNamespaceApplyResultSchema>;

export interface PackageNamespaceBridge {
  check(input: {
    project_path: string;
    package_id: string;
    source_url: string;
    recorded_ref: string;
    recorded_target_path?: string;
    scope: "user" | "project";
    intent: "prune" | "replace";
  }): Promise<PackageNamespacePlan>;
  apply(input: {
    plan_id: string;
    choice: "Bypass" | "Delete";
    confirmation_policy: "explicit_mode" | "native" | "yolo";
    interaction_id?: string;
  }): Promise<PackageNamespaceApplyResult>;
}

export interface PackageReconcileRecordStore {
  read(packageId: string, scope: "user" | "project"): Promise<PackageReconcileRecord | undefined>;
  remove(expected: PackageReconcileRecord): Promise<void>;
  exists(packageId: string, scope: "user" | "project"): Promise<boolean>;
}

export interface PackageQuarantineHandle {
  /** Opaque storage-owned token. Never put a path or secret in this value. */
  token: string;
  prepared: boolean;
}

export interface PackageReconcileStaging {
  quarantine(record: PackageReconcileRecord): Promise<PackageQuarantineHandle>;
  restore(handle: PackageQuarantineHandle): Promise<void>;
  discard(handle: PackageQuarantineHandle): Promise<void>;
}

export interface PackageReconcileJournal {
  write(entry: {
    packageId: string;
    planId: string;
    phase: "registry_commit" | "quarantine_cleanup";
    remediation: string;
  }): Promise<void>;
}

export interface ReconcilePackageNamespaceDependencies {
  bridge: PackageNamespaceBridge;
  records: PackageReconcileRecordStore;
  staging: PackageReconcileStaging;
  journal?: PackageReconcileJournal;
}

export type ReconcilePackageNamespaceReport =
  | {
      status: "planned";
      packageId: string;
      plan: PackageNamespacePlan;
      storage: { mutated: false };
    }
  | {
      status: "kept" | "applied";
      packageId: string;
      planId: string;
      live?: PackageNamespaceApplyResult;
      storage: {
        quarantined: boolean;
        restored: boolean;
        recordRemoved: boolean;
        quarantineDiscarded: boolean;
      };
    }
  | {
      status: "failed" | "partial_failure";
      packageId: string;
      planId?: string;
      code: string;
      storage: {
        quarantined: boolean;
        restored: boolean;
        recordRemoved: boolean;
        quarantineDiscarded: boolean;
      };
      remediation: string[];
    };

const untouchedStorage = () => ({
  quarantined: false,
  restored: false,
  recordRemoved: false,
  quarantineDiscarded: false,
});

function recordFingerprint(record: PackageReconcileRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: record.id,
        sourceUrl: record.sourceUrl,
        ref: record.ref,
        scope: record.scope,
        bridgeTargetPath: record.bridgeTargetPath ?? null,
        stagedPath: record.stagedPath ?? null,
      }),
    )
    .digest("hex");
}

async function readMatchingRecord(
  input: ReconcilePackageNamespaceInput,
  deps: ReconcilePackageNamespaceDependencies,
): Promise<PackageReconcileRecord | undefined> {
  const raw = await deps.records.read(input.packageId, input.scope);
  if (raw === undefined) return undefined;
  const record = PackageReconcileRecordSchema.parse(raw);
  return record.id === input.packageId && record.scope === input.scope ? record : undefined;
}

async function safeRestore(
  deps: ReconcilePackageNamespaceDependencies,
  handle: PackageQuarantineHandle | undefined,
): Promise<boolean> {
  if (handle === undefined || !handle.prepared) return false;
  try {
    await deps.staging.restore(handle);
    return true;
  } catch {
    return false;
  }
}

async function writeJournal(
  deps: ReconcilePackageNamespaceDependencies,
  entry: Parameters<PackageReconcileJournal["write"]>[0],
): Promise<void> {
  try {
    await deps.journal?.write(entry);
  } catch {
    // A journal is remediation evidence, never authority to continue mutating.
  }
}

function failed(
  packageId: string,
  code: string,
  remediation: string,
  planId?: string,
): ReconcilePackageNamespaceReport {
  return {
    status: "failed",
    packageId,
    ...(planId === undefined ? {} : { planId }),
    code,
    storage: untouchedStorage(),
    remediation: [remediation],
  };
}

async function runDryRun(
  input: ReconcilePackageNamespaceInput,
  record: PackageReconcileRecord,
  deps: ReconcilePackageNamespaceDependencies,
): Promise<ReconcilePackageNamespaceReport> {
  try {
    const plan = PackageNamespacePlanSchema.parse(
      await deps.bridge.check({
        project_path: input.projectPath,
        package_id: record.id,
        source_url: record.sourceUrl,
        recorded_ref: record.ref,
        ...(record.bridgeTargetPath === undefined
          ? {}
          : { recorded_target_path: record.bridgeTargetPath }),
        scope: record.scope,
        intent: input.intent,
      }),
    );
    const identityMatches =
      plan.package_id === record.id && plan.scope === record.scope && plan.intent === input.intent;
    if (!identityMatches) {
      return failed(
        input.packageId,
        "plan_identity_mismatch",
        "Discard the unexpected bridge plan and retry the dry-run.",
      );
    }
    return { status: "planned", packageId: record.id, plan, storage: { mutated: false } };
  } catch {
    return failed(
      input.packageId,
      "check_failed",
      "No changes were made; retry the authenticated dry-run after checking the bridge.",
    );
  }
}

async function verifyFreshRecord(
  input: ReconcilePackageNamespaceInput,
  initial: PackageReconcileRecord,
  deps: ReconcilePackageNamespaceDependencies,
  planId: string,
): Promise<ReconcilePackageNamespaceReport | undefined> {
  let current: PackageReconcileRecord | undefined;
  try {
    current = await readMatchingRecord(input, deps);
  } catch {
    return failed(
      input.packageId,
      "package_state_invalid",
      "No changes were made; repair the installed package record.",
      planId,
    );
  }
  if (current !== undefined && recordFingerprint(current) === recordFingerprint(initial)) {
    return undefined;
  }
  return failed(
    input.packageId,
    "package_state_changed",
    "No changes were made; run a new dry-run against current package state.",
    planId,
  );
}

async function runBypass(
  record: PackageReconcileRecord,
  deps: ReconcilePackageNamespaceDependencies,
  planId: string,
): Promise<ReconcilePackageNamespaceReport> {
  try {
    const live = PackageNamespaceApplyResultSchema.parse(
      await deps.bridge.apply({
        plan_id: planId,
        choice: "Bypass",
        confirmation_policy: "explicit_mode",
      }),
    );
    if (live.action_applied !== "bypass") {
      return failed(
        record.id,
        "unexpected_live_result",
        "Package state was preserved; inspect the live target before retrying.",
        planId,
      );
    }
    return {
      status: "applied",
      packageId: record.id,
      planId,
      live,
      storage: untouchedStorage(),
    };
  } catch {
    return failed(
      record.id,
      "live_apply_failed",
      "Package state was preserved; inspect the live target and create a new plan.",
      planId,
    );
  }
}

async function applyDeleteLive(
  input: ReconcilePackageNamespaceInput,
  deps: ReconcilePackageNamespaceDependencies,
  planId: string,
): Promise<PackageNamespaceApplyResult | undefined> {
  try {
    return PackageNamespaceApplyResultSchema.parse(
      await deps.bridge.apply({
        plan_id: planId,
        choice: "Delete",
        confirmation_policy: input.confirmationPolicy,
        ...(input.interactionId === undefined ? {} : { interaction_id: input.interactionId }),
      }),
    );
  } catch {
    return undefined;
  }
}

async function registryFailure(
  record: PackageReconcileRecord,
  deps: ReconcilePackageNamespaceDependencies,
  planId: string,
  handle: PackageQuarantineHandle,
): Promise<ReconcilePackageNamespaceReport> {
  const restored = await safeRestore(deps, handle);
  const remediation =
    "The owned TD node was deleted, but installed state could not be committed; repair the registry before retrying.";
  await writeJournal(deps, {
    packageId: record.id,
    planId,
    phase: "registry_commit",
    remediation,
  });
  return {
    status: "partial_failure",
    packageId: record.id,
    planId,
    code: "registry_commit_failed",
    storage: {
      ...untouchedStorage(),
      quarantined: handle.prepared,
      restored,
    },
    remediation: [remediation],
  };
}

async function cleanupFailure(
  record: PackageReconcileRecord,
  deps: ReconcilePackageNamespaceDependencies,
  planId: string,
  prepared: boolean,
): Promise<ReconcilePackageNamespaceReport> {
  const remediation =
    "TD and installed state converged, but quarantine cleanup failed; remove only the recorded quarantine artifact.";
  await writeJournal(deps, {
    packageId: record.id,
    planId,
    phase: "quarantine_cleanup",
    remediation,
  });
  return {
    status: "partial_failure",
    packageId: record.id,
    planId,
    code: "quarantine_cleanup_failed",
    storage: {
      quarantined: prepared,
      restored: false,
      recordRemoved: true,
      quarantineDiscarded: false,
    },
    remediation: [remediation],
  };
}

async function commitDelete(
  record: PackageReconcileRecord,
  live: PackageNamespaceApplyResult,
  deps: ReconcilePackageNamespaceDependencies,
  planId: string,
  handle: PackageQuarantineHandle,
): Promise<ReconcilePackageNamespaceReport> {
  try {
    await deps.records.remove(record);
    if (await deps.records.exists(record.id, record.scope)) throw new Error("record still present");
  } catch {
    return registryFailure(record, deps, planId, handle);
  }
  try {
    if (handle.prepared) await deps.staging.discard(handle);
  } catch {
    return cleanupFailure(record, deps, planId, handle.prepared);
  }
  return {
    status: "applied",
    packageId: record.id,
    planId,
    live,
    storage: {
      quarantined: handle.prepared,
      restored: false,
      recordRemoved: true,
      quarantineDiscarded: handle.prepared,
    },
  };
}

async function runDelete(
  input: ReconcilePackageNamespaceInput,
  record: PackageReconcileRecord,
  deps: ReconcilePackageNamespaceDependencies,
  planId: string,
): Promise<ReconcilePackageNamespaceReport> {
  let handle: PackageQuarantineHandle;
  try {
    handle = await deps.staging.quarantine(record);
  } catch {
    return failed(
      input.packageId,
      "quarantine_failed",
      "Live deletion was not attempted; repair local staging and run a new dry-run.",
      planId,
    );
  }
  const live = await applyDeleteLive(input, deps, planId);
  if (live === undefined) {
    const restored = await safeRestore(deps, handle);
    return {
      status: "failed",
      packageId: record.id,
      planId,
      code: "live_apply_failed",
      storage: {
        ...untouchedStorage(),
        quarantined: handle.prepared,
        restored,
      },
      remediation: [
        "Installed state was retained; verify the live node and local staging before creating a new plan.",
      ],
    };
  }
  if (live.action_applied === "delete") return commitDelete(record, live, deps, planId, handle);
  const restored = await safeRestore(deps, handle);
  return {
    status: live.action_applied === "keep" ? "kept" : "applied",
    packageId: record.id,
    planId,
    live,
    storage: {
      ...untouchedStorage(),
      quarantined: handle.prepared,
      restored,
    },
  };
}

async function runApply(
  input: ReconcilePackageNamespaceInput,
  record: PackageReconcileRecord,
  deps: ReconcilePackageNamespaceDependencies,
): Promise<ReconcilePackageNamespaceReport> {
  const planId = input.planId;
  if (planId === undefined) {
    return failed(
      input.packageId,
      "plan_required",
      "Run dry-run first and use its opaque plan id.",
    );
  }
  if (input.choice === "Keep") {
    return { status: "kept", packageId: record.id, planId, storage: untouchedStorage() };
  }
  const stale = await verifyFreshRecord(input, record, deps, planId);
  if (stale !== undefined) return stale;
  if (input.choice === "Bypass") return runBypass(record, deps, planId);
  return runDelete(input, record, deps, planId);
}

async function reconcileParsedInput(
  input: ReconcilePackageNamespaceInput,
  deps: ReconcilePackageNamespaceDependencies,
): Promise<ReconcilePackageNamespaceReport> {
  let record: PackageReconcileRecord | undefined;
  try {
    record = await readMatchingRecord(input, deps);
  } catch {
    return failed(input.packageId, "package_state_invalid", "Repair the installed package record.");
  }
  if (record === undefined) {
    return failed(input.packageId, "package_not_recorded", "Run package list before reconciling.");
  }
  return input.dryRun ? runDryRun(input, record, deps) : runApply(input, record, deps);
}

function unsafePackageId(value: ReconcilePackageNamespaceInput): string {
  return typeof value?.packageId === "string" ? value.packageId.slice(0, 128) : "unknown";
}

/**
 * Coordinate one dry-run/check or one ordered local+TD apply transaction.
 *
 * All external effects are dependency-injected so manage_packages can bind its
 * existing scoped registry and bridge client without this isolated module editing
 * shared files. The function never throws and never returns source/staging paths.
 */
export async function reconcilePackageNamespace(
  unsafeInput: ReconcilePackageNamespaceInput,
  deps: ReconcilePackageNamespaceDependencies,
): Promise<ReconcilePackageNamespaceReport> {
  const parsed = ReconcilePackageNamespaceInputSchema.safeParse(unsafeInput);
  if (!parsed.success) {
    return failed(
      unsafePackageId(unsafeInput),
      "invalid_input",
      "Correct the bounded reconciliation input.",
    );
  }
  return reconcileParsedInput(parsed.data, deps);
}

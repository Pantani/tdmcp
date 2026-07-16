import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { EditorGroundingEvidence } from "./editorGrounding.js";
import type { RecoveryReport } from "./failureRecovery.js";
import type { MutationVerificationReport, VerificationStatus } from "./mutationVerification.js";
import type { ToolOutcome } from "./tools.js";

export const TURN_RECEIPT_SCHEMA_VERSION = 1 as const;
export const TURN_RECEIPT_MAX_BYTES = 8 * 1024;
export const TURN_RECEIPT_STORE_MAX_BYTES = 256 * 1024;
export const TURN_RECEIPT_STORE_MAX_RECEIPTS = 100;
export const TURN_RECEIPT_STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TURN_RECEIPT_STORE_PATH = join(homedir(), ".tdmcp", "session-receipts.json");

const VerificationStatusSchema = z.enum(["PASS", "FAIL", "UNVERIFIED"]);
const TierSchema = z.enum(["safe", "standard", "creative", "chat"]);
const TerminalStatusSchema = z.enum(["success", "failed", "cancelled", "max_steps"]);
const PersistenceStatusSchema = z.enum(["off", "show_mode", "emergency", "written", "failed"]);
const ActionStatusSchema = z.enum(["success", "failed", "cancelled"]);
const GroundingStatusSchema = z.enum(["available", "unavailable", "skipped", "failed"]);
const DecisionSchema = z.enum([
  "Delete",
  "Bypass",
  "Keep",
  "Overwrite",
  "Allow",
  "Deny",
  "Cancel",
  "Approved",
  "Rejected",
]);
const AppliedActionSchema = z.enum([
  "create",
  "update",
  "delete",
  "bypass",
  "keep",
  "connect",
  "save",
  "overwrite",
  "pulse",
  "rename",
  "move",
  "rollback",
  "restore",
  "none",
]);
const RecoveryCategorySchema = z.enum([
  "bad_json",
  "invalid_args",
  "bridge_offline",
  "bridge_stale",
  "timeout_ambiguous",
  "auth_or_policy",
  "path_missing",
  "menu_invalid",
  "verification_failed",
  "unknown",
]);
const RecoveryActionSchema = z.enum([
  "return_validation_evidence",
  "probe_bridge",
  "probe_exact_path",
  "probe_menu",
  "stop",
]);

export const TurnReceiptVerificationSchema = z
  .object({
    status: VerificationStatusSchema,
    passed: z.number().int().min(0).max(16),
    failed: z.number().int().min(0).max(16),
    unverified: z.number().int().min(0).max(16),
  })
  .strict();

export const TurnReceiptRecoverySchema = z
  .object({
    category: RecoveryCategorySchema,
    action: RecoveryActionSchema,
    outcome: z.enum(["recovered", "stopped"]),
    budget_used: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export const TurnReceiptActionSchema = z
  .object({
    tool: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9_.:-]+$/u),
    status: ActionStatusSchema,
    affected_paths: z.array(z.string().min(1).max(240).startsWith("/")).max(16),
    decision: DecisionSchema.optional(),
    action_applied: AppliedActionSchema.optional(),
    undo_identity: z.string().min(1).max(160).optional(),
    verification: TurnReceiptVerificationSchema.optional(),
    recovery: TurnReceiptRecoverySchema.optional(),
  })
  .strict();

export const TurnReceiptV1Schema = z
  .object({
    schema_version: z.literal(TURN_RECEIPT_SCHEMA_VERSION),
    receipt_id: z.string().uuid(),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    duration_ms: z.number().int().min(0).max(300_000),
    terminal_status: TerminalStatusSchema,
    requested_tier: TierSchema,
    effective_tier: TierSchema,
    grounding: z
      .object({
        status: GroundingStatusSchema,
        verification: VerificationStatusSchema,
      })
      .strict(),
    goal_summary: z.string().max(500),
    actions: z.array(TurnReceiptActionSchema).max(32),
    overall_verification: VerificationStatusSchema,
    warnings: z.array(z.string().min(1).max(240)).max(16),
    persistence: PersistenceStatusSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!tierWithinPolicy(receipt.requested_tier, receipt.effective_tier)) {
      ctx.addIssue({
        code: "custom",
        path: ["effective_tier"],
        message: "effective tier exceeds requested policy",
      });
    }
    const totalPaths = receipt.actions.reduce(
      (count, action) => count + action.affected_paths.length,
      0,
    );
    if (totalPaths > 16) {
      ctx.addIssue({
        code: "custom",
        path: ["actions"],
        message: "receipt contains more than 16 affected paths",
      });
    }
    if (receipt.overall_verification !== reduceVerification(receipt.actions)) {
      ctx.addIssue({
        code: "custom",
        path: ["overall_verification"],
        message: "overall verification conflicts with action evidence",
      });
    }
    if (serializedBytes(receipt) > TURN_RECEIPT_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: "receipt exceeds 8 KiB" });
    }
  });

export type TurnReceiptV1 = z.infer<typeof TurnReceiptV1Schema>;
export type TurnReceiptAction = z.infer<typeof TurnReceiptActionSchema>;
export type TurnReceiptTier = z.infer<typeof TierSchema>;
export type TurnReceiptTerminalStatus = z.infer<typeof TerminalStatusSchema>;
export type TurnReceiptPersistenceStatus = z.infer<typeof PersistenceStatusSchema>;

/** Compact adapter-safe summary; never includes goal text, paths, arguments, or payloads. */
export function formatTurnReceiptSummary(receipt: TurnReceiptV1): string {
  return `tdmcp receipt: ${receipt.receipt_id} — ${receipt.terminal_status}/${receipt.overall_verification}`;
}

export const TurnReceiptStoreSchema = z
  .object({
    schema_version: z.literal(TURN_RECEIPT_SCHEMA_VERSION),
    receipts: z.array(TurnReceiptV1Schema).max(TURN_RECEIPT_STORE_MAX_RECEIPTS),
  })
  .strict();

export type TurnReceiptStore = z.infer<typeof TurnReceiptStoreSchema>;

const TIER_RANK: Record<TurnReceiptTier, number> = {
  chat: 0,
  safe: 1,
  standard: 2,
  creative: 3,
};

function tierWithinPolicy(requested: TurnReceiptTier, effective: TurnReceiptTier): boolean {
  if (requested === "chat") return effective === "chat";
  return TIER_RANK[effective] <= TIER_RANK[requested];
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function codePointSlice(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [^-\r\n]{0,48}PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]{0,48}PRIVATE KEY-----/giu;
const DATA_URL_PATTERN = /data:[^\s,;]{0,120}(?:;[^\s,;]{0,80})*;base64,[A-Za-z0-9+/=_-]+/giu;
const BEARER_PATTERN = /\b(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]+/giu;
const HEADER_SECRET_PATTERN = /\b(authorization|cookie)\s*[:=]\s*[^\r\n]+/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /["']?(api[-_]?key|(?:access|refresh|auth)[-_]?token|token|authorization|cookie|password|passwd|private[-_]?key|client[-_]?secret|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;\]}]+)/giu;
const BASE64_RUN_PATTERN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-])/gu;

/** Redacts secret-bearing material without retaining the matched value. */
export function redactReceiptText(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  const printable = Array.from(value)
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point === 0x0a || point === 0x09 || (point >= 0x20 && point !== 0x7f);
    })
    .join("");
  const redacted = printable
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(DATA_URL_PATTERN, "[REDACTED_DATA_URL]")
    .replace(BEARER_PATTERN, "[REDACTED_BEARER]")
    .replace(HEADER_SECRET_PATTERN, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(BASE64_RUN_PATTERN, "[REDACTED_BASE64]");
  return codePointSlice(redacted.trim(), max);
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string") return "unknown_tool";
  const candidate = codePointSlice(value, 120);
  return /^[A-Za-z0-9_.:-]+$/u.test(candidate) ? candidate : "unknown_tool";
}

function safeAbsolutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  const candidate = codePointSlice(value, 240);
  const hasControl = Array.from(candidate).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 0x20 || point === 0x7f;
  });
  if (hasControl) return undefined;
  return candidate;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function allowlistedDecision(value: unknown): TurnReceiptAction["decision"] {
  const parsed = DecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function allowlistedAction(value: unknown): TurnReceiptAction["action_applied"] {
  const parsed = AppliedActionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const UNDO_KEYS = ["undo_identity", "undo_label", "checkpoint_identity", "checkpoint_name"];
const PATH_KEYS = ["final_path", "path", "deleted", "bypassed"];

function structuredPaths(value: Record<string, unknown> | undefined): string[] {
  if (!value) return [];
  const scalar = PATH_KEYS.map((key) => safeAbsolutePath(value[key]));
  const listed = Array.isArray(value.affected_paths)
    ? value.affected_paths.map(safeAbsolutePath)
    : [];
  return [...scalar, ...listed].filter((path): path is string => path !== undefined);
}

function structuredUndoIdentity(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  for (const key of UNDO_KEYS) {
    const candidate = redactReceiptText(value[key], 160);
    if (candidate.length > 0) return candidate;
  }
  return undefined;
}

function verificationProjection(
  report: MutationVerificationReport | undefined,
): TurnReceiptAction["verification"] {
  if (!report) return undefined;
  return {
    status: report.status,
    passed: report.checks.filter((check) => check.status === "PASS").length,
    failed: report.checks.filter((check) => check.status === "FAIL").length,
    unverified: report.checks.filter((check) => check.status === "UNVERIFIED").length,
  };
}

function recoveryProjection(report: RecoveryReport | undefined): TurnReceiptAction["recovery"] {
  if (!report) return undefined;
  return {
    category: report.category,
    action: report.action,
    outcome: report.outcome,
    budget_used: report.budgetUsed,
  };
}

function uniquePaths(paths: unknown[], remaining: number): string[] {
  const safe = paths.map(safeAbsolutePath).filter((path): path is string => path !== undefined);
  return [...new Set(safe)].slice(0, Math.max(0, remaining));
}

function reduceVerification(actions: TurnReceiptAction[]): VerificationStatus {
  const statuses = actions
    .map((action) => action.verification?.status)
    .filter((status): status is VerificationStatus => status !== undefined);
  if (statuses.length === 0) return "UNVERIFIED";
  if (statuses.includes("FAIL")) return "FAIL";
  return statuses.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
}

const EMERGENCY_TOOL_PATTERN =
  /(panic|blackout|emergency|e[-_]?stop|fail[-_]?safe|kill[-_]?switch|master[-_]?kill|stop[-_]?all|all[-_]?stop)/iu;

export function isEmergencyReceiptTool(tool: string): boolean {
  return EMERGENCY_TOOL_PATTERN.test(tool);
}

export interface TurnReceiptCollectorOptions {
  requestedTier: TurnReceiptTier;
  effectiveTier: TurnReceiptTier;
  goalSummaryFromLatestUserMessage: string;
  persistence?: "off" | "persist";
  noPersist?: boolean;
  storePath?: string;
  receiptId?: string;
  startedAt?: Date;
  now?: () => number;
  store?: TurnReceiptStoreAdapter;
  onReceipt?: (receipt: TurnReceiptV1) => void | Promise<void>;
}

export interface RecordTurnActionInput {
  tool: string;
  status: "success" | "failed" | "cancelled";
  affectedPaths?: string[];
  structuredContent?: Record<string, unknown>;
  verification?: MutationVerificationReport;
  recovery?: RecoveryReport;
  callId?: string;
}

export interface FinalizeTurnReceiptInput {
  terminalStatus: TurnReceiptTerminalStatus;
}

export interface TurnReceiptCollector {
  readonly receiptId: string;
  recordGrounding(evidence?: EditorGroundingEvidence): void;
  recordAction(input: RecordTurnActionInput): void;
  recordToolOutcome(tool: string, outcome: ToolOutcome, callId?: string): void;
  addWarning(warning: string): void;
  finalize(input: FinalizeTurnReceiptInput): Promise<TurnReceiptV1>;
}

type MutableReceiptState = {
  grounding: TurnReceiptV1["grounding"];
  actions: TurnReceiptAction[];
  warnings: string[];
  pathCount: number;
  performMode: boolean;
  emergency: boolean;
};

function actionFromInput(input: RecordTurnActionInput, remainingPaths: number): TurnReceiptAction {
  const structured = objectValue(input.structuredContent);
  const paths = uniquePaths(
    [...(input.affectedPaths ?? []), ...structuredPaths(structured)],
    remainingPaths,
  );
  const decision = allowlistedDecision(structured?.decision);
  const actionApplied = allowlistedAction(structured?.action_applied);
  const undoIdentity = structuredUndoIdentity(structured);
  return TurnReceiptActionSchema.parse({
    tool: safeToolName(input.tool),
    status: input.status,
    affected_paths: paths,
    ...(decision ? { decision } : {}),
    ...(actionApplied ? { action_applied: actionApplied } : {}),
    ...(undoIdentity ? { undo_identity: undoIdentity } : {}),
    ...(input.verification ? { verification: verificationProjection(input.verification) } : {}),
    ...(input.recovery ? { recovery: recoveryProjection(input.recovery) } : {}),
  });
}

function projectActionSafely(
  input: RecordTurnActionInput,
  remainingPaths: number,
): { action: TurnReceiptAction; projectionFailed: boolean } {
  try {
    return { action: actionFromInput(input, remainingPaths), projectionFailed: false };
  } catch {
    const status = ActionStatusSchema.safeParse(input.status);
    return {
      action: {
        tool: safeToolName(input.tool),
        status: status.success ? status.data : "failed",
        affected_paths: uniquePaths(input.affectedPaths ?? [], remainingPaths),
      },
      projectionFailed: true,
    };
  }
}

function claimToolCall(callIds: Set<string>, callId: string | undefined): boolean {
  if (!callId) return true;
  if (callIds.has(callId)) return false;
  callIds.add(callId);
  return true;
}

function appendAction(
  state: MutableReceiptState,
  projected: ReturnType<typeof projectActionSafely>,
) {
  state.actions.push(projected.action);
  state.pathCount += projected.action.affected_paths.length;
  state.emergency ||= isEmergencyReceiptTool(projected.action.tool);
  if (projected.projectionFailed && state.warnings.length < 16) {
    state.warnings.push("receipt_action_projection_failed");
  }
}

function toolOutcomeInput(
  tool: string,
  outcome: ToolOutcome,
  callId?: string,
): RecordTurnActionInput {
  return {
    tool,
    status: outcome.ok ? "success" : "failed",
    affectedPaths: [
      ...(outcome.affectedPaths ?? []),
      ...(outcome.mutationPlan?.affectedPaths ?? []),
    ],
    structuredContent: outcome.structuredContent,
    verification: outcome.verification,
    recovery: outcome.recovery,
    callId,
  };
}

function receiptPersistenceDisposition(
  options: TurnReceiptCollectorOptions,
  state: MutableReceiptState,
): Exclude<TurnReceiptPersistenceStatus, "written" | "failed"> | undefined {
  if (state.emergency) return "emergency";
  if (state.performMode) return "show_mode";
  if (options.noPersist || options.persistence !== "persist") return "off";
  return undefined;
}

function verificationRepresentative(
  actions: TurnReceiptAction[],
  verification: VerificationStatus,
): TurnReceiptAction | undefined {
  const matching = actions.find((action) => action.verification?.status === verification);
  return matching ?? actions.find((action) => action.verification === undefined);
}

function trimReceiptWarnings(receipt: TurnReceiptV1): boolean {
  let changed = false;
  while (serializedBytes(receipt) > TURN_RECEIPT_MAX_BYTES && receipt.warnings.length > 0) {
    receipt.warnings.pop();
    changed = true;
  }
  return changed;
}

function trimReceiptGoal(receipt: TurnReceiptV1): boolean {
  let changed = false;
  while (serializedBytes(receipt) > TURN_RECEIPT_MAX_BYTES && receipt.goal_summary.length > 0) {
    receipt.goal_summary = codePointSlice(receipt.goal_summary, receipt.goal_summary.length - 40);
    changed = true;
  }
  return changed;
}

function trimOptionalActionEvidence(receipt: TurnReceiptV1): boolean {
  let changed = false;
  for (const action of [...receipt.actions].reverse()) {
    if (serializedBytes(receipt) <= TURN_RECEIPT_MAX_BYTES) break;
    if (action.undo_identity !== undefined) {
      delete action.undo_identity;
      changed = true;
    }
    if (serializedBytes(receipt) <= TURN_RECEIPT_MAX_BYTES) break;
    if (action.recovery !== undefined) {
      delete action.recovery;
      changed = true;
    }
  }
  return changed;
}

function actionAuditImportance(action: TurnReceiptAction): number {
  if (action.verification?.status === "FAIL") return 5;
  if (action.status !== "success") return 4;
  if (action.verification?.status === "UNVERIFIED") return 3;
  if (action.verification === undefined) return 2;
  return 1;
}

function leastImportantActionIndex(
  actions: TurnReceiptAction[],
  representative: TurnReceiptAction | undefined,
): number {
  let candidate = -1;
  let candidateImportance = Number.POSITIVE_INFINITY;
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (!action || action === representative) continue;
    const score = actionAuditImportance(action);
    if (score < candidateImportance) {
      candidate = index;
      candidateImportance = score;
    }
  }
  return candidate;
}

function trimReceiptActions(
  receipt: TurnReceiptV1,
  representative: TurnReceiptAction | undefined,
): boolean {
  let changed = false;
  while (serializedBytes(receipt) > TURN_RECEIPT_MAX_BYTES && receipt.actions.length > 1) {
    const candidate = leastImportantActionIndex(receipt.actions, representative);
    if (candidate < 0) break;
    receipt.actions.splice(candidate, 1);
    changed = true;
  }
  return changed;
}

function annotateCompactedReceipt(receipt: TurnReceiptV1): void {
  const warning = "receipt_compacted_preserving_worst_verification";
  receipt.warnings = [warning, ...receipt.warnings.filter((item) => item !== warning)].slice(0, 16);
  while (serializedBytes(receipt) > TURN_RECEIPT_MAX_BYTES && receipt.warnings.length > 1) {
    receipt.warnings.pop();
  }
  trimReceiptGoal(receipt);
}

function compactReceipt(receipt: TurnReceiptV1): TurnReceiptV1 {
  const compacted = structuredClone(receipt);
  const originalVerification = reduceVerification(compacted.actions);
  const representative = verificationRepresentative(compacted.actions, originalVerification);
  const warningsTrimmed = trimReceiptWarnings(compacted);
  const goalTrimmed = trimReceiptGoal(compacted);
  const optionalEvidenceTrimmed = trimOptionalActionEvidence(compacted);
  const actionsTrimmed = trimReceiptActions(compacted, representative);
  compacted.overall_verification = reduceVerification(compacted.actions);
  if (compacted.overall_verification !== originalVerification) {
    throw new Error("receipt compaction would weaken verification evidence");
  }
  if (warningsTrimmed || goalTrimmed || optionalEvidenceTrimmed || actionsTrimmed) {
    annotateCompactedReceipt(compacted);
  }
  return TurnReceiptV1Schema.parse(compacted);
}

function baseReceipt(
  options: TurnReceiptCollectorOptions,
  state: MutableReceiptState,
  terminalStatus: TurnReceiptTerminalStatus,
  receiptId: string,
  startedAtMs: number,
  completedAtMs: number,
  persistence: TurnReceiptPersistenceStatus,
): TurnReceiptV1 {
  const receipt = {
    schema_version: TURN_RECEIPT_SCHEMA_VERSION,
    receipt_id: receiptId,
    started_at: new Date(startedAtMs).toISOString(),
    completed_at: new Date(completedAtMs).toISOString(),
    duration_ms: Math.max(0, Math.min(300_000, completedAtMs - startedAtMs)),
    terminal_status: terminalStatus,
    requested_tier: options.requestedTier,
    effective_tier: options.effectiveTier,
    grounding: state.grounding,
    goal_summary: redactReceiptText(options.goalSummaryFromLatestUserMessage),
    actions: state.actions,
    overall_verification: reduceVerification(state.actions),
    warnings: state.warnings,
    persistence,
  } satisfies TurnReceiptV1;
  return compactReceipt(receipt);
}

async function finalizePersistence(
  options: TurnReceiptCollectorOptions,
  state: MutableReceiptState,
  build: (persistence: TurnReceiptPersistenceStatus) => TurnReceiptV1,
): Promise<TurnReceiptV1> {
  const disposition = receiptPersistenceDisposition(options, state);
  if (disposition) return build(disposition);
  const path = resolveTurnReceiptStorePath(options.storePath);
  if (!path) {
    state.warnings = [...state.warnings, "receipt_persistence_failed"].slice(0, 16);
    return build("failed");
  }
  const candidate = build("written");
  try {
    const result = await (options.store ?? fileTurnReceiptStore).write(path, candidate);
    if (result === "written") return candidate;
  } catch {
    // Receipt storage is best effort and cannot alter the agent turn result.
  }
  state.warnings = [...state.warnings, "receipt_persistence_failed"].slice(0, 16);
  return build("failed");
}

/** Creates one idempotent, allowlist-only receipt collector for a copilot turn. */
export function createTurnReceiptCollector(
  options: TurnReceiptCollectorOptions,
): TurnReceiptCollector {
  const receiptId = z
    .string()
    .uuid()
    .parse(options.receiptId ?? randomUUID());
  const now = options.now ?? Date.now;
  const startedAtMs = options.startedAt?.getTime() ?? now();
  if (!tierWithinPolicy(options.requestedTier, options.effectiveTier)) {
    throw new Error("effective receipt tier exceeds requested policy");
  }
  const state: MutableReceiptState = {
    grounding: { status: "skipped", verification: "UNVERIFIED" },
    actions: [],
    warnings: [],
    pathCount: 0,
    performMode: false,
    emergency: false,
  };
  const callIds = new Set<string>();
  let finalized: Promise<TurnReceiptV1> | undefined;

  const recordAction = (input: RecordTurnActionInput): void => {
    if (finalized || state.actions.length >= 32) return;
    if (!claimToolCall(callIds, input.callId)) return;
    appendAction(state, projectActionSafely(input, 16 - state.pathCount));
  };

  return {
    receiptId,
    recordGrounding(evidence) {
      if (finalized) return;
      state.grounding = evidence
        ? { status: evidence.status, verification: evidence.verification }
        : { status: "failed", verification: "UNVERIFIED" };
      state.performMode = evidence?.context?.perform_mode === true;
    },
    recordAction,
    recordToolOutcome(tool, outcome, callId) {
      recordAction(toolOutcomeInput(tool, outcome, callId));
    },
    addWarning(warning) {
      if (finalized || state.warnings.length >= 16) return;
      const safe = redactReceiptText(warning, 240);
      if (safe.length > 0) state.warnings.push(safe);
    },
    finalize(input) {
      if (finalized) return finalized;
      const terminalStatus = TerminalStatusSchema.parse(input.terminalStatus);
      const completedAtMs = now();
      const build = (persistence: TurnReceiptPersistenceStatus) =>
        baseReceipt(
          options,
          state,
          terminalStatus,
          receiptId,
          startedAtMs,
          completedAtMs,
          persistence,
        );
      finalized = finalizePersistence(options, state, build).then(async (receipt) => {
        try {
          await options.onReceipt?.(receipt);
        } catch {
          // An adapter/event sink cannot change or duplicate the completed receipt.
        }
        return receipt;
      });
      return finalized;
    },
  };
}

export function resolveTurnReceiptStorePath(path?: string): string | undefined {
  const candidate = path?.trim();
  if (!candidate) return DEFAULT_TURN_RECEIPT_STORE_PATH;
  return isAbsolute(candidate) ? resolve(candidate) : undefined;
}

type StoreReadResult =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "available"; store: TurnReceiptStore };

export interface TurnReceiptStoreAdapter {
  write(path: string, receipt: TurnReceiptV1): Promise<"written" | "failed">;
}

function unsafePrivateMode(mode: number): boolean {
  return process.platform !== "win32" && (mode & 0o077) !== 0;
}

function unsafeWritableMode(mode: number): boolean {
  return process.platform !== "win32" && (mode & 0o022) !== 0;
}

function readNoFollow(path: string): string | undefined {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > TURN_RECEIPT_STORE_MAX_BYTES) {
      return undefined;
    }
    if (unsafePrivateMode(before.mode)) return undefined;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > TURN_RECEIPT_STORE_MAX_BYTES) return undefined;
    if (unsafePrivateMode(opened.mode)) return undefined;
    return readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readTurnReceiptStore(path: string): StoreReadResult {
  if (!isAbsolute(path) || !privateCanonicalParent(path, false)) return { state: "invalid" };
  try {
    lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "invalid" };
  }
  const raw = readNoFollow(path);
  if (raw === undefined) return { state: "invalid" };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const store = TurnReceiptStoreSchema.safeParse(parsed);
    return store.success && serializedBytes(store.data) <= TURN_RECEIPT_STORE_MAX_BYTES
      ? { state: "available", store: store.data }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

function privateCanonicalParent(path: string, create: boolean): boolean {
  const parent = dirname(path);
  try {
    if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const info = lstatSync(parent);
    return (
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      !unsafeWritableMode(info.mode) &&
      realpathSync(parent) === resolve(parent)
    );
  } catch {
    return false;
  }
}

function existingTargetIsSafe(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() && !unsafePrivateMode(info.mode);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

type StoreLockAttempt = number | "retry" | "wait" | "failed";

function inspectStoreLock(lockPath: string): Exclude<StoreLockAttempt, number> {
  try {
    const info = lstatSync(lockPath);
    return info.isSymbolicLink() || !info.isFile() || unsafePrivateMode(info.mode)
      ? "failed"
      : "wait";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "retry" : "failed";
  }
}

function attemptStoreLock(lockPath: string): StoreLockAttempt {
  try {
    return openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "failed";
    return inspectStoreLock(lockPath);
  }
}

async function acquireStoreLock(path: string): Promise<number | undefined> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    const attempt = attemptStoreLock(lockPath);
    if (typeof attempt === "number") return attempt;
    if (attempt === "failed") return undefined;
    if (attempt === "wait") await delay(20);
  }
  return undefined;
}

function pruneStore(receipts: TurnReceiptV1[], now: number): TurnReceiptStore {
  const cutoff = now - TURN_RECEIPT_STORE_MAX_AGE_MS;
  const deduped = new Map<string, TurnReceiptV1>();
  for (const receipt of receipts) {
    if (Date.parse(receipt.completed_at) < cutoff) continue;
    if (!deduped.has(receipt.receipt_id)) deduped.set(receipt.receipt_id, receipt);
  }
  const newest = [...deduped.values()]
    .sort((left, right) => Date.parse(right.completed_at) - Date.parse(left.completed_at))
    .slice(0, TURN_RECEIPT_STORE_MAX_RECEIPTS);
  const store: TurnReceiptStore = {
    schema_version: TURN_RECEIPT_SCHEMA_VERSION,
    receipts: newest,
  };
  while (serializedBytes(store) > TURN_RECEIPT_STORE_MAX_BYTES && store.receipts.length > 0) {
    store.receipts.pop();
  }
  return TurnReceiptStoreSchema.parse(store);
}

function mergeStore(path: string, receipt: TurnReceiptV1): TurnReceiptStore | undefined {
  const current = readTurnReceiptStore(path);
  if (current.state === "invalid") return undefined;
  const existing = current.state === "available" ? current.store.receipts : [];
  return pruneStore([receipt, ...existing], Date.now());
}

function atomicPrivateWrite(path: string, store: TurnReceiptStore): boolean {
  const serialized = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > TURN_RECEIPT_STORE_MAX_BYTES) return false;
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    const readback = readTurnReceiptStore(path);
    return readback.state === "available";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

export const fileTurnReceiptStore: TurnReceiptStoreAdapter = {
  async write(path, receipt) {
    if (!isAbsolute(path) || !privateCanonicalParent(path, true) || !existingTargetIsSafe(path)) {
      return "failed";
    }
    const lockPath = `${path}.lock`;
    const lockFd = await acquireStoreLock(path);
    if (lockFd === undefined) return "failed";
    try {
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, created_at: Date.now() }));
      fsyncSync(lockFd);
      const merged = mergeStore(path, receipt);
      return merged && atomicPrivateWrite(path, merged) ? "written" : "failed";
    } catch {
      return "failed";
    } finally {
      closeSync(lockFd);
      rmSync(lockPath, { force: true });
    }
  },
};

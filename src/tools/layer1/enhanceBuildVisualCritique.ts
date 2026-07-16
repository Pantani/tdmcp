import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const VISUAL_CRITIQUE_RUBRIC_ID = "tdmcp.visual.basic.v1" as const;
export const VISUAL_CRITIQUE_FIXTURE_SUITE = "2026-07-15.3" as const;
export const VISUAL_CRITIQUE_FIXTURE_RECEIPT_ID =
  "wave14_td_fixture_2026-07-15.3_qwen3-vl-8b-q4km" as const;
export const VISUAL_CRITIQUE_WEIGHTS = {
  composition_hierarchy: 0.3,
  palette_coherence: 0.25,
  contrast_legibility: 0.25,
  spatial_balance: 0.2,
} as const;

const tdPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value.startsWith("/"), "TouchDesigner paths must be absolute")
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      }),
    "TouchDesigner paths cannot contain controls",
  )
  .refine(
    (value) => value.split("/").every((segment) => segment !== ".." && segment !== "."),
    "TouchDesigner paths cannot contain traversal segments",
  );

export const visualCritiqueTargetSchema = z
  .object({
    nodePath: tdPathSchema,
    parameter: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    minimum: z.number().finite().min(-1_000_000),
    maximum: z.number().finite().max(1_000_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minimum >= value.maximum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maximum"],
        message: "maximum must be greater than minimum",
      });
    }
  });

export const visualCritiqueSchema = z
  .object({
    outputTopPath: tdPathSchema,
    targets: z.array(visualCritiqueTargetSchema).min(1).max(6),
    maxChanges: z.number().int().min(1).max(3).default(3),
    maxIterations: z.number().int().min(1).max(2).default(1),
    regressionThreshold: z.number().int().min(0).max(20).default(5),
    confirmationTimeoutMs: z.number().int().min(5_000).max(120_000).default(30_000),
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    fixtureReceiptId: z
      .literal(VISUAL_CRITIQUE_FIXTURE_RECEIPT_ID)
      .default(VISUAL_CRITIQUE_FIXTURE_RECEIPT_ID),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.targets.forEach((target, index) => {
      const key = `${target.nodePath}\0${target.parameter}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", index],
          message: "target nodePath/parameter pairs must be unique",
        });
      }
      seen.add(key);
    });
  });

export type VisualCritiqueArgs = z.infer<typeof visualCritiqueSchema>;

const visualRubricSchema = z
  .object({
    composition_hierarchy: z.number().int().min(0).max(100),
    palette_coherence: z.number().int().min(0).max(100),
    contrast_legibility: z.number().int().min(0).max(100),
    spatial_balance: z.number().int().min(0).max(100),
  })
  .strict();

const visualChangeSchema = z
  .object({
    target_id: z.string().regex(/^t[1-6]$/),
    value: z.number().finite(),
    rationale: z.string().max(160),
    risk: z.enum(["low", "medium"]),
  })
  .strict();

export const visualProposalSchema = z
  .object({
    rubric: visualRubricSchema,
    summary: z.string().max(240),
    changes: z.array(visualChangeSchema).max(3),
  })
  .strict();

export type VisualRubric = z.infer<typeof visualRubricSchema>;
export type VisualProposal = z.infer<typeof visualProposalSchema>;
export type VisualCritiqueStatus = "PASS" | "FAIL" | "UNVERIFIED";
export type VisualDecisionState = "pending" | "resolved" | "expired" | "cancelled" | "failed";

export interface VisualModelIdentity {
  provider: string;
  model: string;
  digest: string;
  quantization?: string;
  fingerprint: string;
  advertisesVision: boolean;
}

export interface VisualCalibrationEvidence {
  status: "PASS" | "FAIL" | "UNVERIFIED";
  model: string;
  digest: string;
  fingerprint: string;
  reusableForMutation: boolean;
  expiresAtMs: number;
  imageInput: {
    status: "PASS" | "FAIL" | "UNVERIFIED";
    passed: number;
    failed: number;
    unverified: number;
  };
}

export interface VisualFixtureEvidence {
  result: "PASS" | "FAIL" | "UNVERIFIED";
  suite: string;
  rubricId: string;
  model: string;
  digest: string;
  calibrationFingerprint: string;
  strictResponses: number;
  goodSpread: number;
  badSpread: number;
  medianDelta: number;
  expiresAtMs: number;
}

export interface VisualGateEvidence {
  identity: VisualModelIdentity;
  calibration: VisualCalibrationEvidence;
  fixture: VisualFixtureEvidence;
}

export interface InspectedVisualTarget {
  id: `t${1 | 2 | 3 | 4 | 5 | 6}`;
  path: string;
  parameter: string;
  type: "Float" | "Int";
  mode: "CONSTANT";
  value: number;
  minimum: number;
  maximum: number;
}

export interface VisualInspection {
  scopePath: string;
  outputTopPath: string;
  fingerprint: string;
  targets: InspectedVisualTarget[];
}

export interface VisualTechnicalEvidence {
  errorCount: number;
  perfScore?: number;
  previewReadable: boolean;
}

export interface VisualPreviewEvidence {
  base64: string;
  mimeType: "image/png";
  width: 640;
  height: 360;
  technical: VisualTechnicalEvidence;
}

export interface VisualModelRequest {
  mode: "proposal" | "verification";
  image: { base64: string; mimeType: "image/png" };
  targets: Array<{ id: string; current: number; minimum: number; maximum: number }>;
  maxChanges: number;
  signal?: AbortSignal;
}

export interface VisualModelResponse {
  text: string;
  identity: Pick<VisualModelIdentity, "model" | "digest" | "fingerprint">;
}

export interface VisualApprovalRequest {
  kind: "visual_parameter_apply";
  title: string;
  detail: string;
  choices: readonly ["Apply", "Keep"];
  safeChoice: "Keep";
  ttlMs: number;
  dedupeKey: string;
  expectedFingerprint: string;
  proposalDigest: string;
  changes: Array<{ targetId: string; value: number }>;
  signal?: AbortSignal;
}

export interface VisualApprovalResult {
  requestId?: string;
  state: VisualDecisionState;
  choice: "Apply" | "Keep";
}

export interface VisualCommitRequest {
  scopePath: string;
  outputTopPath: string;
  expectedFingerprint: string;
  proposalDigest: string;
  idempotencyKey: string;
  interactionId: string;
  changes: Array<{ targetId: string; value: number }>;
  signal?: AbortSignal;
}

export type VisualCommitResult =
  | { status: "ambiguous" }
  | { status: "conflict"; reason?: string }
  | { status: "failed"; reason?: string }
  | {
      status: "committed";
      applied: true;
      verified: true;
      finalFingerprint: string;
      restoreToken: string;
      readback: Array<{ targetId: string; value: number }>;
      undoLabel?: string;
    };

export interface VisualRestoreRequest {
  restoreToken: string;
  expectedCommittedFingerprint: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface VisualRestoreResult {
  restored: boolean;
  verified: boolean;
  restoredFingerprint?: string;
  undoLabel?: string;
  reason?: string;
}

export interface VisualCritiqueDependencies {
  now: () => number;
  resolveGate: (signal?: AbortSignal) => Promise<VisualGateEvidence>;
  inspect: (input: {
    scopePath: string;
    outputTopPath: string;
    targets: VisualCritiqueArgs["targets"];
    signal?: AbortSignal;
  }) => Promise<VisualInspection>;
  capture: (input: {
    outputTopPath: string;
    width: 640;
    height: 360;
    signal?: AbortSignal;
  }) => Promise<VisualPreviewEvidence>;
  critique: (input: VisualModelRequest) => Promise<VisualModelResponse>;
  approve: (input: VisualApprovalRequest) => Promise<VisualApprovalResult>;
  commit: (input: VisualCommitRequest) => Promise<VisualCommitResult>;
  restore: (input: VisualRestoreRequest) => Promise<VisualRestoreResult>;
}

export interface VisualIterationReceipt {
  index: 1 | 2;
  status: VisualCritiqueStatus;
  before: {
    target_fingerprint: string;
    preview_sha256: string;
    technical: { error_count: number; perf_score?: number; preview_readable: boolean };
    visual_score: number;
  };
  proposal?: {
    digest: string;
    change_count: number;
    changes: Array<{
      path: string;
      parameter: string;
      before: number;
      proposed: number;
      risk: "low" | "medium";
    }>;
  };
  decision?: {
    state: VisualDecisionState;
    choice: "Apply" | "Keep";
    request_id?: string;
  };
  apply?: {
    applied: boolean;
    verified: boolean;
    final_fingerprint?: string;
    undo_label?: string;
  };
  after?: {
    preview_sha256: string;
    technical: { error_count: number; perf_score?: number; preview_readable: boolean };
    visual_score: number;
  };
  rollback?: {
    attempted: boolean;
    restored: boolean;
    verified: boolean;
    reason?: string;
    undo_label?: string;
  };
}

export interface VisualCritiqueReceipt {
  status: VisualCritiqueStatus;
  rubric: { id: typeof VISUAL_CRITIQUE_RUBRIC_ID; weights: typeof VISUAL_CRITIQUE_WEIGHTS };
  model?: Omit<VisualModelIdentity, "advertisesVision">;
  output_top_path: string;
  iterations: VisualIterationReceipt[];
  warnings: string[];
}

const visualTechnicalReceiptSchema = z
  .object({
    error_count: z.number().int().nonnegative(),
    perf_score: z.number().finite().optional(),
    preview_readable: z.boolean(),
  })
  .strict();

export const visualCritiqueReceiptSchema = z
  .object({
    status: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
    rubric: z
      .object({
        id: z.literal(VISUAL_CRITIQUE_RUBRIC_ID),
        weights: z
          .object({
            composition_hierarchy: z.literal(0.3),
            palette_coherence: z.literal(0.25),
            contrast_legibility: z.literal(0.25),
            spatial_balance: z.literal(0.2),
          })
          .strict(),
      })
      .strict(),
    model: z
      .object({
        provider: z.string().min(1).max(64),
        model: z.string().min(1).max(256),
        digest: z.string().min(1).max(256),
        quantization: z.string().min(1).max(128).optional(),
        fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    output_top_path: z.string().min(1).max(240),
    iterations: z
      .array(
        z
          .object({
            index: z.union([z.literal(1), z.literal(2)]),
            status: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
            before: z
              .object({
                target_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
                preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
                technical: visualTechnicalReceiptSchema,
                visual_score: z.number().int().min(0).max(100),
              })
              .strict(),
            proposal: z
              .object({
                digest: z.string().regex(/^[a-f0-9]{64}$/),
                change_count: z.number().int().min(1).max(3),
                changes: z
                  .array(
                    z
                      .object({
                        path: z.string().min(1).max(240),
                        parameter: z.string().min(1).max(64),
                        before: z.number().finite(),
                        proposed: z.number().finite(),
                        risk: z.enum(["low", "medium"]),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(3),
              })
              .strict()
              .optional(),
            decision: z
              .object({
                state: z.enum(["pending", "resolved", "expired", "cancelled", "failed"]),
                choice: z.enum(["Apply", "Keep"]),
                request_id: z.string().max(128).optional(),
              })
              .strict()
              .optional(),
            apply: z
              .object({
                applied: z.boolean(),
                verified: z.boolean(),
                final_fingerprint: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
                undo_label: z.string().max(256).optional(),
              })
              .strict()
              .optional(),
            after: z
              .object({
                preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
                technical: visualTechnicalReceiptSchema,
                visual_score: z.number().int().min(0).max(100),
              })
              .strict()
              .optional(),
            rollback: z
              .object({
                attempted: z.boolean(),
                restored: z.boolean(),
                verified: z.boolean(),
                reason: z.string().max(64).optional(),
                undo_label: z.string().max(256).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(2),
    warnings: z.array(z.string().max(200)).max(8),
  })
  .strict();

interface ValidatedChange {
  target: InspectedVisualTarget;
  value: number;
  rationale: string;
  risk: "low" | "medium";
}

function normalizeTdPath(value: string): string {
  return value.replace(/\/+$/, "") || "/";
}

function isUnderScope(path: string, scope: string): boolean {
  const normalizedPath = normalizeTdPath(path);
  const normalizedScope = normalizeTdPath(scope);
  return (
    normalizedPath === normalizedScope ||
    normalizedPath.startsWith(normalizedScope === "/" ? "/" : `${normalizedScope}/`)
  );
}

export function validateVisualCritiqueContext(
  scopePath: string,
  focusCriterion: string | undefined,
  args: VisualCritiqueArgs,
): string[] {
  const issues: string[] = [];
  if (focusCriterion !== undefined)
    issues.push("focusCriterion cannot be combined with visualCritique");
  if (!tdPathSchema.safeParse(scopePath).success)
    issues.push("scopePath is not a safe absolute TD path");
  if (!isUnderScope(args.outputTopPath, scopePath)) issues.push("outputTopPath escapes scopePath");
  args.targets.forEach((target, index) => {
    if (!isUnderScope(target.nodePath, scopePath))
      issues.push(`targets[${index}] escapes scopePath`);
  });
  return issues;
}

export function deriveVisualOverall(rubric: VisualRubric): number {
  return Math.round(
    rubric.composition_hierarchy * VISUAL_CRITIQUE_WEIGHTS.composition_hierarchy +
      rubric.palette_coherence * VISUAL_CRITIQUE_WEIGHTS.palette_coherence +
      rubric.contrast_legibility * VISUAL_CRITIQUE_WEIGHTS.contrast_legibility +
      rubric.spatial_balance * VISUAL_CRITIQUE_WEIGHTS.spatial_balance,
  );
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripSingleJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

export function parseVisualProposal(text: string): VisualProposal {
  const candidate = stripSingleJsonFence(text);
  const parsed = JSON.parse(candidate) as unknown;
  return visualProposalSchema.parse(parsed);
}

function gateFailure(evidence: VisualGateEvidence, now: number): string | undefined {
  const { identity, calibration, fixture } = evidence;
  if (!identity.advertisesVision)
    return "vision_unverified: current model does not advertise vision";
  if (!identity.digest || !identity.fingerprint)
    return "vision_unverified: unstable model identity";
  if (
    calibration.status !== "PASS" ||
    !calibration.reusableForMutation ||
    calibration.imageInput.status !== "PASS" ||
    calibration.imageInput.passed < 1 ||
    calibration.imageInput.failed !== 0 ||
    calibration.imageInput.unverified !== 0 ||
    calibration.expiresAtMs <= now
  ) {
    return "vision_unverified: exact calibration is absent, stale, or not mutation-eligible";
  }
  if (
    calibration.model !== identity.model ||
    calibration.digest !== identity.digest ||
    calibration.fingerprint !== identity.fingerprint
  ) {
    return "vision_unverified: calibration identity mismatch";
  }
  if (
    fixture.result !== "PASS" ||
    fixture.suite !== VISUAL_CRITIQUE_FIXTURE_SUITE ||
    fixture.rubricId !== VISUAL_CRITIQUE_RUBRIC_ID ||
    fixture.model !== identity.model ||
    fixture.digest !== identity.digest ||
    fixture.calibrationFingerprint !== identity.fingerprint ||
    fixture.strictResponses < 6 ||
    fixture.goodSpread > 5 ||
    fixture.badSpread > 5 ||
    fixture.medianDelta < 10 ||
    fixture.expiresAtMs <= now
  ) {
    return "vision_unverified: exact TD fixture receipt is absent, stale, or mismatched";
  }
  return undefined;
}

function previewHash(preview: VisualPreviewEvidence): string {
  return hash(Buffer.from(preview.base64, "base64"));
}

function technicalReceipt(technical: VisualTechnicalEvidence) {
  return {
    error_count: technical.errorCount,
    ...(technical.perfScore === undefined ? {} : { perf_score: technical.perfScore }),
    preview_readable: technical.previewReadable,
  };
}

function pushWarning(warnings: string[], message: string): void {
  if (warnings.length >= 8) return;
  warnings.push(message.slice(0, 200));
}

function baseReceipt(outputTopPath: string): VisualCritiqueReceipt {
  return {
    status: "UNVERIFIED",
    rubric: { id: VISUAL_CRITIQUE_RUBRIC_ID, weights: VISUAL_CRITIQUE_WEIGHTS },
    output_top_path: outputTopPath,
    iterations: [],
    warnings: [],
  };
}

function validateInspection(
  inspection: VisualInspection,
  scopePath: string,
  args: VisualCritiqueArgs,
): string | undefined {
  if (inspection.scopePath !== normalizeTdPath(scopePath)) return "inspection scope mismatch";
  if (inspection.outputTopPath !== normalizeTdPath(args.outputTopPath))
    return "inspection output mismatch";
  if (inspection.targets.length !== args.targets.length) return "inspection target count mismatch";
  for (let index = 0; index < args.targets.length; index += 1) {
    const requested = args.targets[index];
    const inspected = inspection.targets[index];
    if (!requested || !inspected) return "inspection target missing";
    if (
      inspected.id !== `t${index + 1}` ||
      inspected.path !== normalizeTdPath(requested.nodePath) ||
      inspected.parameter !== requested.parameter ||
      inspected.mode !== "CONSTANT" ||
      (inspected.type !== "Float" && inspected.type !== "Int") ||
      !Number.isFinite(inspected.value) ||
      !Number.isFinite(inspected.minimum) ||
      !Number.isFinite(inspected.maximum) ||
      inspected.minimum < requested.minimum ||
      inspected.maximum > requested.maximum ||
      inspected.value < inspected.minimum ||
      inspected.value > inspected.maximum
    ) {
      return `inspection target t${index + 1} is not mutation-eligible`;
    }
  }
  return undefined;
}

function validateProposal(
  proposal: VisualProposal,
  inspection: VisualInspection,
  maxChanges: number,
): { changes?: ValidatedChange[]; error?: string } {
  if (proposal.changes.length > maxChanges) return { error: "proposal exceeds maxChanges" };
  const targets = new Map(inspection.targets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  const changes: ValidatedChange[] = [];
  for (const change of proposal.changes) {
    if (seen.has(change.target_id)) return { error: "proposal repeats a target id" };
    seen.add(change.target_id);
    const target = targets.get(change.target_id as InspectedVisualTarget["id"]);
    const error = proposalChangeError(change.value, target);
    if (error) return { error };
    changes.push({
      target: target as InspectedVisualTarget,
      value: change.value,
      rationale: change.rationale,
      risk: change.risk,
    });
  }
  return { changes };
}

function proposalChangeError(
  value: number,
  target: InspectedVisualTarget | undefined,
): string | undefined {
  if (!target) return "proposal references an unknown target id";
  if (Object.is(value, target.value)) return "proposal contains an unchanged value";
  if (value < target.minimum || value > target.maximum)
    return "proposal value is outside effective bounds";
  if (target.type === "Int" && !Number.isInteger(value))
    return "proposal gives a non-integer value to an Int parameter";
  return undefined;
}

function approvalDetail(
  outputTopPath: string,
  iteration: number,
  maxIterations: number,
  changes: ValidatedChange[],
): string | undefined {
  const lines = [
    `Output: ${outputTopPath}`,
    `Rubric: TD visual basic v1 - iteration ${iteration}/${maxIterations}`,
    ...changes.map(
      (change) =>
        `${change.target.path}.${change.target.parameter}: ${change.target.value} -> ${change.value} (${change.risk})`,
    ),
    "Technical checks run after Apply; regression restores the exact snapshot.",
  ];
  const detail = lines.join("\n");
  return detail.length <= 512 ? detail : undefined;
}

function valuesMatch(expected: number, actual: number, type: "Float" | "Int"): boolean {
  if (!Number.isFinite(actual)) return false;
  if (type === "Int") return actual === expected;
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
}

function validateReadback(
  result: Extract<VisualCommitResult, { status: "committed" }>,
  changes: ValidatedChange[],
): boolean {
  if (result.readback.length !== changes.length) return false;
  const byId = new Map(result.readback.map((entry) => [entry.targetId, entry.value]));
  return changes.every((change) => {
    const value = byId.get(change.target.id);
    return value !== undefined && valuesMatch(change.value, value, change.target.type);
  });
}

function technicalRegressed(
  before: VisualTechnicalEvidence,
  after: VisualTechnicalEvidence,
): boolean {
  if (!after.previewReadable || after.errorCount > before.errorCount) return true;
  return (
    before.perfScore !== undefined &&
    after.perfScore !== undefined &&
    before.perfScore - after.perfScore > 10
  );
}

async function restoreCommitted(
  deps: VisualCritiqueDependencies,
  commit: Extract<VisualCommitResult, { status: "committed" }>,
  originalFingerprint: string,
  iterationKey: string,
  reason: string,
  signal?: AbortSignal,
): Promise<NonNullable<VisualIterationReceipt["rollback"]>> {
  try {
    const restored = await deps.restore({
      restoreToken: commit.restoreToken,
      expectedCommittedFingerprint: commit.finalFingerprint,
      idempotencyKey: hash(`${iterationKey}:restore:${commit.finalFingerprint}`),
      ...(signal ? { signal } : {}),
    });
    const verified =
      restored.restored &&
      restored.verified &&
      restored.restoredFingerprint === originalFingerprint;
    return {
      attempted: true,
      restored: verified,
      verified,
      reason: verified ? reason : (restored.reason ?? "rollback_failed"),
      ...(restored.undoLabel ? { undo_label: restored.undoLabel } : {}),
    };
  } catch {
    return {
      attempted: true,
      restored: false,
      verified: false,
      reason: "rollback_failed",
    };
  }
}

async function commitExactlyOnce(
  deps: VisualCritiqueDependencies,
  request: VisualCommitRequest,
): Promise<VisualCommitResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await deps.commit(request);
      if (result.status !== "ambiguous") return result;
    } catch {
      // A response-loss retry is safe only because it reuses the identical
      // idempotency key and proposal digest. Never create a replacement key.
    }
  }
  return { status: "ambiguous" };
}

function modelReceipt(
  identity: VisualModelIdentity,
): Omit<VisualModelIdentity, "advertisesVision"> {
  return {
    provider: identity.provider,
    model: identity.model,
    digest: identity.digest,
    ...(identity.quantization ? { quantization: identity.quantization } : {}),
    fingerprint: identity.fingerprint,
  };
}

function responseMatchesIdentity(
  response: VisualModelResponse,
  identity: VisualModelIdentity,
): boolean {
  return (
    response.identity.model === identity.model &&
    response.identity.digest === identity.digest &&
    response.identity.fingerprint === identity.fingerprint
  );
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

interface VisualCritiqueRunInput {
  scopePath: string;
  focusCriterion?: string;
  autoApply: boolean;
  visualCritique: VisualCritiqueArgs;
  signal?: AbortSignal;
}

interface VisualBeforeEvidence {
  inspection: VisualInspection;
  preview: VisualPreviewEvidence;
  targets: VisualModelRequest["targets"];
}

interface VisualIterationPlan extends VisualBeforeEvidence {
  gate: VisualGateEvidence;
  beforeScore: number;
  changes: ValidatedChange[];
  digest: string;
  key: string;
  receipt: VisualIterationReceipt;
}

class VisualCritiqueRunner {
  private readonly parsed: VisualCritiqueArgs;
  private readonly receipt: VisualCritiqueReceipt;
  private readonly baseKey: string;

  constructor(
    private readonly input: VisualCritiqueRunInput,
    private readonly deps: VisualCritiqueDependencies,
  ) {
    this.parsed = visualCritiqueSchema.parse(input.visualCritique);
    this.receipt = baseReceipt(this.parsed.outputTopPath);
    this.baseKey = this.parsed.idempotencyKey ?? randomUUID().replaceAll("-", "_");
  }

  async run(): Promise<VisualCritiqueReceipt> {
    const issues = validateVisualCritiqueContext(
      this.input.scopePath,
      this.input.focusCriterion,
      this.parsed,
    );
    if (issues.length > 0) return this.finish("FAIL", `proposal_invalid: ${issues[0]}`);
    for (let iteration = 1; iteration <= this.parsed.maxIterations; iteration += 1) {
      const shouldContinue = await this.runIteration(iteration as 1 | 2);
      if (!shouldContinue) return this.receipt;
    }
    return this.receipt;
  }

  private finish(status: VisualCritiqueStatus, warning?: string): VisualCritiqueReceipt {
    this.receipt.status = status;
    if (warning) pushWarning(this.receipt.warnings, warning);
    return this.receipt;
  }

  private stopIteration(
    iteration: VisualIterationReceipt,
    status: VisualCritiqueStatus,
    warning: string,
  ): undefined {
    iteration.status = status;
    this.finish(status, warning);
    return undefined;
  }

  private async runIteration(iteration: 1 | 2): Promise<boolean> {
    if (aborted(this.input.signal)) {
      this.finish("UNVERIFIED", "vision_unverified: request cancelled before mutation");
      return false;
    }
    const gate = await this.resolveGate();
    if (!gate) return false;
    const before = await this.readBefore();
    if (!before) return false;
    const proposal = await this.requestProposal(gate, before);
    if (!proposal) return false;
    const plan = this.createPlan(iteration, gate, before, proposal);
    if (!plan) return false;
    if (!this.input.autoApply) {
      this.finish("PASS");
      return false;
    }
    return this.applyPlan(plan);
  }

  private async resolveGate(): Promise<VisualGateEvidence | undefined> {
    try {
      const gate = await this.deps.resolveGate(this.input.signal);
      const error = gateFailure(gate, this.deps.now());
      if (error) {
        this.finish("UNVERIFIED", error);
        return undefined;
      }
      this.receipt.model = modelReceipt(gate.identity);
      return gate;
    } catch {
      this.finish("UNVERIFIED", "vision_unverified: exact model gate could not be resolved");
      return undefined;
    }
  }

  private async readBefore(): Promise<VisualBeforeEvidence | undefined> {
    try {
      const inspection = await this.deps.inspect({
        scopePath: normalizeTdPath(this.input.scopePath),
        outputTopPath: normalizeTdPath(this.parsed.outputTopPath),
        targets: this.parsed.targets,
        ...(this.input.signal ? { signal: this.input.signal } : {}),
      });
      const error = validateInspection(inspection, this.input.scopePath, this.parsed);
      if (error) {
        this.finish("UNVERIFIED", `stale_targets: ${error}`);
        return undefined;
      }
      const preview = await this.capturePreview();
      return {
        inspection,
        preview,
        targets: inspection.targets.map((target) => ({
          id: target.id,
          current: target.value,
          minimum: target.minimum,
          maximum: target.maximum,
        })),
      };
    } catch {
      this.finish("UNVERIFIED", "vision_unverified: inspection or preview unavailable");
      return undefined;
    }
  }

  private async capturePreview(): Promise<VisualPreviewEvidence> {
    const preview = await this.deps.capture({
      outputTopPath: this.parsed.outputTopPath,
      width: 640,
      height: 360,
      ...(this.input.signal ? { signal: this.input.signal } : {}),
    });
    if (!preview.technical.previewReadable) throw new Error("preview unreadable");
    return preview;
  }

  private async requestProposal(
    gate: VisualGateEvidence,
    before: VisualBeforeEvidence,
  ): Promise<VisualProposal | undefined> {
    try {
      const response = await this.deps.critique({
        mode: "proposal",
        image: { base64: before.preview.base64, mimeType: before.preview.mimeType },
        targets: before.targets,
        maxChanges: this.parsed.maxChanges,
        ...(this.input.signal ? { signal: this.input.signal } : {}),
      });
      if (!responseMatchesIdentity(response, gate.identity))
        throw new Error("model identity changed during proposal");
      return parseVisualProposal(response.text);
    } catch {
      this.finish("FAIL", "proposal_invalid: model response failed the strict contract");
      return undefined;
    }
  }

  private createPlan(
    index: 1 | 2,
    gate: VisualGateEvidence,
    before: VisualBeforeEvidence,
    proposal: VisualProposal,
  ): VisualIterationPlan | undefined {
    const beforeScore = deriveVisualOverall(proposal.rubric);
    const iteration = this.createIterationReceipt(index, before, beforeScore);
    this.receipt.iterations.push(iteration);
    const validated = validateProposal(proposal, before.inspection, this.parsed.maxChanges);
    if (!validated.changes) {
      return this.stopIteration(
        iteration,
        "FAIL",
        `proposal_invalid: ${validated.error ?? "invalid changes"}`,
      );
    }
    if (validated.changes.length === 0) {
      this.finish("PASS");
      return undefined;
    }
    const digest = hash(canonicalJson(proposal));
    iteration.proposal = this.proposalReceipt(digest, validated.changes);
    return {
      ...before,
      gate,
      beforeScore,
      changes: validated.changes,
      digest,
      key: hash(`${this.baseKey}:${index}:${digest}`),
      receipt: iteration,
    };
  }

  private createIterationReceipt(
    index: 1 | 2,
    before: VisualBeforeEvidence,
    beforeScore: number,
  ): VisualIterationReceipt {
    return {
      index,
      status: "PASS",
      before: {
        target_fingerprint: before.inspection.fingerprint,
        preview_sha256: previewHash(before.preview),
        technical: technicalReceipt(before.preview.technical),
        visual_score: beforeScore,
      },
    };
  }

  private proposalReceipt(
    digest: string,
    changes: ValidatedChange[],
  ): NonNullable<VisualIterationReceipt["proposal"]> {
    return {
      digest,
      change_count: changes.length,
      changes: changes.map((change) => ({
        path: change.target.path,
        parameter: change.target.parameter,
        before: change.target.value,
        proposed: change.value,
        risk: change.risk,
      })),
    };
  }

  private async applyPlan(plan: VisualIterationPlan): Promise<boolean> {
    if (aborted(this.input.signal)) {
      this.stopIteration(
        plan.receipt,
        "UNVERIFIED",
        "vision_unverified: request cancelled before approval",
      );
      return false;
    }
    const requestId = await this.requestApproval(plan);
    if (!requestId) return false;
    if (aborted(this.input.signal)) {
      this.stopIteration(
        plan.receipt,
        "UNVERIFIED",
        "stale_targets: request cancelled before commit",
      );
      return false;
    }
    const commit = await this.commitPlan(plan, requestId);
    if (!commit) return false;
    return this.verifyPlan(plan, commit);
  }

  private async requestApproval(plan: VisualIterationPlan): Promise<string | undefined> {
    const detail = approvalDetail(
      this.parsed.outputTopPath,
      plan.receipt.index,
      this.parsed.maxIterations,
      plan.changes,
    );
    if (!detail) {
      return this.stopIteration(
        plan.receipt,
        "FAIL",
        "proposal_invalid: exact approval detail exceeds 512 characters",
      );
    }
    const decision = await this.safeApproval(plan, detail);
    plan.receipt.decision = this.decisionReceipt(decision);
    if (decision.state !== "resolved") {
      return this.stopIteration(
        plan.receipt,
        "UNVERIFIED",
        "vision_unverified: native approval did not resolve explicitly",
      );
    }
    if (decision.choice !== "Apply") {
      this.finish("PASS");
      return undefined;
    }
    if (decision.requestId) return decision.requestId;
    plan.receipt.decision.choice = "Keep";
    return this.stopIteration(
      plan.receipt,
      "UNVERIFIED",
      "vision_unverified: resolved approval had no request id",
    );
  }

  private async safeApproval(
    plan: VisualIterationPlan,
    detail: string,
  ): Promise<VisualApprovalResult> {
    try {
      return await this.deps.approve({
        kind: "visual_parameter_apply",
        title: "Apply visual critique changes?",
        detail,
        choices: ["Apply", "Keep"],
        safeChoice: "Keep",
        ttlMs: this.parsed.confirmationTimeoutMs,
        dedupeKey: hash(`${plan.key}:approval`),
        expectedFingerprint: plan.inspection.fingerprint,
        proposalDigest: plan.digest,
        changes: plan.changes.map((change) => ({
          targetId: change.target.id,
          value: change.value,
        })),
        ...(this.input.signal ? { signal: this.input.signal } : {}),
      });
    } catch {
      return { state: "failed", choice: "Keep" };
    }
  }

  private decisionReceipt(
    decision: VisualApprovalResult,
  ): NonNullable<VisualIterationReceipt["decision"]> {
    const apply = decision.state === "resolved" && decision.choice === "Apply";
    return {
      state: decision.state,
      choice: apply ? "Apply" : "Keep",
      ...(decision.requestId ? { request_id: decision.requestId } : {}),
    };
  }

  private async commitPlan(
    plan: VisualIterationPlan,
    interactionId: string,
  ): Promise<Extract<VisualCommitResult, { status: "committed" }> | undefined> {
    const commit = await commitExactlyOnce(this.deps, {
      scopePath: normalizeTdPath(this.input.scopePath),
      outputTopPath: normalizeTdPath(this.parsed.outputTopPath),
      expectedFingerprint: plan.inspection.fingerprint,
      proposalDigest: plan.digest,
      idempotencyKey: hash(`${plan.key}:commit`),
      interactionId,
      changes: plan.changes.map((change) => ({
        targetId: change.target.id,
        value: change.value,
      })),
      ...(this.input.signal ? { signal: this.input.signal } : {}),
    });
    if (commit.status === "conflict") {
      plan.receipt.apply = { applied: false, verified: false };
      return this.stopIteration(
        plan.receipt,
        "UNVERIFIED",
        "stale_targets: commit CAS refused the approved snapshot",
      );
    }
    if (commit.status !== "committed") {
      plan.receipt.apply = { applied: false, verified: false };
      return this.stopIteration(
        plan.receipt,
        "FAIL",
        "commit_failed: commit was not confirmed exactly once",
      );
    }
    const readbackOk = validateReadback(commit, plan.changes);
    plan.receipt.apply = {
      applied: true,
      verified: readbackOk,
      final_fingerprint: commit.finalFingerprint,
      ...(commit.undoLabel ? { undo_label: commit.undoLabel } : {}),
    };
    if (readbackOk) return commit;
    plan.receipt.rollback = await restoreCommitted(
      this.deps,
      commit,
      plan.inspection.fingerprint,
      plan.key,
      "readback_mismatch",
      this.input.signal,
    );
    return this.stopIteration(
      plan.receipt,
      "FAIL",
      plan.receipt.rollback.restored
        ? "commit_failed: readback mismatch restored"
        : "rollback_failed",
    );
  }

  private async verifyPlan(
    plan: VisualIterationPlan,
    commit: Extract<VisualCommitResult, { status: "committed" }>,
  ): Promise<boolean> {
    const after = await this.readAfter(plan, commit);
    if (!after) return false;
    const afterScore = deriveVisualOverall(after.proposal.rubric);
    plan.receipt.after = {
      preview_sha256: previewHash(after.preview),
      technical: technicalReceipt(after.preview.technical),
      visual_score: afterScore,
    };
    const regressed =
      technicalRegressed(plan.preview.technical, after.preview.technical) ||
      afterScore < plan.beforeScore - this.parsed.regressionThreshold;
    if (!regressed) {
      plan.receipt.status = "PASS";
      this.finish("PASS");
      return true;
    }
    plan.receipt.rollback = await restoreCommitted(
      this.deps,
      commit,
      plan.inspection.fingerprint,
      plan.key,
      "regression",
      this.input.signal,
    );
    this.stopIteration(
      plan.receipt,
      "FAIL",
      plan.receipt.rollback.restored ? "regression_restored" : "rollback_failed",
    );
    return false;
  }

  private async readAfter(
    plan: VisualIterationPlan,
    commit: Extract<VisualCommitResult, { status: "committed" }>,
  ): Promise<{ preview: VisualPreviewEvidence; proposal: VisualProposal } | undefined> {
    try {
      const preview = await this.capturePreview();
      const response = await this.deps.critique({
        mode: "verification",
        image: { base64: preview.base64, mimeType: preview.mimeType },
        targets: this.verificationTargets(plan),
        maxChanges: 0,
        ...(this.input.signal ? { signal: this.input.signal } : {}),
      });
      if (!responseMatchesIdentity(response, plan.gate.identity))
        throw new Error("model identity changed during verification");
      const proposal = parseVisualProposal(response.text);
      if (proposal.changes.length !== 0) throw new Error("verification proposed changes");
      return { preview, proposal };
    } catch {
      plan.receipt.rollback = await restoreCommitted(
        this.deps,
        commit,
        plan.inspection.fingerprint,
        plan.key,
        "after_evidence_unavailable",
        this.input.signal,
      );
      this.stopIteration(
        plan.receipt,
        "FAIL",
        plan.receipt.rollback.restored
          ? "regression_restored: after evidence unavailable"
          : "rollback_failed",
      );
      return undefined;
    }
  }

  private verificationTargets(plan: VisualIterationPlan): VisualModelRequest["targets"] {
    const values = new Map<string, number>(
      plan.changes.map((change) => [change.target.id, change.value]),
    );
    return plan.targets.map((target) => ({
      ...target,
      current: values.get(target.id) ?? target.current,
    }));
  }
}

export async function runBoundedVisualCritique(
  input: VisualCritiqueRunInput,
  deps: VisualCritiqueDependencies,
): Promise<VisualCritiqueReceipt> {
  return new VisualCritiqueRunner(input, deps).run();
}

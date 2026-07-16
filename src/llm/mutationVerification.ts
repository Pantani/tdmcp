import { TdApiError } from "../td-client/types.js";

export type MutationKind =
  | "create"
  | "update_parameters"
  | "delete"
  | "bypass"
  | "connect"
  | "generator";

export type VerificationStatus = "PASS" | "FAIL" | "UNVERIFIED";

export type MutationExpectation =
  | {
      type: "exists";
      path: string;
      operatorType?: string;
      parameters?: Record<string, unknown>;
      flags?: Record<string, boolean>;
      position?: { x: number; y: number };
      viewer?: boolean;
    }
  | { type: "absent"; path: string }
  | {
      type: "connection_exists";
      rootPath: string;
      sourcePath: string;
      targetPath: string;
      sourceOutput: number;
      targetInput: number;
    }
  | { type: "scoped_errors_empty"; path: string }
  | { type: "reported_errors_empty"; path: string; errors: unknown[] };

export interface MutationVerificationPlan {
  kind: MutationKind;
  affectedPaths: string[];
  expectations: MutationExpectation[];
  idempotency: "none" | "reuse_exact";
  applied: boolean;
  previewOutput?: string;
}

export interface MutationDescriptor<TArgs = unknown> {
  kind: MutationKind;
  idempotency: "none" | "reuse_exact";
  plan(args: TArgs, structured: unknown): MutationVerificationPlan | undefined;
}

export interface VerificationCheck {
  expectation: MutationExpectation["type"];
  path: string;
  status: VerificationStatus;
  reason: string;
}

export interface MutationVerificationReport {
  status: VerificationStatus;
  mutationKind: MutationKind;
  affectedPaths: string[];
  applied: boolean;
  idempotency: "none" | "reuse_exact";
  checks: VerificationCheck[];
  mutationRetry: "blocked";
  preview?: {
    status: "observed" | "unavailable";
    path: string;
    grid?: number;
    width?: number;
    height?: number;
    reason?: string;
  };
  limits: {
    callsUsed: number;
    maxCalls: 4;
    maxTotalMs: 3500;
    retryGet: false;
  };
}

interface NodeDetail {
  path: string;
  type?: string;
  family?: string;
  parameters?: Record<string, unknown>;
  flags?: Record<string, unknown>;
  nodeX?: number;
  nodeY?: number;
  viewer?: boolean;
}

interface VerificationClient {
  getNode(path: string, options?: { timeoutMs?: number; retryGet?: boolean }): Promise<NodeDetail>;
  getNetworkTopology(
    path: string,
    recursive?: boolean,
    options?: { timeoutMs?: number; retryGet?: boolean },
  ): Promise<{
    connections: Array<{
      source_path: string;
      source_output: number;
      target_path: string;
      target_input: number;
    }>;
  }>;
  getNetworkErrors(
    path: string,
    options?: { timeoutMs?: number; retryGet?: boolean },
  ): Promise<{ errors: unknown[] }>;
  sampleGrid(
    path: string,
    grid: number,
    options?: { timeoutMs?: number; retryGet?: boolean },
  ): Promise<{ grid: number; width: number; height: number }>;
}

export interface VerifyMutationOptions {
  signal?: AbortSignal;
  /** True only when grounding proved an interactive, non-perform TD editor. */
  allowPreview?: boolean;
  now?: () => number;
}

const MAX_CALLS = 4;
const MAX_TOTAL_MS = 3500;
const PER_CALL_MS = 800;
const MAX_PATHS = 32;
const MAX_EXPECTATIONS = 16;
const MAX_EVIDENCE_TEXT = 160;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedPaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path?.startsWith("/"))))].slice(
    0,
    MAX_PATHS,
  );
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "/";
}

function exactEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((value, index) => exactEqual(value, expected[index]))
    );
  }
  const actualRecord = record(actual);
  const expectedRecord = record(expected);
  if (!actualRecord || !expectedRecord) return false;
  const expectedKeys = Object.keys(expectedRecord);
  return expectedKeys.every(
    (key) => key in actualRecord && exactEqual(actualRecord[key], expectedRecord[key]),
  );
}

function isTypedNotFound(error: unknown): boolean {
  if (!(error instanceof TdApiError)) return false;
  return new Set(["node_not_found", "path_not_found", "not_found"]).has(
    error.apiCode?.toLowerCase() ?? "",
  );
}

function boundedEvidenceText(value: string): string {
  if (value.length <= MAX_EVIDENCE_TEXT) return value;
  return `${value.slice(0, MAX_EVIDENCE_TEXT - 1)}…`;
}

function aggregate(checks: VerificationCheck[]): VerificationStatus {
  if (checks.length === 0 || checks.some((check) => check.status === "UNVERIFIED")) {
    return checks.some((check) => check.status === "FAIL") ? "FAIL" : "UNVERIFIED";
  }
  return checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS";
}

type ExistsExpectation = Extract<MutationExpectation, { type: "exists" }>;
type ConnectionExpectation = Extract<MutationExpectation, { type: "connection_exists" }>;

function recordMismatch(
  prefix: "parameter" | "flag",
  expected: Record<string, unknown> | undefined,
  actual: Record<string, unknown> | undefined,
): string | undefined {
  for (const [name, value] of Object.entries(expected ?? {})) {
    if (!exactEqual(actual?.[name], value)) return `${prefix}_mismatch:${name}`;
  }
  return undefined;
}

function operatorMismatch(expectation: ExistsExpectation, node: NodeDetail): string | undefined {
  if (expectation.operatorType !== undefined && node.type !== expectation.operatorType) {
    return "operator_type_mismatch";
  }
  return undefined;
}

function positionMismatch(expectation: ExistsExpectation, node: NodeDetail): string | undefined {
  if (
    expectation.position &&
    (node.nodeX !== expectation.position.x || node.nodeY !== expectation.position.y)
  ) {
    return "position_mismatch";
  }
  return undefined;
}

function viewerMismatch(expectation: ExistsExpectation, node: NodeDetail): string | undefined {
  if (expectation.viewer !== undefined && node.viewer !== expectation.viewer) {
    return "viewer_mismatch";
  }
  return undefined;
}

function checkExists(expectation: ExistsExpectation, node: NodeDetail): string | undefined {
  return (
    operatorMismatch(expectation, node) ??
    recordMismatch("parameter", expectation.parameters, node.parameters) ??
    recordMismatch("flag", expectation.flags, node.flags) ??
    positionMismatch(expectation, node) ??
    viewerMismatch(expectation, node)
  );
}

function checkPath(expectation: MutationExpectation): string {
  if (expectation.type === "connection_exists") return expectation.targetPath;
  return expectation.path;
}

function missingPlanReport(kind: MutationKind): MutationVerificationReport {
  return {
    status: "UNVERIFIED",
    mutationKind: kind,
    affectedPaths: [],
    applied: true,
    idempotency: "none",
    checks: [
      {
        expectation: "exists",
        path: "",
        status: "UNVERIFIED",
        reason: "missing_verification_contract",
      },
    ],
    mutationRetry: "blocked",
    limits: { callsUsed: 0, maxCalls: 4, maxTotalMs: 3500, retryGet: false },
  };
}

export function unverifiedMutationReport(kind: MutationKind): MutationVerificationReport {
  return missingPlanReport(kind);
}

interface WaitRace {
  promise: Promise<never>;
  cleanup: () => void;
}

function timeoutRace(milliseconds: number): WaitRace {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("verification_read_timeout")), milliseconds);
  });
  return { promise, cleanup: () => clearTimeout(timer) };
}

function abortRace(signal: AbortSignal | undefined): WaitRace {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(new DOMException("cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    },
  };
}

class VerificationRuntime {
  callsUsed = 0;
  private readonly startedAt: number;
  private readonly nodeCache = new Map<string, Promise<NodeDetail>>();

  constructor(
    readonly client: VerificationClient,
    readonly options: VerifyMutationOptions,
    private readonly now = options.now ?? Date.now,
  ) {
    this.startedAt = this.now();
  }

  async boundedRead<T>(read: () => Promise<T>): Promise<T> {
    if (this.options.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    if (this.callsUsed >= MAX_CALLS || this.now() - this.startedAt >= MAX_TOTAL_MS) {
      throw new Error("verification_budget_exhausted");
    }
    this.callsUsed += 1;
    const elapsed = this.now() - this.startedAt;
    const remaining = Math.max(1, Math.min(PER_CALL_MS, MAX_TOTAL_MS - elapsed));
    const timeout = timeoutRace(remaining);
    const aborted = abortRace(this.options.signal);
    try {
      return await Promise.race([read(), timeout.promise, aborted.promise]);
    } finally {
      timeout.cleanup();
      aborted.cleanup();
    }
  }

  getNode(path: string): Promise<NodeDetail> {
    const cached = this.nodeCache.get(path);
    if (cached) return cached;
    const pending = this.boundedRead(() =>
      this.client.getNode(path, { timeoutMs: PER_CALL_MS, retryGet: false }),
    );
    this.nodeCache.set(path, pending);
    return pending;
  }
}

function checkResult(
  expectation: MutationExpectation["type"],
  path: string,
  passed: boolean,
  passReason: string,
  failReason: string,
): VerificationCheck {
  return {
    expectation,
    path,
    status: passed ? "PASS" : "FAIL",
    reason: passed ? passReason : failReason,
  };
}

function verifyReportedErrors(
  expectation: Extract<MutationExpectation, { type: "reported_errors_empty" }>,
): VerificationCheck {
  return checkResult(
    expectation.type,
    expectation.path,
    expectation.errors.length === 0,
    "no_reported_errors",
    "reported_errors",
  );
}

async function verifyExists(
  runtime: VerificationRuntime,
  expectation: ExistsExpectation,
): Promise<VerificationCheck> {
  const node = await runtime.getNode(expectation.path);
  const mismatch = checkExists(expectation, node);
  return checkResult(
    expectation.type,
    expectation.path,
    mismatch === undefined,
    "state_matches",
    mismatch ?? "state_mismatch",
  );
}

async function verifyAbsent(
  runtime: VerificationRuntime,
  expectation: Extract<MutationExpectation, { type: "absent" }>,
): Promise<VerificationCheck> {
  try {
    await runtime.getNode(expectation.path);
    return checkResult(
      expectation.type,
      expectation.path,
      false,
      "typed_not_found",
      "node_still_exists",
    );
  } catch (error) {
    if (isTypedNotFound(error)) {
      return checkResult(
        expectation.type,
        expectation.path,
        true,
        "typed_not_found",
        "absence_not_proven",
      );
    }
    return {
      expectation: expectation.type,
      path: expectation.path,
      status: "UNVERIFIED",
      reason: "absence_not_proven",
    };
  }
}

function connectionMatches(
  connection: {
    source_path: string;
    source_output: number;
    target_path: string;
    target_input: number;
  },
  expectation: ConnectionExpectation,
): boolean {
  return (
    connection.source_path === expectation.sourcePath &&
    connection.target_path === expectation.targetPath &&
    connection.source_output === expectation.sourceOutput &&
    connection.target_input === expectation.targetInput
  );
}

async function verifyConnection(
  runtime: VerificationRuntime,
  expectation: ConnectionExpectation,
): Promise<VerificationCheck> {
  const topology = await runtime.boundedRead(() =>
    runtime.client.getNetworkTopology(expectation.rootPath, false, {
      timeoutMs: PER_CALL_MS,
      retryGet: false,
    }),
  );
  const exists = topology.connections.some((connection) =>
    connectionMatches(connection, expectation),
  );
  return checkResult(
    expectation.type,
    expectation.targetPath,
    exists,
    "connection_matches",
    "connection_missing",
  );
}

async function verifyScopedErrors(
  runtime: VerificationRuntime,
  expectation: Extract<MutationExpectation, { type: "scoped_errors_empty" }>,
): Promise<VerificationCheck> {
  const result = await runtime.boundedRead(() =>
    runtime.client.getNetworkErrors(expectation.path, {
      timeoutMs: PER_CALL_MS,
      retryGet: false,
    }),
  );
  return checkResult(
    expectation.type,
    expectation.path,
    result.errors.length === 0,
    "scoped_errors_empty",
    "scoped_errors_present",
  );
}

function verifyExpectation(
  runtime: VerificationRuntime,
  expectation: MutationExpectation,
): Promise<VerificationCheck> | VerificationCheck {
  switch (expectation.type) {
    case "reported_errors_empty":
      return verifyReportedErrors(expectation);
    case "exists":
      return verifyExists(runtime, expectation);
    case "absent":
      return verifyAbsent(runtime, expectation);
    case "connection_exists":
      return verifyConnection(runtime, expectation);
    case "scoped_errors_empty":
      return verifyScopedErrors(runtime, expectation);
  }
}

function unavailableReason(error: unknown, options: VerifyMutationOptions): string {
  if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return "cancelled";
  }
  if (error instanceof Error && error.message === "verification_budget_exhausted") {
    return "budget_exhausted";
  }
  return "read_unavailable";
}

async function verifyExpectations(
  runtime: VerificationRuntime,
  expectations: MutationExpectation[],
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  for (const expectation of expectations.slice(0, MAX_EXPECTATIONS)) {
    try {
      checks.push(await verifyExpectation(runtime, expectation));
    } catch (error) {
      checks.push({
        expectation: expectation.type,
        path: checkPath(expectation),
        status: "UNVERIFIED",
        reason: unavailableReason(error, runtime.options),
      });
    }
  }
  return checks;
}

async function verifyPreview(
  runtime: VerificationRuntime,
  output: string | undefined,
  allowPreview: boolean | undefined,
): Promise<MutationVerificationReport["preview"]> {
  if (!output || allowPreview !== true) return undefined;
  try {
    const detail = await runtime.getNode(output);
    if (detail.family !== "TOP") {
      return { status: "unavailable", path: output, reason: "not_confirmed_top" };
    }
    const sample = await runtime.boundedRead(() =>
      runtime.client.sampleGrid(output, 3, { timeoutMs: PER_CALL_MS, retryGet: false }),
    );
    return {
      status: "observed",
      path: output,
      grid: sample.grid,
      width: sample.width,
      height: sample.height,
    };
  } catch {
    return { status: "unavailable", path: output, reason: "preview_unavailable" };
  }
}

function boundedChecks(checks: VerificationCheck[]): VerificationCheck[] {
  return checks.map((check) => ({
    ...check,
    path: boundedEvidenceText(check.path),
    reason: boundedEvidenceText(check.reason),
  }));
}

/**
 * Verify one already-completed mutation with bounded, structured, read-only bridge calls.
 * The mutation is never repeated and the report never changes its original success flag.
 */
export async function verifyMutation(
  client: VerificationClient,
  plan: MutationVerificationPlan,
  options: VerifyMutationOptions = {},
): Promise<MutationVerificationReport> {
  const runtime = new VerificationRuntime(client, options);
  const checks = await verifyExpectations(runtime, plan.expectations);
  const preview = await verifyPreview(runtime, plan.previewOutput, options.allowPreview);

  return {
    status: aggregate(checks),
    mutationKind: plan.kind,
    affectedPaths: boundedPaths(plan.affectedPaths).map(boundedEvidenceText),
    applied: plan.applied,
    idempotency: plan.idempotency,
    checks: boundedChecks(checks),
    mutationRetry: "blocked",
    ...(preview ? { preview } : {}),
    limits: { callsUsed: runtime.callsUsed, maxCalls: 4, maxTotalMs: 3500, retryGet: false },
  };
}

export function createMutationDescriptor(): MutationDescriptor<Record<string, unknown>> {
  return {
    kind: "create",
    idempotency: "reuse_exact",
    plan(args, structured) {
      const node = record(record(structured)?.node);
      const path = stringValue(node?.path);
      if (!path) return undefined;
      const placement = args.placement === "explicit";
      const parameters = record(args.parameters);
      return {
        kind: "create",
        affectedPaths: [path],
        expectations: [
          {
            type: "exists",
            path,
            ...(typeof args.type === "string" ? { operatorType: args.type } : {}),
            ...(parameters ? { parameters } : {}),
            ...(placement &&
            finiteNumber(args.node_x) !== undefined &&
            finiteNumber(args.node_y) !== undefined
              ? { position: { x: args.node_x as number, y: args.node_y as number } }
              : {}),
            ...(typeof args.viewer === "boolean" ? { viewer: args.viewer } : {}),
          },
          {
            type: "reported_errors_empty",
            path,
            errors: Array.isArray(node?.parameter_warnings) ? node.parameter_warnings : [],
          },
          { type: "scoped_errors_empty", path: parentPath(path) },
        ],
        idempotency: "reuse_exact",
        applied: true,
      };
    },
  };
}

export function updateParametersMutationDescriptor(): MutationDescriptor<Record<string, unknown>> {
  return {
    kind: "update_parameters",
    idempotency: "reuse_exact",
    plan(args) {
      const path = stringValue(args.path);
      const parameters = record(args.parameters);
      if (!path || !parameters) return undefined;
      return {
        kind: "update_parameters",
        affectedPaths: [path],
        expectations: [
          { type: "exists", path, parameters },
          { type: "scoped_errors_empty", path: parentPath(path) },
        ],
        idempotency: "reuse_exact",
        applied: true,
      };
    },
  };
}

type DeleteAction = "delete" | "bypass" | "keep";

function confirmedDeleteAction(
  result: Record<string, unknown> | undefined,
): DeleteAction | undefined {
  const action = result?.action_applied;
  if (action !== "delete" && action !== "bypass" && action !== "keep") return undefined;
  const shouldBeApplied = action !== "keep";
  return result?.applied === shouldBeApplied ? action : undefined;
}

function deletedPlan(path: string): MutationVerificationPlan {
  return {
    kind: "delete",
    affectedPaths: [path],
    expectations: [{ type: "absent", path }],
    idempotency: "none",
    applied: true,
  };
}

function retainedDeletePlan(action: Exclude<DeleteAction, "delete">, path: string) {
  const bypassed = action === "bypass";
  return {
    kind: bypassed ? ("bypass" as const) : ("delete" as const),
    affectedPaths: [path],
    expectations: [
      {
        type: "exists" as const,
        path,
        ...(bypassed ? { flags: { bypass: true } } : {}),
      },
    ],
    idempotency: "none" as const,
    applied: bypassed,
  };
}

export function deleteMutationDescriptor(): MutationDescriptor<Record<string, unknown>> {
  return {
    kind: "delete",
    idempotency: "none",
    plan(args, structured) {
      const result = record(structured);
      const action = confirmedDeleteAction(result);
      if (!action) return undefined;
      const original = stringValue(result?.original_path) ?? stringValue(args.path);
      if (!original) return undefined;
      if (action === "delete") return deletedPlan(original);
      const finalPath = stringValue(result?.final_path) ?? original;
      return retainedDeletePlan(action, finalPath);
    },
  };
}

export function connectMutationDescriptor(): MutationDescriptor<Record<string, unknown>> {
  return {
    kind: "connect",
    idempotency: "reuse_exact",
    plan(args, structured) {
      const sourcePath = stringValue(args.source_path);
      const targetPath = stringValue(args.target_path);
      if (!sourcePath || !targetPath) return undefined;
      const actualInput = finiteNumber(record(structured)?.actual_input);
      return {
        kind: "connect",
        affectedPaths: [sourcePath, targetPath],
        expectations: [
          {
            type: "connection_exists",
            rootPath: parentPath(targetPath),
            sourcePath,
            targetPath,
            sourceOutput: finiteNumber(args.source_output) ?? 0,
            targetInput: actualInput ?? finiteNumber(args.target_input) ?? 0,
          },
          { type: "scoped_errors_empty", path: parentPath(targetPath) },
        ],
        idempotency: "reuse_exact",
        applied: true,
      };
    },
  };
}

export function generatorMutationDescriptor(): MutationDescriptor<Record<string, unknown>> {
  return {
    kind: "generator",
    idempotency: "none",
    plan(_args, structured) {
      const value = record(structured);
      const container = stringValue(value?.container);
      const output = stringValue(value?.output);
      if (!container || !output) return undefined;
      const created = Array.isArray(value?.created)
        ? value.created.map(stringValue).filter((path): path is string => path !== undefined)
        : [];
      if (value?.errors !== undefined && !Array.isArray(value.errors)) return undefined;
      const errors = Array.isArray(value?.errors) ? value.errors : [];
      return {
        kind: "generator",
        affectedPaths: boundedPaths([container, ...created, output]),
        expectations: [
          { type: "exists", path: container },
          { type: "exists", path: output },
          { type: "reported_errors_empty", path: container, errors },
          { type: "scoped_errors_empty", path: container },
        ],
        idempotency: "none",
        applied: true,
        previewOutput: output,
      };
    },
  };
}

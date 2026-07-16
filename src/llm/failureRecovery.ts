import { TdApiError, TdConnectionError, TdTimeoutError } from "../td-client/types.js";
import type { VerificationStatus } from "./mutationVerification.js";

export type FailureCategory =
  | "bad_json"
  | "invalid_args"
  | "bridge_offline"
  | "bridge_stale"
  | "timeout_ambiguous"
  | "auth_or_policy"
  | "path_missing"
  | "menu_invalid"
  | "verification_failed"
  | "unknown";

export type FailurePhase = "parse" | "validate" | "dispatch" | "verify";
export type RecoveryAction =
  | "return_validation_evidence"
  | "probe_bridge"
  | "probe_exact_path"
  | "probe_menu"
  | "stop";

export interface ToolFailure {
  category: FailureCategory;
  phase: FailurePhase;
  code?: string;
  apiCode?: string;
  status?: number;
  ambiguous: boolean;
  safeMessage: string;
}

export interface RecoveryReport {
  category: FailureCategory;
  action: RecoveryAction;
  outcome: "recovered" | "stopped";
  budgetUsed: 0 | 1;
  mutationRetry: "blocked";
  evidence?: Record<string, unknown>;
}

export interface FailureClassificationInput {
  phase: FailurePhase;
  mutates: boolean;
  error?: unknown;
  code?: string;
  apiCode?: string;
  status?: number;
  verificationStatus?: VerificationStatus;
  safeMessage?: string;
}

interface RecoveryClient {
  getInfo(options?: { timeoutMs?: number; retryGet?: boolean }): Promise<Record<string, unknown>>;
  getNetworkTopology(
    path: string,
    recursive?: boolean,
    options?: { timeoutMs?: number; retryGet?: boolean },
  ): Promise<{ nodes: Array<{ path: string; name?: string; type?: string }> }>;
  getParameterMenu?(
    path: string,
    parameter: string,
    options?: { timeoutMs?: number; retryGet?: boolean },
  ): Promise<{ names: string[]; labels?: string[]; current?: string | null }>;
}

export interface RecoveryOptions {
  mutates: boolean;
  affectedPaths?: string[];
  /** Grounded owner/root for the single recursive exact-basename probe. */
  searchRoot?: string;
  parameter?: string;
  validationIssues?: Array<{ path: string; code: string; message: string }>;
  budget?: 0 | 1;
  signal?: AbortSignal;
}

const AUTH_OR_POLICY_CODES = new Set([
  "auth_required",
  "forbidden",
  "exec_disabled",
  "policy_blocked",
  "unauthorized",
]);
const PATH_CODES = new Set(["node_not_found", "path_not_found", "not_found"]);
const MENU_CODES = new Set(["invalid_menu", "invalid_menu_value", "menu_invalid"]);

function stableMessage(category: FailureCategory): string {
  switch (category) {
    case "bad_json":
      return "Tool arguments were not valid JSON.";
    case "invalid_args":
      return "Tool arguments did not match the registered schema.";
    case "bridge_offline":
      return "The TouchDesigner bridge is unreachable.";
    case "bridge_stale":
      return "The TouchDesigner bridge heartbeat is stale.";
    case "timeout_ambiguous":
      return "The request timed out and application state is ambiguous.";
    case "auth_or_policy":
      return "The request was blocked by authorization or policy.";
    case "path_missing":
      return "The requested TouchDesigner path was not found.";
    case "menu_invalid":
      return "The requested parameter menu value was invalid.";
    case "verification_failed":
      return "Post-mutation state contradicted the requested result.";
    default:
      return "The tool failed without a safe automatic recovery.";
  }
}

function normalizedCode(input: FailureClassificationInput): string | undefined {
  if (typeof input.apiCode === "string") return input.apiCode.toLowerCase();
  if (input.error instanceof TdApiError && input.error.apiCode) {
    return input.error.apiCode.toLowerCase();
  }
  return typeof input.code === "string" ? input.code.toLowerCase() : undefined;
}

function phaseCategory(input: FailureClassificationInput): FailureCategory | undefined {
  if (input.phase === "parse" || input.code === "bad_json") return "bad_json";
  if (input.phase === "validate" || input.code === "invalid_args") return "invalid_args";
  if (input.verificationStatus === "FAIL") return "verification_failed";
  return undefined;
}

function transportCategory(input: FailureClassificationInput): FailureCategory | undefined {
  if (input.error instanceof TdTimeoutError || input.code === "TD_TIMEOUT") {
    return "timeout_ambiguous";
  }
  if (input.error instanceof TdConnectionError || input.code === "TD_CONNECTION") {
    return "bridge_offline";
  }
  return undefined;
}

function apiCategory(apiCode: string | undefined, status: number | undefined): FailureCategory {
  if (apiCode === "bridge_stale" || apiCode === "heartbeat_stale") return "bridge_stale";
  if (status === 401 || status === 403 || (apiCode && AUTH_OR_POLICY_CODES.has(apiCode))) {
    return "auth_or_policy";
  }
  if (apiCode && PATH_CODES.has(apiCode)) return "path_missing";
  if (apiCode && MENU_CODES.has(apiCode)) return "menu_invalid";
  return "unknown";
}

function failureCategory(
  input: FailureClassificationInput,
  apiCode: string | undefined,
  status: number | undefined,
): FailureCategory {
  return phaseCategory(input) ?? transportCategory(input) ?? apiCategory(apiCode, status);
}

export function classifyFailure(input: FailureClassificationInput): ToolFailure {
  const apiCode = normalizedCode(input);
  const status =
    input.status ?? (input.error instanceof TdApiError ? input.error.status : undefined);
  const category = failureCategory(input, apiCode, status);
  const timeoutOrConnection = category === "timeout_ambiguous" || category === "bridge_offline";
  return {
    category,
    phase: input.phase,
    ...(input.code ? { code: input.code.slice(0, 80) } : {}),
    ...(apiCode ? { apiCode: apiCode.slice(0, 80) } : {}),
    ...(status !== undefined ? { status } : {}),
    ambiguous: timeoutOrConnection && input.mutates,
    safeMessage: (input.safeMessage ?? stableMessage(category)).slice(0, 240),
  };
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "/";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function boundedIssues(
  issues: RecoveryOptions["validationIssues"],
): Array<{ path: string; code: string; message: string }> {
  return (issues ?? []).slice(0, 12).map((issue) => ({
    path: issue.path.slice(0, 160),
    code: issue.code.slice(0, 80),
    message: issue.message.slice(0, 160),
  }));
}

async function oneSecond<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("recovery_timeout")), 1000);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(new DOMException("cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function stopped(
  failure: ToolFailure,
  action: RecoveryAction = "stop",
  budgetUsed: 0 | 1 = 0,
  evidence?: Record<string, unknown>,
): RecoveryReport {
  return {
    category: failure.category,
    action,
    outcome: "stopped",
    budgetUsed,
    mutationRetry: "blocked",
    ...(evidence ? { evidence } : {}),
  };
}

function validationRecovery(failure: ToolFailure, options: RecoveryOptions): RecoveryReport {
  return {
    category: failure.category,
    action: "return_validation_evidence",
    outcome: "recovered",
    budgetUsed: 1,
    mutationRetry: "blocked",
    evidence: { issues: boundedIssues(options.validationIssues) },
  };
}

function unsafeRecovery(failure: ToolFailure, options: RecoveryOptions): boolean {
  const blocked = new Set<FailureCategory>([
    "timeout_ambiguous",
    "verification_failed",
    "auth_or_policy",
    "unknown",
  ]);
  return blocked.has(failure.category) || (options.mutates && failure.ambiguous);
}

async function probeBridge(
  client: RecoveryClient,
  failure: ToolFailure,
  signal: AbortSignal | undefined,
): Promise<RecoveryReport> {
  try {
    const info = await oneSecond(
      () => client.getInfo({ timeoutMs: 1000, retryGet: false }),
      signal,
    );
    return {
      category: failure.category,
      action: "probe_bridge",
      outcome: "recovered",
      budgetUsed: 1,
      mutationRetry: "blocked",
      evidence: {
        reachable: true,
        build: typeof info.build === "string" ? info.build.slice(0, 80) : undefined,
        bridge_version:
          typeof info.bridge_version === "string" ? info.bridge_version.slice(0, 80) : undefined,
      },
    };
  } catch {
    return stopped(failure, "probe_bridge", 1, { reachable: false });
  }
}

function affectedPath(options: RecoveryOptions): string | undefined {
  return options.affectedPaths?.find((candidate) => candidate.startsWith("/"));
}

async function probeExactPath(
  client: RecoveryClient,
  failure: ToolFailure,
  options: RecoveryOptions,
): Promise<RecoveryReport> {
  const path = affectedPath(options);
  if (!path) return stopped(failure, "probe_exact_path", 0, { reason: "path_unavailable" });
  const searchRoot = options.searchRoot?.startsWith("/") ? options.searchRoot : parentPath(path);
  try {
    const result = await oneSecond(
      () =>
        client.getNetworkTopology(searchRoot, true, {
          timeoutMs: 1000,
          retryGet: false,
        }),
      options.signal,
    );
    const target = basename(path);
    const matches = result.nodes.filter(
      (node) => node.name === target || basename(node.path) === target,
    );
    return {
      category: failure.category,
      action: "probe_exact_path",
      outcome: matches.length === 1 ? "recovered" : "stopped",
      budgetUsed: 1,
      mutationRetry: "blocked",
      evidence: {
        exact_basename: target.slice(0, 160),
        candidates: matches.slice(0, 5).map((node) => ({
          path: node.path.slice(0, 240),
          ...(node.type ? { type: node.type.slice(0, 80) } : {}),
        })),
      },
    };
  } catch {
    return stopped(failure, "probe_exact_path", 1, { reason: "probe_unavailable" });
  }
}

async function probeMenu(
  client: RecoveryClient,
  failure: ToolFailure,
  options: RecoveryOptions,
): Promise<RecoveryReport> {
  const path = affectedPath(options);
  const parameter = options.parameter;
  const getParameterMenu = client.getParameterMenu;
  if (!path || !parameter || !getParameterMenu) {
    return stopped(failure, "probe_menu", 0, { reason: "structured_menu_probe_unavailable" });
  }
  try {
    const menu = await oneSecond(
      () => getParameterMenu(path, parameter, { timeoutMs: 1000, retryGet: false }),
      options.signal,
    );
    return {
      category: failure.category,
      action: "probe_menu",
      outcome: "recovered",
      budgetUsed: 1,
      mutationRetry: "blocked",
      evidence: {
        parameter: parameter.slice(0, 160),
        choices: menu.names.slice(0, 32).map((name) => name.slice(0, 160)),
      },
    };
  } catch {
    return stopped(failure, "probe_menu", 1, { reason: "probe_unavailable" });
  }
}

/**
 * Spend at most one recovery decision on bounded read-only evidence. This never
 * rewrites arguments and never dispatches or retries the original mutation.
 */
export async function recoverFailure(
  client: RecoveryClient,
  failure: ToolFailure,
  options: RecoveryOptions,
): Promise<RecoveryReport> {
  if ((options.budget ?? 1) === 0 || options.signal?.aborted) return stopped(failure);
  if (unsafeRecovery(failure, options)) {
    return stopped(failure, "stop", 0, { reason: "unsafe_or_ambiguous" });
  }
  switch (failure.category) {
    case "bad_json":
    case "invalid_args":
      return validationRecovery(failure, options);
    case "bridge_offline":
    case "bridge_stale":
      return probeBridge(client, failure, options.signal);
    case "path_missing":
      return probeExactPath(client, failure, options);
    case "menu_invalid":
      return probeMenu(client, failure, options);
    default:
      return stopped(failure);
  }
}

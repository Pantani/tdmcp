import { parseArgs } from "node:util";
import { z } from "zod";
import {
  CURATED_SKILL_NAMES,
  type ManageAgentSkillsResult,
  SKILL_OWNED_NAMESPACE,
} from "../skills/types.js";
import {
  ApiEnvelopeSchema,
  EditorContextSchema,
  HealthSchema,
  InfoSchema,
} from "../td-client/validators.js";
import { getVersion } from "../utils/version.js";

export const RuntimeAvailabilitySchema = z.enum(["available", "unavailable", "unknown"]);
export const RuntimeReadinessSchema = z.enum(["ready", "degraded", "not_ready", "unknown"]);
export const RuntimeReasonSchema = z.enum([
  "none",
  "config_invalid",
  "config_missing_explicit",
  "profile_missing",
  "config_unavailable",
  "bridge_offline",
  "bridge_timeout",
  "bridge_rejected",
  "bridge_version_mismatch",
  "malformed_response",
  "endpoint_unsupported",
  "perform_mode",
  "ui_unavailable",
  "reader_unavailable",
  "manifest_missing",
  "manifest_invalid",
  "manifest_drift",
  "client_config_absent",
  "client_config_invalid",
  "client_entry_absent",
  "endpoint_mismatch",
]);

export const RuntimeWarningSchema = z.object({
  code: RuntimeReasonSchema,
  message: z.string().max(240),
});

export const RuntimeInteractionSummarySchema = z
  .object({
    pending_count: z.number().int().nonnegative(),
    pending_limit: z.number().int().positive(),
    active: z.boolean(),
    delivery_configured: z.boolean(),
  })
  .strict();

const RuntimeSkillInstallationSchema = z.object({
  host: z.enum(["codex", "claude"]),
  scope: z.enum(["project", "user"]),
  state: RuntimeAvailabilitySchema,
  manifest_version: z.string().max(128).nullable(),
  integrity: z.enum(["valid", "missing", "invalid", "stale", "unknown"]),
  installed_count: z.number().int().nonnegative(),
  expected_count: z.number().int().nonnegative().nullable(),
  missing_count: z.number().int().nonnegative(),
  stale_count: z.number().int().nonnegative(),
  hash_mismatch_count: z.number().int().nonnegative(),
});

export const RuntimeClientAdapterObservationSchema = z
  .object({
    client: z.enum(["claude", "cursor", "codex"]),
    scope: z.enum(["project", "user"]),
    registration: z.enum(["registered", "not_registered", "invalid", "unknown"]),
    command_matches: z.boolean().nullable(),
    endpoint_matches: z.boolean().nullable(),
    token_presence: z.enum(["configured", "absent", "unknown"]),
  })
  .strict();

const RuntimeClientObservationSchema = RuntimeClientAdapterObservationSchema.extend({
  state: RuntimeAvailabilitySchema,
});

export const RuntimeStatusReportSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.iso.datetime(),
  readiness: RuntimeReadinessSchema,
  config: z.object({
    state: RuntimeAvailabilitySchema,
    reason_code: RuntimeReasonSchema,
    profile: z.string().max(128).nullable(),
    source_kind: z.enum(["explicit", "workspace", "user", "defaults", "unknown"]),
    transport: z.enum(["stdio", "http"]).nullable(),
    bridge_endpoint: z.string().max(512).nullable(),
    mcp_endpoint: z.string().max(512).nullable(),
    http_auth_mode: z.enum(["none", "static", "oauth", "hybrid"]).nullable(),
    request_timeout_ms: z.number().int().positive().nullable(),
    bridge_token: z.enum(["configured", "absent", "unknown"]),
    mcp_http_token: z.enum(["configured", "absent", "unknown"]),
  }),
  bridge: z.object({
    state: RuntimeAvailabilitySchema,
    reason_code: RuntimeReasonSchema,
    health: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
    bridge_version: z.string().max(128).nullable(),
    expected_bridge_version: z.string().max(128),
    version_state: z.enum(["match", "stale", "unknown"]),
    latency_ms: z.number().nonnegative().nullable(),
    heartbeat_stale: z.boolean().nullable(),
  }),
  touchdesigner: z.object({
    state: RuntimeAvailabilitySchema,
    reason_code: RuntimeReasonSchema,
    version: z.string().max(128).nullable(),
    build: z.object({
      state: RuntimeAvailabilitySchema,
      value: z.string().max(128).nullable(),
    }),
    project: z.object({
      state: RuntimeAvailabilitySchema,
      present: z.boolean().nullable(),
    }),
    perform_mode: z.boolean().nullable(),
    ui: z.object({
      state: RuntimeAvailabilitySchema,
      active_network_editor: z.boolean().nullable(),
    }),
  }),
  policy: z.object({
    state: RuntimeAvailabilitySchema,
    reason_code: RuntimeReasonSchema,
    tool_profile: z.enum(["full", "safe", "directory"]).nullable(),
    raw_python_tool_surface: z.enum(["enabled", "disabled", "unknown"]),
    bridge_allow_exec: z.enum(["enabled", "disabled", "unknown"]),
    yolo_confirmation_skip: z.enum(["enabled", "disabled", "unknown"]),
    delete_default: z.enum(["native_fail_closed", "yolo", "unknown"]),
    save_overwrite_default: z.literal("native_fail_closed").nullable(),
  }),
  interactions: z.object({
    state: RuntimeAvailabilitySchema,
    reason_code: RuntimeReasonSchema,
    broker: RuntimeAvailabilitySchema,
    native_ui: RuntimeAvailabilitySchema,
    pending_count: z.number().int().nonnegative().nullable(),
    pending_limit: z.number().int().positive().nullable(),
    active: z.boolean().nullable(),
    fail_closed_choice: z.literal("Keep"),
  }),
  skills: z.object({
    state: RuntimeAvailabilitySchema,
    reason_code: RuntimeReasonSchema,
    source_version: z.string().max(128).nullable(),
    owned_namespace: z.string().max(128).nullable(),
    expected_count: z.number().int().nonnegative().nullable(),
    installed_count: z.number().int().nonnegative(),
    installations: z.array(RuntimeSkillInstallationSchema).max(4),
  }),
  clients: z.object({
    state: RuntimeAvailabilitySchema,
    reason_code: RuntimeReasonSchema,
    observations: z.array(RuntimeClientObservationSchema).length(5),
  }),
  warnings: z.array(RuntimeWarningSchema).max(32),
});

export type RuntimeAvailability = z.infer<typeof RuntimeAvailabilitySchema>;
export type RuntimeReason = z.infer<typeof RuntimeReasonSchema>;
export type RuntimeStatusReport = z.infer<typeof RuntimeStatusReportSchema>;
export type RuntimeClientAdapterObservation = z.infer<typeof RuntimeClientAdapterObservationSchema>;

export interface RuntimeEffectiveConfig {
  profile: string | null;
  source_kind: RuntimeStatusReport["config"]["source_kind"];
  transport: "stdio" | "http";
  bridge_endpoint: string;
  mcp_endpoint: string | null;
  http_auth_mode: "none" | "static" | "oauth" | "hybrid";
  request_timeout_ms: number;
  bridge_token?: string;
  mcp_http_token_configured: boolean;
  tool_profile: "full" | "safe" | "directory";
  raw_python: "on" | "off";
  yolo: boolean;
}

export type RuntimeConfigReadResult =
  | { state: "available"; config: RuntimeEffectiveConfig }
  | {
      state: "unavailable";
      reason_code:
        | "config_invalid"
        | "config_missing_explicit"
        | "profile_missing"
        | "config_unavailable";
      profile?: string | null;
    };

export interface RuntimeStatusArgs {
  profile?: string;
  config_path?: string;
  timeout_ms: number;
  json: boolean;
}

export interface RuntimeStatusDeps {
  readConfig: (
    input: Pick<RuntimeStatusArgs, "profile" | "config_path">,
  ) => RuntimeConfigReadResult | Promise<RuntimeConfigReadResult>;
  readSkills?: () =>
    | readonly ManageAgentSkillsResult[]
    | Promise<readonly ManageAgentSkillsResult[]>;
  readClients?: (
    config: RuntimeEffectiveConfig,
  ) =>
    | readonly RuntimeClientAdapterObservation[]
    | Promise<readonly RuntimeClientAdapterObservation[]>;
  probeBridge?: (input: RuntimeBridgeProbeInput) => Promise<RuntimeBridgeProbeResult>;
  fetchImpl?: typeof fetch;
  expectedBridgeVersion?: string;
  now?: () => Date;
  nowMs?: () => number;
}

export interface RuntimeBridgeProbeInput {
  endpoint: string;
  token?: string;
  timeout_ms: number;
  expected_bridge_version: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export interface RuntimeBridgeProbeResult {
  bridge: RuntimeStatusReport["bridge"];
  touchdesigner: RuntimeStatusReport["touchdesigner"];
  interactions: RuntimeStatusReport["interactions"];
  warnings: RuntimeStatusReport["warnings"];
  code: 0 | 3 | 4;
}

export interface RuntimeStatusResult {
  stdout: string;
  stderr: string;
  code: 0 | 2 | 3 | 4;
  report?: RuntimeStatusReport;
}

type ProbeFailureKind = "offline" | "timeout" | "rejected" | "malformed" | "unsupported";

class ProbeFailure extends Error {
  readonly kind: ProbeFailureKind;

  constructor(kind: ProbeFailureKind) {
    super(kind);
    this.name = "ProbeFailure";
    this.kind = kind;
  }
}

type ProbeOutcome<T> = { ok: true; data: T } | { ok: false; failure: ProbeFailure };

const CLIENT_TARGETS = [
  { client: "claude", scope: "project" },
  { client: "claude", scope: "user" },
  { client: "cursor", scope: "project" },
  { client: "cursor", scope: "user" },
  { client: "codex", scope: "user" },
] as const;
const MAX_BRIDGE_RESPONSE_BYTES = 256 * 1024;

const HELP = [
  "Usage: tdmcp status [--json] [--profile <name>] [--config <path>] [--timeout-ms <ms>]",
  "",
  "Print one read-only, redacted snapshot of the configured TouchDesigner runtime.",
  "",
  "  --json              Emit the stable JSON schema.",
  "  --profile <name>    Select a named config profile.",
  "  --config <path>     Select one config file.",
  "  --timeout-ms <ms>   Bound all bridge GET probes to 100-5000 ms (default 1500).",
  "  --help, -h          Show this help without reading config or probing the bridge.",
].join("\n");

function unknownClient(
  target: (typeof CLIENT_TARGETS)[number],
): RuntimeStatusReport["clients"]["observations"][number] {
  return {
    ...target,
    state: "unknown",
    registration: "unknown",
    command_matches: null,
    endpoint_matches: null,
    token_presence: "unknown",
  };
}

function boundedText(value: unknown, maximum = 128): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, maximum);
}

function validatedCliText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maximum) return null;
  return text;
}

function parseStatusArgs(
  argv: string[],
): { kind: "help" } | { kind: "error" } | { kind: "run"; args: RuntimeStatusArgs } {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        json: { type: "boolean", default: false },
        profile: { type: "string" },
        config: { type: "string" },
        "timeout-ms": { type: "string", default: "1500" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (parsed.values.help) return { kind: "help" };
    const profile = validatedCliText(parsed.values.profile, 128);
    if (parsed.values.profile !== undefined && profile === null) return { kind: "error" };
    const configPath = validatedCliText(parsed.values.config, 4096);
    if (parsed.values.config !== undefined && configPath === null) return { kind: "error" };
    const timeoutMs = Number(parsed.values["timeout-ms"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
      return { kind: "error" };
    }
    return {
      kind: "run",
      args: {
        json: parsed.values.json,
        timeout_ms: timeoutMs,
        ...(profile === null ? {} : { profile }),
        ...(configPath === null ? {} : { config_path: configPath }),
      },
    };
  } catch {
    return { kind: "error" };
  }
}

function redactedEndpoint(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`.slice(0, 512);
  } catch {
    return null;
  }
}

function probeUrl(endpoint: string, path: string): URL {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new ProbeFailure("malformed");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ProbeFailure("malformed");
  }
  base.username = "";
  base.password = "";
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  return new URL(path, base);
}

function failureFromFetch(error: unknown): ProbeFailure {
  if (error instanceof Error && error.name === "AbortError") {
    return new ProbeFailure("timeout");
  }
  return new ProbeFailure("offline");
}

function assertProbeTimeRemaining(remaining: number): void {
  if (remaining < 1) throw new ProbeFailure("timeout");
}

function parseBridgeResponse<T>(text: string, schema: z.ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProbeFailure("malformed");
  }
  const envelope = ApiEnvelopeSchema.safeParse(json);
  if (!envelope.success) throw new ProbeFailure("malformed");
  if (!envelope.data.ok) throw new ProbeFailure("rejected");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new ProbeFailure("malformed");
  return parsed.data;
}

async function fetchBridgeResponse<T>(
  input: RuntimeBridgeProbeInput,
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const headers = input.token ? { authorization: `Bearer ${input.token}` } : undefined;
  const response = await (input.fetchImpl ?? fetch)(probeUrl(input.endpoint, path), {
    method: "GET",
    headers,
    signal,
  });
  if (response.status === 404) throw new ProbeFailure("unsupported");
  if (!response.ok) throw new ProbeFailure("rejected");
  const text = await readBoundedResponseBody(response, MAX_BRIDGE_RESPONSE_BYTES);
  return parseBridgeResponse(text, schema);
}

async function bridgeGet<T>(
  input: RuntimeBridgeProbeInput,
  path: string,
  schema: z.ZodType<T>,
  deadline: number,
): Promise<T> {
  const nowMs = input.nowMs ?? Date.now;
  const remaining = Math.max(0, deadline - nowMs());
  assertProbeTimeRemaining(remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  timer.unref?.();
  try {
    return await fetchBridgeResponse(input, path, schema, controller.signal);
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw failureFromFetch(error);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseBody(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > maximumBytes) {
      throw new ProbeFailure("malformed");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProbeFailure("malformed");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function settled<T>(promise: Promise<T>): Promise<ProbeOutcome<T>> {
  try {
    return { ok: true, data: await promise };
  } catch (error) {
    return {
      ok: false,
      failure: error instanceof ProbeFailure ? error : new ProbeFailure("malformed"),
    };
  }
}

async function probeCore(
  input: RuntimeBridgeProbeInput,
  deadline: number,
): Promise<
  | { ok: true; health: z.infer<typeof HealthSchema> | null; info: z.infer<typeof InfoSchema> }
  | { ok: false; failure: ProbeFailure }
> {
  const health = await settled(bridgeGet(input, "/api/health", HealthSchema, deadline));
  if (health.ok) return { ok: true, health: health.data, info: health.data.touchdesigner ?? {} };
  if (health.failure.kind !== "unsupported") return health;

  const info = await settled(bridgeGet(input, "/api/info", InfoSchema, deadline));
  if (!info.ok) return info;
  return { ok: true, health: null, info: info.data };
}

function probeReason(failure: ProbeFailure): RuntimeReason {
  if (failure.kind === "offline") return "bridge_offline";
  if (failure.kind === "timeout") return "bridge_timeout";
  if (failure.kind === "rejected") return "bridge_rejected";
  if (failure.kind === "unsupported") return "endpoint_unsupported";
  return "malformed_response";
}

function probeCode(failure: ProbeFailure): 3 | 4 {
  return failure.kind === "offline" || failure.kind === "timeout" ? 3 : 4;
}

function unavailableBridge(
  failure: ProbeFailure,
  expectedBridgeVersion: string,
): RuntimeBridgeProbeResult {
  const reason = probeReason(failure);
  const bridgeState = failure.kind === "malformed" ? "unknown" : "unavailable";
  return {
    bridge: {
      state: bridgeState,
      reason_code: reason,
      health: "unknown",
      bridge_version: null,
      expected_bridge_version: expectedBridgeVersion,
      version_state: "unknown",
      latency_ms: null,
      heartbeat_stale: null,
    },
    touchdesigner: {
      state: "unknown",
      reason_code: reason,
      version: null,
      build: { state: "unknown", value: null },
      project: { state: "unknown", present: null },
      perform_mode: null,
      ui: { state: "unknown", active_network_editor: null },
    },
    interactions: {
      state: "unknown",
      reason_code: reason,
      broker: "unknown",
      native_ui: "unknown",
      pending_count: null,
      pending_limit: null,
      active: null,
      fail_closed_choice: "Keep",
    },
    warnings: [{ code: reason, message: bridgeFailureMessage(reason) }],
    code: probeCode(failure),
  };
}

function bridgeFailureMessage(reason: RuntimeReason): string {
  if (reason === "bridge_timeout") return "The configured bridge probe reached its deadline.";
  if (reason === "bridge_rejected") return "The configured bridge rejected the status probe.";
  if (reason === "endpoint_unsupported") return "The bridge has no compatible status endpoint.";
  if (reason === "malformed_response") return "The bridge returned an invalid status response.";
  return "The configured bridge is not reachable.";
}

function healthState(
  health: z.infer<typeof HealthSchema> | null,
): RuntimeStatusReport["bridge"]["health"] {
  if (health === null) return "unknown";
  const raw = `${health.state} ${health.status ?? ""}`.toLowerCase();
  if (/unhealthy|error|failed/u.test(raw)) return "unhealthy";
  if (health.degraded_signals.length > 0 || health.warnings.length > 0 || /degraded/u.test(raw)) {
    return "degraded";
  }
  if (/healthy|ready|running|ok/u.test(raw)) return "healthy";
  return "unknown";
}

function editorUi(
  editor: ProbeOutcome<z.infer<typeof EditorContextSchema>>,
): Pick<RuntimeStatusReport["touchdesigner"], "perform_mode" | "ui"> {
  if (!editor.ok) {
    return {
      perform_mode: null,
      ui: { state: "unknown", active_network_editor: null },
    };
  }
  const performMode = editor.data.perform_mode;
  if (performMode === true) {
    return {
      perform_mode: true,
      ui: { state: "unavailable", active_network_editor: false },
    };
  }
  return {
    perform_mode: performMode,
    ui: {
      state: editor.data.ui_available ? "available" : "unavailable",
      active_network_editor: editor.data.ui_available
        ? editor.data.active_network_editor !== null
        : false,
    },
  };
}

function interactionStatus(
  summary: ProbeOutcome<z.infer<typeof RuntimeInteractionSummarySchema>>,
  ui: RuntimeStatusReport["touchdesigner"]["ui"],
  performMode: boolean | null,
): RuntimeStatusReport["interactions"] {
  if (!summary.ok) {
    return unavailableInteractionStatus(summary.failure);
  }
  const readiness = interactionUiReadiness(summary.data.delivery_configured, ui, performMode);
  return {
    state: readiness.state,
    reason_code: readiness.reason,
    broker: "available",
    native_ui: readiness.state,
    pending_count: summary.data.pending_count,
    pending_limit: summary.data.pending_limit,
    active: summary.data.active,
    fail_closed_choice: "Keep",
  };
}

function unavailableInteractionStatus(failure: ProbeFailure): RuntimeStatusReport["interactions"] {
  const unsupported = failure.kind === "unsupported";
  return {
    state: unsupported ? "unavailable" : "unknown",
    reason_code: unsupported ? "endpoint_unsupported" : "reader_unavailable",
    broker: unsupported ? "unavailable" : "unknown",
    native_ui: "unknown",
    pending_count: null,
    pending_limit: null,
    active: null,
    fail_closed_choice: "Keep",
  };
}

function interactionUiReadiness(
  deliveryConfigured: boolean,
  ui: RuntimeStatusReport["touchdesigner"]["ui"],
  performMode: boolean | null,
): { state: RuntimeAvailability; reason: RuntimeReason } {
  if (!deliveryConfigured || ui.state === "unavailable") {
    return {
      state: "unavailable",
      reason: performMode === true ? "perform_mode" : "ui_unavailable",
    };
  }
  if (ui.state === "available") return { state: "available", reason: "none" };
  return { state: "unknown", reason: "reader_unavailable" };
}

function bridgeVersionState(
  bridgeVersion: string | null,
  expectedBridgeVersion: string,
): RuntimeStatusReport["bridge"]["version_state"] {
  if (bridgeVersion === null || bridgeVersion === "unknown") return "unknown";
  return bridgeVersion === expectedBridgeVersion ? "match" : "stale";
}

function bridgeProbeWarnings(
  versionState: RuntimeStatusReport["bridge"]["version_state"],
  interactions: RuntimeStatusReport["interactions"],
): RuntimeStatusReport["warnings"] {
  const warnings: RuntimeStatusReport["warnings"] = [];
  if (versionState === "stale") {
    warnings.push({
      code: "bridge_version_mismatch",
      message: "The running bridge version differs from this tdmcp build.",
    });
  }
  if (interactions.state !== "available") {
    warnings.push({
      code: interactions.reason_code,
      message: "Native interaction readiness is not fully observable.",
    });
  }
  return warnings;
}

export async function probeConfiguredBridge(
  input: RuntimeBridgeProbeInput,
): Promise<RuntimeBridgeProbeResult> {
  const nowMs = input.nowMs ?? Date.now;
  const startedAt = nowMs();
  const deadline = startedAt + input.timeout_ms;
  const corePromise = probeCore(input, deadline);
  const editorPromise = settled(
    bridgeGet(input, "/api/editor/context", EditorContextSchema, deadline),
  );
  const interactionPromise = settled(
    bridgeGet(input, "/api/interactions/status", RuntimeInteractionSummarySchema, deadline),
  );
  const [core, editor, interaction] = await Promise.all([
    corePromise,
    editorPromise,
    interactionPromise,
  ]);
  if (!core.ok) return unavailableBridge(core.failure, input.expected_bridge_version);

  const version = boundedText(core.info.td_version);
  const build = boundedText(core.info.build);
  const bridgeVersion = boundedText(core.info.bridge_version);
  const projectObserved = typeof core.info.project === "string";
  const hasTdInfo = version !== null || build !== null || projectObserved;
  const ui = editorUi(editor);
  const interactions = interactionStatus(interaction, ui.ui, ui.perform_mode);
  const versionState = bridgeVersionState(bridgeVersion, input.expected_bridge_version);
  const warnings = bridgeProbeWarnings(versionState, interactions);
  return {
    bridge: {
      state: "available",
      reason_code: "none",
      health: healthState(core.health),
      bridge_version: bridgeVersion,
      expected_bridge_version: input.expected_bridge_version,
      version_state: versionState,
      latency_ms: Math.max(0, Math.round(nowMs() - startedAt)),
      heartbeat_stale: core.health?.heartbeat?.stale ?? null,
    },
    touchdesigner: {
      state: hasTdInfo ? "available" : "unknown",
      reason_code: hasTdInfo ? "none" : "malformed_response",
      version,
      build: { state: build === null ? "unknown" : "available", value: build },
      project: {
        state: projectObserved ? "available" : "unknown",
        present: projectObserved ? Boolean(core.info.project?.trim()) : null,
      },
      perform_mode: ui.perform_mode,
      ui: ui.ui,
    },
    interactions,
    warnings,
    code: 0,
  };
}

function unknownClients(): RuntimeStatusReport["clients"] {
  return {
    state: "unknown",
    reason_code: "reader_unavailable",
    observations: CLIENT_TARGETS.map(unknownClient),
  };
}

async function observeClients(
  reader: RuntimeStatusDeps["readClients"],
  config: RuntimeEffectiveConfig,
): Promise<RuntimeStatusReport["clients"]> {
  if (!reader) return unknownClients();
  let raw: readonly RuntimeClientAdapterObservation[];
  try {
    raw = await reader(config);
  } catch {
    return unknownClients();
  }
  const parsed = z.array(RuntimeClientAdapterObservationSchema).safeParse(raw);
  if (!parsed.success) return unknownClients();
  const observations = CLIENT_TARGETS.map((target) => {
    const source = parsed.data.find(
      (item) => item.client === target.client && item.scope === target.scope,
    );
    if (!source) return unknownClient(target);
    const matching =
      source.registration === "registered" &&
      source.command_matches === true &&
      source.endpoint_matches === true;
    const state: RuntimeAvailability = matching
      ? "available"
      : source.registration === "unknown" || source.registration === "invalid"
        ? "unknown"
        : "unavailable";
    return { ...source, state };
  });
  if (observations.some((item) => item.state === "available")) {
    return { state: "available", reason_code: "none", observations };
  }
  if (observations.every((item) => item.state !== "unknown")) {
    const mismatch = observations.some(
      (item) => item.registration === "registered" && item.endpoint_matches === false,
    );
    return {
      state: "unavailable",
      reason_code: mismatch ? "endpoint_mismatch" : "client_entry_absent",
      observations,
    };
  }
  const invalid = observations.some((item) => item.registration === "invalid");
  return {
    state: "unknown",
    reason_code: invalid ? "client_config_invalid" : "reader_unavailable",
    observations,
  };
}

function unknownSkills(): RuntimeStatusReport["skills"] {
  return {
    state: "unknown",
    reason_code: "reader_unavailable",
    source_version: null,
    owned_namespace: SKILL_OWNED_NAMESPACE,
    expected_count: CURATED_SKILL_NAMES.length,
    installed_count: 0,
    installations: [],
  };
}

function skillInstallation(
  result: ManageAgentSkillsResult,
): RuntimeStatusReport["skills"]["installations"][number] {
  const expectedCount = CURATED_SKILL_NAMES.length;
  const installedCount = result.skills.filter(
    (skill) =>
      skill.state === "installed" || skill.state === "outdated" || skill.state === "drifted",
  ).length;
  const explicitMissing = result.skills.filter(
    (skill) => skill.state === "missing" || skill.state === "not_installed",
  ).length;
  const missingCount = Math.max(explicitMissing, expectedCount - result.skills.length);
  const staleCount = result.skills.filter((skill) => skill.state === "outdated").length;
  const mismatchCount = result.skills.filter(
    (skill) => skill.state === "drifted" || skill.state === "unowned_conflict",
  ).length;
  const failed = result.status === "failed" || result.status === "conflict";
  const integrity =
    failed || mismatchCount > 0
      ? "invalid"
      : staleCount > 0
        ? "stale"
        : missingCount > 0
          ? "missing"
          : "valid";
  return {
    host: result.host,
    scope: result.scope,
    state: integrity === "valid" ? "available" : "unavailable",
    manifest_version: null,
    integrity,
    installed_count: installedCount,
    expected_count: expectedCount,
    missing_count: missingCount,
    stale_count: staleCount,
    hash_mismatch_count: mismatchCount,
  };
}

function sortSkillInstallations(
  installations: RuntimeStatusReport["skills"]["installations"],
): RuntimeStatusReport["skills"]["installations"] {
  const hostOrder = { codex: 0, claude: 1 } as const;
  const scopeOrder = { project: 0, user: 1 } as const;
  return installations.sort(
    (left, right) =>
      hostOrder[left.host] - hostOrder[right.host] ||
      scopeOrder[left.scope] - scopeOrder[right.scope],
  );
}

async function observeSkills(
  reader: RuntimeStatusDeps["readSkills"],
): Promise<RuntimeStatusReport["skills"]> {
  const results = await readSkillResults(reader);
  if (results === null) return unknownSkills();
  if (results.length === 0) {
    return {
      ...unknownSkills(),
      state: "unavailable",
      reason_code: "manifest_missing",
    };
  }
  const installations = sortSkillInstallations(results.slice(0, 4).map(skillInstallation));
  const versions = new Set(
    results
      .map((result) => boundedText(result.source_version))
      .filter((value): value is string => value !== null),
  );
  const invalid = installations.some((item) => item.integrity === "invalid");
  const stale = installations.some((item) => item.integrity === "stale");
  const missing = installations.some((item) => item.integrity === "missing");
  const allValid =
    installations.length > 0 && installations.every((item) => item.integrity === "valid");
  const reason = skillAggregateReason({ invalid, stale, missing, versionCount: versions.size });
  return {
    state: allValid && versions.size <= 1 ? "available" : "unavailable",
    reason_code: reason,
    source_version: versions.size === 1 ? ([...versions][0] ?? null) : null,
    owned_namespace: SKILL_OWNED_NAMESPACE,
    expected_count: CURATED_SKILL_NAMES.length,
    installed_count: installations.reduce((sum, item) => sum + item.installed_count, 0),
    installations,
  };
}

async function readSkillResults(
  reader: RuntimeStatusDeps["readSkills"],
): Promise<readonly ManageAgentSkillsResult[] | null> {
  if (!reader) return null;
  try {
    return await reader();
  } catch {
    return null;
  }
}

function skillAggregateReason(input: {
  invalid: boolean;
  stale: boolean;
  missing: boolean;
  versionCount: number;
}): RuntimeReason {
  if (input.invalid) return "manifest_invalid";
  if (input.stale) return "manifest_drift";
  if (input.missing) return "manifest_missing";
  if (input.versionCount > 1) return "manifest_drift";
  return "none";
}

function unavailableConfig(
  read: Exclude<RuntimeConfigReadResult, { state: "available" }>,
): RuntimeStatusReport["config"] {
  return {
    state: "unavailable",
    reason_code: read.reason_code,
    profile: boundedText(read.profile),
    source_kind: "unknown",
    transport: null,
    bridge_endpoint: null,
    mcp_endpoint: null,
    http_auth_mode: null,
    request_timeout_ms: null,
    bridge_token: "unknown",
    mcp_http_token: "unknown",
  };
}

function availableConfig(config: RuntimeEffectiveConfig): RuntimeStatusReport["config"] {
  return {
    state: "available",
    reason_code: "none",
    profile: boundedText(config.profile),
    source_kind: config.source_kind,
    transport: config.transport,
    bridge_endpoint: redactedEndpoint(config.bridge_endpoint),
    mcp_endpoint: redactedEndpoint(config.mcp_endpoint),
    http_auth_mode: config.http_auth_mode,
    request_timeout_ms: config.request_timeout_ms,
    bridge_token: config.bridge_token ? "configured" : "absent",
    mcp_http_token: config.mcp_http_token_configured ? "configured" : "absent",
  };
}

function availablePolicy(config: RuntimeEffectiveConfig): RuntimeStatusReport["policy"] {
  return {
    state: "available",
    reason_code: "none",
    tool_profile: config.tool_profile,
    raw_python_tool_surface: config.raw_python === "on" ? "enabled" : "disabled",
    bridge_allow_exec: "unknown",
    yolo_confirmation_skip: config.yolo ? "enabled" : "disabled",
    delete_default: config.yolo ? "yolo" : "native_fail_closed",
    save_overwrite_default: "native_fail_closed",
  };
}

function unknownPolicy(): RuntimeStatusReport["policy"] {
  return {
    state: "unknown",
    reason_code: "config_unavailable",
    tool_profile: null,
    raw_python_tool_surface: "unknown",
    bridge_allow_exec: "unknown",
    yolo_confirmation_skip: "unknown",
    delete_default: "unknown",
    save_overwrite_default: null,
  };
}

function reportReadiness(
  report: Omit<RuntimeStatusReport, "readiness">,
): RuntimeStatusReport["readiness"] {
  if (report.config.state === "unavailable" || report.bridge.state === "unavailable") {
    return "not_ready";
  }
  if (report.config.state === "unknown" || report.bridge.state === "unknown") return "unknown";
  const degraded =
    report.bridge.health !== "healthy" ||
    report.bridge.version_state === "stale" ||
    report.touchdesigner.state !== "available" ||
    report.interactions.state !== "available" ||
    report.skills.state !== "available" ||
    report.clients.state !== "available";
  return degraded ? "degraded" : "ready";
}

function stateTag(state: RuntimeAvailability): string {
  if (state === "available") return "OK";
  if (state === "unavailable") return "OFFLINE";
  return "?";
}

function humanNextSteps(report: RuntimeStatusReport): string[] {
  const steps = new Set<string>();
  if (report.config.state !== "available") {
    steps.add("Run `tdmcp init --dry-run` to inspect the bounded setup plan.");
  }
  if (report.bridge.state !== "available") {
    steps.add("Run `tdmcp install-bridge --verify` to stage and verify the bridge.");
  }
  if (report.skills.state !== "available") {
    steps.add("Run `tdmcp skills status` to inspect the owned skill manifest.");
  }
  if (report.clients.state !== "available") {
    steps.add("Run `tdmcp install-client <claude|codex|cursor> --check` for the intended client.");
  }
  return [...steps].slice(0, 4);
}

function renderHuman(report: RuntimeStatusReport): string {
  const profile = report.config.profile ?? "default";
  const bridgeEndpoint = report.config.bridge_endpoint ?? "unknown endpoint";
  const bridgeVersion = report.bridge.bridge_version ?? "unknown";
  const tdVersion = report.touchdesigner.version ?? "unknown";
  const tdBuild = report.touchdesigner.build.value ?? "unknown";
  const clients =
    report.clients.observations
      .filter((item) => item.registration === "registered")
      .map((item) => `${item.client}:${item.scope}`)
      .join(", ") || "none observed";
  const lines = [
    "tdmcp status — active runtime",
    "",
    `  [${stateTag(report.config.state)}] Config: profile ${profile} · ${report.config.transport ?? "unknown"} · bridge ${bridgeEndpoint}`,
    `  [${stateTag(report.bridge.state)}] Bridge: ${report.bridge.health} · version ${bridgeVersion}`,
    `  [${stateTag(report.touchdesigner.state)}] TouchDesigner: ${tdVersion} · build ${tdBuild}`,
    `  [${stateTag(report.policy.state)}] Safety: profile ${report.policy.tool_profile ?? "unknown"} · raw-Python ${report.policy.raw_python_tool_surface} · YOLO ${report.policy.yolo_confirmation_skip}`,
    `  [${stateTag(report.interactions.state)}] Interaction: ${report.interactions.pending_count ?? "?"}/${report.interactions.pending_limit ?? "?"} pending · fail-closed Keep`,
    `  [${stateTag(report.skills.state)}] Skills: ${report.skills.installed_count}/${report.skills.expected_count ?? "?"} installed`,
    `  [${stateTag(report.clients.state)}] Clients: ${clients}`,
    "",
    report.readiness === "ready"
      ? "Ready — the configured runtime and agent guidance are observable."
      : report.readiness === "not_ready"
        ? "Not ready — inspect the unavailable rows above."
        : report.readiness === "degraded"
          ? "Degraded — the bridge is reachable, with warnings or unknown optional state."
          : "Unknown — runtime readiness could not be determined safely.",
  ];
  const nextSteps = humanNextSteps(report);
  if (nextSteps.length > 0) {
    lines.push("", "Next safe checks:", ...nextSteps.map((step) => `  - ${step}`));
  }
  return `${lines.join("\n")}\n`;
}

function finishReport(
  report: Omit<RuntimeStatusReport, "readiness">,
  json: boolean,
  code: 0 | 2 | 3 | 4,
): RuntimeStatusResult {
  const candidate = { ...report, readiness: reportReadiness(report) };
  const parsed = RuntimeStatusReportSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      stdout: "",
      stderr: "Runtime status could not construct a safe report.\n",
      code: 4,
    };
  }
  return {
    stdout: json ? `${JSON.stringify(parsed.data, null, 2)}\n` : renderHuman(parsed.data),
    stderr: "",
    code,
    report: parsed.data,
  };
}

function unavailableBridgeWithoutProbe(expectedBridgeVersion: string): RuntimeBridgeProbeResult {
  return unavailableBridge(new ProbeFailure("malformed"), expectedBridgeVersion);
}

export async function runRuntimeStatus(
  argv: string[],
  deps: RuntimeStatusDeps,
): Promise<RuntimeStatusResult> {
  const parsedArgs = parseStatusArgs(argv);
  if (parsedArgs.kind === "help") {
    return { stdout: `${HELP}\n`, stderr: "", code: 0 };
  }
  if (parsedArgs.kind === "error") {
    return {
      stdout: "",
      stderr: "Invalid status arguments. Run `tdmcp status --help`.\n",
      code: 2,
    };
  }

  const expectedBridgeVersion =
    boundedText(deps.expectedBridgeVersion ?? getVersion()) ?? "unknown";
  const skillsPromise = observeSkills(deps.readSkills);
  let configRead: RuntimeConfigReadResult;
  try {
    configRead = await deps.readConfig(parsedArgs.args);
  } catch {
    configRead = { state: "unavailable", reason_code: "config_unavailable" };
  }

  if (configRead.state === "unavailable") {
    const skills = await skillsPromise;
    const bridge = unavailableBridgeWithoutProbe(expectedBridgeVersion);
    return finishReport(
      {
        schema_version: 1,
        generated_at: (deps.now ?? (() => new Date()))().toISOString(),
        config: unavailableConfig(configRead),
        bridge: { ...bridge.bridge, reason_code: "config_unavailable" },
        touchdesigner: {
          ...bridge.touchdesigner,
          reason_code: "config_unavailable",
        },
        policy: unknownPolicy(),
        interactions: {
          ...bridge.interactions,
          reason_code: "config_unavailable",
        },
        skills,
        clients: unknownClients(),
        warnings: [
          { code: configRead.reason_code, message: "Effective configuration is unavailable." },
        ],
      },
      parsedArgs.args.json,
      2,
    );
  }

  const config = configRead.config;
  if (redactedEndpoint(config.bridge_endpoint) === null) {
    const skills = await skillsPromise;
    return finishReport(
      {
        schema_version: 1,
        generated_at: (deps.now ?? (() => new Date()))().toISOString(),
        config: unavailableConfig({ state: "unavailable", reason_code: "config_invalid" }),
        bridge: unavailableBridgeWithoutProbe(expectedBridgeVersion).bridge,
        touchdesigner: unavailableBridgeWithoutProbe(expectedBridgeVersion).touchdesigner,
        policy: unknownPolicy(),
        interactions: unavailableBridgeWithoutProbe(expectedBridgeVersion).interactions,
        skills,
        clients: unknownClients(),
        warnings: [{ code: "config_invalid", message: "The bridge endpoint is invalid." }],
      },
      parsedArgs.args.json,
      2,
    );
  }

  const probe = deps.probeBridge ?? probeConfiguredBridge;
  const [bridge, skills, clients] = await Promise.all([
    probe({
      endpoint: config.bridge_endpoint,
      ...(config.bridge_token ? { token: config.bridge_token } : {}),
      timeout_ms: parsedArgs.args.timeout_ms,
      expected_bridge_version: expectedBridgeVersion,
      fetchImpl: deps.fetchImpl,
      nowMs: deps.nowMs,
    }),
    skillsPromise,
    observeClients(deps.readClients, config),
  ]);
  const warnings = [...bridge.warnings];
  if (skills.state !== "available") {
    warnings.push({ code: skills.reason_code, message: "Owned agent skills are not fully ready." });
  }
  if (clients.state !== "available") {
    warnings.push({
      code: clients.reason_code,
      message: "No matching client registration was fully observed.",
    });
  }
  return finishReport(
    {
      schema_version: 1,
      generated_at: (deps.now ?? (() => new Date()))().toISOString(),
      config: availableConfig(config),
      bridge: bridge.bridge,
      touchdesigner: bridge.touchdesigner,
      policy: availablePolicy(config),
      interactions: bridge.interactions,
      skills,
      clients,
      warnings,
    },
    parsedArgs.args.json,
    bridge.code,
  );
}

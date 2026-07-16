import { parseArgs } from "node:util";
import { z } from "zod";
import { buildToolContext } from "../server/context.js";
import type { TdEditorContext, TdPerformModeState } from "../td-client/validators.js";
import { PerformModeStateSchema } from "../td-client/validators.js";
import {
  type ShowPreflightReportArgs,
  showPreflightReportImpl,
  showPreflightReportOutputSchema,
} from "../tools/showPreflightReportCore.js";
import type { ToolContext } from "../tools/types.js";
import { loadConfig, type TdmcpConfig, tdBaseUrl } from "../utils/config.js";
import { type DoctorReport, runDoctor as runEnvironmentDoctor } from "./doctor.js";
import {
  type RuntimeStatusDeps,
  type RuntimeStatusReport,
  type RuntimeStatusResult,
  runRuntimeStatus,
} from "./runtimeStatus.js";
import { createRuntimeStatusDeps } from "./runtimeStatusAdapters.js";
import { runTopLevelDoctor, type TopLevelDoctorResult } from "./topLevelDoctor.js";

const MAX_WARNINGS = 16;
const MAX_CHECKS = 64;
const MAX_MESSAGE = 240;

const showGateStatusSchema = z.enum(["pass", "warn", "fail", "unverified", "not_run"]);
const profileNameSchema = z
  .string()
  .min(1)
  .refine((value) => Array.from(value).length <= 128, "Profile exceeds 128 code points.");

const showCheckSchema = z
  .object({
    id: z.string().min(1).max(128),
    status: z.enum(["pass", "warn", "fail", "unverified"]),
    message: z.string().max(MAX_MESSAGE),
    critical: z.boolean().optional(),
  })
  .strict();

export const showModeResultSchema = z
  .object({
    schema_version: z.literal(1),
    requested_profile: profileNameSchema,
    resolved_profile: profileNameSchema.nullable(),
    config_source: z.enum(["explicit", "workspace", "user", "defaults", "unknown"]),
    bridge_origin: z.string().url().max(512).nullable(),
    root_path: z.string().max(240),
    target_fps: z.number().min(1).max(240),
    timeout_ms: z.number().int().min(100).max(5_000),
    dry_run: z.boolean(),
    overrides: z.object({ allow_warn: z.boolean(), allow_unverified: z.boolean() }).strict(),
    overall: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
    runtime_status: z
      .object({
        status: showGateStatusSchema,
        readiness: z.enum(["ready", "degraded", "not_ready", "unknown"]).nullable(),
        config: z.enum(["available", "unavailable", "unknown"]).nullable(),
        bridge: z.enum(["available", "unavailable", "unknown"]).nullable(),
        bridge_health: z.enum(["healthy", "degraded", "unhealthy", "unknown"]).nullable(),
        touchdesigner: z.enum(["available", "unavailable", "unknown"]).nullable(),
        project_present: z.boolean().nullable(),
        perform_mode: z.boolean().nullable(),
        warning_count: z.number().int().nonnegative().max(32),
      })
      .strict(),
    doctor: z
      .object({
        status: showGateStatusSchema,
        checks: z.array(showCheckSchema).max(MAX_CHECKS),
      })
      .strict(),
    preflight: z
      .object({
        status: showGateStatusSchema,
        summary: z
          .object({
            pass: z.number().int().nonnegative(),
            unverified: z.number().int().nonnegative(),
            warn: z.number().int().nonnegative(),
            fail: z.number().int().nonnegative(),
          })
          .strict(),
        checks: z.array(showCheckSchema).max(MAX_CHECKS),
      })
      .strict(),
    perform_before: z.boolean().nullable(),
    perform_after: z.boolean().nullable(),
    already_perform: z.boolean(),
    action_applied: z.enum(["none", "entered", "rolled_back"]),
    rollback: z
      .object({
        status: z.enum(["not_needed", "pass", "fail", "unverified"]),
      })
      .strict(),
    warnings: z.array(z.string().max(MAX_MESSAGE)).max(MAX_WARNINGS),
    exit_code: z.union([z.literal(0), z.literal(3), z.literal(4)]),
  })
  .strict();

export type ShowModeReport = z.infer<typeof showModeResultSchema>;

export interface ShowModeResult {
  stdout: string;
  stderr: string;
  code: 0 | 2 | 3 | 4;
  report?: ShowModeReport;
}

interface ParsedShowArgs {
  profile: string;
  config_path?: string;
  root_path: string;
  target_fps: number;
  timeout_ms: number;
  allow_warn: boolean;
  allow_unverified: boolean;
  dry_run: boolean;
  json: boolean;
}

interface DoctorRunInput {
  config: TdmcpConfig;
  context: ToolContext;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface ShowModeDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  createRuntimeStatusDeps: (options: { env: NodeJS.ProcessEnv; cwd: string }) => RuntimeStatusDeps;
  runRuntimeStatus: (argv: string[], deps: RuntimeStatusDeps) => Promise<RuntimeStatusResult>;
  loadConfig: typeof loadConfig;
  buildToolContext: (config: TdmcpConfig) => ToolContext;
  runDoctor: (argv: string[], input: DoctorRunInput) => Promise<TopLevelDoctorResult>;
  runPreflight: (
    context: ToolContext,
    args: ShowPreflightReportArgs,
  ) => ReturnType<typeof showPreflightReportImpl>;
}

const HELP = [
  "Usage: tdmcp show <profile> [--config <file>] [--root-path <path>]",
  "                  [--target-fps <fps>] [--timeout-ms <ms>]",
  "                  [--allow-warn] [--allow-unverified] [--dry-run] [--json]",
  "",
  "Run fail-closed show gates for one exact venue profile, then enter Perform Mode.",
  "Availability: source-only; enter, already-on and failure/rollback passed on TD 2025.32820. Other builds and headless runtimes remain unverified.",
  "This command never loads a project and never falls back to raw Python.",
].join("\n");

const defaultDeps: ShowModeDeps = {
  env: process.env,
  cwd: process.cwd(),
  createRuntimeStatusDeps: (options) => createRuntimeStatusDeps(options),
  runRuntimeStatus,
  loadConfig,
  buildToolContext,
  runDoctor: (argv, input) =>
    runTopLevelDoctor(argv, {
      env: input.env,
      cwd: input.cwd,
      loadConfig: () => input.config,
      runDoctor: (options) =>
        runEnvironmentDoctor({
          ...options,
          config: input.config,
          makeCtx: () => input.context,
        }),
    }),
  runPreflight: showPreflightReportImpl,
};

type ParseResult = { kind: "help" } | { kind: "error" } | { kind: "run"; args: ParsedShowArgs };

function safeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return null;
  if (value.trim() !== value) return null;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f)
    ) {
      return null;
    }
  }
  return value;
}

function safeProfile(value: unknown): string | null {
  const profile = safeText(value, 256);
  if (profile === null || Array.from(profile).length > 128 || profile.startsWith("-")) return null;
  return profile;
}

function safeRootPath(value: unknown): string | null {
  const path = safeText(value, 240);
  if (path === null || !path.startsWith("/") || path.includes("\\") || path.includes("//")) {
    return null;
  }
  if (path.split("/").some((part) => part === "." || part === "..")) return null;
  return path;
}

function optionCount(argv: readonly string[], name: string): number {
  return argv.filter((token) => token === name || token.startsWith(`${name}=`)).length;
}

function hasDuplicateOptions(argv: readonly string[]): boolean {
  if (argv.filter((token) => token === "-h").length > 1) return true;
  return [
    "--config",
    "--root-path",
    "--target-fps",
    "--timeout-ms",
    "--allow-warn",
    "--allow-unverified",
    "--dry-run",
    "--json",
    "--help",
  ].some((name) => optionCount(argv, name) > 1);
}

function parseShowArgs(argv: string[]): ParseResult {
  if (hasDuplicateOptions(argv)) return { kind: "error" };
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        "root-path": { type: "string", default: "/project1" },
        "target-fps": { type: "string", default: "60" },
        "timeout-ms": { type: "string", default: "1500" },
        "allow-warn": { type: "boolean", default: false },
        "allow-unverified": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (parsed.values.help) return { kind: "help" };
    if (parsed.positionals.length !== 1) return { kind: "error" };
    const profile = safeProfile(parsed.positionals[0]);
    const configPath =
      parsed.values.config === undefined ? undefined : safeText(parsed.values.config, 4_096);
    if (configPath === null) return { kind: "error" };
    const rootPath = safeRootPath(parsed.values["root-path"]);
    const targetFps = Number(parsed.values["target-fps"]);
    const timeoutMs = Number(parsed.values["timeout-ms"]);
    if (
      profile === null ||
      rootPath === null ||
      !Number.isFinite(targetFps) ||
      targetFps < 1 ||
      targetFps > 240 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 5_000
    ) {
      return { kind: "error" };
    }
    return {
      kind: "run",
      args: {
        profile,
        ...(configPath === undefined ? {} : { config_path: configPath }),
        root_path: rootPath,
        target_fps: targetFps,
        timeout_ms: timeoutMs,
        allow_warn: parsed.values["allow-warn"],
        allow_unverified: parsed.values["allow-unverified"],
        dry_run: parsed.values["dry-run"],
        json: parsed.values.json,
      },
    };
  } catch {
    return { kind: "error" };
  }
}

function emptyRuntimeSummary(): ShowModeReport["runtime_status"] {
  return {
    status: "not_run",
    readiness: null,
    config: null,
    bridge: null,
    bridge_health: null,
    touchdesigner: null,
    project_present: null,
    perform_mode: null,
    warning_count: 0,
  };
}

function baseReport(args: ParsedShowArgs): ShowModeReport {
  return {
    schema_version: 1,
    requested_profile: args.profile,
    resolved_profile: null,
    config_source: "unknown",
    bridge_origin: null,
    root_path: args.root_path,
    target_fps: args.target_fps,
    timeout_ms: args.timeout_ms,
    dry_run: args.dry_run,
    overrides: {
      allow_warn: args.allow_warn,
      allow_unverified: args.allow_unverified,
    },
    overall: "FAIL",
    runtime_status: emptyRuntimeSummary(),
    doctor: { status: "not_run", checks: [] },
    preflight: {
      status: "not_run",
      summary: { pass: 0, unverified: 0, warn: 0, fail: 0 },
      checks: [],
    },
    perform_before: null,
    perform_after: null,
    already_perform: false,
    action_applied: "none",
    rollback: { status: "not_needed" },
    warnings: [],
    exit_code: 3,
  };
}

function boundedId(value: unknown, fallback: string): string {
  const safe = safeText(value, 128);
  return safe ?? fallback;
}

function safeMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const printable = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }).join("");
  const redacted = printable
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/\b(?:token|secret|password)\s*[:=]\s*\S+/giu, "credential=[redacted]")
    .trim();
  return (redacted || fallback).slice(0, MAX_MESSAGE);
}

function addWarning(report: ShowModeReport, message: string): void {
  if (report.warnings.length >= MAX_WARNINGS) return;
  report.warnings.push(safeMessage(message, "A show-mode gate needs attention."));
}

function origin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function summarizeRuntime(report: RuntimeStatusReport): ShowModeReport["runtime_status"] {
  return {
    status:
      report.readiness === "ready"
        ? "pass"
        : report.readiness === "degraded"
          ? "warn"
          : report.readiness === "unknown"
            ? "unverified"
            : "fail",
    readiness: report.readiness,
    config: report.config.state,
    bridge: report.bridge.state,
    bridge_health: report.bridge.health,
    touchdesigner: report.touchdesigner.state,
    project_present: report.touchdesigner.project.present,
    perform_mode: report.touchdesigner.perform_mode,
    warning_count: report.warnings.length,
  };
}

interface GateEvidence {
  fail: string[];
  warn: string[];
  unverified: string[];
  essentialUnverified: string[];
}

function evidence(): GateEvidence {
  return { fail: [], warn: [], unverified: [], essentialUnverified: [] };
}

function appendEvidence(
  target: string[],
  candidates: ReadonlyArray<readonly [boolean, string]>,
): void {
  for (const [present, message] of candidates) {
    if (present) target.push(message);
  }
}

function inspectRuntime(
  runtime: RuntimeStatusReport,
  args: ParsedShowArgs,
  expectedOrigin: string,
  gates: GateEvidence,
): void {
  appendEvidence(gates.fail, [
    [runtime.config.profile !== args.profile, "Resolved profile mismatch."],
    [runtime.config.state !== "available", "Configuration is unavailable."],
    [runtime.bridge.state !== "available", "Bridge is unavailable."],
    [runtime.touchdesigner.state !== "available", "TouchDesigner is unavailable."],
    [
      runtime.touchdesigner.project.state !== "available" ||
        runtime.touchdesigner.project.present !== true,
      "A saved TouchDesigner project is required.",
    ],
    [runtime.bridge.health === "unhealthy", "Bridge health is unhealthy."],
    [
      origin(runtime.config.bridge_endpoint) !== expectedOrigin,
      "Status and action bridge endpoints do not match.",
    ],
  ]);
  appendEvidence(gates.essentialUnverified, [
    [
      runtime.touchdesigner.perform_mode === null,
      "Perform Mode state is unavailable in runtime status.",
    ],
  ]);
  appendEvidence(gates.warn, [
    [
      runtime.bridge.health === "degraded" || runtime.bridge.version_state === "stale",
      "Bridge health or version is degraded.",
    ],
    [runtime.warnings.length > 0, `${runtime.warnings.length} runtime warning(s) were reported.`],
  ]);
  appendEvidence(gates.unverified, [
    [runtime.bridge.health === "unknown", "Bridge health is unverified."],
    [
      runtime.touchdesigner.ui.state !== "available" && runtime.touchdesigner.perform_mode !== true,
      "TouchDesigner UI/display context is unavailable.",
    ],
  ]);
}

const doctorReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["pass", "warn", "fail"]),
      detail: z.string(),
      critical: z.boolean(),
    }),
  ),
  config: z.object({ tdBaseUrl: z.string() }).passthrough(),
});

function parseDoctor(result: TopLevelDoctorResult): DoctorReport | null {
  try {
    const parsed = doctorReportSchema.safeParse(JSON.parse(result.stdout));
    return parsed.success ? (parsed.data as DoctorReport) : null;
  } catch {
    return null;
  }
}

function resolvedDoctorStatus(
  criticalFail: boolean,
  warningCount: number,
  doctorOk: boolean,
  resultCode: number,
): ShowModeReport["doctor"]["status"] {
  if (criticalFail) return "fail";
  if (warningCount > 0) return "warn";
  return doctorOk && resultCode === 0 ? "pass" : "fail";
}

function inspectDoctor(
  doctor: DoctorReport,
  expectedOrigin: string,
  result: TopLevelDoctorResult,
  report: ShowModeReport,
  gates: GateEvidence,
): void {
  report.doctor.checks = doctor.checks.slice(0, MAX_CHECKS).map((check) => ({
    id: boundedId(check.id, "doctor_check"),
    status: check.status,
    message: `${check.critical ? "Critical" : "Optional"} doctor check ${check.status}.`,
    critical: check.critical,
  }));
  const criticalFail = doctor.checks.some((check) => check.critical && check.status === "fail");
  const warnings = doctor.checks.filter(
    (check) => check.status === "warn" || (!check.critical && check.status === "fail"),
  );
  report.doctor.status = resolvedDoctorStatus(
    criticalFail,
    warnings.length,
    doctor.ok,
    result.code,
  );
  if (origin(doctor.config.tdBaseUrl) !== expectedOrigin) {
    gates.fail.push("Doctor and action bridge endpoints do not match.");
  }
  if (criticalFail || (!doctor.ok && warnings.length === 0)) {
    gates.fail.push("A critical doctor check failed.");
  }
  if (warnings.length > 0) gates.warn.push(`${warnings.length} doctor warning(s) were reported.`);
}

function inspectPreflight(raw: unknown, report: ShowModeReport, gates: GateEvidence): boolean {
  const parsed = showPreflightReportOutputSchema.safeParse(raw);
  if (!parsed.success) {
    report.preflight.status = "fail";
    gates.fail.push("Preflight returned an invalid structured report.");
    return false;
  }
  const preflight = parsed.data;
  report.preflight = {
    status: preflight.status,
    summary: preflight.summary,
    checks: preflight.checks.slice(0, MAX_CHECKS).map((check) => ({
      id: boundedId(check.id, "preflight_check"),
      status: check.status,
      message: safeMessage(check.message, `Preflight check ${check.status}.`),
    })),
  };
  if (preflight.checks.some((check) => check.status === "fail")) {
    gates.fail.push("A preflight check failed.");
  }
  if (preflight.checks.some((check) => check.status === "warn")) {
    gates.warn.push("Preflight warnings require explicit acceptance.");
  }
  if (preflight.checks.some((check) => check.status === "unverified")) {
    gates.unverified.push("Unverified preflight checks require explicit acceptance.");
  }
  return true;
}

type PerformRead = { kind: "known"; value: boolean } | { kind: "unknown" } | { kind: "error" };

async function readPerform(context: ToolContext, timeoutMs: number): Promise<PerformRead> {
  try {
    const editor: TdEditorContext = await context.client.getEditorContext({
      timeoutMs,
      retry: false,
    });
    return typeof editor.perform_mode === "boolean"
      ? { kind: "known", value: editor.perform_mode }
      : { kind: "unknown" };
  } catch {
    return { kind: "error" };
  }
}

function confirmedWrite(raw: unknown, enabled: boolean): raw is TdPerformModeState {
  const parsed = PerformModeStateSchema.safeParse(raw);
  return (
    parsed.success &&
    parsed.data.enabled === enabled &&
    parsed.data.stored &&
    (parsed.data.ui_perform_mode_set || parsed.data.project_perform_mode_set) &&
    parsed.data.warnings.length === 0
  );
}

interface RollbackResult {
  status: ShowModeReport["rollback"]["status"];
  performAfter: boolean | null;
}

async function rollback(context: ToolContext, timeoutMs: number): Promise<RollbackResult> {
  try {
    confirmedWrite(await context.client.setPerformMode(false), false);
  } catch {
    // The bounded readback below remains authoritative after an ambiguous POST.
  }
  const readback = await readPerform(context, timeoutMs);
  if (readback.kind === "known" && readback.value === false) {
    return { status: "pass", performAfter: false };
  }
  if (readback.kind === "known" && readback.value === true) {
    return { status: "fail", performAfter: true };
  }
  return {
    status: "unverified",
    performAfter: null,
  };
}

function applyGateDecision(
  args: ParsedShowArgs,
  gates: GateEvidence,
  report: ShowModeReport,
): boolean {
  for (const message of [...gates.fail, ...gates.essentialUnverified]) addWarning(report, message);
  if (gates.fail.length > 0) {
    report.overall = "FAIL";
    report.exit_code = 3;
    return false;
  }
  if (gates.essentialUnverified.length > 0) {
    report.overall = "UNVERIFIED";
    report.exit_code = 4;
    return false;
  }
  if (gates.warn.length > 0 && !args.allow_warn) {
    addWarning(report, "Warnings were not accepted; use --allow-warn after reviewing them.");
    report.overall = "FAIL";
    report.exit_code = 3;
    return false;
  }
  if (gates.unverified.length > 0 && !args.allow_unverified) {
    addWarning(
      report,
      "Optional checks remain unverified; use --allow-unverified after reviewing them.",
    );
    report.overall = "UNVERIFIED";
    report.exit_code = 4;
    return false;
  }
  for (const message of gates.warn) addWarning(report, `${message} Accepted by --allow-warn.`);
  for (const message of gates.unverified) {
    addWarning(report, `${message} Accepted by --allow-unverified.`);
  }
  return true;
}

function renderHuman(report: ShowModeReport): string {
  const label = (status: ShowModeReport["runtime_status"]["status"]) =>
    status.toUpperCase().padEnd(10);
  const lines = [
    `tdmcp show — ${report.requested_profile}`,
    "",
    `  ${label(report.runtime_status.status)} profile/runtime`,
    `  ${label(report.doctor.status)} doctor · ${report.doctor.checks.length} check(s)`,
    `  ${label(report.preflight.status)} preflight · ${report.preflight.summary.pass} pass`,
  ];
  if (report.overall === "PASS" && report.dry_run) {
    lines.push("", "WOULD ENTER PERFORM MODE · dry_run=true");
  } else if (report.overall === "PASS" && report.already_perform) {
    lines.push("", "SHOW READY · Perform Mode was already ON; no state changed.");
  } else if (report.overall === "PASS") {
    lines.push("", "SHOW READY");
  } else {
    lines.push("", `${report.overall} · ${report.warnings[0] ?? "Show gates did not pass."}`);
    if (report.perform_before === true) {
      lines.push("Pre-existing Perform Mode was not owned or changed by this command.");
    }
  }
  return `${lines.join("\n")}\n`;
}

function finish(args: ParsedShowArgs, report: ShowModeReport): ShowModeResult {
  const parsed = showModeResultSchema.safeParse(report);
  if (!parsed.success) {
    return {
      stdout: "",
      stderr: "Show mode could not construct a safe bounded report.\n",
      code: 4,
    };
  }
  return {
    stdout: args.json ? `${JSON.stringify(parsed.data, null, 2)}\n` : renderHuman(parsed.data),
    stderr: "",
    code: parsed.data.exit_code,
    report: parsed.data,
  };
}

function statusArgv(args: ParsedShowArgs): string[] {
  return [
    "--json",
    "--profile",
    args.profile,
    ...(args.config_path ? ["--config", args.config_path] : []),
    "--timeout-ms",
    String(args.timeout_ms),
  ];
}

function doctorArgv(args: ParsedShowArgs): string[] {
  return [
    "--json",
    "--profile",
    args.profile,
    ...(args.config_path ? ["--config", args.config_path] : []),
  ];
}

function resolvedDeps(overrides: Partial<ShowModeDeps>): ShowModeDeps {
  return {
    ...defaultDeps,
    ...overrides,
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? process.cwd(),
  };
}

async function readRuntimePhase(
  args: ParsedShowArgs,
  deps: ShowModeDeps,
  report: ShowModeReport,
): Promise<RuntimeStatusReport | null> {
  let runtimeResult: RuntimeStatusResult;
  try {
    runtimeResult = await deps.runRuntimeStatus(
      statusArgv(args),
      deps.createRuntimeStatusDeps({ env: deps.env, cwd: deps.cwd }),
    );
  } catch {
    addWarning(report, "Runtime status could not be read safely.");
    report.overall = "FAIL";
    return null;
  }
  const runtime = runtimeResult.report;
  if (!runtime) {
    addWarning(report, "Runtime status did not return a structured report.");
    report.overall = runtimeResult.code === 4 ? "UNVERIFIED" : "FAIL";
    report.exit_code = runtimeResult.code === 4 ? 4 : 3;
    return null;
  }
  report.resolved_profile = runtime.config.profile;
  report.config_source = runtime.config.source_kind;
  report.bridge_origin = origin(runtime.config.bridge_endpoint);
  report.runtime_status = summarizeRuntime(runtime);
  return runtime;
}

interface ActionContext {
  config: TdmcpConfig;
  context: ToolContext;
}

function loadActionContext(
  args: ParsedShowArgs,
  deps: ShowModeDeps,
  report: ShowModeReport,
): ActionContext | null {
  try {
    const config = deps.loadConfig(deps.env, {
      useFiles: true,
      profile: args.profile,
      ...(args.config_path ? { configPath: args.config_path } : {}),
      cwd: deps.cwd,
      overrides: { requestTimeoutMs: args.timeout_ms },
    });
    return { config, context: deps.buildToolContext(config) };
  } catch {
    addWarning(report, "The exact venue profile could not be loaded safely.");
    report.overall = "FAIL";
    return null;
  }
}

async function collectDoctorPhase(
  args: ParsedShowArgs,
  deps: ShowModeDeps,
  action: ActionContext,
  expectedOrigin: string,
  report: ShowModeReport,
  gates: GateEvidence,
): Promise<void> {
  let result: TopLevelDoctorResult;
  try {
    result = await deps.runDoctor(doctorArgv(args), {
      config: action.config,
      context: action.context,
      env: deps.env,
      cwd: deps.cwd,
    });
  } catch {
    gates.fail.push("Doctor could not be run safely.");
    result = { stdout: "", stderr: "", code: 1 };
  }
  const doctor = parseDoctor(result);
  if (doctor) {
    inspectDoctor(doctor, expectedOrigin, result, report, gates);
  } else {
    report.doctor.status = "fail";
    gates.fail.push("Doctor returned an invalid structured report.");
  }
}

async function collectPreflightPhase(
  args: ParsedShowArgs,
  deps: ShowModeDeps,
  context: ToolContext,
  report: ShowModeReport,
  gates: GateEvidence,
): Promise<void> {
  try {
    const result = await deps.runPreflight(context, {
      root_path: args.root_path,
      target_fps: args.target_fps,
      recursive: true,
      include_displays: true,
      include_performance: true,
    });
    inspectPreflight(result.structuredContent, report, gates);
  } catch {
    report.preflight.status = "fail";
    gates.fail.push("Preflight could not be run safely.");
  }
}

async function collectPerformPhase(
  runtime: RuntimeStatusReport,
  args: ParsedShowArgs,
  context: ToolContext,
  report: ShowModeReport,
  gates: GateEvidence,
): Promise<void> {
  const before = await readPerform(context, args.timeout_ms);
  if (before.kind === "known") {
    report.perform_before = before.value;
    report.perform_after = before.value;
    report.already_perform = before.value;
    if (runtime.touchdesigner.perform_mode !== before.value) {
      gates.essentialUnverified.push("Perform Mode snapshots disagree.");
    }
  } else {
    gates.essentialUnverified.push("Perform Mode readback is unavailable.");
  }
}

async function applyPerformMutation(
  args: ParsedShowArgs,
  context: ToolContext,
  report: ShowModeReport,
): Promise<ShowModeResult> {
  if (args.dry_run || report.already_perform) {
    report.overall = "PASS";
    report.exit_code = 0;
    return finish(args, report);
  }

  let enterConfirmed = false;
  try {
    enterConfirmed = confirmedWrite(await context.client.setPerformMode(true), true);
  } catch {
    enterConfirmed = false;
  }
  let after: PerformRead = { kind: "unknown" };
  if (enterConfirmed) after = await readPerform(context, args.timeout_ms);
  if (enterConfirmed && after.kind === "known" && after.value === true) {
    report.perform_after = true;
    report.action_applied = "entered";
    report.overall = "PASS";
    report.exit_code = 0;
    return finish(args, report);
  }

  addWarning(report, "Perform Mode entry was not safely confirmed; rollback was attempted.");
  const rollbackResult = await rollback(context, args.timeout_ms);
  report.rollback.status = rollbackResult.status;
  report.perform_after = rollbackResult.performAfter;
  report.action_applied = rollbackResult.status === "pass" ? "rolled_back" : "none";
  report.overall = "FAIL";
  report.exit_code = 3;
  return finish(args, report);
}

async function runValidatedShow(args: ParsedShowArgs, deps: ShowModeDeps): Promise<ShowModeResult> {
  const report = baseReport(args);
  const runtime = await readRuntimePhase(args, deps, report);
  if (!runtime) return finish(args, report);
  const action = loadActionContext(args, deps, report);
  if (!action) return finish(args, report);
  const expectedOrigin = origin(tdBaseUrl(action.config));
  if (expectedOrigin === null) {
    addWarning(report, "The configured bridge origin is invalid.");
    return finish(args, report);
  }
  const gates = evidence();
  inspectRuntime(runtime, args, expectedOrigin, gates);
  await collectDoctorPhase(args, deps, action, expectedOrigin, report, gates);
  await collectPreflightPhase(args, deps, action.context, report, gates);
  await collectPerformPhase(runtime, args, action.context, report, gates);
  if (!applyGateDecision(args, gates, report)) return finish(args, report);
  return applyPerformMutation(args, action.context, report);
}

export async function runShowMode(
  argv: string[],
  overrides: Partial<ShowModeDeps> = {},
): Promise<ShowModeResult> {
  const parsed = parseShowArgs(argv);
  if (parsed.kind === "help") return { stdout: `${HELP}\n`, stderr: "", code: 0 };
  if (parsed.kind === "error") {
    return {
      stdout: "",
      stderr: "Invalid show arguments. Run `tdmcp show --help`.\n",
      code: 2,
    };
  }
  return runValidatedShow(parsed.args, resolvedDeps(overrides));
}

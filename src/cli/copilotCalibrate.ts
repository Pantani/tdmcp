import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CalibrationCacheAdapter,
  type CalibrationIdentityProbeInput,
  type CalibrationMode,
  type CalibrationModelClient,
  type CalibrationRunDependencies,
  type CalibrationRunOptions,
  type CalibrationRunResult,
  type CalibrationTier,
  defaultCalibrationCachePath,
  type ProbedCalibrationIdentity,
  runLocalModelCalibration,
} from "../llm/calibration.js";
import { LlmClient } from "../llm/client.js";
import { type LoadConfigOptions, type LoadedTdmcpConfig, loadConfig } from "../utils/config.js";

export const COPILOT_CALIBRATE_HELP = `tdmcp copilot-calibrate — sandbox local-model capability check

Usage: tdmcp copilot-calibrate [flags]

Flags:
  --mode recommend|enforce   Policy shown/applied to the result (default: config, then recommend).
  --samples 3..5             Samples per tier-gating capability (default: 3).
  --timeout <ms>             Whole-suite deadline, 5000..300000 (default: 180000).
  --vision auto|off|required Synthetic image probe (default: auto).
  --refresh                  Ignore a reusable cache entry and run a fresh suite.
  --no-cache                 Do not read or write the calibration cache.
  --cache <path>             Override the cache path (must be absolute; ~/ is expanded).
  --model <id>               Override the configured model id. API keys are never accepted here.
  --profile <name>           Load a named tdmcp config profile.
  --config <path>            Load one explicit tdmcp config file.
  --json                     Emit exactly one JSON manifest line on stdout.
  -h, --help                 Show help without probing the endpoint.

Calibration uses synthetic fixture tools only. It does not start/pull a model or contact TouchDesigner.

Exit codes: 0 completed, 1 suite/protocol failure, 2 usage, 3 endpoint/model unavailable, 124 timeout/cancel.`;

export interface CopilotCalibrateCliOptions {
  help: boolean;
  json: boolean;
  refresh: boolean;
  noCache: boolean;
  mode?: CalibrationMode;
  samples: number;
  timeoutMs: number;
  vision: "auto" | "off" | "required";
  cachePath?: string;
  model?: string;
  profile?: string;
  configPath?: string;
}

type CalibrationConfigFields = LoadedTdmcpConfig & {
  llmCalibrationMode?: CalibrationMode;
  llmCalibrationCachePath?: string;
  llmCalibrationTtlMs?: number;
};

export interface CopilotCalibrateRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  loadConfig?: (env?: NodeJS.ProcessEnv, opts?: LoadConfigOptions) => LoadedTdmcpConfig;
  createClient?: (config: LoadedTdmcpConfig) => CalibrationModelClient;
  runCalibration?: (
    options: CalibrationRunOptions,
    deps: CalibrationRunDependencies,
  ) => Promise<CalibrationRunResult>;
  probeIdentity?: (input: CalibrationIdentityProbeInput) => Promise<ProbedCalibrationIdentity>;
  cache?: CalibrationCacheAdapter;
  now?: () => number;
  nonce?: () => string;
  signal?: AbortSignal;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
}

function parseInteger(raw: string | undefined, flag: string, min: number, max: number): number {
  if (!raw || !/^\d+$/u.test(raw))
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function enumValue<T extends string>(
  raw: string | undefined,
  flag: string,
  choices: readonly T[],
): T | undefined {
  if (raw === undefined) return undefined;
  if (!choices.includes(raw as T)) throw new Error(`${flag} must be ${choices.join("|")}`);
  return raw as T;
}

function expandCachePath(raw: string): string {
  const expanded = raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) throw new Error("--cache must be an absolute path");
  return resolve(expanded);
}

function parseRawCopilotCalibrateArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      "no-cache": { type: "boolean", default: false },
      mode: { type: "string" },
      samples: { type: "string" },
      timeout: { type: "string" },
      vision: { type: "string" },
      cache: { type: "string" },
      model: { type: "string" },
      profile: { type: "string" },
      config: { type: "string" },
    },
  });
}

type RawCalibrationValues = ReturnType<typeof parseRawCopilotCalibrateArgs>["values"];

function defaultedInteger(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
  fallback: number,
): number {
  return raw === undefined ? fallback : parseInteger(raw, flag, min, max);
}

function parsedCalibrationOptions(values: RawCalibrationValues): CopilotCalibrateCliOptions {
  const mode = enumValue(values.mode, "--mode", ["recommend", "enforce"] as const);
  const vision =
    enumValue(values.vision, "--vision", ["auto", "off", "required"] as const) ?? "auto";
  const samples = defaultedInteger(values.samples, "--samples", 3, 5, 3);
  const timeoutMs = defaultedInteger(values.timeout, "--timeout", 5_000, 300_000, 180_000);
  const model = values.model?.trim();
  if (values.model !== undefined && !model) throw new Error("--model must not be empty");
  const parsed: CopilotCalibrateCliOptions = {
    help: values.help === true,
    json: values.json === true,
    refresh: values.refresh === true,
    noCache: values["no-cache"] === true,
    samples,
    timeoutMs,
    vision,
  };
  if (mode) parsed.mode = mode;
  if (values.cache) parsed.cachePath = expandCachePath(values.cache);
  if (model) parsed.model = model;
  if (values.profile) parsed.profile = values.profile;
  if (values.config) parsed.configPath = values.config;
  return parsed;
}

export function parseCopilotCalibrateArgs(argv: string[] = []): CopilotCalibrateCliOptions {
  const parsed = parseRawCopilotCalibrateArgs(argv);
  if (parsed.positionals.length > 0) {
    throw new Error("copilot-calibrate does not take positional arguments");
  }
  return parsedCalibrationOptions(parsed.values);
}

function capabilityLabel(id: string): string {
  return id.replaceAll("_", " ");
}

export function formatCalibrationHuman(result: CalibrationRunResult): string {
  const { manifest } = result;
  const lines = [`Local copilot calibration · ${manifest.identity.model} · ${manifest.source}`, ""];
  for (const capability of manifest.capabilities) {
    const samples = capability.samples;
    const count = `${samples.passed}/${samples.total}`;
    lines.push(
      `${capabilityLabel(capability.id).padEnd(24)} ${capability.status.padEnd(10)} ${count}`,
    );
  }
  lines.push(
    "",
    `recommended maximum      ${manifest.recommended_max_tier}`,
    `requested / effective    ${manifest.requested_tier} / ${manifest.effective_tier} (${manifest.mode} mode)`,
    `policy                   ${manifest.policy_reason}`,
    `cache                    ${manifest.cache.write}${manifest.cache.expires_at ? ` · expires ${manifest.cache.expires_at}` : ""}`,
  );
  for (const warning of result.warnings) lines.push(`warning                  ${warning}`);
  return `${lines.join("\n")}\n`;
}

function exitCode(result: CalibrationRunResult): number {
  if (result.termination === "timeout" || result.termination === "aborted") return 124;
  if (result.termination === "endpoint_unreachable" || result.termination === "model_unavailable") {
    return 3;
  }
  if (result.termination === "vision_required_failed" || result.termination === "failed") return 1;
  return 0;
}

function configuredMode(config: CalibrationConfigFields): CalibrationMode {
  return config.llmCalibrationMode === "enforce" ? "enforce" : "recommend";
}

function configuredCachePath(config: CalibrationConfigFields, env: NodeJS.ProcessEnv): string {
  if (config.llmCalibrationCachePath) return expandCachePath(config.llmCalibrationCachePath);
  return defaultCalibrationCachePath(env);
}

function configuredTier(config: LoadedTdmcpConfig): CalibrationTier {
  if (config.llmTier === "safe" || config.llmTier === "creative") return config.llmTier;
  return "standard";
}

/**
 * CLI adapter for the sandbox-only calibrator. It intentionally depends only on
 * the LLM transport, local config loader, and calibration core.
 */
export async function runCopilotCalibrate(
  argv: string[] = [],
  deps: CopilotCalibrateRuntimeDeps = {},
): Promise<number> {
  const stdout = deps.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));
  let options: CopilotCalibrateCliOptions;
  try {
    options = parseCopilotCalibrateArgs(argv);
  } catch (err) {
    stderr(`tdmcp copilot-calibrate: ${(err as Error).message}\n\n${COPILOT_CALIBRATE_HELP}\n`);
    return 2;
  }
  if (options.help) {
    stdout(`${COPILOT_CALIBRATE_HELP}\n`);
    return 0;
  }

  try {
    const result = await executeConfiguredCalibration(options, deps);
    emitCalibrationResult(options, result, stdout, stderr);
    return exitCode(result);
  } catch {
    stderr("tdmcp copilot-calibrate: calibration_failed\n");
    return 1;
  }
}

function loadCalibrationConfig(
  options: CopilotCalibrateCliOptions,
  deps: CopilotCalibrateRuntimeDeps,
  env: NodeJS.ProcessEnv,
): LoadedTdmcpConfig {
  const load = deps.loadConfig ?? loadConfig;
  return load(env, {
    useFiles: true,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.model ? { overrides: { llmModel: options.model } } : {}),
  });
}

function calibrationRunOptions(
  options: CopilotCalibrateCliOptions,
  config: CalibrationConfigFields,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): CalibrationRunOptions {
  return {
    endpoint: config.llmBaseUrl,
    model: options.model ?? config.llmModel,
    ...(config.llmApiKey ? { apiKey: config.llmApiKey } : {}),
    mode: options.mode ?? configuredMode(config),
    requestedTier: configuredTier(config),
    samples: options.samples,
    timeoutMs: options.timeoutMs,
    vision: options.vision,
    refresh: options.refresh,
    noCache: options.noCache,
    cachePath: options.cachePath ?? configuredCachePath(config, env),
    cacheTtlMs: config.llmCalibrationTtlMs,
    signal,
  };
}

function calibrationRunDependencies(
  client: CalibrationModelClient,
  deps: CopilotCalibrateRuntimeDeps,
): CalibrationRunDependencies {
  return {
    client,
    ...(deps.probeIdentity ? { probeIdentity: deps.probeIdentity } : {}),
    ...(deps.cache ? { cache: deps.cache } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.nonce ? { nonce: deps.nonce } : {}),
  };
}

async function executeConfiguredCalibration(
  options: CopilotCalibrateCliOptions,
  deps: CopilotCalibrateRuntimeDeps,
): Promise<CalibrationRunResult> {
  const env = deps.env ?? process.env;
  const loaded = loadCalibrationConfig(options, deps, env);
  const config = loaded as CalibrationConfigFields;
  const client = (deps.createClient ?? ((value) => new LlmClient(value)))(loaded);
  const calibrate = deps.runCalibration ?? runLocalModelCalibration;
  return calibrate(
    calibrationRunOptions(options, config, env, deps.signal),
    calibrationRunDependencies(client, deps),
  );
}

function emitCalibrationResult(
  options: CopilotCalibrateCliOptions,
  result: CalibrationRunResult,
  stdout: (chunk: string) => void,
  stderr: (chunk: string) => void,
): void {
  if (options.json) stdout(`${JSON.stringify(result.manifest)}\n`);
  else stdout(formatCalibrationHuman(result));
  for (const warning of result.warnings) stderr(`tdmcp copilot-calibrate: ${warning}\n`);
}

import { parseArgs } from "node:util";
import { loadConfig, type TdmcpConfig } from "../utils/config.js";
import { type RunDoctorOptions, runDoctor } from "./doctor.js";

export interface TopLevelDoctorResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface TopLevelDoctorDeps {
  runDoctor: typeof runDoctor;
  loadConfig: typeof loadConfig;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const DEFAULT_DEPS: TopLevelDoctorDeps = {
  runDoctor,
  loadConfig,
  env: process.env,
  cwd: process.cwd(),
};

const HELP = `Usage: tdmcp doctor [--json] [--fix] [--profile <name>] [--config <file>]

Run environment diagnostics for the effective tdmcp configuration. Package-specific
diagnostics live under: tdmcp packages doctor [package].`;

type ParsedDoctorArgs =
  | { kind: "help" }
  | {
      kind: "run";
      json: boolean;
      quiet: boolean;
      fix: boolean;
      profile?: string;
      configPath?: string;
    }
  | { kind: "error"; message: string };

function parseDoctorArgs(argv: string[]): ParsedDoctorArgs {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        json: { type: "boolean", default: false },
        quiet: { type: "boolean", short: "q", default: false },
        fix: { type: "boolean", default: false },
        profile: { type: "string" },
        config: { type: "string" },
      },
    });
    if (parsed.values.help) return { kind: "help" };
    return {
      kind: "run",
      json: parsed.values.json ?? false,
      quiet: parsed.values.quiet ?? false,
      fix: parsed.values.fix ?? false,
      profile: parsed.values.profile,
      configPath: parsed.values.config,
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function loadDoctorConfig(
  parsed: Extract<ParsedDoctorArgs, { kind: "run" }>,
  deps: TopLevelDoctorDeps,
): TdmcpConfig {
  return deps.loadConfig(deps.env, {
    useFiles: true,
    profile: parsed.profile,
    configPath: parsed.configPath,
    cwd: deps.cwd,
  });
}

export async function runTopLevelDoctor(
  argv: string[],
  deps: TopLevelDoctorDeps = DEFAULT_DEPS,
): Promise<TopLevelDoctorResult> {
  const parsed = parseDoctorArgs(argv);
  if (parsed.kind === "help") return { stdout: `${HELP}\n`, stderr: "", code: 0 };
  if (parsed.kind === "error") return { stdout: "", stderr: `${parsed.message}\n`, code: 2 };

  let config: TdmcpConfig;
  try {
    config = loadDoctorConfig(parsed, deps);
  } catch (error) {
    return {
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      code: 2,
    };
  }
  const options: RunDoctorOptions = { config, fix: parsed.fix };
  const result = await deps.runDoctor(options);
  if (parsed.quiet) return { stdout: "", stderr: "", code: result.code };
  if (parsed.json) {
    return { stdout: `${JSON.stringify(result.report, null, 2)}\n`, stderr: "", code: result.code };
  }
  return { stdout: result.stdout, stderr: result.stderr, code: result.code };
}

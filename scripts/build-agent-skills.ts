import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BuildAgentSkillBundleOptions,
  type BuildAgentSkillBundleResult,
  buildAgentSkillBundle,
  readTdmcpPackageVersion,
} from "../src/skills/bundle.js";

const USAGE = `Usage: pnpm build:agent-skills -- [options]

Build deterministic, local-only Codex and Claude skill artifacts.

Options:
  --output <path>              Output directory (default: dist/agent-skills)
  --archives <none|skill>      Emit deterministic .skill archives (default: skill)
  --bundle-version <version>   Bundle identity (default: package version)
  --overwrite                  Replace only a previously marked tdmcp bundle
  --verify-reproducible        Require two byte-identical staged builds
  --json                       Print one JSON result to stdout
  --help                       Show this help without reading bundle state
`;

export class AgentSkillBundleCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSkillBundleCliError";
  }
}

export interface AgentSkillBundleCliStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface ParsedCliOptions {
  output?: string;
  archiveMode: BuildAgentSkillBundleOptions["archiveMode"];
  bundleVersion?: string;
  overwrite: boolean;
  verifyReproducible: boolean;
  json: boolean;
  help: boolean;
}

function optionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new AgentSkillBundleCliError(`${option} requires a value.`);
  }
  return value;
}

export function parseAgentSkillBundleArgs(argv: readonly string[]): ParsedCliOptions {
  const parsed: ParsedCliOptions = {
    archiveMode: "skill",
    overwrite: false,
    verifyReproducible: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--" && index === 0) continue;
    if (argument === "--help") parsed.help = true;
    else if (argument === "--overwrite") parsed.overwrite = true;
    else if (argument === "--verify-reproducible") parsed.verifyReproducible = true;
    else if (argument === "--json") parsed.json = true;
    else if (argument === "--output") {
      parsed.output = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--archives") {
      const value = optionValue(argv, index, argument);
      if (value !== "none" && value !== "skill") {
        throw new AgentSkillBundleCliError("--archives must be none or skill.");
      }
      parsed.archiveMode = value;
      index += 1;
    } else if (argument === "--bundle-version") {
      parsed.bundleVersion = optionValue(argv, index, argument);
      index += 1;
    } else {
      throw new AgentSkillBundleCliError(`Unknown argument: ${argument ?? ""}`);
    }
  }
  return parsed;
}

function humanReceipt(result: BuildAgentSkillBundleResult): string {
  const hosts = new Map(result.hosts.map((host) => [host.host, host.skill_count]));
  return `tdmcp agent-skill bundle
  source        @dpantani/tdmcp ${result.package_version} (bundle ${result.bundle_version})
  destination   ${result.output_dir}
  codex         ${hosts.get("codex") ?? 0} skills
  claude        ${hosts.get("claude") ?? 0} skills
  archives      ${result.archive_count} .skill files
  manifest      sha256:${result.manifest_sha256}
  checksums     sha256:${result.checksums_sha256}
  reproducible  ${result.reproducible_verified ? "verified" : "not requested"}
  external      installed=no published=no attached=no released=no
`;
}

export function runBuildAgentSkillsCli(
  argv: readonly string[],
  options: {
    repoRoot?: string;
    streams?: AgentSkillBundleCliStreams;
  } = {},
): number {
  const streams = options.streams ?? {
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
  };
  let parsed: ParsedCliOptions;
  try {
    parsed = parseAgentSkillBundleArgs(argv);
  } catch (error) {
    streams.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    streams.stdout(USAGE);
    return 0;
  }
  const repoRoot = resolve(
    options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  try {
    const packageVersion = readTdmcpPackageVersion(repoRoot);
    const result = buildAgentSkillBundle({
      repoRoot,
      outputDir: resolve(repoRoot, parsed.output ?? "dist/agent-skills"),
      archiveMode: parsed.archiveMode,
      bundleVersion: parsed.bundleVersion ?? packageVersion,
      overwrite: parsed.overwrite,
      verifyReproducible: parsed.verifyReproducible,
    });
    streams.stdout(parsed.json ? `${JSON.stringify(result)}\n` : humanReceipt(result));
    return 0;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? ` [${String((error as { code?: unknown }).code)}]`
        : "";
    streams.stderr(
      `Agent skill bundle failed${code}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runBuildAgentSkillsCli(process.argv.slice(2));
}

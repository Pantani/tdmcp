/**
 * Project RAG — CLI subcommand (`tdmcp project-rag {sync|index|search|info|sources}`).
 *
 * Mirrors the Creative RAG CLI style: parseArgs from `node:util`, friendly help,
 * `--json` everywhere, no throws (failures become stderr + non-zero exit).
 *
 * Double gating:
 *   - `TDMCP_RAG_ENABLED=0` → disabled (exit 0, prints disabled line).
 *   - `TDMCP_PROJECT_RAG_ENABLED=0` → disabled (exit 0, prints disabled line).
 *
 * The integrator in `src/index.ts` wires this with {@link toProjectRagConfig}
 * built from the loaded `TdmcpConfig`.
 */

import { parseArgs } from "node:util";
import { createLogger } from "../utils/logger.js";
import { createProjectRagService } from "./service.js";
import type {
  ProjectRagConfig,
  ProjectRagLicense,
  ProjectRagService,
  ProjectRagType,
  ProjectSearchFilters,
} from "./types.js";

const VALID_LICENSES: ProjectRagLicense[] = [
  "CC0",
  "PublicDomain",
  "CC-BY",
  "CC-BY-SA",
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "Derivative-EULA",
  "Proprietary-Free",
  "Proprietary-Paid",
  "Unknown",
  "Restricted",
];

const VALID_TYPES: ProjectRagType[] = [
  "project",
  "component",
  "snippet",
  "tutorial",
  "custom-op",
  "framework",
];

const DISABLED_MESSAGE =
  "Project RAG is disabled (set TDMCP_RAG_ENABLED=1 and TDMCP_PROJECT_RAG_ENABLED=1)";

const HELP = `tdmcp project-rag — local TouchDesigner project repertoire (opt-in, offline)

Usage: tdmcp project-rag <sync|index|search|info|sources> [flags]

Commands:
  sources           List configured project sources and their status.
  sync              Pull cards from selected sources (F1+; F0 is a no-op).
  index             Embed new/changed cards (F1+).
  search <query>    Cosine search the local project index (F1+).
  info <id>         Show one card (provenance + license + score) by id.

Flags:
  --source <name>   Limit sync to one source (repeatable).
  --limit <n>       Max items per source on sync (default 10).
  --k <n>           Number of search results (default 10).
  --license <csv>   Filter search by license(s), e.g. MIT,Apache-2.0,CC0.
  --type <csv>      Filter search by card type(s).
  --tags <csv>      Filter search to cards having ALL listed tags.
  --operator <csv>  Filter search to cards using ALL listed operator names.
  --json            Emit machine-readable JSON.
  -h, --help        Show this help.

Status: F0 (foundations) — sources/extractors land in F1. Hard rule:
NEVER opens a downloaded .toe/.tox in the user's active TD project.`;

export interface RunProjectRagCliDeps {
  service?: ProjectRagService;
  config?: ProjectRagConfig;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

interface StructurallyConfigLike {
  ragEnabled: boolean;
  ragDataDir: string;
  ragOllamaUrl: string;
  ragEmbedModel: string;
  ragEmbedBatch: number;
  ragBackend: "jsonl" | "lancedb";
  projectRagEnabled: boolean;
  projectRagBridgeAnalysis: boolean;
  projectRagBridgePort: number;
  projectRagGhToken?: string;
  projectRagGithubRepos?: string;
  projectRagAnalyzeTimeoutMs: number;
  projectRagLicenseAllowlist: string[];
  projectRagScoreWeights: {
    technical: number;
    license: number;
    freshness: number;
    reliability: number;
  };
}

/**
 * Maps the loaded `TdmcpConfig` into a {@link ProjectRagConfig}. `enabled` is
 * the AND of both gating flags. `dataDir` is `<ragDataDir>/project` to keep the
 * project cards/index isolated from the creative ones (per design).
 */
export function toProjectRagConfig(config: StructurallyConfigLike): ProjectRagConfig {
  const allowlist = config.projectRagLicenseAllowlist.filter((value): value is ProjectRagLicense =>
    (VALID_LICENSES as string[]).includes(value),
  );
  const result: ProjectRagConfig = {
    enabled: Boolean(config.ragEnabled && config.projectRagEnabled),
    dataDir: `${config.ragDataDir.replace(/\/+$/, "")}/project`,
    ollamaUrl: config.ragOllamaUrl,
    embedModel: config.ragEmbedModel,
    licenseAllowlist: allowlist,
    embedBatch: config.ragEmbedBatch,
    backend: config.ragBackend,
    bridgeAnalysis: config.projectRagBridgeAnalysis,
    bridgePort: config.projectRagBridgePort,
    analyzeTimeoutMs: config.projectRagAnalyzeTimeoutMs,
    scoreWeights: config.projectRagScoreWeights,
  };
  if (config.projectRagGhToken !== undefined) result.ghToken = config.projectRagGhToken;
  if (config.projectRagGithubRepos !== undefined)
    result.githubReposCsv = config.projectRagGithubRepos;
  return result;
}

/** Runs the `project-rag` CLI; never throws. Disabled is success (exit 0). */
export async function runProjectRagCli(
  argv: string[],
  deps: RunProjectRagCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const stderrLine = (s: string) => stderr(`${s}\n`);
  const stdoutLine = (s: string) => stdout(`${s}\n`);

  let parsed: { command: string; positionals: string[]; values: ParsedFlags };
  try {
    parsed = parseProjectRagArgs(argv);
  } catch (err) {
    stderrLine(`tdmcp project-rag: ${(err as Error).message}`);
    stderrLine(HELP);
    return 2;
  }

  if (parsed.values.help === true || parsed.command === "") {
    stdoutLine(HELP);
    return parsed.command === "" && parsed.values.help !== true ? 2 : 0;
  }

  const config = deps.config;
  if (config === undefined) {
    stderrLine("tdmcp project-rag: no config provided.");
    return 2;
  }

  if (!config.enabled) {
    stdoutLine(DISABLED_MESSAGE);
    return 0;
  }

  const service = deps.service ?? createProjectRagService({ config, logger: createLogger("warn") });

  try {
    switch (parsed.command) {
      case "sources":
        return await runSources(service, parsed.values, stdoutLine);
      case "sync":
        return await runSync(service, parsed.values, stdoutLine);
      case "index":
        return await runIndex(service, parsed.values, stdoutLine);
      case "search":
        return await runSearch(service, parsed.positionals, parsed.values, stdoutLine, stderrLine);
      case "info":
        return await runInfo(service, parsed.positionals, parsed.values, stdoutLine, stderrLine);
      default:
        stderrLine(`tdmcp project-rag: unknown command "${parsed.command}".`);
        stderrLine(HELP);
        return 2;
    }
  } catch (err) {
    stderrLine(`tdmcp project-rag: ${(err as Error).message ?? String(err)}`);
    return 1;
  }
}

interface ParsedFlags {
  help: boolean;
  json: boolean;
  source: string[];
  limit?: number;
  k?: number;
  license?: string[];
  type?: string[];
  tags?: string[];
  operator?: string[];
}

function parseProjectRagArgs(argv: string[]): {
  command: string;
  positionals: string[];
  values: ParsedFlags;
} {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
      source: { type: "string", multiple: true },
      limit: { type: "string" },
      k: { type: "string" },
      license: { type: "string" },
      type: { type: "string" },
      tags: { type: "string" },
      operator: { type: "string" },
    },
  });

  const command = positionals[0] ?? "";
  const rest = positionals.slice(1);

  const flags: ParsedFlags = {
    help: values.help === true,
    json: values.json === true,
    source: Array.isArray(values.source) ? values.source : [],
  };
  if (typeof values.limit === "string") flags.limit = parsePositiveInt(values.limit, "--limit");
  if (typeof values.k === "string") flags.k = parsePositiveInt(values.k, "--k");
  if (typeof values.license === "string")
    flags.license = parseCsvEnum(values.license, VALID_LICENSES, "--license");
  if (typeof values.type === "string")
    flags.type = parseCsvEnum(values.type, VALID_TYPES, "--type");
  if (typeof values.tags === "string") flags.tags = splitCsv(values.tags);
  if (typeof values.operator === "string") flags.operator = splitCsv(values.operator);

  return { command, positionals: rest, values: flags };
}

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function parseCsvEnum(raw: string, allowed: readonly string[], flag: string): string[] {
  const values = splitCsv(raw);
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new Error(`${flag} has invalid value "${value}" (allowed: ${allowed.join(", ")})`);
    }
  }
  return values;
}

async function runSources(
  service: ProjectRagService,
  flags: ParsedFlags,
  out: (s: string) => void,
): Promise<number> {
  const list = await service.listSources();
  if (flags.json) {
    out(JSON.stringify(list));
    return 0;
  }
  if (list.length === 0) {
    out("No sources configured.");
    return 0;
  }
  for (const s of list) {
    const reason = s.reason !== undefined ? ` — ${s.reason}` : "";
    out(`${s.status.padEnd(8)} ${s.name}  (${s.displayName})${reason}`);
  }
  return 0;
}

async function runSync(
  service: ProjectRagService,
  flags: ParsedFlags,
  out: (s: string) => void,
): Promise<number> {
  const report = await service.sync({
    ...(flags.source.length > 0 ? { sources: flags.source } : {}),
    ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
  });
  if (flags.json) {
    out(JSON.stringify(report));
  } else if (Object.keys(report.perSource).length === 0) {
    out("No sources configured (F0). Try: tdmcp project-rag sources");
  } else {
    out(
      `synced: ${report.added} added, ${report.updated} updated, ${report.tombstoned} tombstoned, ` +
        `${report.binariesStored} binaries stored, ${report.skippedNoLicense} skipped (license)`,
    );
  }
  return 0;
}

async function runIndex(
  service: ProjectRagService,
  flags: ParsedFlags,
  out: (s: string) => void,
): Promise<number> {
  const report = await service.index();
  if (flags.json) {
    out(JSON.stringify(report));
  } else {
    out(
      `indexed: ${report.embedded} embedded, ${report.cachedSkipped} cached/skipped, ` +
        `${report.total} total cards`,
    );
  }
  return 0;
}

async function runSearch(
  service: ProjectRagService,
  positionals: string[],
  flags: ParsedFlags,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const query = positionals.join(" ").trim();
  if (query.length === 0) {
    err("tdmcp project-rag: search needs a query.");
    return 2;
  }
  const filters = buildFilters(flags);
  const k = flags.k ?? 10;
  const results = await service.search(query, k, filters);
  if (flags.json) {
    out(JSON.stringify(results));
    return 0;
  }
  if (results.length === 0) {
    out("No results.");
    return 0;
  }
  for (const r of results) {
    out(
      `${r.score.toFixed(3)}  ${r.title} [${r.type}] — ${r.license}\n` +
        `        ${r.sourceUrl}` +
        (r.rightsNotes !== undefined ? `\n        rights: ${r.rightsNotes}` : ""),
    );
  }
  return 0;
}

async function runInfo(
  service: ProjectRagService,
  positionals: string[],
  flags: ParsedFlags,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const id = positionals[0]?.trim() ?? "";
  if (id.length === 0) {
    err("tdmcp project-rag: info needs a card id.");
    return 2;
  }
  const card = await service.getCard(id);
  if (card === undefined) {
    if (flags.json) {
      out(JSON.stringify({ error: `Card "${id}" not found.` }));
    } else {
      err(`Card "${id}" not found.`);
    }
    return 1;
  }
  if (flags.json) {
    out(JSON.stringify(card));
    return 0;
  }
  out(`${card.title} [${card.type}] — ${card.license} (${card.licenseConfidence})`);
  out(`  source: ${card.provenance.sourceName} ${card.provenance.sourceUrl}`);
  if (card.rightsNotes !== undefined) out(`  rights: ${card.rightsNotes}`);
  if (card.score !== undefined) out(`  score: composite=${card.score.composite.toFixed(3)}`);
  return 0;
}

function buildFilters(flags: ParsedFlags): ProjectSearchFilters | undefined {
  const filters: ProjectSearchFilters = {};
  if (flags.license !== undefined && flags.license.length > 0)
    filters.license = flags.license as ProjectRagLicense[];
  if (flags.type !== undefined && flags.type.length > 0)
    filters.type = flags.type as ProjectRagType[];
  if (flags.tags !== undefined && flags.tags.length > 0) filters.tags = flags.tags;
  if (flags.operator !== undefined && flags.operator.length > 0) filters.operators = flags.operator;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

/**
 * Creative RAG — CLI subcommand (`tdmcp creative-rag {sync|index|search}`).
 *
 * Parses argv with `node:util` `parseArgs` (same style as `src/cli/ask.ts`),
 * honors the opt-in `enabled` flag (disabled is success, not failure → exit 0),
 * and never throws: any failure becomes a friendly stderr line via
 * {@link friendlyOllamaError} and a non-zero exit code. The integrator wires the
 * one-line dispatch in `src/index.ts` using {@link toCreativeRagConfig}.
 */

import { parseArgs } from "node:util";
import { friendlyOllamaError } from "./ollamaErrors.js";
import { createCreativeRagService } from "./service.js";
import type {
  CreativeRagConfig,
  CreativeRagLicense,
  CreativeRagService,
  CreativeRagType,
  SearchFilters,
} from "./types.js";

const VALID_LICENSES: CreativeRagLicense[] = [
  "CC0",
  "PublicDomain",
  "CC-BY",
  "CC-BY-SA",
  "Unknown",
  "Restricted",
];
const VALID_TYPES: CreativeRagType[] = [
  "project",
  "artist",
  "artwork",
  "technique",
  "cue_reference",
];

const DISABLED_MESSAGE = "Creative RAG is disabled (set TDMCP_RAG_ENABLED=1)";

const HELP = `tdmcp creative-rag — local creative repertoire (opt-in, offline)

Usage: tdmcp creative-rag <sync|index|search> [flags]

Commands:
  sync             Fetch open-licensed records into the local card store.
  index            Embed new/changed cards into the local search index.
  search <query>   Cosine search the local index.

Flags:
  --source <name>  Limit sync to one source (repeatable).
  --limit <n>      Max items per source on sync (default 10).
  --k <n>          Number of search results (default 10).
  --license <csv>  Filter search by license(s), e.g. CC0,PublicDomain.
  --type <csv>     Filter search by card type(s).
  --tags <csv>     Filter search to cards having ALL listed tags.
  --json           Emit machine-readable JSON.
  -h, --help       Show this help.`;

export interface RunCreativeRagCliDeps {
  service?: CreativeRagService;
  config?: CreativeRagConfig;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

interface StructurallyConfigLike {
  ragEnabled: boolean;
  ragDataDir: string;
  ragOllamaUrl: string;
  ragEmbedModel: string;
  ragLicenseAllowlist: string[];
}

/**
 * Maps the repo's loaded `AppConfig` (structurally — the `rag*` fields the
 * integrator adds) into a {@link CreativeRagConfig}. Accepts a structural shape so
 * this module compiles standalone before those config fields land.
 */
export function toCreativeRagConfig(config: StructurallyConfigLike): CreativeRagConfig {
  return {
    enabled: config.ragEnabled,
    dataDir: config.ragDataDir,
    ollamaUrl: config.ragOllamaUrl,
    embedModel: config.ragEmbedModel,
    licenseAllowlist: config.ragLicenseAllowlist.filter((value): value is CreativeRagLicense =>
      (VALID_LICENSES as string[]).includes(value),
    ),
  };
}

/**
 * Runs the `creative-rag` CLI. Returns an exit code and never throws: usage
 * errors return 2, a disabled config returns 0 (printing the disabled line and
 * calling no service), and runtime failures return 1 with a friendly line.
 */
export async function runCreativeRagCli(
  argv: string[],
  deps: RunCreativeRagCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const stderrLine = (s: string) => stderr(`${s}\n`);
  const stdoutLine = (s: string) => stdout(`${s}\n`);

  let parsed: { command: string; positionals: string[]; values: ParsedFlags };
  try {
    parsed = parseCreativeRagArgs(argv);
  } catch (err) {
    stderrLine(`tdmcp creative-rag: ${(err as Error).message}`);
    stderrLine(HELP);
    return 2;
  }

  if (parsed.values.help === true || parsed.command === "") {
    stdoutLine(HELP);
    return parsed.command === "" && parsed.values.help !== true ? 2 : 0;
  }

  const config = deps.config;
  if (config === undefined) {
    stderrLine("tdmcp creative-rag: no config provided.");
    return 2;
  }

  // Opt-in gate: disabled is a success path. Print the line and call no service.
  if (!config.enabled) {
    stdoutLine(DISABLED_MESSAGE);
    return 0;
  }

  const service = deps.service ?? createCreativeRagService({ config });

  try {
    switch (parsed.command) {
      case "sync":
        return await runSync(service, parsed.values, stdoutLine);
      case "index":
        return await runIndex(service, parsed.values, stdoutLine);
      case "search":
        return await runSearch(service, parsed.positionals, parsed.values, stdoutLine, stderrLine);
      default:
        stderrLine(`tdmcp creative-rag: unknown command "${parsed.command}".`);
        stderrLine(HELP);
        return 2;
    }
  } catch (err) {
    stderrLine(`tdmcp creative-rag: ${friendlyOllamaError(err)}`);
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
}

function parseCreativeRagArgs(argv: string[]): {
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
    },
  });

  const command = positionals[0] ?? "";
  const rest = positionals.slice(1);

  const flags: ParsedFlags = {
    help: values.help === true,
    json: values.json === true,
    source: Array.isArray(values.source) ? values.source : [],
  };
  if (typeof values.limit === "string") {
    flags.limit = parsePositiveInt(values.limit, "--limit");
  }
  if (typeof values.k === "string") {
    flags.k = parsePositiveInt(values.k, "--k");
  }
  if (typeof values.license === "string") {
    flags.license = parseCsvEnum(values.license, VALID_LICENSES, "--license");
  }
  if (typeof values.type === "string") {
    flags.type = parseCsvEnum(values.type, VALID_TYPES, "--type");
  }
  if (typeof values.tags === "string") {
    flags.tags = values.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  return { command, positionals: rest, values: flags };
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function parseCsvEnum(raw: string, allowed: readonly string[], flag: string): string[] {
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new Error(`${flag} has invalid value "${value}" (allowed: ${allowed.join(", ")})`);
    }
  }
  return values;
}

async function runSync(
  service: CreativeRagService,
  flags: ParsedFlags,
  out: (s: string) => void,
): Promise<number> {
  const report = await service.sync({
    ...(flags.source.length > 0 ? { sources: flags.source } : {}),
    ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
  });
  if (flags.json) {
    out(JSON.stringify(report));
  } else {
    out(
      `synced: ${report.added} added, ${report.updated} updated, ${report.tombstoned} tombstoned, ` +
        `${report.binariesStored} binaries stored, ${report.skippedNoLicense} binaries skipped (license)`,
    );
  }
  return 0;
}

async function runIndex(
  service: CreativeRagService,
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
  service: CreativeRagService,
  positionals: string[],
  flags: ParsedFlags,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const query = positionals.join(" ").trim();
  if (query.length === 0) {
    err("tdmcp creative-rag: search needs a query.");
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

  for (const result of results) {
    out(
      `${result.score.toFixed(3)}  ${result.title} [${result.type}] — ${result.license}\n` +
        `        ${result.sourceUrl}` +
        (result.rightsNotes !== undefined ? `\n        rights: ${result.rightsNotes}` : ""),
    );
  }
  return 0;
}

function buildFilters(flags: ParsedFlags): SearchFilters | undefined {
  const filters: SearchFilters = {};
  if (flags.license !== undefined && flags.license.length > 0) {
    filters.license = flags.license as CreativeRagLicense[];
  }
  if (flags.type !== undefined && flags.type.length > 0) {
    filters.type = flags.type as CreativeRagType[];
  }
  if (flags.tags !== undefined && flags.tags.length > 0) {
    filters.tags = flags.tags;
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

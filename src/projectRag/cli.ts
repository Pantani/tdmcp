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
import { isCopyleftLicense } from "./licensePolicy.js";
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

Usage: tdmcp project-rag <sources|sync|index|reindex|search|info|analyze|bridge> [flags]

Commands:
  sources              List configured project sources and their status.
  sync                 Pull cards from selected sources.
  index                Embed new/changed cards (uses Ollama).
  reindex --rescore    Recompute card.score in place without re-embedding.
  search <query>       Cosine search the local project index.
  info <id>            Show one card (provenance + license + score) by id.
  analyze <path>       (F3) Open one .toe/.tox in the QUARANTINE bridge
                       (port 9981 — never your main TD) and report errors.
  bridge install       (F3) Print the dedicated quarantine-bridge setup steps
                       and probe whether the bridge is reachable.

Flags:
  --source <name>      Limit sync to one source (repeatable).
  --limit <n>          Max items per source on sync (default 10).
  --topic <csv>        Override topic list for the github-topic source. Use
                       "off" to disable that source for this run.
  --cap <n>            Per-run cap for the github-topic source (default 25).
  --bridge             (F3) After sync, run the QUARANTINE bridge analyzer on
                       every downloadable card with a permissive license.
                       Skipped cleanly when the bridge is offline.
  --rescore            With "reindex": recompute scores in place.
  --k <n>              Number of search results (default 10).
  --license <csv>      Filter search by license(s), e.g. MIT,Apache-2.0,CC0.
  --type <csv>         Filter search by card type(s).
  --tags <csv>         Filter search to cards having ALL listed tags.
  --operator <csv>     Filter search to cards using ALL listed operator names.
  --json               Emit machine-readable JSON.
  -h, --help           Show this help.

Hard rule: NEVER opens a downloaded .toe/.tox in the user's active TD project.
The F3 quarantine bridge runs on a SEPARATE TouchDesigner instance bound to
port 9981 (never 9980); when it is offline analyze/--bridge degrade to
"skipped" — not "failed".`;

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
  projectRagGithubTopics?: string;
  projectRagTopicCap: number;
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
  if (config.projectRagGithubTopics !== undefined)
    result.githubTopicsCsv = config.projectRagGithubTopics;
  result.topicCap = config.projectRagTopicCap;
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
      case "reindex":
        return await runReindex(service, parsed.values, stdoutLine, stderrLine);
      case "search":
        return await runSearch(service, parsed.positionals, parsed.values, stdoutLine, stderrLine);
      case "info":
        return await runInfo(service, parsed.positionals, parsed.values, stdoutLine, stderrLine);
      case "analyze":
        return await runAnalyze(service, parsed.positionals, parsed.values, stdoutLine, stderrLine);
      case "bridge":
        return await runBridge(service, parsed.positionals, parsed.values, config, stdoutLine);
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
  rescore: boolean;
  bridge: boolean;
  source: string[];
  limit?: number;
  topic?: string;
  cap?: number;
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
      rescore: { type: "boolean", default: false },
      bridge: { type: "boolean", default: false },
      source: { type: "string", multiple: true },
      limit: { type: "string" },
      topic: { type: "string" },
      cap: { type: "string" },
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
    rescore: values.rescore === true,
    bridge: values.bridge === true,
    source: Array.isArray(values.source) ? values.source : [],
  };
  if (typeof values.limit === "string") flags.limit = parsePositiveInt(values.limit, "--limit");
  if (typeof values.topic === "string") flags.topic = values.topic;
  if (typeof values.cap === "string") flags.cap = parsePositiveInt(values.cap, "--cap");
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
    ...(flags.topic !== undefined ? { topicsCsv: flags.topic } : {}),
    ...(flags.cap !== undefined ? { topicCap: flags.cap } : {}),
    ...(flags.bridge ? { bridge: true } : {}),
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
    if (report.bridgeAnalysis !== undefined) {
      const b = report.bridgeAnalysis;
      out(`bridge: ${b.attempted} attempted, ${b.ok} ok, ${b.failed} failed, ${b.skipped} skipped`);
    }
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

async function runReindex(
  service: ProjectRagService,
  flags: ParsedFlags,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  if (!flags.rescore) {
    err(
      "tdmcp project-rag reindex: only --rescore is supported (recomputes score without re-embedding).",
    );
    return 2;
  }
  const report = await service.rescore();
  if (flags.json) {
    out(JSON.stringify(report));
  } else {
    out(`rescored: ${report.rescored} of ${report.total} cards (no re-embed)`);
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
    const licenseBadge = isCopyleftLicense(r.license) ? `${r.license} · copyleft` : r.license;
    out(
      `${r.score.toFixed(3)}  ${r.title} [${r.type}] — ${licenseBadge}\n` +
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

async function runAnalyze(
  service: ProjectRagService,
  positionals: string[],
  flags: ParsedFlags,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const artifactPath = positionals[0]?.trim() ?? "";
  if (artifactPath.length === 0) {
    err("tdmcp project-rag: analyze needs an absolute .toe/.tox path.");
    return 2;
  }
  const report = await service.analyze(artifactPath);
  if (flags.json) {
    out(JSON.stringify(report));
  } else {
    out(`analyze ${report.status} (bridge: ${report.bridgeUrl})`);
    if (report.errorCount !== undefined) out(`  td errors: ${report.errorCount}`);
    if (report.hasPreview === true) out("  preview: captured");
    if (report.reason !== undefined) out(`  reason: ${report.reason}`);
    if (report.error !== undefined) out(`  error: ${report.error}`);
  }
  // Skipped (offline bridge) is success — exit 1 only on real failure.
  return report.status === "failed" ? 1 : 0;
}

async function runBridge(
  service: ProjectRagService,
  positionals: string[],
  flags: ParsedFlags,
  config: ProjectRagConfig,
  out: (s: string) => void,
): Promise<number> {
  const sub = positionals[0]?.trim() ?? "";
  if (sub !== "install") {
    out(BRIDGE_INSTALL_HELP);
    return sub.length === 0 ? 0 : 2;
  }
  // Pure reachability probe — never touches any artifact. `service.probeBridge`
  // calls only `getInfo` on the quarantine bridge; offline → `reachable: false`.
  const probe = await service.probeBridge();
  const bridgeUrl = probe.bridgeUrl;
  const reachable = probe.reachable;
  if (flags.json) {
    const payload: Record<string, unknown> = { bridgeUrl, reachable };
    if (probe.reason !== undefined) payload.reason = probe.reason;
    out(JSON.stringify(payload));
    return 0;
  }
  out(BRIDGE_INSTALL_HELP);
  out("");
  out(`Probe: ${bridgeUrl} — ${reachable ? "REACHABLE" : "OFFLINE"}`);
  if (!reachable) {
    if (probe.reason !== undefined) out(`  reason: ${probe.reason}`);
    out("  Follow the steps above, then re-run: tdmcp project-rag bridge install");
  } else {
    out("  Ready. Try: tdmcp project-rag analyze /absolute/path/to/file.toe");
  }
  return 0;
}

const BRIDGE_INSTALL_HELP = `tdmcp project-rag bridge install — quarantine bridge setup

The Project RAG F3 bridge analyzer runs your .toe/.tox files inside a
DEDICATED TouchDesigner instance, bound to a SEPARATE port (default 9981).
It NEVER touches your main TD on port 9980.

Steps:

  1. Open a fresh TouchDesigner instance (do NOT reuse the one tdmcp drives
     for live work).
  2. Inside that instance, install the tdmcp bridge as usual:
        tdmcp install-bridge
     The bridge installs a Web Server DAT.
  3. Edit that Web Server DAT's "port" parameter from 9980 → 9981.
  4. Save that instance as a fresh project file (suggested name:
     "tdmcp_bridge_qa.toe") so you can reopen the quarantine bridge fast.
  5. Enable the F3 feature:
        export TDMCP_PROJECT_RAG_BRIDGE_ANALYSIS=1
        export TDMCP_PROJECT_RAG_ENABLED=1
        export TDMCP_RAG_ENABLED=1
  6. Confirm it works:
        tdmcp project-rag bridge install   # probes the bridge
        tdmcp project-rag analyze ~/Downloads/some.tox

If the probe says OFFLINE, the analyzer will return "skipped" — it never
falls back to your main TD. That is the safe default.`;

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

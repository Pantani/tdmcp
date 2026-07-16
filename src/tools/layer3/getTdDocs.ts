import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createDefaultTdDocsResolver,
  type TdOfflineHelpResolver,
  validateTdDocsQuery,
} from "../../knowledge/sources/tdOfflineHelp.js";
import {
  TD_DOCS_DEFAULT_CONTENT_CHARS,
  TD_DOCS_MAX_CANDIDATES,
  TD_DOCS_MAX_CONTENT_CHARS,
  TD_DOCS_MAX_SECTIONS,
  type TdDocsBuildRelation,
  type TdDocsCandidate,
  type TdDocsDocument,
  type TdDocsLookupRequest,
  type TdDocsOutput,
  type TdDocsParsedSection,
  type TdDocsSection,
  type TdDocsSource,
  type TdDocsSourceLookup,
  type TdDocsWarning,
  tdDocsKinds,
  tdDocsSources,
} from "../../knowledge/tdDocsTypes.js";
import type { OperatorDoc, PythonClass } from "../../knowledge/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const safeQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(validateTdDocsQuery, "Query must be a documentation identity, not a path.");

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

export const getTdDocsSchema = z
  .object({
    query: safeQuerySchema.describe(
      "Operator type, Python class/page id, or concept text; never a filesystem path.",
    ),
    kind: z
      .enum(tdDocsKinds)
      .default("auto")
      .describe("Documentation kind: auto, operator, python, or concept."),
    section: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((value) => !containsControlCharacter(value), "Section contains controls.")
      .optional()
      .describe("Stable heading id or an exact unique section title from sections_available."),
    source: z
      .enum(tdDocsSources)
      .default("auto")
      .describe("Source policy: installed, embedded, web, or local-first auto."),
    web_fallback: z
      .boolean()
      .default(false)
      .describe("Allow auto mode to try the Derivative web API when the server gate is enabled."),
    max_chars: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(TD_DOCS_MAX_CONTENT_CHARS)
      .default(TD_DOCS_DEFAULT_CONTENT_CHARS)
      .describe("Maximum returned documentation body characters (1000-12000)."),
  })
  .strict();

type GetTdDocsInput = z.input<typeof getTdDocsSchema>;

const tdDocsSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  level: z.number().int().min(1).max(6),
  parent_id: z.string().optional(),
});

const tdDocsCandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["operator", "python", "concept"]),
});

const tdDocsWarningCodeSchema = z.enum([
  "running_build_unavailable",
  "corpus_build_unknown",
  "build_mismatch",
  "installed_docs_unavailable",
  "installed_page_missing",
  "embedded_fallback",
  "web_disabled",
  "web_latest_not_installed_build",
  "web_fetch_failed",
  "content_truncated",
  "sections_truncated",
]);

export const getTdDocsOutputSchema = z.object({
  status: z.enum(["found", "not_found", "section_not_found", "source_unavailable"]),
  query: z.string(),
  kind_requested: z.enum(tdDocsKinds),
  page: z
    .object({
      id: z.string(),
      title: z.string(),
      kind: z.enum(["operator", "python", "concept"]),
      matched_by: z.enum(["exact", "normalized", "derived_class", "search", "embedded"]),
    })
    .optional(),
  content: z.string().optional(),
  content_chars: z.number().int().nonnegative(),
  content_truncated: z.boolean(),
  sections_available: z.array(tdDocsSectionSchema).max(TD_DOCS_MAX_SECTIONS),
  sections_truncated: z.boolean(),
  selected_section: tdDocsSectionSchema.optional(),
  candidates: z.array(tdDocsCandidateSchema).max(TD_DOCS_MAX_CANDIDATES),
  provenance: z.object({
    source: z.enum(["installed-offline", "embedded", "web"]).optional(),
    source_path: z.string().optional(),
    source_url: z.string().url().optional(),
    installed_corpus_build: z.string().optional(),
    running_td_build: z.string().optional(),
    build_relation: z.enum(["match", "mismatch", "unknown"]),
    cache: z.enum(["hit", "miss", "not_applicable"]),
    sources_attempted: z.array(z.enum(["installed-offline", "embedded", "web"])).max(3),
  }),
  warnings: z.array(
    z.object({
      code: tdDocsWarningCodeSchema,
      message: z.string(),
    }),
  ),
});

let defaultResolver: TdOfflineHelpResolver | undefined;

function resolverForProcess(): TdOfflineHelpResolver {
  defaultResolver ??= createDefaultTdDocsResolver();
  return defaultResolver;
}

function section(id: string, title: string, content: string, level = 2): TdDocsParsedSection {
  return { id, title, level, content: content.trim() };
}

function lines(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join("\n");
}

function operatorSections(doc: OperatorDoc): TdDocsParsedSection[] {
  const overview = lines([doc.summary, doc.description, doc.usage]);
  const parameters = (doc.parameters ?? []).map((parameter) => {
    const type = parameter.type ?? parameter.dataType;
    const suffix = [type, parameter.description].filter(Boolean).join(" — ");
    return `- \`${parameter.name}\`${suffix ? ` — ${suffix}` : ""}`;
  });
  return [
    section("Overview", "Overview", overview || `Embedded documentation for ${doc.name}.`, 1),
    ...(parameters.length > 0 ? [section("Parameters", "Parameters", parameters.join("\n"))] : []),
    ...(doc.tips?.length
      ? [section("Tips", "Tips", doc.tips.map((tip) => `- ${tip}`).join("\n"))]
      : []),
    ...(doc.warnings?.length
      ? [section("Warnings", "Warnings", doc.warnings.map((warning) => `- ${warning}`).join("\n"))]
      : []),
    ...(doc.relatedOperators?.length
      ? [
          section(
            "Related_Operators",
            "Related Operators",
            doc.relatedOperators.map((operator) => `- ${operator}`).join("\n"),
          ),
        ]
      : []),
  ];
}

function pythonSections(doc: PythonClass): TdDocsParsedSection[] {
  const members = (doc.members ?? [])
    .map((member) =>
      lines([
        `- \`${member.name ?? member.id ?? "unknown"}\`${member.returnType ? ` → ${member.returnType}` : ""}${member.readOnly ? " (read-only)" : ""}`,
        member.description ? `  ${member.description}` : undefined,
      ]),
    )
    .join("\n");
  const methods = (doc.methods ?? [])
    .map((method) =>
      lines([
        `- \`${method.signature ?? method.name ?? "unknown"}\`${method.returns ? ` → ${method.returns}` : ""}`,
        method.description ? `  ${method.description}` : undefined,
      ]),
    )
    .join("\n");
  return [
    section(
      "Overview",
      "Overview",
      doc.description || `Embedded Python API documentation for ${doc.className}.`,
      1,
    ),
    ...(members ? [section("Members", "Members", members)] : []),
    ...(methods ? [section("Methods", "Methods", methods)] : []),
  ];
}

function embeddedPython(ctx: ToolContext, query: string): TdDocsDocument | undefined {
  const className = query.replace(/_class$/i, "");
  const doc = ctx.knowledge.getPythonClass(className);
  if (!doc) return undefined;
  const sections = pythonSections(doc);
  return {
    page: {
      id: `${doc.className}_Class`,
      title: doc.displayName ?? `${doc.className} Class`,
      kind: "python",
      matched_by: "embedded",
    },
    intro: doc.description ?? "",
    sections,
    default_content: sections.slice(0, 3).map(renderOneSection).join("\n\n"),
    source: "embedded",
    cache: "not_applicable",
  };
}

function embeddedOperator(ctx: ToolContext, query: string): TdDocsDocument | undefined {
  const doc = ctx.knowledge.getOperator(query);
  if (!doc) return undefined;
  const sections = operatorSections(doc);
  return {
    page: {
      id: doc.name,
      title: doc.displayName ?? doc.name,
      kind: "operator",
      matched_by: "embedded",
    },
    intro: doc.summary ?? doc.description ?? "",
    sections,
    default_content: renderOneSection(sections[0]),
    source: "embedded",
    cache: "not_applicable",
  };
}

function embeddedCandidates(ctx: ToolContext, request: TdDocsLookupRequest): TdDocsCandidate[] {
  if (request.kind === "python") {
    const key = request.query.toLowerCase();
    return ctx.knowledge
      .listPythonClasses()
      .filter((entry) => `${entry.className} ${entry.displayName}`.toLowerCase().includes(key))
      .slice(0, TD_DOCS_MAX_CANDIDATES)
      .map((entry) => ({
        id: `${entry.className}_Class`,
        title: entry.displayName,
        kind: "python" as const,
      }));
  }
  return ctx.knowledge
    .searchOperators(request.query, TD_DOCS_MAX_CANDIDATES)
    .map((entry) => ({ id: entry.slug, title: entry.displayName, kind: "operator" as const }));
}

function embeddedLookup(ctx: ToolContext, request: TdDocsLookupRequest): TdDocsSourceLookup {
  const document =
    request.kind === "python"
      ? embeddedPython(ctx, request.query)
      : request.kind === "operator"
        ? embeddedOperator(ctx, request.query)
        : request.kind === "auto"
          ? (embeddedPython(ctx, request.query) ?? embeddedOperator(ctx, request.query))
          : undefined;
  return {
    status: document ? "found" : "not_found",
    document,
    candidates: document ? [] : embeddedCandidates(ctx, request),
    warnings: [],
    source: "embedded",
    cache: "not_applicable",
  };
}

function renderOneSection(value: TdDocsParsedSection | undefined): string {
  if (!value) return "";
  return [`${"#".repeat(value.level)} ${value.title}`, value.content].filter(Boolean).join("\n\n");
}

function sectionBody(sections: TdDocsParsedSection[], selected: TdDocsParsedSection): string {
  const start = sections.indexOf(selected);
  if (start < 0) return renderOneSection(selected);
  let end = sections.length;
  for (let index = start + 1; index < sections.length; index++) {
    const candidate = sections[index];
    if (candidate && candidate.level <= selected.level) {
      end = index;
      break;
    }
  }
  return sections.slice(start, end).map(renderOneSection).join("\n\n");
}

function publicSection(value: TdDocsParsedSection): TdDocsSection {
  return {
    id: value.id,
    title: value.title,
    level: value.level,
    ...(value.parent_id ? { parent_id: value.parent_id } : {}),
  };
}

function selectedSection(
  sections: TdDocsParsedSection[],
  wanted: string | undefined,
): TdDocsParsedSection | undefined {
  if (!wanted) return undefined;
  const key = wanted.trim().toLowerCase();
  const byId = sections.find((entry) => entry.id.toLowerCase() === key);
  if (byId) return byId;
  const byTitle = sections.filter((entry) => entry.title.trim().toLowerCase() === key);
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

function capContent(content: string, maximum: number): { content: string; truncated: boolean } {
  if (content.length <= maximum) return { content, truncated: false };
  const suffix = "\n\n… [truncated — select a narrower section]";
  const budget = Math.max(0, maximum - suffix.length);
  const slice = content.slice(0, budget);
  const newline = slice.lastIndexOf("\n");
  const body = newline > budget / 2 ? slice.slice(0, newline) : slice;
  return { content: `${body.trimEnd()}${suffix}`.slice(0, maximum), truncated: true };
}

function relation(installed: string | undefined, running: string | undefined): TdDocsBuildRelation {
  if (!installed || !running) return "unknown";
  return installed.trim() === running.trim() ? "match" : "mismatch";
}

function uniqueWarnings(warnings: TdDocsWarning[]): TdDocsWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runningTdBuild(ctx: ToolContext): Promise<string | undefined> {
  return ctx.client
    .getInfo({ timeoutMs: 750, retryGet: false })
    .then((info) => info.build)
    .catch(() => undefined);
}

function baseOutput(
  request: TdDocsLookupRequest,
  status: TdDocsOutput["status"],
  runningBuild: string | undefined,
  installedBuild: string | undefined,
  sourcesAttempted: TdDocsSource[],
  warnings: TdDocsWarning[],
): TdDocsOutput {
  const buildRelation = relation(installedBuild, runningBuild);
  const buildWarnings = [...warnings];
  if (!runningBuild) {
    buildWarnings.push({
      code: "running_build_unavailable",
      message:
        "The running TouchDesigner build is unavailable; documentation lookup still completed.",
    });
  }
  if (buildRelation === "mismatch") {
    buildWarnings.push({
      code: "build_mismatch",
      message: `Installed corpus build ${installedBuild} differs from running TD build ${runningBuild}.`,
    });
  }
  return {
    status,
    query: request.query,
    kind_requested: request.kind,
    content_chars: 0,
    content_truncated: false,
    sections_available: [],
    sections_truncated: false,
    candidates: [],
    provenance: {
      installed_corpus_build: installedBuild,
      running_td_build: runningBuild,
      build_relation: buildRelation,
      cache: "not_applicable",
      sources_attempted: sourcesAttempted,
    },
    warnings: uniqueWarnings(buildWarnings),
  };
}

function documentOutput(
  request: TdDocsLookupRequest,
  document: TdDocsDocument,
  runningBuild: string | undefined,
  installedBuild: string | undefined,
  sourcesAttempted: TdDocsSource[],
  warnings: TdDocsWarning[],
): TdDocsOutput {
  const output = baseOutput(
    request,
    "found",
    runningBuild,
    installedBuild,
    sourcesAttempted,
    warnings,
  );
  const available = document.sections.slice(0, TD_DOCS_MAX_SECTIONS).map(publicSection);
  const sectionsTruncated = document.sections.length > TD_DOCS_MAX_SECTIONS;
  const selected = selectedSection(document.sections, request.section);
  if (request.section && !selected) {
    applyMissingSection(output, document, available, sectionsTruncated);
  } else {
    applyDocumentContent(output, request, document, selected, available, sectionsTruncated);
  }
  appendSectionWarning(output, sectionsTruncated);
  output.provenance = documentProvenance(document, runningBuild, installedBuild, sourcesAttempted);
  output.warnings = uniqueWarnings(output.warnings);
  return output;
}

function applyMissingSection(
  output: TdDocsOutput,
  document: TdDocsDocument,
  available: TdDocsSection[],
  sectionsTruncated: boolean,
): void {
  output.status = "section_not_found";
  output.page = document.page;
  output.sections_available = available;
  output.sections_truncated = sectionsTruncated;
}

function applyDocumentContent(
  output: TdDocsOutput,
  request: TdDocsLookupRequest,
  document: TdDocsDocument,
  selected: TdDocsParsedSection | undefined,
  available: TdDocsSection[],
  sectionsTruncated: boolean,
): void {
  const rendered = selected
    ? sectionBody(document.sections, selected)
    : document.default_content || document.intro;
  const capped = capContent(rendered, request.max_chars);
  output.page = document.page;
  output.content = capped.content;
  output.content_chars = capped.content.length;
  output.content_truncated = capped.truncated;
  output.sections_available = available;
  output.sections_truncated = sectionsTruncated;
  if (selected) output.selected_section = publicSection(selected);
  if (capped.truncated) {
    output.warnings.push({
      code: "content_truncated",
      message: `Content was truncated to ${request.max_chars} characters.`,
    });
  }
}

function appendSectionWarning(output: TdDocsOutput, sectionsTruncated: boolean): void {
  if (!sectionsTruncated) return;
  output.warnings.push({
    code: "sections_truncated",
    message: `Only the first ${TD_DOCS_MAX_SECTIONS} section descriptors were returned.`,
  });
}

function documentProvenance(
  document: TdDocsDocument,
  runningBuild: string | undefined,
  installedBuild: string | undefined,
  sourcesAttempted: TdDocsSource[],
): TdDocsOutput["provenance"] {
  const corpusBuild = installedBuild ?? document.installed_corpus_build;
  return {
    source: document.source,
    source_path: document.source_path,
    source_url: document.source_url,
    installed_corpus_build: corpusBuild,
    running_td_build: runningBuild,
    build_relation: relation(corpusBuild, runningBuild),
    cache: document.cache,
    sources_attempted: sourcesAttempted,
  };
}

interface LookupSequenceResult {
  lookup?: TdDocsSourceLookup;
  candidates: TdDocsCandidate[];
  warnings: TdDocsWarning[];
  sourcesAttempted: TdDocsSource[];
  installedBuild?: string;
  finalStatus: "not_found" | "source_unavailable";
}

interface LookupSequenceState {
  candidates: TdDocsCandidate[];
  warnings: TdDocsWarning[];
  sourcesAttempted: TdDocsSource[];
  installedBuild?: string;
  anyAvailable: boolean;
}

function lookupSources(request: TdDocsLookupRequest): TdDocsSource[] {
  if (request.source === "installed") return ["installed-offline"];
  if (request.source === "embedded") return ["embedded"];
  if (request.source === "web") return ["web"];
  const sources: TdDocsSource[] = ["installed-offline", "embedded"];
  if (request.web_fallback) sources.push("web");
  return sources;
}

function lookupOneSource(
  source: TdDocsSource,
  ctx: ToolContext,
  request: TdDocsLookupRequest,
  resolver: Pick<TdOfflineHelpResolver, "resolveInstalled" | "resolveWeb">,
): Promise<TdDocsSourceLookup> {
  if (source === "installed-offline") return resolver.resolveInstalled(request);
  if (source === "web") return resolver.resolveWeb(request);
  return Promise.resolve(embeddedLookup(ctx, request));
}

function mergeLookup(state: LookupSequenceState, lookup: TdDocsSourceLookup): void {
  state.warnings.push(...lookup.warnings);
  state.candidates.push(...lookup.candidates);
  if (lookup.installed_corpus_build) state.installedBuild = lookup.installed_corpus_build;
  if (lookup.status !== "source_unavailable") state.anyAvailable = true;
}

function sequenceResult(
  state: LookupSequenceState,
  lookup?: TdDocsSourceLookup,
): LookupSequenceResult {
  return {
    lookup,
    candidates: state.candidates,
    warnings: state.warnings,
    sourcesAttempted: state.sourcesAttempted,
    installedBuild: state.installedBuild,
    finalStatus: state.anyAvailable ? "not_found" : "source_unavailable",
  };
}

async function lookupSequence(
  ctx: ToolContext,
  request: TdDocsLookupRequest,
  resolver: Pick<TdOfflineHelpResolver, "resolveInstalled" | "resolveWeb">,
): Promise<LookupSequenceResult> {
  const state: LookupSequenceState = {
    candidates: [],
    warnings: [],
    sourcesAttempted: [],
    anyAvailable: false,
  };
  for (const source of lookupSources(request)) {
    state.sourcesAttempted.push(source);
    const lookup = await lookupOneSource(source, ctx, request, resolver);
    mergeLookup(state, lookup);
    if (lookup.status === "found") {
      if (source === "embedded" && request.source === "auto") {
        state.warnings.push({
          code: "embedded_fallback",
          message:
            "The installed corpus had no matching page; the deterministic embedded KB was used.",
        });
      }
      return sequenceResult(state, lookup);
    }
  }
  return sequenceResult(state);
}

export async function getTdDocsImpl(
  ctx: ToolContext,
  rawArgs: GetTdDocsInput,
  resolver: Pick<TdOfflineHelpResolver, "resolveInstalled" | "resolveWeb"> = resolverForProcess(),
): Promise<CallToolResult> {
  const parsed = getTdDocsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid get_td_docs input.", { issues: parsed.error.issues });
  }
  const request: TdDocsLookupRequest = parsed.data;
  try {
    const [runningBuild, sequence] = await Promise.all([
      runningTdBuild(ctx),
      lookupSequence(ctx, request, resolver),
    ]);
    const output = sequence.lookup?.document
      ? documentOutput(
          request,
          sequence.lookup.document,
          runningBuild,
          sequence.installedBuild,
          sequence.sourcesAttempted,
          sequence.warnings,
        )
      : {
          ...baseOutput(
            request,
            sequence.finalStatus,
            runningBuild,
            sequence.installedBuild,
            sequence.sourcesAttempted,
            sequence.warnings,
          ),
          candidates: sequence.candidates.slice(0, TD_DOCS_MAX_CANDIDATES),
        };
    const checked = getTdDocsOutputSchema.parse(output);
    const label = checked.page?.title ?? request.query;
    return structuredResult(`TouchDesigner docs ${checked.status}: ${label}.`, checked);
  } catch (error) {
    return errorResult(
      `TouchDesigner documentation lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const registerGetTdDocs: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_docs",
    {
      title: "Get build-aware TouchDesigner docs",
      description:
        "Read-only: resolve compact TouchDesigner operator, Python API, or concept documentation from the installed OfflineHelp corpus first, then the embedded KB. Returns section ids for bounded drill-down plus installed/running build provenance. Web fallback is off by default and, when explicitly enabled, is restricted to docs.derivative.ca and labeled as latest-web rather than installed-build truth. Never accepts a filesystem path or returns raw HTML.",
      inputSchema: getTdDocsSchema.shape,
      outputSchema: getTdDocsOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdDocsImpl(ctx, args),
  );
};

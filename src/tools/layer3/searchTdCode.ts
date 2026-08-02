import { z } from "zod";
import { isMissingEndpoint } from "../../td-client/types.js";
import { CodeSearchResultSchema } from "../../td-client/validators.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const familySchema = z.enum(["TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP"]);
const sourceKindSchema = z.enum(["dat_text", "parameter_expression"]);

function boundedText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\0\r\n]/.test(value), "Control characters are not supported.");
}

function starGlob(max: number) {
  return boundedText(max).refine(
    (value) => !/[?[\]{}\\]/.test(value),
    "Only '*' is supported as a glob metacharacter.",
  );
}

const rootPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.startsWith("/"), "root_path must be absolute.")
  .refine((value) => !/[\0\r\n]/.test(value), "root_path contains control characters.")
  .refine(
    (value) =>
      value === "/" ||
      !value
        .split("/")
        .slice(1)
        .some((part) => ["", ".", ".."].includes(part)),
    "root_path must be normalized.",
  );

export const searchTdCodeSchema = z.object({
  query: boundedText(256)
    .refine((value) => /[A-Za-z0-9]/.test(value), "query must contain an alphanumeric token.")
    .describe("Code, identifier, path fragment, or behavior to find."),
  root_path: rootPathSchema.default("/project1").describe("Network root to inspect."),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(3)
    .describe("Maximum descendant depth; 1 means direct children."),
  source_kinds: z
    .array(sourceKindSchema)
    .min(1)
    .max(2)
    .default(["dat_text", "parameter_expression"])
    .describe("Authored code-bearing sources to inspect."),
  node_pattern: boundedText(128)
    .optional()
    .describe("Case-insensitive node name-or-path pattern; '*' is a wildcard."),
  node_name_glob: starGlob(128).optional().describe("Anchored node-name '*' glob."),
  node_path_glob: starGlob(128).optional().describe("Anchored absolute node-path '*' glob."),
  type: boundedText(128).optional().describe("TouchDesigner operator type filter."),
  type_match: z.enum(["partial", "exact"]).default("partial"),
  family: familySchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  node_scan_limit: z.number().int().min(1).max(10_000).default(1_000),
  document_scan_limit: z.number().int().min(1).max(50_000).default(10_000),
  parameter_scan_limit: z.number().int().min(1).max(100_000).default(25_000),
  byte_scan_limit: z
    .number()
    .int()
    .min(1)
    .max(8 * 1_024 * 1_024)
    .default(2 * 1_024 * 1_024),
  time_budget_ms: z.number().int().min(25).max(2_500).default(1_000),
});

type SearchTdCodeArgs = z.input<typeof searchTdCodeSchema>;
type CodeSearchReport = z.infer<typeof CodeSearchResultSchema>;

interface CodeSearchRequest {
  query: string;
  rootPath: string;
  maxDepth: number;
  sourceKinds: Array<z.infer<typeof sourceKindSchema>>;
  nodePattern?: string;
  nodeNameGlob?: string;
  nodePathGlob?: string;
  type?: string;
  typeMatch: "partial" | "exact";
  family?: z.infer<typeof familySchema>;
  limit: number;
  nodeScanLimit: number;
  documentScanLimit: number;
  parameterScanLimit: number;
  byteScanLimit: number;
  timeBudgetMs: number;
}

interface CodeSearchClient {
  searchCode(request: CodeSearchRequest): Promise<CodeSearchReport>;
}

function updateRequiredResult() {
  const guidance =
    "search_td_code requires the structured POST /api/code/search route. Update or reinstall the TDMCP TouchDesigner bridge, then retry; this tool will not fall back to raw Python or export project code.";
  const result = errorResult(guidance);
  result.structuredContent = {
    status: "failed",
    error: {
      code: "BRIDGE_UPDATE_REQUIRED",
      route: "POST /api/code/search",
      action: "update_or_reinstall_bridge",
    },
  };
  return result;
}

function requestFromArgs(args: SearchTdCodeArgs): CodeSearchRequest {
  return {
    query: args.query,
    rootPath: args.root_path ?? "/project1",
    maxDepth: args.max_depth ?? 3,
    sourceKinds: args.source_kinds ?? ["dat_text", "parameter_expression"],
    nodePattern: args.node_pattern,
    nodeNameGlob: args.node_name_glob,
    nodePathGlob: args.node_path_glob,
    type: args.type,
    typeMatch: args.type_match ?? "partial",
    family: args.family,
    limit: args.limit ?? 50,
    nodeScanLimit: args.node_scan_limit ?? 1_000,
    documentScanLimit: args.document_scan_limit ?? 10_000,
    parameterScanLimit: args.parameter_scan_limit ?? 25_000,
    byteScanLimit: args.byte_scan_limit ?? 2 * 1_024 * 1_024,
    timeBudgetMs: args.time_budget_ms ?? 1_000,
  };
}

export async function searchTdCodeImpl(ctx: ToolContext, args: SearchTdCodeArgs) {
  const client = ctx.client as unknown as CodeSearchClient;
  try {
    const report = await client.searchCode(requestFromArgs(args));
    const qualifier = report.count_complete ? "" : "At least ";
    const suffix = report.truncated ? `; returning ${report.returned}` : "";
    return structuredResult(
      `${qualifier}${report.matched} code match(es) under ${report.root_path}${suffix}.`,
      report,
    );
  } catch (error) {
    if (isMissingEndpoint(error)) return updateRequiredResult();
    return guardTd(
      () => Promise.reject(error),
      () => errorResult("search_td_code failed unexpectedly."),
    );
  }
}

export const registerSearchTdCode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "search_td_code",
    {
      title: "Search TouchDesigner code",
      description:
        "Read-only: bounded BM25-style lexical search across authored DAT text and parameter expressions in the live TouchDesigner project. Returns short redacted excerpts with exact operator, source field, line, column, ranking provenance, and truthful completeness metadata. Works with TDMCP_BRIDGE_ALLOW_EXEC=0; never falls back to raw Python, exports whole DATs, or requires an embedding service.",
      inputSchema: searchTdCodeSchema.shape,
      outputSchema: CodeSearchResultSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => searchTdCodeImpl(ctx, args),
  );
};

import { z } from "zod";
import { isMissingEndpoint, TdApiError } from "../../td-client/types.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const familySchema = z.enum(["TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP"]);
const resultFamilySchema = z.enum(["TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP", "UNKNOWN"]);
const modeSchema = z.enum(["CONSTANT", "EXPRESSION", "EXPORT", "BIND", "UNKNOWN"]);
const stopReasonSchema = z.enum([
  "completed",
  "node_scan_limit",
  "parameter_scan_limit",
  "time_limit",
]);

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

export const findTdParametersSchema = z
  .object({
    root_path: rootPathSchema.default("/project1").describe("Network root to inspect."),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(3)
      .describe("Maximum descendant depth; 1 means direct children."),
    node_pattern: boundedText(128)
      .optional()
      .describe("Legacy-style case-insensitive name-or-path pattern; '*' is a wildcard."),
    node_name_glob: starGlob(128).optional().describe("Anchored node-name '*' glob."),
    node_path_glob: starGlob(128).optional().describe("Anchored absolute node-path '*' glob."),
    type: boundedText(128).optional().describe("TouchDesigner operator type filter."),
    type_match: z.enum(["partial", "exact"]).default("partial"),
    family: familySchema.optional(),
    parameter_glob: starGlob(256).optional().describe("Anchored parameter-name '*' glob."),
    value_glob: starGlob(256)
      .optional()
      .describe("Anchored point-in-time evaluated-value '*' glob."),
    expression_glob: starGlob(256).optional().describe("Anchored expression-text '*' glob."),
    mode: modeSchema.optional(),
    non_default_only: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(100),
    node_scan_limit: z.number().int().min(1).max(10_000).default(1_000),
    parameter_scan_limit: z.number().int().min(1).max(100_000).default(25_000),
    time_budget_ms: z.number().int().min(25).max(2_500).default(1_000),
  })
  .superRefine((value, refineCtx) => {
    if (
      value.root_path === "/" &&
      !value.node_pattern &&
      !value.node_name_glob &&
      !value.node_path_glob &&
      !value.type &&
      !value.family &&
      !value.parameter_glob &&
      !value.value_glob &&
      !value.expression_glob &&
      !value.mode &&
      !value.non_default_only
    ) {
      refineCtx.addIssue({
        code: "custom",
        path: ["root_path"],
        message: "root_path='/' requires at least one narrowing predicate.",
      });
    }
  });

type FindTdParametersArgs = z.input<typeof findTdParametersSchema>;

const parameterSearchHitSchema = z.object({
  op: z.string(),
  type: z.string(),
  family: resultFamilySchema,
  par: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  expr: z.string().optional(),
  mode: modeSchema,
  non_default: z.boolean(),
  redacted: z.literal(true).optional(),
  value_truncated: z.literal(true).optional(),
  expr_truncated: z.literal(true).optional(),
});

export const findTdParametersOutputSchema = z.object({
  root_path: z.string(),
  max_depth: z.number().int().min(1).max(32),
  results: z.array(parameterSearchHitSchema),
  scanned_nodes: z.number().int().nonnegative(),
  scanned_parameters: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200),
  truncated: z.boolean(),
  scan_truncated: z.boolean(),
  count_complete: z.boolean(),
  unreadable_parameters: z.number().int().nonnegative(),
  skipped_parameters: z.number().int().nonnegative(),
  redacted_parameters: z.number().int().nonnegative(),
  stop_reason: stopReasonSchema,
  elapsed_ms: z.number().int().nonnegative(),
});

type ParameterSearchReport = z.infer<typeof findTdParametersOutputSchema>;

interface ParameterSearchRequest {
  rootPath: string;
  maxDepth: number;
  nodePattern?: string;
  nodeNameGlob?: string;
  nodePathGlob?: string;
  type?: string;
  typeMatch: "partial" | "exact";
  family?: z.infer<typeof familySchema>;
  parameterGlob?: string;
  valueGlob?: string;
  expressionGlob?: string;
  mode?: z.infer<typeof modeSchema>;
  nonDefaultOnly: boolean;
  limit: number;
  nodeScanLimit: number;
  parameterScanLimit: number;
  timeBudgetMs: number;
}

interface ParameterSearchClient {
  searchParameters(request: ParameterSearchRequest): Promise<ParameterSearchReport>;
}

function missingParameterSearchEndpoint(error: unknown): boolean {
  if (isMissingEndpoint(error)) return true;
  return (
    error instanceof TdApiError &&
    error.status === 400 &&
    error.apiCode === "operator_not_found" &&
    /Node not found:\s*\/search\b/i.test(error.message)
  );
}

function updateRequiredResult() {
  const guidance =
    "find_td_parameters requires the structured POST /api/params/search route. Update or reinstall the TDMCP TouchDesigner bridge, then retry; this tool will not fall back to raw Python or a full parameter dump.";
  const result = errorResult(guidance);
  result.structuredContent = {
    status: "failed",
    error: {
      code: "BRIDGE_UPDATE_REQUIRED",
      route: "POST /api/params/search",
      action: "update_or_reinstall_bridge",
    },
  };
  return result;
}

function requestFromArgs(args: FindTdParametersArgs): ParameterSearchRequest {
  return {
    rootPath: args.root_path ?? "/project1",
    maxDepth: args.max_depth ?? 3,
    nodePattern: args.node_pattern,
    nodeNameGlob: args.node_name_glob,
    nodePathGlob: args.node_path_glob,
    type: args.type,
    typeMatch: args.type_match ?? "partial",
    family: args.family,
    parameterGlob: args.parameter_glob,
    valueGlob: args.value_glob,
    expressionGlob: args.expression_glob,
    mode: args.mode,
    nonDefaultOnly: args.non_default_only ?? false,
    limit: args.limit ?? 100,
    nodeScanLimit: args.node_scan_limit ?? 1_000,
    parameterScanLimit: args.parameter_scan_limit ?? 25_000,
    timeBudgetMs: args.time_budget_ms ?? 1_000,
  };
}

export async function findTdParametersImpl(ctx: ToolContext, args: FindTdParametersArgs) {
  const client = ctx.client as unknown as ParameterSearchClient;
  try {
    const report = await client.searchParameters(requestFromArgs(args));
    const qualifier = report.count_complete ? "" : "At least ";
    const suffix = report.truncated ? `; returning ${report.returned}` : "";
    return structuredResult(
      `${qualifier}${report.matched} parameter match(es) under ${report.root_path}${suffix}.`,
      report,
    );
  } catch (error) {
    if (missingParameterSearchEndpoint(error)) return updateRequiredResult();
    return guardTd(
      () => Promise.reject(error),
      () => errorResult("find_td_parameters failed unexpectedly."),
    );
  }
}

export const registerFindTdParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "find_td_parameters",
    {
      title: "Find TouchDesigner parameters",
      description:
        "Read-only: bounded bridge-side search for live TouchDesigner parameters by node, operator type/family, parameter name, evaluated value, expression, mode, or non-default state. Values are point-in-time snapshots; likely secrets are redacted and cannot satisfy value/expression filters. Inspect scan_truncated and count_complete before claiming project-wide completeness. Requires the current structured bridge route and never falls back to raw Python or a full parameter dump.",
      inputSchema: findTdParametersSchema.shape,
      outputSchema: findTdParametersOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => findTdParametersImpl(ctx, args),
  );
};

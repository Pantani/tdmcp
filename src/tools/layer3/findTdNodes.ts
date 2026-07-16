import { z } from "zod";
import { isMissingEndpoint, TdApiError } from "../../td-client/types.js";
import {
  BoundedSearchMetadataSchema,
  NodeSearchHitSchema,
  TdOperatorFamilySchema,
} from "../../td-client/validators.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { globToRegExp } from "./nodeMatch.js";

const boundedNodeText = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/.test(value), "Control characters are not supported.");

const starGlob = boundedNodeText.refine(
  (value) => !/[?[\]{}\\]/.test(value),
  "Only '*' is supported as a glob metacharacter.",
);

const rootPath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.startsWith("/"), "parent_path must be absolute.")
  .refine((value) => !/[\0\r\n]/.test(value), "parent_path contains control characters.")
  .refine(
    (value) =>
      value === "/" ||
      !value
        .split("/")
        .slice(1)
        .some((part) => ["", ".", ".."].includes(part)),
    "parent_path must be normalized.",
  );

export const findTdNodesSchema = z.object({
  parent_path: rootPath.default("/project1").describe("Where to search from."),
  pattern: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !/[\0\r\n]/.test(value), "Control characters are not supported.")
    .optional()
    .describe("Case-insensitive name/path filter with '*' wildcards (e.g. 'text*', '*noise*')."),
  name_glob: starGlob.optional().describe("Additional name-only '*' glob."),
  path_glob: starGlob.optional().describe("Additional absolute-path '*' glob."),
  type: boundedNodeText
    .optional()
    .describe("Case-insensitive operator-type substring (e.g. 'TOP', 'noise')."),
  type_match: z
    .enum(["partial", "exact"])
    .default("partial")
    .describe("Whether `type` is a substring or an exact operator type."),
  family: z
    .enum(["TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP"])
    .optional()
    .describe("Optional exact TouchDesigner operator family."),
  recursive: z
    .boolean()
    .default(true)
    .describe("Search the whole sub-network (true) or only direct children (false)."),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .describe("Maximum descendant depth; 1 means direct children. Overrides recursive=true."),
  path_only: z.boolean().default(false).describe("Return only matching paths."),
  limit: z.number().int().min(1).max(200).default(50).describe("Max matches to return."),
  node_scan_limit: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(5_000)
    .describe("Hard cap on nodes inspected inside TouchDesigner."),
  time_limit_ms: z
    .number()
    .int()
    .min(1)
    .max(2_000)
    .default(500)
    .describe("Hard bridge-side search budget in milliseconds."),
});
type FindTdNodesArgs = z.input<typeof findTdNodesSchema>;

const findTdNodeHitSchema = NodeSearchHitSchema.extend({
  family: TdOperatorFamilySchema.optional(),
});

type LegacyNode = z.infer<typeof findTdNodeHitSchema>;
type BridgeSearchReport = {
  nodes: z.infer<typeof NodeSearchHitSchema>[];
  metadata: z.infer<typeof BoundedSearchMetadataSchema>;
};

function familyFromType(type: string) {
  const suffix = type.match(/(TOP|CHOP|SOP|DAT|COMP|MAT|POP)$/i)?.[1]?.toUpperCase();
  return TdOperatorFamilySchema.safeParse(suffix).data;
}

function isMissingNodeSearchEndpoint(error: unknown): boolean {
  if (isMissingEndpoint(error)) return true;
  return (
    error instanceof TdApiError &&
    error.status === 400 &&
    error.apiCode === "operator_not_found" &&
    /Node not found:\s*\/search\b/i.test(error.message)
  );
}

export const findTdNodesOutputSchema = z.object({
  parent_path: z.string().describe("The network root the search ran under."),
  recursive: z.boolean().describe("Whether descendants were searched, echoing the request."),
  count: z.number().describe("Total nodes matched before `limit` truncation."),
  truncated: z.boolean().describe("True if more nodes matched than `limit` returned."),
  paths: z
    .array(z.string())
    .optional()
    .describe("path_only mode: the matched node paths and nothing else."),
  matches: z
    .array(findTdNodeHitSchema)
    .optional()
    .describe("Default mode: each matched node as {path, name, type, family}."),
  search_metadata: BoundedSearchMetadataSchema.optional().describe(
    "Current-bridge scan completeness and budget evidence; absent on an older-bridge fallback.",
  ),
  source: z.enum(["bridge_search", "legacy_structured_fallback"]),
  warnings: z.array(z.string()).max(4).optional(),
});

function bridgeSearchResult(
  report: BridgeSearchReport,
  parentPath: string,
  recursive: boolean,
  pathOnly: boolean,
) {
  const { nodes, metadata } = report;
  const count = metadata.matched;
  const truncated = metadata.truncated || metadata.scan_truncated;
  const qualifier = metadata.count_complete ? "" : "at least ";
  const summary = `${qualifier}${count} match(es) under ${parentPath}${truncated ? ` (showing ${nodes.length})` : ""}.`;
  const base = {
    parent_path: parentPath,
    recursive,
    count,
    truncated,
    search_metadata: metadata,
    source: "bridge_search" as const,
  };
  return pathOnly
    ? structuredResult(summary, { ...base, paths: nodes.map((node) => node.path) })
    : structuredResult(summary, { ...base, matches: nodes });
}

function filterLegacyNodes(inputNodes: LegacyNode[], args: FindTdNodesArgs) {
  let nodes = [...inputNodes].sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (args.pattern) {
    const pattern = globToRegExp(args.pattern);
    nodes = nodes.filter((node) => pattern.test(node.name) || pattern.test(node.path));
  }
  if (args.name_glob) {
    const name = globToRegExp(args.name_glob);
    nodes = nodes.filter((node) => name.test(node.name));
  }
  if (args.path_glob) {
    const path = globToRegExp(args.path_glob);
    nodes = nodes.filter((node) => path.test(node.path));
  }
  if (args.type) {
    const expected = args.type.toLowerCase();
    nodes = nodes.filter((node) => {
      const actual = node.type.toLowerCase();
      return (args.type_match ?? "partial") === "exact"
        ? actual === expected
        : actual.includes(expected);
    });
  }
  return args.family ? nodes.filter((node) => familyFromType(node.type) === args.family) : nodes;
}

function legacySearchResult(
  inputNodes: LegacyNode[],
  args: FindTdNodesArgs,
  parentPath: string,
  recursive: boolean,
  pathOnly: boolean,
) {
  let nodes = filterLegacyNodes(inputNodes, args);
  const count = nodes.length;
  const limit = args.limit ?? 50;
  const truncated = count > limit;
  nodes = nodes.slice(0, limit);
  const summary = `${count} match(es) under ${parentPath}${truncated ? ` (showing ${limit})` : ""}.`;
  const base = {
    parent_path: parentPath,
    recursive,
    count,
    truncated,
    source: "legacy_structured_fallback" as const,
    warnings: recursive
      ? [
          "Older bridge fallback transferred recursive structured topology before filtering; update the bridge for bounded compact server-side search.",
        ]
      : [
          "Older bridge fallback listed direct children before filtering; update the bridge for bounded compact server-side search.",
        ],
  };
  return pathOnly
    ? structuredResult(summary, { ...base, paths: nodes.map((node) => node.path) })
    : structuredResult(summary, {
        ...base,
        matches: nodes.map((node) => ({ ...node, family: familyFromType(node.type) })),
      });
}

export async function findTdNodesImpl(ctx: ToolContext, args: FindTdNodesArgs) {
  const parentPath = args.parent_path ?? "/project1";
  const recursive = args.recursive ?? true;
  const pathOnly = args.path_only ?? false;
  if (!recursive && args.max_depth !== undefined && args.max_depth !== 1) {
    return errorResult("find_td_nodes: recursive=false only permits max_depth=1.");
  }

  const legacyFetch = recursive
    ? async () => (await ctx.client.getNetworkTopology(parentPath, true)).nodes
    : async () => (await ctx.client.getNodes(parentPath)).nodes;

  const fetch = async () => {
    const typeMatch = args.type_match ?? "partial";
    try {
      const report = await ctx.client.searchNodes({
        rootPath: parentPath,
        pattern: args.pattern,
        nameGlob: args.name_glob,
        pathGlob: args.path_glob,
        type: args.type,
        typeMatch: typeMatch === "partial" ? "contains" : "exact",
        family: args.family,
        maxDepth: args.max_depth ?? (recursive ? 32 : 1),
        limit: args.limit ?? 50,
        nodeScanLimit: args.node_scan_limit ?? 5_000,
        timeLimitMs: args.time_limit_ms ?? 500,
      });
      return { kind: "bridge_search" as const, report };
    } catch (error) {
      if (!isMissingNodeSearchEndpoint(error)) throw error;
      return { kind: "legacy_structured_fallback" as const, nodes: await legacyFetch() };
    }
  };

  return guardTd(fetch, (search) =>
    search.kind === "bridge_search"
      ? bridgeSearchResult(search.report, parentPath, recursive, pathOnly)
      : legacySearchResult(search.nodes, args, parentPath, recursive, pathOnly),
  );
}

export const registerFindTdNodes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "find_td_nodes",
    {
      title: "Find TouchDesigner nodes",
      description:
        "Read-only: compact bridge-side node search by name/path glob, exact or partial operator type, family and bounded depth. Returns {count, truncated, matches/paths, search_metadata} without transferring topology; older bridges fall back only to structured list/topology reads. Prefer this over get_td_nodes when looking through a sub-tree; use get_td_topology only when you need wiring.",
      inputSchema: findTdNodesSchema.shape,
      outputSchema: findTdNodesOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => findTdNodesImpl(ctx, args),
  );
};

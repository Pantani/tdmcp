import { z } from "zod";
import { verifyNetwork } from "../../feedback/networkVerifier.js";
import { ConnectionSchema } from "../../td-client/validators.js";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/** Cap on per-node parameter fetches so a big graph can't fan out into hundreds of requests. */
const MAX_PARAM_NODES = 60;

export const snapshotTdGraphSchema = z.object({
  path: z.string().default("/project1").describe("Network root to snapshot."),
  include_params: z
    .boolean()
    .default(false)
    .describe("Also fetch each node's parameters (one request per node; capped for large graphs)."),
  compact: z
    .boolean()
    .default(false)
    .describe(
      "Token-cheap whole-COMP read: hoist each operator type's most-common parameter values into a shared `typeDefaults` map and store only each node's *deltas* from them (Embody-style read_tdn). Implies fetching parameters. Use for feeding a large network to an agent without paying for repeated identical values.",
    ),
});
type SnapshotTdGraphArgs = z.infer<typeof snapshotTdGraphSchema>;

export const snapshotTdGraphOutputSchema = z.object({
  path: z.string().describe("The network root that was snapshotted, echoing the request."),
  nodeCount: z.number().describe("Total number of nodes captured."),
  connectionCount: z.number().describe("Total number of connections captured."),
  issues: z.array(z.string()).describe("Plain-language structural problems detected in the graph."),
  params_truncated: z
    .boolean()
    .describe("True if include_params was set but the graph exceeded the per-node fetch cap."),
  compact: z
    .boolean()
    .optional()
    .describe(
      "True when compact mode hoisted per-type default parameters and delta-encoded nodes.",
    ),
  typeDefaults: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      "Compact mode only: each operator type's hoisted default parameter values; nodes store only their deltas from these.",
    ),
  nodes: z
    .array(
      z.object({
        path: z.string().describe("Full path of the node."),
        type: z.string().describe("Operator type of the node."),
        name: z.string().describe("Short name of the node."),
        parameters: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "The node's parameters as key→value; present when `include_params` or `compact` is set (compact implies fetching). In compact mode, only the deltas from the type default.",
          ),
        params_unfetched: z
          .boolean()
          .optional()
          .describe(
            "True when parameters were requested (`include_params` or `compact`) but not fetched for this node (past the per-node cap or a failed read), so a missing `parameters` field isn't mistaken for matching the type default.",
          ),
      }),
    )
    .describe("Every captured node, optionally with its parameters."),
  connections: z
    .array(ConnectionSchema)
    .describe("Every wire as {source_path, target_path, …}, suitable for diffing."),
});

interface SnapshotNode {
  path: string;
  type: string;
  name: string;
  parameters?: Record<string, unknown>;
  /**
   * True when parameters were requested for this node but never fetched (truncated past
   * MAX_PARAM_NODES, or the per-node read failed). Distinguishes "params unknown" from
   * "params match the type default", which both otherwise carry no `parameters` field.
   */
  params_unfetched?: boolean;
}

/**
 * For each operator type, the most-common value of each parameter across the nodes of
 * that type. These become the hoisted "type defaults" against which per-node values are
 * delta-encoded, so N identical noiseTOPs cost one shared block plus N near-empty nodes.
 */
export function computeTypeDefaults(
  nodes: ReadonlyArray<SnapshotNode>,
): Record<string, Record<string, unknown>> {
  const byType = new Map<string, Array<Record<string, unknown>>>();
  for (const node of nodes) {
    // Skip nodes without fetched/meaningful params (e.g. unreadable nodes that degrade to {}),
    // so they don't seed empty type-default entries that inflate the hoist count without saving tokens.
    if (!node.parameters || Object.keys(node.parameters).length === 0) continue;
    const list = byType.get(node.type) ?? [];
    list.push(node.parameters);
    byType.set(node.type, list);
  }
  const defaults: Record<string, Record<string, unknown>> = {};
  for (const [type, paramSets] of byType) {
    const perKey: Record<string, Map<string, { value: unknown; count: number }>> = {};
    for (const params of paramSets) {
      for (const [key, value] of Object.entries(params)) {
        const counts = perKey[key] ?? new Map<string, { value: unknown; count: number }>();
        perKey[key] = counts;
        const serialized = JSON.stringify(value ?? null);
        const entry = counts.get(serialized) ?? { value, count: 0 };
        entry.count += 1;
        counts.set(serialized, entry);
      }
    }
    const typeDefault: Record<string, unknown> = {};
    for (const [key, counts] of Object.entries(perKey)) {
      let best: { value: unknown; count: number } | undefined;
      for (const entry of counts.values()) {
        if (!best || entry.count > best.count) best = entry;
      }
      if (best) typeDefault[key] = best.value;
    }
    // Only hoist types that actually have shared defaults — an empty default is just noise.
    if (Object.keys(typeDefault).length > 0) defaults[type] = typeDefault;
  }
  return defaults;
}

/**
 * Re-expresses each node's parameters as only the keys that differ from its type default
 * (the `parameters` field is dropped entirely when a node matches its type default), so the
 * payload carries each non-default value exactly once.
 */
export function toCompactNodes(
  nodes: ReadonlyArray<SnapshotNode>,
  typeDefaults: Record<string, Record<string, unknown>>,
): SnapshotNode[] {
  return nodes.map((node) => {
    const base: SnapshotNode = { path: node.path, type: node.type, name: node.name };
    // Carry the "params unknown" marker through unchanged — these nodes have no
    // fetched parameters to delta-encode, and dropping the marker would make them
    // look like they match the type default.
    if (node.params_unfetched) {
      base.params_unfetched = true;
      return base;
    }
    if (!node.parameters) return base;
    const def = typeDefaults[node.type] ?? {};
    const delta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.parameters)) {
      if (JSON.stringify(value ?? null) !== JSON.stringify(def[key] ?? null)) delta[key] = value;
    }
    if (Object.keys(delta).length > 0) base.parameters = delta;
    return base;
  });
}

export async function snapshotTdGraphImpl(ctx: ToolContext, args: SnapshotTdGraphArgs) {
  // Compact mode is only useful with parameters, so it implies fetching them.
  const wantParams = args.include_params || args.compact;
  return guardTd(
    async () => {
      const report = await verifyNetwork(ctx.client, args.path);
      const refs = report.topology.nodes;
      let paramsTruncated = false;
      const params = new Map<string, Record<string, unknown>>();
      if (wantParams) {
        const targets = refs.slice(0, MAX_PARAM_NODES);
        paramsTruncated = refs.length > MAX_PARAM_NODES;
        // Fail-forward: one unreadable node shouldn't sink the whole snapshot.
        const details = await Promise.allSettled(targets.map((n) => ctx.client.getNode(n.path)));
        for (const detail of details) {
          if (detail.status === "fulfilled") params.set(detail.value.path, detail.value.parameters);
        }
      }
      const nodes: SnapshotNode[] = refs.map((n) => {
        const node: SnapshotNode = { path: n.path, type: n.type, name: n.name };
        if (wantParams) {
          // Only attach `parameters` when this node was actually read. Nodes past the
          // MAX_PARAM_NODES cap or whose read failed are flagged `params_unfetched` so a
          // missing `parameters` field isn't misread as "no params / matches default".
          if (params.has(n.path)) {
            node.parameters = params.get(n.path);
          } else {
            node.params_unfetched = true;
          }
        }
        return node;
      });
      return { report, nodes, paramsTruncated };
    },
    ({ report, nodes, paramsTruncated }) => {
      if (args.compact) {
        const typeDefaults = computeTypeDefaults(nodes);
        const compactNodes = toCompactNodes(nodes, typeDefaults);
        return structuredResult(
          `Compact snapshot of ${args.path}: ${report.nodeCount} node(s), ${report.connectionCount} connection(s), ${Object.keys(typeDefaults).length} type default(s) hoisted${report.issues.length ? `, ${report.issues.length} issue(s)` : ""}.`,
          {
            path: report.path,
            nodeCount: report.nodeCount,
            connectionCount: report.connectionCount,
            issues: report.issues,
            params_truncated: paramsTruncated,
            compact: true,
            typeDefaults,
            nodes: compactNodes,
            connections: report.topology.connections,
          },
        );
      }
      return structuredResult(
        `Snapshot of ${args.path}: ${report.nodeCount} node(s), ${report.connectionCount} connection(s)${report.issues.length ? `, ${report.issues.length} issue(s)` : ""}.`,
        {
          path: report.path,
          nodeCount: report.nodeCount,
          connectionCount: report.connectionCount,
          issues: report.issues,
          params_truncated: paramsTruncated,
          nodes,
          connections: report.topology.connections,
        },
      );
    },
  );
}

export const registerSnapshotTdGraph: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "snapshot_td_graph",
    {
      title: "Snapshot network graph",
      description:
        "Read-only: capture a compact, serializable snapshot of a network — nodes, connections, structural issues, and optionally each node's parameters — for review, diffing, or documentation. Returns {nodeCount, connectionCount, issues[], nodes[], connections[]}. Set `compact` for a token-cheap whole-COMP read that hoists per-type default parameters and stores only each node's deltas. Feed two of these snapshots to diff_snapshots to see exactly what changed across an edit.",
      inputSchema: snapshotTdGraphSchema.shape,
      outputSchema: snapshotTdGraphOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => snapshotTdGraphImpl(ctx, args),
  );
};

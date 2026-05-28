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
            "The node's parameters as key→value; present only when include_params is true.",
          ),
      }),
    )
    .describe("Every captured node, optionally with its parameters."),
  connections: z
    .array(ConnectionSchema)
    .describe("Every wire as {source_path, target_path, …}, suitable for diffing."),
});

export async function snapshotTdGraphImpl(ctx: ToolContext, args: SnapshotTdGraphArgs) {
  return guardTd(
    async () => {
      const report = await verifyNetwork(ctx.client, args.path);
      const refs = report.topology.nodes;
      let paramsTruncated = false;
      const params = new Map<string, Record<string, unknown>>();
      if (args.include_params) {
        const targets = refs.slice(0, MAX_PARAM_NODES);
        paramsTruncated = refs.length > MAX_PARAM_NODES;
        // Fail-forward: one unreadable node shouldn't sink the whole snapshot.
        const details = await Promise.allSettled(targets.map((n) => ctx.client.getNode(n.path)));
        for (const detail of details) {
          if (detail.status === "fulfilled") params.set(detail.value.path, detail.value.parameters);
        }
      }
      const nodes = refs.map((n) => ({
        path: n.path,
        type: n.type,
        name: n.name,
        ...(args.include_params ? { parameters: params.get(n.path) ?? {} } : {}),
      }));
      return { report, nodes, paramsTruncated };
    },
    ({ report, nodes, paramsTruncated }) =>
      structuredResult(
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
      ),
  );
}

export const registerSnapshotTdGraph: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "snapshot_td_graph",
    {
      title: "Snapshot network graph",
      description:
        "Read-only: capture a compact, serializable snapshot of a network — nodes, connections, structural issues, and optionally each node's parameters — for review, diffing, or documentation. Returns {nodeCount, connectionCount, issues[], nodes[], connections[]}. Feed two of these snapshots to diff_snapshots to see exactly what changed across an edit.",
      inputSchema: snapshotTdGraphSchema.shape,
      outputSchema: snapshotTdGraphOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => snapshotTdGraphImpl(ctx, args),
  );
};

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
  path: z.string(),
  nodeCount: z.number(),
  connectionCount: z.number(),
  issues: z.array(z.string()),
  params_truncated: z.boolean(),
  nodes: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      name: z.string(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  connections: z.array(ConnectionSchema),
});

export async function snapshotTdGraphImpl(ctx: ToolContext, args: SnapshotTdGraphArgs) {
  return guardTd(
    async () => {
      const report = await verifyNetwork(ctx.client, args.path);
      const refs = report.topology.nodes;
      let paramsTruncated = false;
      let params = new Map<string, Record<string, unknown>>();
      if (args.include_params) {
        const targets = refs.slice(0, MAX_PARAM_NODES);
        paramsTruncated = refs.length > MAX_PARAM_NODES;
        const details = await Promise.all(targets.map((n) => ctx.client.getNode(n.path)));
        params = new Map(details.map((d) => [d.path, d.parameters]));
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
        "Capture a compact, serializable snapshot of a network — nodes, connections, structural issues, and optionally each node's parameters — for review, diffing, or documentation.",
      inputSchema: snapshotTdGraphSchema.shape,
      outputSchema: snapshotTdGraphOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => snapshotTdGraphImpl(ctx, args),
  );
};

import { z } from "zod";
import { verifyNetwork } from "../../feedback/networkVerifier.js";
import { TopologySchema } from "../../td-client/validators.js";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdTopologySchema = z.object({
  root_path: z.string().default("/project1").describe("Network root to map."),
});
type GetTdTopologyArgs = z.infer<typeof getTdTopologySchema>;

export const getTdTopologyOutputSchema = z.object({
  path: z.string().describe("The network root that was mapped, echoing the request."),
  nodeCount: z.number().describe("Total number of nodes found under the root."),
  connectionCount: z.number().describe("Total number of wires (connections) between those nodes."),
  issues: z
    .array(z.string())
    .describe("Plain-language structural problems detected, e.g. dangling or orphaned nodes."),
  topology: TopologySchema.describe("The full graph: the node list and the connection list."),
});

export async function getTdTopologyImpl(ctx: ToolContext, args: GetTdTopologyArgs) {
  return guardTd(
    () => verifyNetwork(ctx.client, args.root_path),
    (report) =>
      structuredResult(
        `${report.nodeCount} node(s), ${report.connectionCount} connection(s) under ${args.root_path}.`,
        report,
      ),
  );
}

export const registerGetTdTopology: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_topology",
    {
      title: "Get network topology",
      description:
        "Read-only: return the nodes AND the connections (wiring) under a network root, flagging obvious structural issues. Returns {nodeCount, connectionCount, issues[], topology}. Use this when you need how nodes are wired together; use get_td_nodes/find_td_nodes when you only need the node list without connections, or snapshot_td_graph when you also want each node's parameters captured for diffing.",
      inputSchema: getTdTopologySchema.shape,
      outputSchema: getTdTopologyOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdTopologyImpl(ctx, args),
  );
};

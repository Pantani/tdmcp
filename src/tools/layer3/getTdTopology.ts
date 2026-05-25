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
  path: z.string(),
  nodeCount: z.number(),
  connectionCount: z.number(),
  issues: z.array(z.string()),
  topology: TopologySchema,
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
        "Return the nodes and connections under a network root, flagging obvious structural issues.",
      inputSchema: getTdTopologySchema.shape,
      outputSchema: getTdTopologyOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getTdTopologyImpl(ctx, args),
  );
};

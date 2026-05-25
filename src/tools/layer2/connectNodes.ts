import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { connectNodesViaBridge } from "./connectHelper.js";

export const connectNodesSchema = z.object({
  source_path: z.string().describe("Path of the source node (output side)."),
  target_path: z.string().describe("Path of the target node (input side)."),
  source_output: z.number().int().nonnegative().default(0),
  target_input: z.number().int().nonnegative().default(0),
});
type ConnectNodesArgs = z.infer<typeof connectNodesSchema>;

export async function connectNodesImpl(ctx: ToolContext, args: ConnectNodesArgs) {
  return guardTd(
    () =>
      connectNodesViaBridge(
        ctx.client,
        args.source_path,
        args.target_path,
        args.source_output,
        args.target_input,
      ),
    (result) =>
      jsonResult(`Connected ${args.source_path} → ${args.target_path} (via ${result.method}).`, {
        source: args.source_path,
        target: args.target_path,
        source_output: args.source_output,
        target_input: args.target_input,
        method: result.method,
      }),
  );
}

export const registerConnectNodes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_nodes",
    {
      title: "Connect two nodes",
      description:
        "Wire one node's output into another node's input. Uses the batch endpoint when available, with a Python fallback.",
      inputSchema: connectNodesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectNodesImpl(ctx, args),
  );
};

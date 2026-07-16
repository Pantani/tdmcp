import { z } from "zod";
import { guardTd, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { connectNodesViaBridge } from "./connectHelper.js";

export const connectNodesSchema = z.object({
  source_path: z.string().describe("Path of the source node (output side)."),
  target_path: z.string().describe("Path of the target node (input side)."),
  source_output: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Which output connector of the source node to wire from (0-based; default 0)."),
  target_input: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Which input connector of the target node to wire into (0-based; default 0)."),
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
    (result) => {
      // Surface the slot TD actually used: a multi-input TOP can pack a requested
      // slot to a different live index, and the endpoint reports it.
      const actualInput = result.actualInput ?? args.target_input;
      const packed = result.actualInput !== undefined && result.actualInput !== args.target_input;
      const note =
        (result.batchError
          ? ` Batch connect first failed (${result.batchError}); used the Python fallback.`
          : "") +
        (packed ? ` Requested input ${args.target_input} packed to live slot ${actualInput}.` : "");
      return jsonStructuredResult(
        `Connected ${args.source_path} → ${args.target_path} (via ${result.method}).${note}`,
        {
          source: args.source_path,
          target: args.target_path,
          source_output: args.source_output,
          target_input: args.target_input,
          actual_input: actualInput,
          method: result.method,
          ...(result.batchError ? { batch_error: result.batchError } : {}),
        },
      );
    },
  );
}

export const registerConnectNodes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_nodes",
    {
      title: "Connect two nodes",
      description:
        "Wire one node's output connector into another node's input connector inside TouchDesigner, creating a single link between two existing nodes. Uses the bridge's batch endpoint when available and falls back to a Python connect otherwise. Use create_node_chain instead when you are creating several new nodes and want them auto-wired in sequence. Returns the source and target paths, the connector indices used, and which method made the connection.",
      inputSchema: connectNodesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectNodesImpl(ctx, args),
  );
};

import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdNodeParametersSchema = z.object({
  path: z.string().describe("Full path of the node to inspect."),
});
type GetTdNodeParametersArgs = z.infer<typeof getTdNodeParametersSchema>;

export async function getTdNodeParametersImpl(ctx: ToolContext, args: GetTdNodeParametersArgs) {
  return guardTd(
    () => ctx.client.getNode(args.path),
    (node) =>
      jsonResult(`Parameters for ${node.path} (${node.type}).`, {
        path: node.path,
        type: node.type,
        name: node.name,
        parameters: node.parameters,
        inputs: node.inputs,
        outputs: node.outputs,
      }),
  );
}

export const registerGetTdNodeParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_node_parameters",
    {
      title: "Get node parameters",
      description: "Read the current parameters (and I/O) of a node.",
      inputSchema: getTdNodeParametersSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getTdNodeParametersImpl(ctx, args),
  );
};

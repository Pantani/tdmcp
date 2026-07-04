import { z } from "zod";
import { NodeDetailSchema } from "../../td-client/validators.js";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdNodeParametersSchema = z.object({
  path: z.string().describe("Full path of the node to inspect."),
  keys: z
    .array(z.string())
    .optional()
    .describe("Only return these parameter names (case-sensitive). Omit to return all parameters."),
  omit_io: z
    .boolean()
    .default(false)
    .describe("Drop the inputs/outputs lists from the result to save context."),
});
type GetTdNodeParametersArgs = z.infer<typeof getTdNodeParametersSchema>;

export async function getTdNodeParametersImpl(ctx: ToolContext, args: GetTdNodeParametersArgs) {
  return guardTd(
    () => ctx.client.getNode(args.path),
    (node) => {
      let parameters = node.parameters;
      if (args.keys && args.keys.length > 0) {
        const wanted = new Set(args.keys);
        parameters = Object.fromEntries(
          Object.entries(node.parameters).filter(([k]) => wanted.has(k)),
        );
      }
      const data: Record<string, unknown> = {
        path: node.path,
        type: node.type,
        name: node.name,
        parameters,
      };
      if (!args.omit_io) {
        data.inputs = node.inputs;
        data.outputs = node.outputs;
      }
      const count = Object.keys(parameters).length;
      return structuredResult(`${count} parameter(s) for ${node.path} (${node.type}).`, data);
    },
  );
}

export const registerGetTdNodeParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_node_parameters",
    {
      title: "Get node parameters",
      description:
        "Read-only: read the current parameters (and inputs/outputs) of one node. Returns {path, type, name, parameters, inputs, outputs}. Pass `keys` to project specific parameters or `omit_io:true` to drop the inputs/outputs lists. Use compare_td_nodes to diff two nodes' parameters at once. Token economy: pass `keys` to fetch only the parameters you care about and `omit_io:true` to drop inputs/outputs — a full parameter dump is large.",
      inputSchema: getTdNodeParametersSchema.shape,
      outputSchema: NodeDetailSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdNodeParametersImpl(ctx, args),
  );
};

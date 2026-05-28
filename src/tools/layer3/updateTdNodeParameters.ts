import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const updateTdNodeParametersSchema = z.object({
  path: z.string().describe("Full path of the node whose parameters to update."),
  parameters: z
    .record(z.string(), z.unknown())
    .describe("Parameter overrides as key→value pairs, e.g. { period: 4, amplitude: 0.5 }."),
});
type UpdateTdNodeParametersArgs = z.infer<typeof updateTdNodeParametersSchema>;

export async function updateTdNodeParametersImpl(
  ctx: ToolContext,
  args: UpdateTdNodeParametersArgs,
) {
  return guardTd(
    () => ctx.client.updateNodeParameters(args.path, args.parameters),
    (node) =>
      jsonResult(`Updated ${Object.keys(args.parameters).length} parameter(s) on ${node.path}.`, {
        node,
      }),
  );
}

export const registerUpdateTdNodeParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "update_td_node_parameters",
    {
      title: "Update node parameters",
      description:
        "Modify an existing node by setting one or more of its parameters to constant values. The update is strict (not best-effort): an unknown parameter name fails the whole call atomically without changing anything, and a bad value (wrong type or out of range) returns an error naming which parameters applied and which failed. On success returns the updated {node}. To inspect valid parameter names/current values first use get_td_node_parameters; to make a parameter move over time use animate_parameter instead of a static value.",
      inputSchema: updateTdNodeParametersSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => updateTdNodeParametersImpl(ctx, args),
  );
};

import { z } from "zod";
import { tryEndpoint } from "../../td-client/types.js";
import { NodeDetailSchema, ParameterSequenceSchema } from "../../td-client/validators.js";
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
  include_sequences: z
    .boolean()
    .default(true)
    .describe("Include bounded parameter-sequence names, block counts, values, and modes."),
});
type GetTdNodeParametersArgs = z.input<typeof getTdNodeParametersSchema>;

const GetTdNodeParametersOutputSchema = NodeDetailSchema.extend({
  sequences: z.array(ParameterSequenceSchema).optional(),
  sequences_inspected: z.boolean(),
  sequences_truncated: z.boolean().optional(),
  sequence_warnings: z.array(z.string()).optional(),
});

export async function getTdNodeParametersImpl(ctx: ToolContext, args: GetTdNodeParametersArgs) {
  return guardTd(
    async () => {
      const node = await ctx.client.getNode(args.path);
      if (args.include_sequences === false) return { node, sequenceReport: undefined };
      const sequenceReport = await tryEndpoint(
        () => ctx.client.getParameterSequences(args.path),
        async () => ({
          path: args.path,
          sequences: [],
          truncated: false,
          warnings: [
            "This bridge predates structured parameter-sequence discovery; reinstall or reload it to include sequences.",
          ],
        }),
      );
      return { node, sequenceReport };
    },
    ({ node, sequenceReport }) => {
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
      if (sequenceReport) {
        data.sequences = sequenceReport.sequences;
        data.sequences_inspected = true;
        data.sequences_truncated = sequenceReport.truncated;
        if (sequenceReport.warnings.length > 0) {
          data.sequence_warnings = sequenceReport.warnings;
        }
      } else {
        data.sequences_inspected = false;
      }
      const count = Object.keys(parameters).length;
      const sequenceSummary = sequenceReport
        ? `${sequenceReport.sequences.length} sequence(s)${sequenceReport.truncated ? " (truncated)" : ""}`
        : "sequence inspection skipped";
      return structuredResult(
        `${count} parameter(s) and ${sequenceSummary} for ${node.path} (${node.type}).`,
        data,
      );
    },
  );
}

export const registerGetTdNodeParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_node_parameters",
    {
      title: "Get node parameters",
      description:
        "Read-only: read current parameters, bounded sequence block metadata, and inputs/outputs for one node. Returns {path, type, name, parameters, sequences, inputs, outputs}. Pass `keys` to project specific parameters, `include_sequences:false` to skip sequence discovery, or `omit_io:true` to drop I/O. Use compare_td_nodes to diff two nodes' parameters at once.",
      inputSchema: getTdNodeParametersSchema.shape,
      outputSchema: GetTdNodeParametersOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdNodeParametersImpl(ctx, args),
  );
};

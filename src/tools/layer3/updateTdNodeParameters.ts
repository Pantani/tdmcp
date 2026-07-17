import { z } from "zod";
import { TdApiError, tryEndpoint } from "../../td-client/types.js";
import { errorResult, guardTd, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const updateTdNodeParametersSchema = z.object({
  path: z.string().describe("Full path of the node whose parameters to update."),
  parameters: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Parameter overrides as key→value pairs, e.g. { period: 4, amplitude: 0.5 }."),
  sequences: z
    .record(z.string(), z.number().int().min(1).max(256))
    .optional()
    .describe(
      "Optional parameter-sequence block counts. The bridge resizes sequences first, applies indexed constant values, and rolls back the whole transaction on failure.",
    ),
});
type UpdateTdNodeParametersArgs = z.input<typeof updateTdNodeParametersSchema>;

export async function updateTdNodeParametersImpl(
  ctx: ToolContext,
  args: UpdateTdNodeParametersArgs,
) {
  const parameters = args.parameters ?? {};
  const sequences = args.sequences ?? {};
  if (Object.keys(parameters).length === 0 && Object.keys(sequences).length === 0) {
    return errorResult("Provide at least one parameter value or sequence resize.");
  }
  if (Object.keys(sequences).length > 0) {
    return guardTd(
      () =>
        tryEndpoint(
          () => ctx.client.updateParameterSequences(args.path, { parameters, sequences }),
          async () => {
            throw new TdApiError(
              "This TouchDesigner bridge predates structured parameter sequences. Reinstall or reload the bridge and retry.",
              { status: 404 },
            );
          },
        ),
      (report) =>
        jsonStructuredResult(
          `Resized ${report.resized.length} sequence(s) and updated ${report.applied.length} indexed parameter(s) on ${report.path}.`,
          { sequence_update: report },
        ),
    );
  }
  return guardTd(
    () => ctx.client.updateNodeParameters(args.path, parameters),
    (node) =>
      jsonStructuredResult(
        `Updated ${Object.keys(parameters).length} parameter(s) on ${node.path}.`,
        { node },
      ),
  );
}

export const registerUpdateTdNodeParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "update_td_node_parameters",
    {
      title: "Update node parameters",
      description:
        "Modify an existing node by setting constant parameters. Add `sequences:{name:blockCount}` to resize parameter sequences and write indexed values in one rollback-safe transaction. Sequence calls reject expression/bind objects and return resize/value readback. Parameters-only calls keep the existing strict node update path. Inspect names and sequences first with get_td_node_parameters; use animate_parameter for time-varying values.",
      inputSchema: updateTdNodeParametersSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => updateTdNodeParametersImpl(ctx, args),
  );
};

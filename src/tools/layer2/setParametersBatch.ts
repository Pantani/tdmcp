import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import {
  allowsCallerCode,
  callerCodeDenied,
  genericNodeCodeBearingSources,
} from "../codeBearing.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const UpdateSchema = z.object({
  path: z.string().describe("Path of the node whose parameters to update."),
  parameters: z
    .record(z.string(), z.unknown())
    .describe("Parameter values to set on that node, as a { parName: value } map."),
});

export const setParametersBatchSchema = z.object({
  updates: z
    .array(UpdateSchema)
    .min(1)
    .describe(
      "List of { path, parameters } updates sent in one batch request (per-update results; not transactional — a failed update does not roll back the others).",
    ),
});
type SetParametersBatchArgs = z.infer<typeof setParametersBatchSchema>;

export async function setParametersBatchImpl(ctx: ToolContext, args: SetParametersBatchArgs) {
  if (!allowsCallerCode(ctx)) {
    try {
      const nodes = await Promise.all(
        args.updates.map((update) => ctx.client.getNode(update.path)),
      );
      for (const [index, update] of args.updates.entries()) {
        const node = nodes[index];
        const codeSources = genericNodeCodeBearingSources(node?.type, update.parameters);
        if (codeSources.length > 0) {
          return callerCodeDenied(
            `Batch parameter update with ${codeSources.join(", ")} on ${update.path}`,
          );
        }
      }
    } catch (err) {
      return errorResult(
        `Could not safely inspect every batch target before mutation: ${friendlyTdError(err)}. No parameters were changed.`,
      );
    }
  }
  return guardTd(
    () =>
      ctx.client.batch(
        args.updates.map((update) => ({
          action: "update" as const,
          path: update.path,
          parameters: update.parameters,
        })),
      ),
    (result) => {
      const failed = result.results.filter((r) => !r.ok);
      const okCount = result.results.length - failed.length;
      const summary = failed.length
        ? `Applied ${okCount}/${result.results.length} parameter update(s); ${failed.length} failed (see results).`
        : `Applied ${okCount} parameter update(s) in one batch.`;
      return jsonResult(summary, result);
    },
  );
}

export const registerSetParametersBatch: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "set_parameters_batch",
    {
      title: "Set parameters (batch)",
      description:
        "Update parameters on multiple nodes in a single batch request. Each update reports its own success; a failure does not roll back the others.",
      inputSchema: setParametersBatchSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setParametersBatchImpl(ctx, args),
  );
};

import { z } from "zod";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const saveTdProjectSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Optional Save As path. Omit to save the current project at its existing path; unsaved projects require a path.",
    ),
  confirmation_timeout_ms: z
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(30_000)
    .describe("Maximum bounded wait for native overwrite consent."),
});
type SaveTdProjectArgs = z.infer<typeof saveTdProjectSchema>;

interface SaveProjectRequest {
  path?: string;
  confirmation_timeout_ms: number;
}

export async function saveTdProjectImpl(ctx: ToolContext, args: SaveTdProjectArgs) {
  const request: SaveProjectRequest = {
    confirmation_timeout_ms: args.confirmation_timeout_ms,
    ...(args.path !== undefined ? { path: args.path } : {}),
  };
  return guardTd(
    () => ctx.client.saveProject(request),
    (result) => {
      const claimedApplied = result.saved === true || result.action_applied === true;
      const verified =
        result.saved === true &&
        result.action_applied === true &&
        result.verified_exists === true &&
        typeof result.final_path === "string";
      if (claimedApplied && !verified) {
        return errorResult(
          "TouchDesigner reported a save mutation but did not confirm its complete postcondition.",
          result,
        );
      }
      if (verified) {
        return jsonResult(`Saved TouchDesigner project to ${result.final_path}.`, result);
      }
      return jsonResult(
        `TouchDesigner project was not saved${result.decision ? ` (${result.decision})` : ""}.`,
        result,
      );
    },
  );
}

export const registerSaveTdProject: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "save_td_project",
    {
      title: "Save TouchDesigner project",
      description:
        "Save the current TouchDesigner project or Save As to an explicit path. Existing Save As targets require bounded native overwrite consent and fail closed to Keep on timeout, close, error, or unavailable UI. Never opens a native file dialog, loads/quits a project, or falls back to raw Python. Returns the requested/final path, verified save state, decision and project/build metadata.",
      inputSchema: saveTdProjectSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => saveTdProjectImpl(ctx, args),
  );
};

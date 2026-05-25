import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const executePythonScriptSchema = z.object({
  script: z
    .string()
    .min(1)
    .describe(
      "Python source to execute inside TouchDesigner (runs in the TD process, not locally).",
    ),
  return_output: z
    .boolean()
    .default(true)
    .describe("Capture stdout / the value of the last expression and return it."),
});
type ExecutePythonScriptArgs = z.infer<typeof executePythonScriptSchema>;

export async function executePythonScriptImpl(ctx: ToolContext, args: ExecutePythonScriptArgs) {
  return guardTd(
    () => ctx.client.executePythonScript(args.script, args.return_output),
    (result) => jsonResult("Python executed in TouchDesigner.", result),
  );
}

export const registerExecutePythonScript: ToolRegistrar = (server, ctx) => {
  if (ctx.allowRawPython === false) return;
  server.registerTool(
    "execute_python_script",
    {
      title: "Execute Python in TouchDesigner",
      description:
        "Escape hatch — run an arbitrary Python script inside the TouchDesigner process. Prefer the structured tools (find_td_nodes, get_td_node_parameters, update_td_node_parameters, summarize_td_errors, snapshot_td_graph, …); reach for this only when no structured tool can express the operation. Code runs in TD only, never on the local machine.",
      inputSchema: executePythonScriptSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => executePythonScriptImpl(ctx, args),
  );
};

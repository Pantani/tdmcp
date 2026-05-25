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
  server.registerTool(
    "execute_python_script",
    {
      title: "Execute Python in TouchDesigner",
      description:
        "Run a Python script inside the TouchDesigner process via the bridge. Code is executed in TD only — never on the local machine.",
      inputSchema: executePythonScriptSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => executePythonScriptImpl(ctx, args),
  );
};

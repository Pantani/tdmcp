import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const execNodeMethodSchema = z.object({
  path: z.string().describe("Full path of the node to call the method on."),
  method: z.string().describe("Method name to call, e.g. 'cook', 'par', 'destroy', 'copy'."),
  args: z.array(z.unknown()).default([]).describe("Positional arguments."),
  kwargs: z.record(z.string(), z.unknown()).default({}).describe("Keyword arguments."),
});
type ExecNodeMethodArgs = z.infer<typeof execNodeMethodSchema>;

export async function execNodeMethodImpl(ctx: ToolContext, args: ExecNodeMethodArgs) {
  return guardTd(
    () => ctx.client.execNodeMethod(args.path, args.method, args.args, args.kwargs),
    (result) => jsonResult(`Called ${args.path}.${args.method}().`, result),
  );
}

export const registerExecNodeMethod: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "exec_node_method",
    {
      title: "Call node method",
      description: "Invoke a Python method on a specific node (operator).",
      inputSchema: execNodeMethodSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => execNodeMethodImpl(ctx, args),
  );
};

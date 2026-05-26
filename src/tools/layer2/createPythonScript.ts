import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const TYPE_MAP = {
  text: "textDAT",
  execute: "executeDAT",
  script: "scriptDAT",
} as const;

export const createPythonScriptSchema = z.object({
  parent_path: z.string().describe("Parent COMP to create the DAT inside."),
  name: z.string().optional(),
  code: z.string().min(1).describe("Python source to place in the DAT."),
  dat_type: z
    .enum(["text", "execute", "script"])
    .default("text")
    .describe("Kind of DAT: 'text' (plain), 'execute' (event hooks), or 'script' (table builder)."),
});
type CreatePythonScriptArgs = z.infer<typeof createPythonScriptSchema>;

export async function createPythonScriptImpl(ctx: ToolContext, args: CreatePythonScriptArgs) {
  return guardTd(
    async () => {
      const dat = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: TYPE_MAP[args.dat_type],
        name: args.name,
      });
      const path = JSON.stringify(dat.path);
      const code = JSON.stringify(args.code);
      // A Script DAT's own .text is read-only ("operator is not editable").
      // Creating a scriptDAT auto-creates a companion text-editable callbacks
      // DAT (<name>_callbacks) referenced by its `callbacks` parameter, so the
      // code must be written there. text/execute DATs are .text-editable.
      const script =
        args.dat_type === "script"
          ? [
              `_op = op(${path})`,
              "_cb = None",
              "try:",
              "    _cb = _op.par.callbacks.eval()",
              "except Exception:",
              "    _cb = None",
              "if _cb is None:",
              "    _cb = _op.parent().op(_op.name + '_callbacks')",
              `_cb.text = ${code}`,
            ].join("\n")
          : `op(${path}).text = ${code}`;
      await ctx.client.executePythonScript(script, false);
      return dat;
    },
    (dat) => jsonResult(`Created ${args.dat_type} DAT at ${dat.path}.`, { node: dat }),
  );
}

export const registerCreatePythonScript: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_python_script",
    {
      title: "Create Python DAT",
      description: "Create a DAT (text/execute/script) preloaded with Python code.",
      inputSchema: createPythonScriptSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPythonScriptImpl(ctx, args),
  );
};

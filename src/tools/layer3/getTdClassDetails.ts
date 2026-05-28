import { z } from "zod";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdClassDetailsSchema = z.object({
  class_name: z.string().describe("Python class name, e.g. 'OP', 'TOP', 'App', 'CHOP'."),
});
type GetTdClassDetailsArgs = z.infer<typeof getTdClassDetailsSchema>;

export function getTdClassDetailsImpl(ctx: ToolContext, args: GetTdClassDetailsArgs) {
  const cls = ctx.knowledge.getPythonClass(args.class_name);
  if (!cls) {
    const suggestions = ctx.knowledge
      .listPythonClasses()
      .filter((c) => c.className.toLowerCase().includes(args.class_name.toLowerCase()))
      .slice(0, 5)
      .map((c) => c.className);
    return structuredResult(`Python class "${args.class_name}" not found.`, {
      found: false,
      suggestions,
    });
  }
  return structuredResult(
    `${cls.className} — ${cls.methods?.length ?? 0} methods, ${cls.members?.length ?? 0} members.`,
    cls,
  );
}

export const registerGetTdClassDetails: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_class_details",
    {
      title: "Get TD Python class details",
      description:
        "Read-only: full STRUCTURED documentation for one TouchDesigner Python class (members + methods) from the embedded knowledge base (offline). Returns the class object, or {found:false, suggestions[]} of near-name matches if unknown. Use get_module_help instead when you want the same content as ready-to-read Markdown rather than structured JSON.",
      inputSchema: getTdClassDetailsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => getTdClassDetailsImpl(ctx, args),
  );
};

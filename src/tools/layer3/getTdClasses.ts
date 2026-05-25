import { z } from "zod";
import { jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdClassesSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring to filter class names by."),
});
type GetTdClassesArgs = z.infer<typeof getTdClassesSchema>;

export function getTdClassesImpl(ctx: ToolContext, args: GetTdClassesArgs) {
  let classes = ctx.knowledge.listPythonClasses();
  if (args.filter) {
    const needle = args.filter.toLowerCase();
    classes = classes.filter(
      (c) =>
        c.className.toLowerCase().includes(needle) || c.displayName.toLowerCase().includes(needle),
    );
  }
  return jsonResult(`Found ${classes.length} TouchDesigner Python API class(es).`, { classes });
}

export const registerGetTdClasses: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_classes",
    {
      title: "List TD Python classes",
      description:
        "List TouchDesigner Python API classes from the embedded knowledge base (works offline). Optionally filter by name.",
      inputSchema: getTdClassesSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => getTdClassesImpl(ctx, args),
  );
};

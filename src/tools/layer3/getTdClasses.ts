import { z } from "zod";
import { structuredResult } from "../result.js";
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
  return structuredResult(`Found ${classes.length} TouchDesigner Python API class(es).`, {
    classes,
  });
}

export const registerGetTdClasses: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_classes",
    {
      title: "List TD Python classes",
      description:
        "Read-only: list TouchDesigner Python API class names from the embedded knowledge base (works offline, never touches TD). Returns {classes[]} of name/displayName entries. Optionally filter by name. Use get_td_class_details or get_module_help to expand one class into its members and methods.",
      inputSchema: getTdClassesSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => getTdClassesImpl(ctx, args),
  );
};

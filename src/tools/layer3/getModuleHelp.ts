import { z } from "zod";
import { jsonResult, textResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getModuleHelpSchema = z.object({
  name: z.string().describe("Class or module name to get help for, e.g. 'OP', 'App', 'Project'."),
});
type GetModuleHelpArgs = z.infer<typeof getModuleHelpSchema>;

export function getModuleHelpImpl(ctx: ToolContext, args: GetModuleHelpArgs) {
  const cls = ctx.knowledge.getPythonClass(args.name);
  if (!cls) {
    const suggestions = ctx.knowledge
      .listPythonClasses()
      .filter((c) => c.className.toLowerCase().includes(args.name.toLowerCase()))
      .slice(0, 5)
      .map((c) => c.className);
    return jsonResult(`No help found for "${args.name}".`, { found: false, suggestions });
  }

  const lines: string[] = [`# ${cls.displayName || cls.className}`, ""];
  if (cls.description) lines.push(cls.description, "");
  if (cls.members && cls.members.length > 0) {
    lines.push("## Members");
    for (const m of cls.members) {
      const ro = m.readOnly ? " (read-only)" : "";
      lines.push(`- ${m.name}${m.returnType ? `: ${m.returnType}` : ""}${ro}`);
    }
    lines.push("");
  }
  if (cls.methods && cls.methods.length > 0) {
    lines.push("## Methods");
    for (const method of cls.methods) {
      const sig = method.signature || method.name || "";
      lines.push(`- ${sig}${method.returns ? ` -> ${method.returns}` : ""}`);
    }
  }
  return textResult(lines.join("\n"));
}

export const registerGetModuleHelp: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_module_help",
    {
      title: "Get module/class help",
      description:
        "Read-only: human-readable Markdown help (description, members, method signatures) for a TouchDesigner Python class or module, from the embedded knowledge base (offline). Returns formatted text, or {found:false, suggestions[]} of near-name matches if unknown. Use get_td_class_details instead when you need the same information as structured JSON to process in code.",
      inputSchema: getModuleHelpSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => getModuleHelpImpl(ctx, args),
  );
};

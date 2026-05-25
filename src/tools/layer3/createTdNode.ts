import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createTdNodeSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path to create the node inside."),
  type: z
    .string()
    .describe("Operator type string, e.g. 'noiseTOP', 'feedbackTOP', 'nullTOP', 'constantCHOP'."),
  name: z.string().optional().describe("Optional node name (auto-generated if omitted)."),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional initial parameter overrides as key→value pairs."),
});
type CreateTdNodeArgs = z.infer<typeof createTdNodeSchema>;

export async function createTdNodeImpl(ctx: ToolContext, args: CreateTdNodeArgs) {
  const warnings: string[] = [];
  if (!ctx.knowledge.operatorExists(args.type)) {
    const suggestions = ctx.knowledge.searchOperators(args.type, 3).map((s) => s.name);
    warnings.push(
      `Operator type "${args.type}" was not found in the knowledge base.${
        suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
      }`,
    );
  }
  return guardTd(
    () =>
      ctx.client.createNode({
        parent_path: args.parent_path,
        type: args.type,
        name: args.name,
        parameters: args.parameters,
      }),
    (node) => jsonResult(`Created ${node.type || args.type} at ${node.path}.`, { node, warnings }),
  );
}

export const registerCreateTdNode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_td_node",
    {
      title: "Create TouchDesigner node",
      description:
        "Create a single operator (node) inside a parent COMP. Validates the operator type against the knowledge base and warns (without blocking) on unknown types.",
      inputSchema: createTdNodeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTdNodeImpl(ctx, args),
  );
};

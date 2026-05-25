import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const duplicateNetworkSchema = z.object({
  source_path: z.string().describe("Path of the node/COMP to duplicate."),
  name: z.string().optional().describe("Name for the copy (auto-generated if omitted)."),
  parent_path: z
    .string()
    .optional()
    .describe("Where to place the copy (defaults to the source's parent)."),
});
type DuplicateNetworkArgs = z.infer<typeof duplicateNetworkSchema>;

export async function duplicateNetworkImpl(ctx: ToolContext, args: DuplicateNetworkArgs) {
  const script = [
    `src = op(${q(args.source_path)})`,
    `if src is None: raise Exception('source not found: ' + ${q(args.source_path)})`,
    args.parent_path ? `parent = op(${q(args.parent_path)})` : "parent = src.parent()",
    "if parent is None: raise Exception('parent not found')",
    args.name ? `new = parent.copy(src, name=${q(args.name)})` : "new = parent.copy(src)",
    "result = new.path",
  ].join("\n");

  return guardTd(
    () => ctx.client.executePythonScript(script, true),
    (res) =>
      jsonResult(`Duplicated ${args.source_path} → ${res.result ?? "(see stdout)"}.`, {
        source: args.source_path,
        copy: res.result,
      }),
  );
}

export const registerDuplicateNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "duplicate_network",
    {
      title: "Duplicate a network",
      description:
        "Copy a node or whole COMP (and its contents) to a new node, optionally into another parent.",
      inputSchema: duplicateNetworkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => duplicateNetworkImpl(ctx, args),
  );
};

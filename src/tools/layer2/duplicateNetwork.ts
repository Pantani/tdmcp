import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

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
  // Goes through the first-class `POST /api/duplicate` route (survives
  // TDMCP_BRIDGE_ALLOW_EXEC=0), with a transparent `/api/exec` fallback baked into
  // `client.duplicateNode` for older bridges. `parent.copy` deep-copies the source
  // including its internal wires + parameter values.
  return guardTd(
    () => ctx.client.duplicateNode(args.source_path, args.name, args.parent_path),
    (res) =>
      jsonResult(`Duplicated ${res.source} → ${res.copy}.`, {
        source: res.source,
        copy: res.copy,
      }),
  );
}

export const registerDuplicateNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "duplicate_network",
    {
      title: "Duplicate a network",
      description:
        "Copy a node or whole COMP (and all its contents) to a new node, placed in the source's parent or another parent_path. Returns the source path and the new copy's path. Use duplicate this way to clone a built network; use create_container instead when you just need a fresh empty COMP.",
      inputSchema: duplicateNetworkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => duplicateNetworkImpl(ctx, args),
  );
};

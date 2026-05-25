import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const COMP_MAP = {
  container: "containerCOMP",
  base: "baseCOMP",
} as const;

export const createContainerSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP to create the container in."),
  name: z.string().optional(),
  comp_type: z
    .enum(["container", "base"])
    .default("container")
    .describe("'container' (2D panel COMP) or 'base' (generic COMP)."),
});
type CreateContainerArgs = z.infer<typeof createContainerSchema>;

export async function createContainerImpl(ctx: ToolContext, args: CreateContainerArgs) {
  return guardTd(
    () =>
      ctx.client.createNode({
        parent_path: args.parent_path,
        type: COMP_MAP[args.comp_type],
        name: args.name,
      }),
    (node) => jsonResult(`Created ${args.comp_type} COMP at ${node.path}.`, { node }),
  );
}

export const registerCreateContainer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_container",
    {
      title: "Create container COMP",
      description: "Create a self-contained COMP to hold a visual system.",
      inputSchema: createContainerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createContainerImpl(ctx, args),
  );
};

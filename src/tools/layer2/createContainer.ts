import { z } from "zod";
import { placeInGridScript } from "../layout.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const COMP_MAP = {
  container: "containerCOMP",
  base: "baseCOMP",
} as const;

export const createContainerSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP to create the container in."),
  name: z
    .string()
    .optional()
    .describe("Name for the new COMP; TouchDesigner auto-generates one when omitted."),
  comp_type: z
    .enum(["container", "base"])
    .default("container")
    .describe("'container' (2D panel COMP) or 'base' (generic COMP)."),
});
type CreateContainerArgs = z.infer<typeof createContainerSchema>;

export async function createContainerImpl(ctx: ToolContext, args: CreateContainerArgs) {
  return guardTd(
    async () => {
      const node = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: COMP_MAP[args.comp_type],
        name: args.name,
      });
      // Tile it into the 2D grid clear of existing siblings (cosmetic — never block creation).
      try {
        await ctx.client.executePythonScript(placeInGridScript(args.parent_path, node.path), false);
      } catch (err) {
        ctx.logger.debug("container placement skipped", { err: String(err) });
      }
      return node;
    },
    (node) => jsonResult(`Created ${args.comp_type} COMP at ${node.path}.`, { node }),
  );
}

export const registerCreateContainer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_container",
    {
      title: "Create container COMP",
      description:
        "Create one empty COMP under parent_path to hold a visual system, then tile it into the parent's network grid clear of existing siblings. `comp_type` picks a Container COMP (a 2D panel) or a generic Base COMP. Returns the created node's path, type, and name. Use a higher-level Layer 1 tool instead when you want a fully built, wired network rather than an empty shell.",
      inputSchema: createContainerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createContainerImpl(ctx, args),
  );
};

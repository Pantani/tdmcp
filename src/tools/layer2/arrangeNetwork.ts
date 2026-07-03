import { z } from "zod";
import { computeLayoutByParent, layoutScript } from "../layout.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const arrangeNetworkSchema = z.object({
  path: z
    .string()
    .describe("COMP whose children to arrange, e.g. '/project1' or a container path."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Also arrange the nodes inside nested COMPs (each network is tidied on its own)."),
  include_docked: z
    .boolean()
    .default(true)
    .describe(
      "Move each node's docked DATs (e.g. GLSL *_pixel or callbacks DATs) with it by the same delta, like an interactive drag. Set false to reposition only the nodes themselves.",
    ),
});
type ArrangeNetworkArgs = z.infer<typeof arrangeNetworkSchema>;

export async function arrangeNetworkImpl(ctx: ToolContext, args: ArrangeNetworkArgs) {
  return guardTd(
    async () => {
      const topology = await ctx.client.getNetworkTopology(args.path, args.recursive);
      const nodes = topology.nodes.map((n) => n.path);
      const edges = topology.connections.map((c) => ({ from: c.source_path, to: c.target_path }));
      const positions = computeLayoutByParent(nodes, edges);
      if (nodes.length > 0) {
        await ctx.client.executePythonScript(layoutScript(positions, args.include_docked), false);
      }
      return Object.keys(positions).length;
    },
    (arranged) =>
      jsonResult(
        arranged === 0
          ? `No nodes to arrange under ${args.path}.`
          : `Arranged ${arranged} node(s) under ${args.path} into a left→right data-flow layout.`,
        { path: args.path, arranged, recursive: args.recursive },
      ),
  );
}

export const registerArrangeNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "arrange_network",
    {
      title: "Arrange network layout",
      description:
        "Tidy an existing network: reposition a COMP's children into a readable left→right data-flow layout (sources on the left, output on the right). Use this to clean up nodes that are piled on top of each other. Set recursive to also arrange the contents of nested COMPs. Only moves node positions — it never adds, deletes, or rewires nodes. Returns the COMP path and how many nodes were repositioned.",
      inputSchema: arrangeNetworkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => arrangeNetworkImpl(ctx, args),
  );
};

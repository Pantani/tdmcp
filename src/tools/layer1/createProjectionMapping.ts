import { z } from "zod";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createProjectionMappingSchema = z.object({
  source_path: z
    .string()
    .optional()
    .describe("TOP to map (brought in via a Select TOP). Omit for a demo grid source."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'projection' container is created inside."),
});
type CreateProjectionMappingArgs = z.infer<typeof createProjectionMappingSchema>;

export async function createProjectionMappingImpl(
  ctx: ToolContext,
  args: CreateProjectionMappingArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "projection");

    // Bring the source in via a Select TOP (so it can live in another container); fall back
    // to a grid so the warp handles are visible against a reference pattern.
    const source = args.source_path
      ? await builder.add("selectTOP", "source", { top: args.source_path })
      : await builder.add("rampTOP", "source", { type: "radial" });

    // Corner Pin TOP — drag its four pin handles (pintopleft…/pinbottomright…) in the viewer
    // to line the image up with a real surface. The corners are ordinary parameters too.
    const warp = await builder.add("cornerpinTOP", "warp", { extend: "hold" });
    await builder.connect(source, warp);
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(warp, out);

    return finalize(ctx, {
      summary: `Built a projection-mapping warp → ${out}. Adjust the Corner Pin's four handles to fit your surface, then send ${out} to setup_output.`,
      builder,
      outputPath: out,
      extra: { warp, output_path: out },
    });
  });
}

export const registerCreateProjectionMapping: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_projection_mapping",
    {
      title: "Create projection mapping",
      description:
        "Wrap a source TOP in a Corner Pin warp for projection mapping: drag the four corner handles to line the image up with a physical surface (wall, object, screen). The source comes in through a Select TOP so it can live anywhere; output is a Null ready for setup_output. The corner positions are parameters, so you can also drive or save them.",
      inputSchema: createProjectionMappingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createProjectionMappingImpl(ctx, args),
  );
};

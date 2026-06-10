import { z } from "zod";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";

export const scaffoldShowSchema = z.object({
  name: z.string().default("show").describe("Name of the show container to create."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the show container is created inside."),
});
type ScaffoldShowArgs = z.infer<typeof scaffoldShowSchema>;

export async function scaffoldShowImpl(ctx: ToolContext, args: ScaffoldShowArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // A master output Null (where the mix lands) and a beat clock to drive reactivity — the
    // skeleton of a live show; the artist fills in scenes and wires them to the master.
    const master = await builder.add("nullTOP", "master");
    const beat = await builder.add("beatCHOP", "beat", {
      ramp: 1,
      pulse: 1,
      count: 1,
      beat: 1,
      bar: 1,
      bpm: 1,
    });
    const tempo = await builder.add("nullCHOP", "tempo");
    await builder.connect(beat, tempo);

    return finalize(ctx, {
      summary: `Scaffolded a show at ${builder.containerPath}: a "master" output Null and a "tempo" beat clock. Next: build scenes (visual / generative / feedback / 3d / simulation), extract_audio_features for reactivity, create_layer_mixer into ${master}, store looks with manage_cue, and create_control_surface to play it.`,
      builder,
      outputPath: master,
      capturePreviewImage: false,
      extra: { show: builder.containerPath, master, tempo },
    });
  });
}

export const registerScaffoldShow: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "scaffold_show",
    {
      title: "Scaffold a show",
      description:
        "Create a starting skeleton for a live show: a new container under parent_path with a 'master' output Null (where your mix lands) and a 'tempo' beat clock for reactivity, but NO scenes or look. Use scaffold_genre instead when you want a genre-flavored start (tempo + a ready-made look + palette already wired in). Returns the container path plus the 'master' and 'tempo' node paths. A blank-canvas starting point — then add scenes, audio features, a layer mixer into master, cues and a control surface.",
      inputSchema: scaffoldShowSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => scaffoldShowImpl(ctx, args),
  );
};

import type { ToolContext, ToolRegistrar } from "../types.js";

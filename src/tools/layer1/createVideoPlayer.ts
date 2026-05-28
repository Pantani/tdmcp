import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

export const createVideoPlayerSchema = z.object({
  files: z
    .array(z.string())
    .default([])
    .describe(
      "Movie file path(s). 0 = an empty player you can point at a file later; 1 = a single clip; 2+ = a playlist with a Switch TOP and a Clip selector.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live Play / Speed (and Clip, for a playlist) controls."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'video_player' container is created inside."),
});
type CreateVideoPlayerArgs = z.infer<typeof createVideoPlayerSchema>;

export async function createVideoPlayerImpl(ctx: ToolContext, args: CreateVideoPlayerArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "video_player");

    const clips: string[] = [];
    if (args.files.length === 0) {
      clips.push(await builder.add("moviefileinTOP", "clip1", { play: 1 }));
    } else {
      for (const [i, file] of args.files.entries()) {
        clips.push(await builder.add("moviefileinTOP", `clip${i + 1}`, { file, play: 1 }));
      }
    }

    let output: string;
    const controls: ControlSpec[] = [];
    if (clips.length > 1) {
      const sw = await builder.add("switchTOP", "switch", { index: 0 });
      for (const [i, clip] of clips.entries()) await builder.connect(clip, sw, 0, i);
      output = sw;
      if (args.expose_controls) {
        controls.push({
          name: "Clip",
          type: "int",
          min: 0,
          max: clips.length - 1,
          default: 0,
          bind_to: [`${sw}.index`],
        });
      }
    } else {
      output = clips[0] as string;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);

    if (args.expose_controls) {
      controls.push(
        {
          name: "Speed",
          type: "float",
          min: -2,
          max: 2,
          default: 1,
          bind_to: clips.map((c) => `${c}.speed`),
        },
        { name: "Play", type: "toggle", default: true, bind_to: clips.map((c) => `${c}.play`) },
      );
    }

    return finalize(ctx, {
      summary: `Built a video player with ${clips.length} clip(s) → ${out}${args.files.length === 0 ? " (set the Movie File In's file to load a clip)" : ""}.`,
      builder,
      outputPath: out,
      controls,
      extra: { clips, output_path: out, playlist: clips.length > 1 },
    });
  });
}

export const registerCreateVideoPlayer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_video_player",
    {
      title: "Create video player",
      description:
        "Build a movie/clip player inside a new 'video_player' container under parent_path: one Movie File In TOP, or a playlist of clips fed through a Switch TOP with a Clip selector. Exposes live Play / Speed (and Clip) controls, output as a Null TOP. Pass file paths, or none to get an empty player you point at a file in TD. Use create_video_synth instead when you want a procedurally generated (oscillator/CRT) image rather than playing a video file. Returns the created clip paths, the output Null path, and whether a playlist was built. For VJ clip playback — mix it with create_layer_mixer or make it react with bind_to_channel.",
      inputSchema: createVideoPlayerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVideoPlayerImpl(ctx, args),
  );
};

import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createMotionReactiveSchema = z.object({
  source: z
    .enum(["camera", "file", "synthetic", "existing_top"])
    .default("camera")
    .describe(
      "Video source. 'camera' = live webcam/capture device (the real-world default; creating it may pop a one-time macOS camera-permission dialog — click Allow). 'file' = a movie file. 'synthetic' = an animated noise pattern, handy for testing without any device permission. 'existing_top' = analyze a TOP you already have.",
    ),
  movie_file_path: z
    .string()
    .optional()
    .describe("Path to a movie file to play as the source; used only when source='file'."),
  existing_top_path: z
    .string()
    .optional()
    .describe("Path of an existing TOP to analyze; used only when source='existing_top'."),
  analysis_resolution: z.coerce
    .number()
    .int()
    .positive()
    .default(160)
    .describe(
      "The video is downsized to this square resolution before analysis — small keeps it cheap (the reactive values barely change with size).",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose a live 'Sensitivity' knob (a gain over every feature channel).",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent network where the motion-reactive container is created (default '/project1').",
    ),
});
type CreateMotionReactiveArgs = z.infer<typeof createMotionReactiveSchema>;

async function buildSource(
  builder: NetworkBuilder,
  args: CreateMotionReactiveArgs,
): Promise<string> {
  if (args.source === "existing_top" && args.existing_top_path) {
    return args.existing_top_path;
  }
  if (args.source === "file") {
    return builder.add("moviefileinTOP", "videoin", {
      ...(args.movie_file_path ? { file: args.movie_file_path } : {}),
      play: 1,
    });
  }
  if (args.source === "synthetic") {
    // A scrolling noise pattern: consecutive frames differ, so 'motion' reads non-zero —
    // a self-contained signal for verifying the chain without any camera permission.
    const noise = await builder.add("noiseTOP", "videoin", {
      resolutionw: args.analysis_resolution,
      resolutionh: args.analysis_resolution,
    });
    await builder.python(`op(${q(noise)}).par.tz.expr = "absTime.seconds * 2"`);
    return noise;
  }
  return builder.add("videodeviceinTOP", "videoin");
}

export async function createMotionReactiveImpl(ctx: ToolContext, args: CreateMotionReactiveArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "motion_reactive");
    const source = await buildSource(builder, args);

    // Downsize to a small monochrome image once; both branches read it (cheap, and the
    // reactive averages are resolution-independent).
    const mono = await builder.add("monochromeTOP", "mono", {
      outputresolution: "custom",
      resolutionw: args.analysis_resolution,
      resolutionh: args.analysis_resolution,
    });
    await builder.connect(source, mono);

    // brightness = average luminance of the current frame.
    const brightA = await builder.add("analyzeTOP", "bright_a", { op: "average" });
    await builder.connect(mono, brightA);
    const brightC = await builder.add("toptoCHOP", "bright_c", {
      top: brightA,
      r: "brightness",
      g: "",
      b: "",
      a: "",
    });

    // motion = average per-pixel change vs the previous frame. A Cache TOP holds the frame one
    // step back (outputindex -1; index 0 is newest), a Difference TOP subtracts, and Analyze
    // reduces to one value. Static input ⇒ 0; movement ⇒ > 0 (validated live).
    const cache = await builder.add("cacheTOP", "prevframe", {
      active: 1,
      cachesize: 2,
      outputindexunit: "indices",
      outputindex: -1,
    });
    await builder.connect(mono, cache);
    const diff = await builder.add("differenceTOP", "framediff");
    await builder.connect(mono, diff, 0, 0);
    await builder.connect(cache, diff, 0, 1);
    const motionA = await builder.add("analyzeTOP", "motion_a", { op: "average" });
    await builder.connect(diff, motionA);
    const motionC = await builder.add("toptoCHOP", "motion_c", {
      top: motionA,
      r: "motion",
      g: "",
      b: "",
      a: "",
    });

    // Merge the two single-channel CHOPs, apply a Sensitivity gain, and end on a Null as the
    // stable bind point. Expressions read op('…/features')['motion'] / ['brightness'].
    const merge = await builder.add("mergeCHOP", "merged");
    await builder.connect(brightC, merge, 0, 0);
    await builder.connect(motionC, merge, 0, 1);
    const gain = await builder.add("mathCHOP", "sensitivity", { gain: 1 });
    await builder.connect(merge, gain);
    const features = await builder.add("nullCHOP", "features");
    await builder.connect(gain, features);

    // The analysis is TOP-based, so without something pulling it every frame the Cache/Difference
    // chain goes cold and motion freezes. A tiny Execute DAT cooks the Null each frame so the
    // signals stay live even before anything is bound (binding a parameter would also pull it).
    const cooker = await builder.add("executeDAT", "cooker");
    await builder.python(
      `_c = op(${q(cooker)})\n_c.text = "def onFrameStart(frame):\\n\\tparent().op('features').cook(force=True)\\n\\treturn\\n"\n_c.par.framestart = True\n_c.par.active = True`,
    );

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Sensitivity",
            type: "float",
            min: 0,
            max: 8,
            default: 1,
            bind_to: [`${gain}.gain`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a motion-reactive chain (source: ${args.source}) → ${features} with channels brightness/motion. Bind a parameter to op('${features}')['motion'] (or ['brightness']) to make it react to the camera.`,
      builder,
      outputPath: features,
      // The output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        source: args.source,
        features_path: features,
        channels: ["brightness", "motion"],
        analysis_resolution: args.analysis_resolution,
      },
    });
  });
}

export const registerCreateMotionReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_motion_reactive",
    {
      title: "Create motion reactive",
      description:
        "Build a video-analysis chain that exposes ready-to-bind reactive channels — overall brightness plus frame-to-frame motion energy — on a Null CHOP. The camera counterpart to extract_audio_features: bind any parameter to op('…/motion_reactive/features')['motion'] and it responds to movement in front of the camera, or ['brightness'] to ambient light. A Sensitivity knob scales both. Creates a new baseCOMP under `parent_path` holding the source, a downsized monochrome analysis chain, and a 'features' Null CHOP output. Source can be the live camera (may prompt for macOS permission), a movie file, an animated synthetic pattern (for testing without a camera), or an existing TOP. Optical flow is unavailable on macOS, so direction isn't exposed. Returns a summary plus a JSON block with the container path, created node paths, the features Null path, the channel names, exposed controls, any node errors, and warnings (no preview image — the output is a CHOP, not a TOP).",
      inputSchema: createMotionReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMotionReactiveImpl(ctx, args),
  );
};

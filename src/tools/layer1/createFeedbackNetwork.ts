import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const SEED_TYPES = {
  noise: "noiseTOP",
  shape: "circleTOP",
  image: "moviefileinTOP",
  video: "moviefileinTOP",
  webcam: "videodeviceinTOP",
  glsl: "glslTOP",
} as const;

const TRANSFORM_TYPES = {
  blur: "blurTOP",
  displace: "displaceTOP",
  edge: "edgeTOP",
  level: "levelTOP",
  hsv_adjust: "hsvadjustTOP",
  transform: "transformTOP",
  mirror: "mirrorTOP",
  tile: "tileTOP",
  luma_blur: "lumablurTOP",
} as const;

export const createFeedbackNetworkSchema = z.object({
  seed_type: z.enum(["noise", "shape", "image", "video", "webcam", "glsl"]).default("noise"),
  transformations: z
    .array(
      z.enum([
        "blur",
        "displace",
        "edge",
        "level",
        "hsv_adjust",
        "transform",
        "mirror",
        "tile",
        "luma_blur",
      ]),
    )
    .default(["blur", "displace", "level"]),
  feedback_gain: z.number().min(0).max(1).default(0.95),
  parent_path: z.string().default("/project1"),
});
type CreateFeedbackNetworkArgs = z.infer<typeof createFeedbackNetworkSchema>;

export async function createFeedbackNetworkImpl(ctx: ToolContext, args: CreateFeedbackNetworkArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "feedback_system");

    const seed = await builder.add(SEED_TYPES[args.seed_type], "seed", {
      ...(args.seed_type === "noise" ? { monochrome: 1, period: 4 } : {}),
    });
    const feedback = await builder.add("feedbackTOP", "feedback1");
    const comp = await builder.add("compositeTOP", "comp1");
    await builder.connect(seed, comp, 0, 0);
    await builder.connect(feedback, comp, 0, 1);

    let last = comp;
    for (const transformation of args.transformations) {
      const node = await builder.add(TRANSFORM_TYPES[transformation], transformation);
      await builder.connect(last, node);
      last = node;
    }

    const gain = await builder.add("levelTOP", "gain");
    await builder.setParams(gain, { gain: args.feedback_gain });
    await builder.connect(last, gain);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(gain, out);

    // Close the loop: feedbackTOP samples the gain node's output.
    await builder.python(
      `op(${JSON.stringify(feedback)}).par.top = op(${JSON.stringify(gain)}).name`,
    );

    return finalize(ctx, {
      summary: `Created a feedback network (seed: ${args.seed_type}, gain: ${args.feedback_gain}, ${args.transformations.length} transform(s)).`,
      builder,
      outputPath: out,
      extra: { seed_type: args.seed_type, transformations: args.transformations },
    });
  });
}

export const registerCreateFeedbackNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_feedback_network",
    {
      title: "Create feedback network",
      description:
        "Build a feedback-based visual system: a seed feeds a loop that is transformed (blur/displace/etc.) and fed back each frame. Great for evolving, hypnotic visuals.",
      inputSchema: createFeedbackNetworkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createFeedbackNetworkImpl(ctx, args),
  );
};

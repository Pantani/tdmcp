import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

// Builds a GLSL fragment that maps the grayscale luminance through a 1- or 2-color
// gradient, so a described palette ("blues and magentas") survives to the output.
function colorizeShader(colors: string[]): string {
  const toVec3 = (hex: string | undefined): string => {
    const m = hex ? /^#?([0-9a-fA-F]{6})$/.exec(hex.trim()) : null;
    if (!m?.[1]) return "vec3(1.0)";
    const n = Number.parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
  };
  const lo = colors.length >= 2 ? toVec3(colors[0]) : "vec3(0.0)";
  const hi = toVec3(colors[colors.length - 1]);
  return `out vec4 fragColor;
void main(){
    float l = texture(sTD2DInputs[0], vUV.st).r;
    fragColor = TDOutputSwizzle(vec4(mix(${lo}, ${hi}, l), 1.0));
}
`;
}

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
  feedback_gain: z.coerce.number().min(0).max(1).default(0.95),
  colors: z
    .array(z.string())
    .max(2)
    .optional()
    .describe("Up to two hex colors to colorize the otherwise-grayscale output."),
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
    // The TD default operand (multiply) collapses the loop to black; an additive
    // operand injects the seed each frame, and "maximum" stays bounded under feedback gain.
    await builder.setParams(comp, { operand: "maximum" });
    await builder.connect(seed, comp, 0, 0);
    await builder.connect(feedback, comp, 0, 1);
    // feedbackTOP needs an input for its first frame; seed it before the loop closes.
    await builder.connect(seed, feedback);

    let last = comp;
    for (const transformation of args.transformations) {
      const node = await builder.add(TRANSFORM_TYPES[transformation], transformation);
      await builder.connect(last, node);
      // displaceTOP and lumablurTOP need a second input (the displacement / luma map).
      if (transformation === "displace" || transformation === "luma_blur") {
        await builder.connect(seed, node, 0, 1);
      }
      last = node;
    }

    const gain = await builder.add("levelTOP", "gain");
    await builder.setParams(gain, { gain: args.feedback_gain });
    await builder.connect(last, gain);

    // Colorize only the final output; the loop keeps sampling the grayscale gain node
    // so the feedback stays clean.
    let output = gain;
    if (args.colors && args.colors.length > 0) {
      const colorize = await builder.add("glslTOP", "colorize");
      const frag = await builder.add("textDAT", "colorize_frag");
      await builder.python(
        `op(${q(frag)}).text = ${q(colorizeShader(args.colors))}\nop(${q(colorize)}).par.pixeldat = op(${q(frag)}).name`,
      );
      await builder.connect(gain, colorize);
      output = colorize;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);

    // Close the loop: feedbackTOP samples the gain node's output.
    await builder.python(`op(${q(feedback)}).par.top = op(${q(gain)}).name`);

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

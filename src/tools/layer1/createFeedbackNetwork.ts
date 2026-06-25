import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

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

// A self-contained generative pattern for the "glsl" seed type. A bare glslTOP ships TD's
// boilerplate shader (solid white `vec4(1.0)`), which would feed the loop pure white; this
// gives it a varied colour field to evolve instead.
const SEED_GLSL = `out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    float v = sin(uv.x * 12.0) + sin(uv.y * 12.0) + sin((uv.x + uv.y) * 8.0);
    vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + v);
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

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
  seed_type: z
    .enum(["noise", "shape", "image", "video", "webcam", "glsl"])
    .default("noise")
    .describe(
      "What feeds the loop each frame: 'noise' (monochrome Noise TOP), 'shape' (Circle TOP), 'image'/'video' (Movie File In TOP), 'webcam' (Video Device In TOP — may prompt for camera permission), or 'glsl' (a generative shader). Default 'noise'.",
    ),
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
    .default(["blur", "displace", "level"])
    .describe(
      "TOP effects applied in order inside the loop each frame (blur, displace, edge, level, hsv_adjust, transform, mirror, tile, luma_blur). Default ['blur','displace','level'].",
    ),
  feedback_gain: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.95)
    .describe(
      "Loop decay multiplier (0–1) applied via a Level TOP's brightness1: how much of the fed-back frame survives each cycle. Higher = longer-lived, more saturated trails; default 0.95.",
    ),
  colors: z
    .array(z.string())
    .max(2)
    .optional()
    .describe(
      "Up to two hex colors ('#rrggbb') used to colorize the otherwise-grayscale output via a final GLSL gradient (one color = black→color, two = color0→color1). Omit to leave it grayscale.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose a live 'Feedback' knob on the system container, bound to the loop's decay.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the feedback container is created (default '/project1')."),
});
type CreateFeedbackNetworkArgs = z.infer<typeof createFeedbackNetworkSchema>;

export async function createFeedbackNetworkImpl(ctx: ToolContext, args: CreateFeedbackNetworkArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "feedback_system");

    const seed = await builder.add(SEED_TYPES[args.seed_type], "seed", {
      ...(args.seed_type === "noise" ? { monochrome: 1, period: 4 } : {}),
    });
    if (args.seed_type === "glsl") {
      // Replace the glslTOP's default white boilerplate with a real generative pattern.
      const seedFrag = await builder.add("textDAT", "seed_frag");
      await builder.python(
        `op(${q(seedFrag)}).text = ${q(SEED_GLSL)}\nop(${q(seed)}).par.pixeldat = op(${q(seedFrag)}).name`,
      );
    }
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
    // A levelTOP has no "gain" parameter (setting it is a silent no-op), so the loop never
    // decayed and the "maximum" composite saturated to solid white. "brightness1" multiplies
    // RGB, so set it to feedback_gain to actually fade the fed-back frame each cycle.
    await builder.setParams(gain, { brightness1: args.feedback_gain });
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

    // The decay multiplier (gain.brightness1) is the one knob a feedback system lives by.
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Feedback",
            type: "float",
            min: 0,
            max: 1,
            default: args.feedback_gain,
            bind_to: [`${gain}.brightness1`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a feedback network (seed: ${args.seed_type}, gain: ${args.feedback_gain}, ${args.transformations.length} transform(s)).`,
      builder,
      outputPath: out,
      controls,
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
        "Build a feedback-based visual system: a seed feeds a loop that is transformed (blur/displace/etc.) and fed back each frame. Creates a new baseCOMP under `parent_path` holding the seed, a Feedback TOP, a 'maximum' Composite, the transform chain, a Level decay node, an optional GLSL colorize pass, and a Null output (the Feedback TOP samples the Level node to close the loop). Great for evolving, hypnotic visuals. Exposes a live 'Feedback' decay knob. Returns a summary plus a JSON block with the container path, created node paths, the output path, exposed controls, any node errors, warnings, and an inline preview image. Use this for a general feedback look with a chosen seed type and an ordered chain of effects; for the specific infinite-zoom/rotate spiral (with Zoom/Rotate/HueShift/Decay knobs) use create_feedback_tunnel instead.",
      inputSchema: createFeedbackNetworkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createFeedbackNetworkImpl(ctx, args),
  );
};

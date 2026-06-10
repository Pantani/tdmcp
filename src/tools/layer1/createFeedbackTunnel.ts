import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const createFeedbackTunnelSchema = z.object({
  name: z.string().default("feedback_tunnel"),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path inside which the 'feedback_tunnel' container is created."),
  source: z
    .string()
    .optional()
    .describe(
      "Path to an existing TOP to use as the tunnel seed. Omit to generate a built-in animated noise seed.",
    ),
  zoom: z.coerce
    .number()
    .default(1.02)
    .describe(
      "Per-frame zoom factor applied to the fed-back frame (>1 = inward tunnel, e.g. 1.02).",
    ),
  rotate: z.coerce
    .number()
    .default(2)
    .describe("Per-frame rotation in degrees added to the fed-back frame (positive = clockwise)."),
  hue_shift: z.coerce
    .number()
    .default(0.0)
    .describe(
      "Per-frame hue rotation (0–1, wrapping). Applied via levelTOP huerotate. 0 = no shift.",
    ),
  decay: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.95)
    .describe(
      "Trail persistence (0–1). Applied via levelTOP brightness1 each frame. Higher = longer-lived tunnel; default 0.95.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe(
      "Output resolution [width, height] in pixels. Fixed resolution prevents feedback runaway.",
    ),
});

type CreateFeedbackTunnelArgs = z.infer<typeof createFeedbackTunnelSchema>;

export async function createFeedbackTunnelImpl(
  ctx: ToolContext,
  args: CreateFeedbackTunnelArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const [resW, resH] = args.resolution;

    // Seed: user-supplied external TOP or a built-in animated noise source.
    // The noise seed uses "monochrome: 1" (confirmed in createFeedbackNetwork.ts and
    // feedback_tunnel.json recipe; "mono" is an alias documented in performable_feedback_tunnel
    // but the canonical parameter the code uses is "monochrome").
    let seedPath: string;
    if (args.source) {
      // Wire a Select TOP so we can reference an external node inside this container.
      seedPath = await builder.add("selectTOP", "seed", { top: args.source });
    } else {
      seedPath = await builder.add("noiseTOP", "seed", {
        monochrome: 1,
        period: 3,
        // Force resolution on the seed so the loop has a fixed frame from frame 0.
        resolutionw: resW,
        resolutionh: resH,
      });
    }

    // feedbackTOP: holds the previous frame. CRITICAL: must have a wired input so it has
    // something to output on frame 0 (without it the loop starts blank and never recovers).
    const feedbackPath = await builder.add("feedbackTOP", "feedback1");

    // Composite: blend seed with fed-back frame. "maximum" operand keeps brightness bounded
    // under the decay (the default "multiply" collapses the loop to black).
    const compPath = await builder.add("compositeTOP", "comp1");
    await builder.setParams(compPath, { operand: "maximum" });
    await builder.connect(seedPath, compPath, 0, 0);
    await builder.connect(feedbackPath, compPath, 0, 1);

    // Wire seed → feedbackTOP as its first-frame input (closed by par.top below).
    await builder.connect(seedPath, feedbackPath);

    // Transform: zoom + rotate the fed-back composite each frame to create tunnel motion.
    // transformTOP uses "sx"/"sy" for scale and "rotate" for degrees — NOT "scalex"/"scaley"
    // (verified against both recipe JSONs and noted in performable_feedback_tunnel comments).
    const transformPath = await builder.add("transformTOP", "transform1", {
      sx: args.zoom,
      sy: args.zoom,
      rotate: args.rotate,
      // Force resolution so the transform doesn't reset size after compositing.
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(compPath, transformPath);

    // Optional blur smooths the tunnel edges.
    const blurPath = await builder.add("blurTOP", "blur1", { size: 2 });
    await builder.connect(transformPath, blurPath);

    // Level: controls decay and optional hue shift.
    // "brightness1" multiplies RGB each frame (levelTOP has NO "gain" parameter —
    // confirmed in createFeedbackNetwork.ts comment + recipe).
    // "huerotate" shifts hue; 0 = no shift.
    const levelPath = await builder.add("levelTOP", "level1", {
      brightness1: args.decay,
      huerotate: args.hue_shift,
    });
    await builder.connect(blurPath, levelPath);

    // Output null.
    const outPath = await builder.add("nullTOP", "out1");
    await builder.connect(levelPath, outPath);

    // Close the loop: feedbackTOP samples the level node's output each frame.
    // This must be done via Python after both nodes exist (par.top takes the node name).
    await builder.python(`op(${q(feedbackPath)}).par.top = op(${q(levelPath)}).name`);

    // Expose the four performance-ready knobs: Zoom, Rotate, HueShift, Decay.
    // bind_to uses "node_path.param" strings resolved to real paths.
    const controls: ControlSpec[] = [
      {
        name: "Zoom",
        type: "float",
        min: 1.0,
        max: 1.2,
        default: args.zoom,
        bind_to: [`${transformPath}.sx`, `${transformPath}.sy`],
      },
      {
        name: "Rotate",
        type: "float",
        min: -10,
        max: 10,
        default: args.rotate,
        bind_to: [`${transformPath}.rotate`],
      },
      {
        name: "HueShift",
        type: "float",
        min: 0,
        max: 1,
        default: args.hue_shift,
        bind_to: [`${levelPath}.huerotate`],
      },
      {
        name: "Decay",
        type: "float",
        min: 0,
        max: 1,
        default: args.decay,
        bind_to: [`${levelPath}.brightness1`],
      },
    ];

    const summary = args.source
      ? `Created a feedback tunnel (source: ${args.source}, zoom: ${args.zoom}, rotate: ${args.rotate} deg/frame, decay: ${args.decay}).`
      : `Created a feedback tunnel (built-in noise seed, zoom: ${args.zoom}, rotate: ${args.rotate} deg/frame, decay: ${args.decay}).`;

    return finalize(ctx, {
      summary,
      builder,
      outputPath: outPath,
      controls,
      extra: {
        zoom: args.zoom,
        rotate: args.rotate,
        hue_shift: args.hue_shift,
        decay: args.decay,
        resolution: args.resolution,
        source: args.source ?? "noise (built-in)",
        live_preview_verified: false,
        note: "transformTOP scale uses sx/sy; levelTOP decay uses brightness1; feedbackTOP loop closed via par.top. TD offline at build time — live-preview UNVERIFIED.",
      },
    });
  });
}

export const registerCreateFeedbackTunnel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_feedback_tunnel",
    {
      title: "Create feedback tunnel",
      description:
        "Build a parameterized infinite-zoom/rotate feedback tunnel: a seed TOP is composited with its own fed-back, zoomed, rotated, and decayed frame each cook to produce a hypnotic inward-spiral tunnel. Four audio-bind-ready controls (Zoom, Rotate, HueShift, Decay) are exposed on the container for live performance. A built-in animated noise seed is used when no `source` TOP is given. The recipe-validated topology (noiseTOP → feedbackTOP + compositeTOP-maximum → transformTOP sx/sy → blurTOP → levelTOP brightness1/huerotate → nullTOP, loop closed by feedbackTOP.par.top) is created inside a new baseCOMP under `parent_path`. Returns a summary, the container + node paths, exposed controls, any node errors, and an inline preview image.",
      inputSchema: createFeedbackTunnelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createFeedbackTunnelImpl(ctx, args),
  );
};

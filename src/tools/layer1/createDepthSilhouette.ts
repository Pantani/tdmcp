import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { hexToRgb } from "../util/color.js";
import { addExternalSensorLocalStatusSurface } from "./externalSensorStatusSurface.js";

const q = (value: string): string => JSON.stringify(value);
const DEPTH_SILHOUETTE_STATUS_STORE_KEY = "tdmcp_depth_silhouette_status";

/**
 * Depth/IR capture devices whose TOPs were confirmed to exist in this build's knowledge base
 * (kinect_azure_top → kinectazureTOP, kinect_top → kinectTOP, realsense_top → realsenseTOP).
 * Selecting one of these creates the live sensor op, which on macOS may pop a one-time
 * camera/depth permission modal that can hang TD until the artist clicks Allow — so none of
 * these is the default. The exact per-device parameter names (which feed depth vs. colour, the
 * player/body index, etc.) still need live confirmation; we create the op with defaults and let
 * the threshold chain isolate the body from whatever single-channel signal it emits.
 */
const DEPTH_DEVICE_OPS: Record<string, string> = {
  kinect_azure: "kinectazureTOP",
  kinect: "kinectTOP",
  realsense: "realsenseTOP",
};

export const createDepthSilhouetteSchema = z.object({
  source: z
    .enum(["synthetic", "file", "kinect_azure", "kinect", "realsense"])
    .default("synthetic")
    .describe(
      "Where the depth/luma signal comes from. 'synthetic' (the default) = a self-contained animated noise/ramp field that needs ZERO device permissions, so the network builds and previews immediately — use it to dial in the look. 'file' = a movie/image file (source_file_path). 'kinect_azure' | 'kinect' | 'realsense' = a live depth/IR sensor (the real installation source); creating it may pop a one-time macOS camera/depth-permission dialog — click Allow. (The depth-device op names are confirmed to exist; their per-device params still need live confirmation.)",
    ),
  source_file_path: z
    .string()
    .optional()
    .describe(
      "Movie/image file path for source='file' (e.g. a pre-recorded depth or IR clip). Ignored for other sources.",
    ),
  threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "Depth/luma cutoff (0..1) that separates the body from the background: pixels brighter than this become the white silhouette, the rest go black. The headline 'Threshold' knob and the parameter to bind to audio/beat/proximity later.",
    ),
  smooth: z.coerce
    .number()
    .min(0)
    .default(0.5)
    .describe(
      "Edge smoothing — a Blur TOP filter size applied to the raw mask to round off jagged sensor edges before the silhouette is keyed. 0 = hard, aliased edges; higher = softer outline.",
    ),
  invert: z
    .boolean()
    .default(false)
    .describe(
      "Invert the mask (swap silhouette and background). Off = white body on black; on = black body on white. Drives a Level TOP's invert.",
    ),
  fill_color: z
    .string()
    .optional()
    .describe(
      "Optional hex colour ('#rrggbb') to fill the silhouette with instead of plain white — keyed through the mask via a Constant TOP composited (multiply) against it. Omit for a white-on-black mask.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live Threshold / Smooth / Invert (+ FillColor) controls on the system container.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the silhouette container is created (default '/project1')."),
});
type CreateDepthSilhouetteArgs = z.infer<typeof createDepthSilhouetteSchema>;

/**
 * The single-channel source the silhouette is keyed from. The default 'synthetic' source is a
 * self-contained animated monochrome noise field — no device, no permissions — that gives the
 * threshold something with bright/dark structure to isolate (mimicking a near/far depth signal),
 * and a slow drift so the preview is alive. 'file' brings in a movie/image via a Movie File In
 * TOP. The depth-device kinds create the confirmed sensor op directly (live, permission-gated).
 */
async function buildSource(
  builder: NetworkBuilder,
  args: CreateDepthSilhouetteArgs,
): Promise<string> {
  if (args.source === "file") {
    return builder.add("moviefileinTOP", "source", {
      ...(args.source_file_path ? { file: args.source_file_path } : {}),
      play: 1,
    });
  }
  const deviceOp = DEPTH_DEVICE_OPS[args.source];
  if (deviceOp) {
    // Live sensor — created with defaults; the threshold chain isolates the body from whatever
    // single-channel (depth/IR/player-index) signal it emits. May prompt for macOS permission.
    return builder.add(deviceOp, "source");
  }
  // Monochrome noise = a device-free stand-in for a depth/IR feed: bright blobs read as
  // "near" (the body) against a darker field, so the threshold isolates a moving silhouette.
  const src = await builder.add("noiseTOP", "source", { monochrome: 1, period: 3 });
  await builder.python(
    `_p = op(${q(src)}).par.tz\n_PM = type(_p.mode)\n_p.expr = ${q("absTime.seconds * 0.15")}\n_p.mode = _PM.EXPRESSION`,
  );
  return src;
}

export async function createDepthSilhouetteImpl(ctx: ToolContext, args: CreateDepthSilhouetteArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "depth_silhouette");

    const source = await buildSource(builder, args);

    // Smooth the raw signal first so the keyed edge is clean rather than per-pixel noisy.
    // blurTOP size is the filter width (0 = no blur). Smooth maps straight to it.
    const blur = await builder.add("blurTOP", "smooth", { size: args.smooth });
    await builder.connect(source, blur);

    // Key the body out of the (smoothed) signal: a Threshold TOP emits white where the input is
    // brighter than `threshold`, black elsewhere — the silhouette mask. comparator='greater'
    // makes "near/bright = body"; soften gives the mask edge a little feather. This is the
    // headline knob (Threshold) and the bind target for reactive proximity.
    const mask = await builder.add("thresholdTOP", "mask", {
      threshold: args.threshold,
      comparator: "greater",
      soften: 0.05,
    });
    await builder.connect(blur, mask);

    // Optional invert (swap body/background). levelTOP's `invert` (0/1) flips black<->white;
    // it sits in the chain always so the Invert toggle can drive it live regardless of the
    // build-time default. brightness1=1 keeps it a clean pass-through otherwise.
    const level = await builder.add("levelTOP", "invert", {
      invert: args.invert ? 1 : 0,
      brightness1: 1,
    });
    await builder.connect(mask, level);

    // Optional coloured fill: a flat Constant TOP keyed THROUGH the mask via a multiply
    // composite (input 0 = colour, input 1 = mask → colour survives only where the mask is
    // white). Without a fill_color the white-on-black mask itself is the output.
    let output = level;
    let fillRgb: { r: number; g: number; b: number } | undefined;
    if (args.fill_color) {
      fillRgb = hexToRgb(args.fill_color, { r: 1, g: 1, b: 1 }, { shorthand: true });
      const fill = await builder.add("constantTOP", "fill", {
        colorr: fillRgb.r,
        colorg: fillRgb.g,
        colorb: fillRgb.b,
        alpha: 1,
      });
      const keyed = await builder.add("compositeTOP", "keyed", { operand: "multiply" });
      await builder.connect(fill, keyed, 0, 0);
      await builder.connect(level, keyed, 0, 1);
      output = keyed;
    }

    // Null = the stable output bind point (other tools/composites reference op('…/out1')).
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);
    const statusSurface = await addExternalSensorLocalStatusSurface(builder, {
      channelPrefix: "depth_source",
      outputPath: out,
      sourceKind: args.source,
      sourcePath: source,
      storeKey: DEPTH_SILHOUETTE_STATUS_STORE_KEY,
    });

    // Threshold is the headline knob; Smooth the blur size; Invert toggles the level invert.
    // FillColor is an RGB swatch (the ControlSpec 'rgb' type does not support bind_to, so it
    // is a convenience display of the build-time fill — only shown when a fill was set).
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Threshold",
            type: "float",
            min: 0,
            max: 1,
            default: args.threshold,
            bind_to: [`${mask}.threshold`],
          },
          {
            name: "Smooth",
            type: "float",
            min: 0,
            max: 32,
            default: args.smooth,
            bind_to: [`${blur}.size`],
          },
          {
            name: "Invert",
            type: "toggle",
            default: args.invert,
            bind_to: [`${level}.invert`],
          },
          ...(fillRgb
            ? [
                {
                  name: "FillColor",
                  type: "rgb" as const,
                  default: args.fill_color,
                },
              ]
            : []),
        ]
      : [];

    const sourceLabel =
      args.source === "synthetic"
        ? "device-free synthetic noise"
        : args.source === "file"
          ? `file ${args.source_file_path ?? "(unset)"}`
          : `${args.source} sensor`;

    return finalize(ctx, {
      summary: `Built a depth silhouette / body mask (source: ${sourceLabel}, threshold ${args.threshold}) → ${out}. White silhouette on black${
        args.fill_color ? ` filled ${args.fill_color}` : ""
      }${args.invert ? " (inverted)" : ""}. Bind op('${mask}').par.threshold to proximity/audio to make it react, or use ${out} as a mask for other visuals. Source diagnostics are exposed at source_status and source_status_chop.`,
      builder,
      outputPath: out,
      // Output is a TOP (the Null), so a preview image is captured.
      capturePreviewImage: true,
      controls,
      extra: {
        source: args.source,
        source_file_path: args.source_file_path,
        threshold: args.threshold,
        smooth: args.smooth,
        invert: args.invert,
        fill_color: args.fill_color,
        mask_path: mask,
        output_path: out,
        source_status_chop: statusSurface.statusChop,
        source_status_dat: statusSurface.statusDat,
        source_status_driver: statusSurface.statusDriver,
      },
    });
  });
}

export const registerCreateDepthSilhouette: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_depth_silhouette",
    {
      title: "Create depth silhouette",
      description:
        "Extract a silhouette / body mask from a depth or video source — a person's white outline on black you can composite, fill with colour, or use as a mask for reactive visuals (interactive installations / camera-reactive sets). The signal is smoothed (Blur TOP), keyed to a mask (Threshold TOP), optionally inverted (Level TOP) and optionally filled with a colour keyed through the mask (Constant + multiply Composite). Creates a new baseCOMP under `parent_path` holding the source, Blur, Threshold, Level, optional Constant + Composite fill, and a Null output. Source defaults to a self-contained synthetic noise field so it builds and previews with ZERO device permissions; pick 'file' for a clip, or a 'kinect_azure'/'kinect'/'realsense' sensor for the live installation (may prompt for macOS permission). Exposes Threshold (bind to proximity/audio), Smooth, Invert (+ FillColor) and outputs a Null TOP. Use create_depth_displacement instead for true 3D relief geometry rather than a flat 2D mask. Returns a summary plus a JSON block with the container path, created node paths, the mask/output paths, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createDepthSilhouetteSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDepthSilhouetteImpl(ctx, args),
  );
};

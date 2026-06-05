import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const DEBUG_VIEWS = [
  "final",
  "camera",
  "analysis",
  "motion",
  "blobs",
  "calibration",
  "visual",
] as const;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const createInteractiveProjectionMappingBaseSchema = z.object({
  name: z
    .string()
    .default("interactive_projection_mapping")
    .describe("Name for the generated interactive projection mapping Base COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP where the interactive projection mapping system is created."),
  source: z
    .enum(["camera", "synthetic", "existing_top"])
    .default("camera")
    .describe(
      "Input source: a USB camera, a self-animated synthetic TOP, or an existing TOP pulled through a Select TOP.",
    ),
  existing_top_path: z
    .string()
    .optional()
    .describe("Absolute TOP path required when source='existing_top'."),
  camera_index: z.coerce
    .number()
    .int()
    .default(0)
    .describe("USB/webcam device index used when source='camera'."),
  fallback_to_synthetic: z
    .boolean()
    .default(true)
    .describe("If camera creation fails, build a synthetic source so the rig remains previewable."),
  interaction_mode: z
    .enum(["hybrid", "motion_only", "blob_markers"])
    .default("hybrid")
    .describe("Interaction branch to prioritize. The first slice always keeps motion available."),
  analysis_resolution: z.coerce
    .number()
    .int()
    .min(64)
    .max(2048)
    .default(256)
    .describe("Square working resolution for cheap motion/blob analysis."),
  output_width: z.coerce
    .number()
    .int()
    .min(64)
    .max(8192)
    .default(1280)
    .describe("Projection output width in pixels."),
  output_height: z.coerce
    .number()
    .int()
    .min(64)
    .max(8192)
    .default(720)
    .describe("Projection output height in pixels."),
  particle_count: z.coerce
    .number()
    .int()
    .min(1)
    .max(2048)
    .default(64)
    .describe("Target count for the cyan dot field. This MVP uses it as visual density metadata."),
  card_count: z.coerce
    .number()
    .int()
    .min(0)
    .max(128)
    .default(5)
    .describe("Target count for magenta card blocks. This MVP uses it as visual density metadata."),
  motion_sensitivity: z.coerce
    .number()
    .min(0)
    .max(16)
    .default(4.0)
    .describe("Gain over the frame-difference motion field."),
  repel_radius: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.18)
    .describe("Normalized radius metadata for hand/motion repulsion."),
  trail_decay: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.88)
    .describe("Feedback persistence for visual trails."),
  blob_threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.55)
    .describe("Threshold used by the placeholder blob/post-it mask branch."),
  max_blobs: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(8)
    .describe("Maximum blob slots reserved for the later marker-tracking branch."),
  dot_color: z.string().regex(HEX_COLOR).default("#8ff4f2").describe("Cyan dot color as #rrggbb."),
  card_color: z
    .string()
    .regex(HEX_COLOR)
    .default("#ff2f9a")
    .describe("Magenta card color as #rrggbb."),
  background_color: z
    .string()
    .regex(HEX_COLOR)
    .default("#05100e")
    .describe("Dark projected background color as #rrggbb."),
  projection_brightness: z.coerce
    .number()
    .min(0)
    .max(2)
    .default(0.85)
    .describe("Final Level TOP brightness before out1."),
  debug_view: z
    .enum(DEBUG_VIEWS)
    .default("final")
    .describe("Which branch the debug switch shows initially."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live controls for calibration/debug/performance tuning."),
});

export const createInteractiveProjectionMappingSchema =
  createInteractiveProjectionMappingBaseSchema.superRefine((args, ctx) => {
    if (args.source === "existing_top" && !args.existing_top_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["existing_top_path"],
        message: "existing_top_path is required when source='existing_top'.",
      });
    }
  });

type CreateInteractiveProjectionMappingArgs = z.infer<
  typeof createInteractiveProjectionMappingSchema
>;

const debugViewIndex = (view: (typeof DEBUG_VIEWS)[number]): number => DEBUG_VIEWS.indexOf(view);

const q = (value: string): string => JSON.stringify(value);

function motionBlurSize(repelRadius: number): number {
  return Math.max(1, Math.min(8, Math.round(repelRadius * 16)));
}

function topColor(hex: string): Record<string, number> {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    colorr: ((value >> 16) & 255) / 255,
    colorg: ((value >> 8) & 255) / 255,
    colorb: (value & 255) / 255,
    alpha: 1,
  };
}

async function buildSyntheticSource(
  builder: NetworkBuilder,
  args: CreateInteractiveProjectionMappingArgs,
): Promise<string> {
  const source = await builder.add("noiseTOP", "camera_in", {
    resolutionw: args.analysis_resolution,
    resolutionh: args.analysis_resolution,
  });
  await builder.python(
    `op(${q(source)}).par.tz.expr = "absTime.seconds * 2"\nop(${q(source)}).par.tx.expr = "absTime.seconds * 0.35"`,
  );
  return source;
}

async function buildSource(
  builder: NetworkBuilder,
  args: CreateInteractiveProjectionMappingArgs,
): Promise<string> {
  if (args.source === "existing_top") {
    if (!args.existing_top_path) throw new Error("existing_top_path is required.");
    return builder.add("selectTOP", "camera_in", {
      top: args.existing_top_path,
      resolutionw: args.analysis_resolution,
      resolutionh: args.analysis_resolution,
    });
  }

  if (args.source === "synthetic") return buildSyntheticSource(builder, args);

  try {
    const source = await builder.add("videodeviceinTOP", "camera_in", {
      device: args.camera_index,
      resolutionw: args.analysis_resolution,
      resolutionh: args.analysis_resolution,
    });
    builder.warnings.push(
      "Camera source requested; USB device selection, macOS permission, and live frame availability are UNVERIFIED until opened in TouchDesigner.",
    );
    return source;
  } catch (err) {
    if (!args.fallback_to_synthetic) throw err;
    builder.warnings.push(
      `Camera source could not be created; fallback_to_synthetic=true built a synthetic source instead (${String(
        err,
      )}).`,
    );
    return buildSyntheticSource(builder, args);
  }
}

function controlsFor(
  args: CreateInteractiveProjectionMappingArgs,
  paths: {
    motionGain: string;
    trailDecay: string;
    blobMask: string;
    projectionBrightness: string;
  },
): ControlSpec[] {
  if (!args.expose_controls) return [];
  return [
    {
      name: "Sensitivity",
      type: "float",
      min: 0,
      max: 8,
      default: args.motion_sensitivity,
      bind_to: [`${paths.motionGain}.brightness1`],
    },
    {
      name: "TrailDecay",
      type: "float",
      min: 0,
      max: 1,
      default: args.trail_decay,
      bind_to: [`${paths.trailDecay}.opacity`],
    },
    {
      name: "BlobThreshold",
      type: "float",
      min: 0,
      max: 1,
      default: args.blob_threshold,
      bind_to: [`${paths.blobMask}.threshold`],
    },
    {
      name: "ProjectionBrightness",
      type: "float",
      min: 0,
      max: 1.5,
      default: args.projection_brightness,
      bind_to: [`${paths.projectionBrightness}.brightness1`],
    },
    {
      name: "Calibration",
      type: "toggle",
      default: args.debug_view === "calibration",
      bind_to: [],
    },
    {
      name: "DebugView",
      type: "menu",
      default: args.debug_view,
      menu_items: [...DEBUG_VIEWS],
      bind_to: [],
    },
  ];
}

export async function createInteractiveProjectionMappingImpl(
  ctx: ToolContext,
  args: CreateInteractiveProjectionMappingArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const source = await buildSource(builder, args);

    if (args.source === "synthetic") {
      builder.warnings.push(
        "Synthetic source active; USB camera input, camera permission, and projector/camera alignment are UNVERIFIED.",
      );
    }
    if (args.interaction_mode !== "motion_only") {
      builder.warnings.push(
        "Blob/post-it tracking is represented by a threshold mask in this first slice; stable blob IDs/channels remain a follow-up.",
      );
    }
    if (args.interaction_mode === "blob_markers") {
      builder.warnings.push(
        "interaction_mode='blob_markers' requested, but this isolated slice keeps the motion branch active so the rig remains playable.",
      );
    }
    builder.warnings.push(
      "Calibration corners are defaults; physical projection alignment must be adjusted on the real projector surface.",
    );

    const analysisParams = {
      resolutionw: args.analysis_resolution,
      resolutionh: args.analysis_resolution,
    };
    const outputParams = {
      resolutionw: args.output_width,
      resolutionh: args.output_height,
    };

    const cameraDebug = await builder.add("nullTOP", "camera_debug", analysisParams);
    await builder.connect(source, cameraDebug);

    const cameraFit = await builder.add("fitTOP", "camera_fit", analysisParams);
    await builder.connect(source, cameraFit);

    const analysisPlane = await builder.add("monochromeTOP", "analysis_plane", analysisParams);
    await builder.connect(cameraFit, analysisPlane);

    const analysisDebug = await builder.add("nullTOP", "analysis_debug", analysisParams);
    await builder.connect(analysisPlane, analysisDebug);

    const motionBlur = await builder.add("blurTOP", "motion_pre_blur", {
      ...analysisParams,
      size: 2,
    });
    await builder.connect(analysisPlane, motionBlur);

    const previousFrame = await builder.add("cacheTOP", "motion_prev", {
      ...analysisParams,
      active: 1,
      cachesize: 2,
      replaceindex: 0,
      outputindexunit: "indices",
      outputindex: -1,
    });
    await builder.connect(motionBlur, previousFrame);
    await builder.python(
      `_c = op(${q(previousFrame)})\nfor _a, _v in [('cachesize', 2), ('size', 2)]:\n    try:\n        setattr(_c.par, _a, _v)\n        break\n    except Exception:\n        pass\nfor _a, _v in [('replaceindex', 0), ('replaceat', 0)]:\n    try:\n        setattr(_c.par, _a, _v)\n        break\n    except Exception:\n        pass\nfor _a, _v in [('outputindex', -1), ('outputat', -1)]:\n    try:\n        setattr(_c.par, _a, _v)\n        break\n    except Exception:\n        pass`,
    );

    const motionDelta = await builder.add("differenceTOP", "motion_delta", analysisParams);
    await builder.connect(motionBlur, motionDelta, 0, 0);
    await builder.connect(previousFrame, motionDelta, 0, 1);

    const motionField = await builder.add("blurTOP", "motion_field", {
      ...analysisParams,
      size: motionBlurSize(args.repel_radius),
    });
    await builder.connect(motionDelta, motionField);

    const motionGain = await builder.add("levelTOP", "motion_gain", {
      ...analysisParams,
      brightness1: args.motion_sensitivity,
    });
    await builder.connect(motionField, motionGain);

    const presenceEdges = await builder.add("edgeTOP", "presence_edges", {
      ...analysisParams,
      strength: 1,
    });
    await builder.connect(analysisPlane, presenceEdges);

    const presenceMask = await builder.add("thresholdTOP", "presence_mask", {
      ...analysisParams,
      threshold: 0.12,
    });
    await builder.connect(presenceEdges, presenceMask);

    const presenceField = await builder.add("blurTOP", "presence_field", {
      ...analysisParams,
      size: Math.max(2, motionBlurSize(args.repel_radius)),
    });
    await builder.connect(presenceMask, presenceField);

    const presenceGain = await builder.add("levelTOP", "presence_gain", {
      ...analysisParams,
      brightness1: 0.25,
    });
    await builder.connect(presenceField, presenceGain);

    const interactionField = await builder.add("compositeTOP", "interaction_field", {
      ...analysisParams,
      operand: "maximum",
    });
    await builder.connect(motionGain, interactionField, 0, 0);
    await builder.connect(presenceGain, interactionField, 0, 1);

    const motionHoldFeedback = await builder.add("feedbackTOP", "motion_hold_feedback", {
      ...analysisParams,
    });
    await builder.connect(interactionField, motionHoldFeedback);

    const motionHoldDecay = await builder.add("levelTOP", "motion_hold_decay", {
      ...analysisParams,
      brightness1: 0.92,
      opacity: 0.92,
    });
    await builder.connect(motionHoldFeedback, motionHoldDecay);

    const motionHoldMix = await builder.add("compositeTOP", "motion_hold_mix", {
      ...analysisParams,
      operand: "maximum",
    });
    await builder.connect(motionHoldDecay, motionHoldMix, 0, 0);
    await builder.connect(interactionField, motionHoldMix, 0, 1);
    await builder.python(
      `_fb = op(${q(motionHoldFeedback)})\ntry:\n    _fb.par.top = ${q(motionHoldMix)}\nexcept Exception:\n    pass`,
    );

    const motionDebug = await builder.add("nullTOP", "motion_debug", analysisParams);
    await builder.connect(motionHoldMix, motionDebug);

    const motionCooker = await builder.add("executeDAT", "motion_cooker");
    await builder.python(
      `_c = op(${q(motionCooker)})\n_c.text = "def onFrameStart(frame):\\n\\tparent().op('motion_debug').cook(force=True)\\n\\treturn\\n"\n_c.par.framestart = True\n_c.par.active = True`,
    );

    const blobMask = await builder.add("thresholdTOP", "blob_mask", {
      ...analysisParams,
      threshold: args.blob_threshold,
    });
    await builder.connect(analysisPlane, blobMask);

    const blobDebug = await builder.add("nullTOP", "blob_debug", analysisParams);
    await builder.connect(blobMask, blobDebug);

    const background = await builder.add("constantTOP", "background", {
      ...outputParams,
      ...topColor(args.background_color),
    });
    const dotSeed = await builder.add("noiseTOP", "dot_seed", {
      ...outputParams,
      period: Math.max(1, Math.round(args.particle_count / 8)),
    });
    await builder.python(
      `op(${q(dotSeed)}).par.tz.expr = "absTime.seconds * 0.12"\nop(${q(dotSeed)}).par.tx.expr = "absTime.seconds * 0.03"`,
    );
    const dotMask = await builder.add("thresholdTOP", "cyan_dot_mask", {
      ...outputParams,
      threshold: 0.82,
    });
    await builder.connect(dotSeed, dotMask);
    const dotTint = await builder.add("constantTOP", "cyan_dot_tint", {
      ...outputParams,
      ...topColor(args.dot_color),
    });
    const dots = await builder.add("compositeTOP", "cyan_dots", {
      ...outputParams,
      operand: "multiply",
    });
    await builder.connect(dotMask, dots, 0, 0);
    await builder.connect(dotTint, dots, 0, 1);

    const cardSeed = await builder.add("noiseTOP", "card_seed", {
      ...outputParams,
      period: Math.max(1, args.card_count),
    });
    await builder.python(
      `op(${q(cardSeed)}).par.tx.expr = "absTime.seconds * -0.015"\nop(${q(cardSeed)}).par.ty.expr = "absTime.seconds * 0.02"`,
    );
    const cardMask = await builder.add("thresholdTOP", "card_mask", {
      ...outputParams,
      threshold: 0.74,
    });
    await builder.connect(cardSeed, cardMask);
    const cardTint = await builder.add("constantTOP", "card_tint", {
      ...outputParams,
      ...topColor(args.card_color),
    });
    const cards = await builder.add("compositeTOP", "magenta_cards", {
      ...outputParams,
      operand: "multiply",
    });
    await builder.connect(cardMask, cards, 0, 0);
    await builder.connect(cardTint, cards, 0, 1);

    const motionFit = await builder.add("fitTOP", "motion_field_fit", outputParams);
    await builder.connect(motionDebug, motionFit);

    const baseVisual = await builder.add("compositeTOP", "visual_base", {
      ...outputParams,
      operand: "add",
    });
    await builder.connect(background, baseVisual, 0, 0);
    await builder.connect(dots, baseVisual, 0, 1);
    await builder.connect(cards, baseVisual, 0, 2);
    await builder.connect(motionFit, baseVisual, 0, 3);

    const trailFeedback = await builder.add("feedbackTOP", "trail_feedback", outputParams);
    await builder.connect(baseVisual, trailFeedback);
    const trailDecay = await builder.add("levelTOP", "trail_decay", {
      ...outputParams,
      opacity: args.trail_decay,
    });
    await builder.connect(trailFeedback, trailDecay);

    const visualWithTrails = await builder.add("compositeTOP", "visual_with_trails", {
      ...outputParams,
      operand: "add",
    });
    await builder.connect(baseVisual, visualWithTrails, 0, 0);
    await builder.connect(trailDecay, visualWithTrails, 0, 1);
    await builder.python(
      `_fb = op(${q(trailFeedback)})\ntry:\n    _fb.par.top = ${q(visualWithTrails)}\nexcept Exception:\n    pass`,
    );

    const visualOut = await builder.add("nullTOP", "visual_out", outputParams);
    await builder.connect(visualWithTrails, visualOut);

    const projectionMap = await builder.add("cornerpinTOP", "projection_map", {
      ...outputParams,
      extend: "hold",
    });
    await builder.connect(visualOut, projectionMap);

    const mappedOut = await builder.add("nullTOP", "mapped_out", outputParams);
    await builder.connect(projectionMap, mappedOut);

    const calibrationGrid = await builder.add("rampTOP", "calibration_grid", {
      ...outputParams,
      type: "radial",
    });

    const debugSwitch = await builder.add("switchTOP", "debug_switch", {
      ...outputParams,
      index: debugViewIndex(args.debug_view),
    });
    await builder.connect(mappedOut, debugSwitch, 0, 0);
    await builder.connect(cameraDebug, debugSwitch, 0, 1);
    await builder.connect(analysisDebug, debugSwitch, 0, 2);
    await builder.connect(motionDebug, debugSwitch, 0, 3);
    await builder.connect(blobDebug, debugSwitch, 0, 4);
    await builder.connect(calibrationGrid, debugSwitch, 0, 5);
    await builder.connect(visualOut, debugSwitch, 0, 6);

    const projectionBrightness = await builder.add("levelTOP", "projection_brightness", {
      ...outputParams,
      brightness1: args.projection_brightness,
    });
    await builder.connect(debugSwitch, projectionBrightness);

    const out = await builder.add("nullTOP", "out1", outputParams);
    await builder.connect(projectionBrightness, out);

    const controls = controlsFor(args, {
      motionGain,
      trailDecay,
      blobMask,
      projectionBrightness,
    });

    return finalize(ctx, {
      summary: `Built an interactive projection mapping MVP (${args.source}, ${args.interaction_mode}) with frame-difference motion, placeholder blob mask, projection warp, and output ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        source: args.source,
        interaction_mode: args.interaction_mode,
        output_top_path: out,
        debug_paths: {
          camera: cameraDebug,
          analysis: analysisDebug,
          motion: motionDebug,
          blobs: blobDebug,
          visual: visualOut,
          mapped: mappedOut,
        },
        control_names: controls.map((control) => control.name),
        calibration: {
          status: "uncalibrated",
          projector_mapper: projectionMap,
          calibration_view: calibrationGrid,
        },
        deferred: {
          blob_tracking:
            "Stable blob IDs/channels are deferred to the blob/post-it tracking integration slice.",
          physical_alignment:
            "Preview only verifies a nonblank TOP; projector alignment requires live inspection.",
        },
        visual_defaults: {
          particle_count: args.particle_count,
          card_count: args.card_count,
          dot_color: args.dot_color,
          card_color: args.card_color,
          background_color: args.background_color,
        },
      },
    });
  });
}

export const registerCreateInteractiveProjectionMapping: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_interactive_projection_mapping",
    {
      title: "Create interactive projection mapping",
      description:
        "Build a synthetic-safe interactive projection mapping rig for a USB webcam plus projector: camera/synthetic/existing TOP input, frame-difference motion field, placeholder blob/post-it mask, cyan dot and magenta card visual TOPs, manual Corner Pin projection mapping, debug switch, live controls, and an out1 Null TOP. Defaults to source='camera' for installations, but source='synthetic' previews without camera permission. Returns output/debug paths and explicit warnings for camera, blob tracking, and physical calibration states.",
      inputSchema: createInteractiveProjectionMappingBaseSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      createInteractiveProjectionMappingImpl(
        ctx,
        createInteractiveProjectionMappingSchema.parse(args),
      ),
  );
};

import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";
import {
  buildPoseSource,
  installFrameCooker,
  POSE_CAMERA_TZ,
  poseSourceSchemaFields,
} from "./poseSource.js";

const q = (value: string): string => JSON.stringify(value);

/** Parses '#rrggbb' / 'rrggbb' (3- or 6-digit) into 0..1 RGB. Falls back to magenta. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 1, g: 0.25, b: 0.8 };
  let h = m[1] as string;
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const int = Number.parseInt(h, 16);
  return { r: ((int >> 16) & 0xff) / 255, g: ((int >> 8) & 0xff) / 255, b: (int & 0xff) / 255 };
}

export const createBodyReactiveSchema = z.object({
  ...poseSourceSchemaFields,
  visual_style: z
    .enum(["glow", "points", "trails"])
    .default("glow")
    .describe(
      "Look of the body-reactive visual: 'points' = crisp dots at each landmark; 'glow' = dots with a bloom halo; 'trails' = dots that smear into motion trails as the body moves.",
    ),
  color: z
    .string()
    .default("#ff40cc")
    .describe("Dot colour as hex ('#rrggbb'). Drives the Constant MAT; default is hot magenta."),
  dot_size: z.coerce
    .number()
    .positive()
    .default(0.03)
    .describe("Radius of each landmark dot (world units). Exposed as a live knob."),
  glow_amount: z.coerce
    .number()
    .min(0)
    .default(16)
    .describe("Bloom blur size for visual_style='glow' (Blur TOP size). Exposed as a live knob."),
  trail_decay: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.9)
    .describe(
      "How much of the previous frame survives for visual_style='trails' (feedback opacity). Higher = longer trails. Exposed as a live knob.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live DotSize (+ style-specific Glow/TrailDecay) knobs and a Color swatch.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the body-reactive container is created (default '/project1')."),
});
type CreateBodyReactiveArgs = z.infer<typeof createBodyReactiveSchema>;

export async function createBodyReactiveImpl(ctx: ToolContext, args: CreateBodyReactiveArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "body_reactive");
    const src = await buildPoseSource(builder, args);
    const rgb = hexToRgb(args.color);

    // Geometry: a small sphere copied onto a point cloud built from the pose landmarks. The
    // CHOP-to-SOP turns the 33 samples into points; Copy stamps a dot on each (validated live —
    // geometry instancing left the dots at the origin, so Copy is used instead).
    const geo = await builder.add("geometryCOMP", "geo");
    const dot = await builder.add(
      "sphereSOP",
      "dot",
      { radx: args.dot_size, rady: args.dot_size, radz: args.dot_size },
      geo,
    );
    const pts = await builder.add("choptoSOP", "pts", { chop: src.path }, geo);
    const copy = await builder.add("copySOP", "copy", undefined, geo);
    await builder.connect(dot, copy, 0, 0);
    await builder.connect(pts, copy, 0, 1);
    await builder.python(
      `op(${q(copy)}).render = True\nop(${q(copy)}).display = True\nfor _n in (op(${q(dot)}), op(${q(pts)})):\n\t_n.render = False\n\t_n.display = False`,
    );

    const mat = await builder.add("constantMAT", "dotmat", {
      colorr: rgb.r,
      colorg: rgb.g,
      colorb: rgb.b,
    });
    await builder.setParams(geo, { material: mat });

    const cam = await builder.add("cameraCOMP", "cam", { tz: POSE_CAMERA_TZ });
    const render = await builder.add("renderTOP", "render", {
      outputresolution: "custom",
      resolutionw: 1280,
      resolutionh: 720,
      antialias: "3",
    });
    await builder.setParams(render, { geometry: geo, camera: cam });

    // Per-style post-processing onto a final Null TOP.
    const controls: ControlSpec[] = [];
    if (args.expose_controls) {
      controls.push({
        name: "DotSize",
        type: "float",
        min: 0.005,
        max: 0.15,
        default: args.dot_size,
        bind_to: [`${dot}.radx`, `${dot}.rady`, `${dot}.radz`],
      });
      controls.push({ name: "Color", type: "rgb", default: args.color });
    }

    let output: string;
    if (args.visual_style === "glow") {
      const blur = await builder.add("blurTOP", "bloom", { size: args.glow_amount });
      await builder.connect(render, blur);
      const add = await builder.add("compositeTOP", "glow", { operand: "add" });
      await builder.connect(render, add, 0, 0);
      await builder.connect(blur, add, 0, 1);
      output = await builder.add("nullTOP", "out1");
      await builder.connect(add, output);
      if (args.expose_controls)
        controls.push({
          name: "Glow",
          type: "float",
          min: 0,
          max: 64,
          default: args.glow_amount,
          bind_to: [`${blur}.size`],
        });
    } else if (args.visual_style === "trails") {
      // Feedback loop: composite the fresh render OVER a decayed copy of the previous frame.
      const fb = await builder.add("feedbackTOP", "fb");
      const decay = await builder.add("levelTOP", "decay", { opacity: args.trail_decay });
      await builder.connect(fb, decay);
      // Force the resolution: the feedback loop would otherwise collapse to the Feedback TOP's
      // 128² default and lock the whole chain there.
      const over = await builder.add("compositeTOP", "trails", {
        operand: "over",
        outputresolution: "custom",
        resolutionw: 1280,
        resolutionh: 720,
      });
      await builder.connect(render, over, 0, 0);
      await builder.connect(decay, over, 0, 1);
      output = await builder.add("nullTOP", "out1");
      await builder.connect(over, output);
      // Close the feedback loop: wire the final output into the Feedback TOP's input — it emits
      // the previous frame, which legally breaks the cook cycle. (Also setting its Target TOP par
      // double-paths it and trips a "cook dependency loop" warning — verified live, so we don't.)
      // Wire via Python so no layout back-edge is recorded.
      await builder.python(`op(${q(fb)}).inputConnectors[0].connect(op(${q(output)}))`);
      if (args.expose_controls)
        controls.push({
          name: "TrailDecay",
          type: "float",
          min: 0,
          max: 0.99,
          default: args.trail_decay,
          bind_to: [`${decay}.opacity`],
        });
    } else {
      output = await builder.add("nullTOP", "out1");
      await builder.connect(render, output);
    }

    // Force-cook the output each frame so the Script-CHOP-driven point cloud stays live.
    await installFrameCooker(builder, output, "cooker");

    return finalize(ctx, {
      summary: `Built a body-reactive '${args.visual_style}' visual (source: ${src.label}) → ${output}. Glowing ${args.color} marks track the 33 body landmarks. Drive the source from a webcam via the MediaPipe plugin (source='mediapipe') for a live performer.`,
      builder,
      outputPath: output,
      // Output is a TOP (the Null), so a preview image is captured.
      capturePreviewImage: true,
      controls,
      extra: {
        source: args.source,
        visual_style: args.visual_style,
        output_path: output,
        color: args.color,
        dot_size: args.dot_size,
      },
    });
  });
}

export const registerCreateBodyReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_body_reactive",
    {
      title: "Create body reactive",
      description:
        "Build a body-reactive visual driven by full-body pose tracking: glowing marks that follow the 33 landmarks (head, hands, elbows, hips, knees, feet), rendered to a Null TOP. Creates a new baseCOMP under `parent_path` holding the pose source, a Geometry COMP (dots copied onto the landmark point cloud), a Camera, a Render TOP, and per-style post-processing. Styles: 'points' (crisp dots), 'glow' (bloomed dots), 'trails' (motion smears that follow the body). Source defaults to a SYNTHETIC animated pose so it builds and previews instantly with no camera and no plugin; switch to 'mediapipe' (the free torinmb plugin), 'osc', or an existing pose CHOP (e.g. from create_pose_tracking) for the real performer. The visual counterpart of create_audio_reactive, for the body instead of sound. Returns a summary plus a JSON block with the container path, created node paths, the output path, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createBodyReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createBodyReactiveImpl(ctx, args),
  );
};

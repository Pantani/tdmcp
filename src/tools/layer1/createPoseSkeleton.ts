import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";
import {
  buildPoseSource,
  installFrameCooker,
  POSE_CAMERA_TZ,
  POSE_CONNECTIONS,
  poseSourceSchemaFields,
} from "./poseSource.js";

const q = (value: string): string => JSON.stringify(value);

/** Parses '#rrggbb' / 'rrggbb' (3- or 6-digit) into 0..1 RGB. Falls back to cyan. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0.2, g: 1, b: 0.9 };
  let h = m[1] as string;
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const int = Number.parseInt(h, 16);
  return { r: ((int >> 16) & 0xff) / 255, g: ((int >> 8) & 0xff) / 255, b: (int & 0xff) / 255 };
}

export const createPoseSkeletonSchema = z.object({
  ...poseSourceSchemaFields,
  line_color: z
    .string()
    .default("#33ffe6")
    .describe("Bone colour as hex ('#rrggbb'). Drives the Line MAT; default is bright cyan."),
  line_width: z.coerce
    .number()
    .min(0)
    .default(3)
    .describe("Bone thickness in pixels (Line MAT near width). Exposed as a live knob."),
  camera_distance: z.coerce
    .number()
    .positive()
    .default(POSE_CAMERA_TZ)
    .describe(
      "Camera distance on Z. Default frames a whole standing figure in 16:9; larger = further/smaller. Exposed as a live knob.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live LineWidth / CamDistance knobs (+ a LineColor swatch).",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the pose-skeleton container is created (default '/project1')."),
});
type CreatePoseSkeletonArgs = z.infer<typeof createPoseSkeletonSchema>;

/**
 * The Python onCook for the skeleton Script SOP: reads the pose CHOP and builds a point per
 * landmark plus an open 2-point polyline for every bone in POSE_CONNECTIONS, which the Line MAT
 * draws as the stick figure.
 */
function skeletonCallback(posePath: string): string {
  return [
    `BONES = ${JSON.stringify(POSE_CONNECTIONS)}`,
    `POSE_PATH = ${q(posePath)}`,
    "",
    "def onCook(scriptOp):",
    "    scriptOp.clear()",
    "    pose = op(POSE_PATH)",
    "    if pose is None or pose.numChans < 3 or pose.numSamples < 1:",
    "        return",
    "    tx = pose['tx']; ty = pose['ty']; tz = pose['tz']",
    "    if tx is None or ty is None or tz is None:",
    "        return",
    "    n = pose.numSamples",
    "    pts = []",
    "    for i in range(n):",
    "        p = scriptOp.appendPoint()",
    "        p.x = float(tx[i]); p.y = float(ty[i]); p.z = float(tz[i])",
    "        pts.append(p)",
    "    for a, b in BONES:",
    "        if a < n and b < n:",
    "            poly = scriptOp.appendPoly(2, closed=False, addPoints=False)",
    "            poly[0].point = pts[a]",
    "            poly[1].point = pts[b]",
    "    return",
    "",
  ].join("\n");
}

export async function createPoseSkeletonImpl(ctx: ToolContext, args: CreatePoseSkeletonArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "pose_skeleton");
    const src = await buildPoseSource(builder, args);
    const rgb = hexToRgb(args.line_color);

    // The skeleton geometry lives inside a Geometry COMP so the Render TOP can draw it. The
    // Script SOP reads the pose CHOP by absolute path (a reference, not a wire) and rebuilds the
    // points + bones each cook.
    const geo = await builder.add("geometryCOMP", "geo");
    const skeleton = await builder.add("scriptSOP", "skeleton", undefined, geo);
    const skcb = await builder.add("textDAT", "skel_cb", undefined, geo);
    await builder.python(
      `_cb = op(${q(skcb)})\n_cb.text = ${q(skeletonCallback(src.path))}\n_s = op(${q(skeleton)})\n_s.par.callbacks = _cb.name\n_s.render = True\n_s.display = True`,
    );

    // Line MAT: unlit coloured lines, so no light is needed.
    const wire = await builder.add("lineMAT", "wire", {
      linenearcolorr: rgb.r,
      linenearcolorg: rgb.g,
      linenearcolorb: rgb.b,
      widthnear: args.line_width,
    });
    await builder.setParams(geo, { material: wire });

    const cam = await builder.add("cameraCOMP", "cam", { tz: args.camera_distance });
    const render = await builder.add("renderTOP", "render", {
      outputresolution: "custom",
      resolutionw: 1280,
      resolutionh: 720,
      antialias: "3",
    });
    await builder.setParams(render, { geometry: geo, camera: cam });

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Force-cook the output each frame so the Script SOP re-reads the (time-dependent) pose.
    await installFrameCooker(builder, out, "cooker");

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "LineWidth",
            type: "float",
            min: 0,
            max: 20,
            default: args.line_width,
            bind_to: [`${wire}.widthnear`],
          },
          {
            name: "CamDistance",
            type: "float",
            min: 1,
            max: 12,
            default: args.camera_distance,
            bind_to: [`${cam}.tz`],
          },
          { name: "LineColor", type: "rgb", default: args.line_color },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a pose skeleton (source: ${src.label}) → ${out}. ${POSE_CONNECTIONS.length} bones drawn as ${args.line_color} lines from the 33 landmarks. Bind/composite ${out}, or drive the source from a webcam via the MediaPipe plugin (source='mediapipe').`,
      builder,
      outputPath: out,
      // Output is a TOP (the Null), so a preview image is captured.
      capturePreviewImage: true,
      controls,
      extra: {
        source: args.source,
        output_path: out,
        skeleton_sop: skeleton,
        bones: POSE_CONNECTIONS.length,
        line_color: args.line_color,
        line_width: args.line_width,
        camera_distance: args.camera_distance,
      },
    });
  });
}

export const registerCreatePoseSkeleton: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pose_skeleton",
    {
      title: "Create pose skeleton",
      description:
        "Render a live stick-figure skeleton from full-body pose tracking — the classic MediaPipe body-tracking look: glowing lines connecting the 33 landmarks (shoulders, elbows, wrists, hips, knees, ankles) drawn by a Line MAT and rendered to a Null TOP you can composite or post-process. Source defaults to a SYNTHETIC animated pose so it builds and previews instantly with no camera and no plugin; switch to 'mediapipe' (the free torinmb plugin), 'osc', or an existing pose CHOP (e.g. from create_pose_tracking) for the real performer. Creates a new baseCOMP under `parent_path` holding the pose source, a Geometry COMP (a Script SOP that rebuilds points + bones each cook), a Line MAT, a Camera, a Render TOP, and a Null output. Use create_body_reactive instead for glowing dots/trails at the landmarks rather than a connected stick figure. Exposes LineColor / LineWidth / CamDistance. Returns a summary plus a JSON block with the container path, created node paths, the skeleton SOP and output paths, the bone count, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createPoseSkeletonSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPoseSkeletonImpl(ctx, args),
  );
};

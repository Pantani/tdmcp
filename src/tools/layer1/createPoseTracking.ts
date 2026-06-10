import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { buildPoseSource, installFrameCooker, poseSourceSchemaFields } from "./poseSource.js";

const q = (value: string): string => JSON.stringify(value);

export const createPoseTrackingSchema = z.object({
  ...poseSourceSchemaFields,
  smoothing: z.coerce
    .number()
    .min(0)
    .max(0.95)
    .default(0.08)
    .describe(
      "Temporal smoothing (0..0.95): each landmark is blended with its previous frame so jittery tracking glides instead of snapping. 0 = raw/instant; higher = smoother but laggier. Exposed as a live knob.",
    ),
  mirror: z
    .boolean()
    .default(false)
    .describe(
      "Flip the pose horizontally (negate tx) so a webcam feed reads like a mirror — the performer's right hand is on the right of the frame. Build-time; off by default.",
    ),
  expose_controls: z.boolean().default(true).describe("Expose a live 'Smoothing' knob (0 = raw)."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'pose_tracking' container is created inside."),
});
type CreatePoseTrackingArgs = z.infer<typeof createPoseTrackingSchema>;

/**
 * The Python onCook for the 'keypoints' Script CHOP: reads the canonical pose CHOP (33 samples)
 * and emits one scalar channel per useful landmark coordinate plus a few derived signals, so an
 * artist can bind a parameter to op('…/keypoints')['r_wrist_y'] without indexing samples.
 */
function keypointsCallback(posePath: string): string {
  return [
    "import math",
    "",
    "def _g(ch, i):",
    "    try:",
    "        return float(ch[i])",
    "    except Exception:",
    "        return 0.0",
    "",
    "def onCook(scriptOp):",
    "    scriptOp.clear()",
    `    pose = op(${q(posePath)})`,
    "    if pose is None or pose.numChans < 2 or pose.numSamples < 33:",
    "        return",
    "    tx = pose['tx']; ty = pose['ty']",
    "    if tx is None or ty is None:",
    "        return",
    "    pts = {'nose': 0, 'l_shoulder': 11, 'r_shoulder': 12, 'l_wrist': 15,",
    "           'r_wrist': 16, 'l_hip': 23, 'r_hip': 24, 'l_ankle': 27, 'r_ankle': 28}",
    "    scriptOp.numSamples = 1",
    "    for nm, idx in pts.items():",
    "        scriptOp.appendChan(nm + '_x')[0] = _g(tx, idx)",
    "        scriptOp.appendChan(nm + '_y')[0] = _g(ty, idx)",
    "    scriptOp.appendChan('hips_x')[0] = (_g(tx, 23) + _g(tx, 24)) * 0.5",
    "    scriptOp.appendChan('hips_y')[0] = (_g(ty, 23) + _g(ty, 24)) * 0.5",
    "    scriptOp.appendChan('hand_span')[0] = math.hypot(_g(tx, 15) - _g(tx, 16), _g(ty, 15) - _g(ty, 16))",
    "    ankle_y = (_g(ty, 27) + _g(ty, 28)) * 0.5",
    "    scriptOp.appendChan('height')[0] = abs(_g(ty, 0) - ankle_y)",
    "    return",
    "",
  ].join("\n");
}

/**
 * The Python onCook for the 'smooth' Script CHOP: copies the input pose and exponentially blends
 * each landmark with its previous frame, reading a live 'Smoothing' custom par when one exists (it
 * falls back to the build-time default). This preserves the 33 spatial samples — a Lag/Filter CHOP
 * would collapse them to 1, because those operate on the time axis (verified live).
 */
function smootherCallback(defaultAmt: number): string {
  const amt = Number.isFinite(defaultAmt) ? defaultAmt : 0;
  return [
    `DEFAULT_AMT = ${amt}`,
    "",
    "def onCook(scriptOp):",
    "    inp = scriptOp.inputs[0] if scriptOp.inputs else None",
    "    if inp is None or inp.numChans == 0:",
    "        scriptOp.clear()",
    "        return",
    "    scriptOp.copy(inp)",
    "    try:",
    "        amt = float(getattr(parent().par, 'Smoothing'))",
    "    except Exception:",
    "        amt = DEFAULT_AMT",
    "    amt = max(0.0, min(0.95, amt))",
    "    if amt > 0:",
    "        prev = scriptOp.fetch('prev_vals', None)",
    "        if prev and len(prev) == scriptOp.numChans:",
    "            for ci in range(scriptOp.numChans):",
    "                col = prev[ci]",
    "                if len(col) == scriptOp.numSamples:",
    "                    ch = scriptOp[ci]",
    "                    for si in range(scriptOp.numSamples):",
    "                        ch[si] = col[si] * amt + ch[si] * (1.0 - amt)",
    "        scriptOp.store('prev_vals', [[float(scriptOp[ci][si]) for si in range(scriptOp.numSamples)] for ci in range(scriptOp.numChans)])",
    "    return",
    "",
  ].join("\n");
}

export async function createPoseTrackingImpl(ctx: ToolContext, args: CreatePoseTrackingArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "pose_tracking");
    const src = await buildPoseSource(builder, args);

    // Optional mirror: negate only the tx channel, then merge it back with the rest. A Math CHOP
    // gain applies to all channels, so tx is split off, flipped, and recombined.
    let feed = src.path;
    if (args.mirror && src.path) {
      const txIn = await builder.add("selectCHOP", "tx_in", { channames: "tx" });
      await builder.connect(src.path, txIn);
      const flip = await builder.add("mathCHOP", "mirror", { gain: -1 });
      await builder.connect(txIn, flip);
      const rest = await builder.add("selectCHOP", "rest_in", { channames: "ty tz confidence" });
      await builder.connect(src.path, rest);
      const merged = await builder.add("mergeCHOP", "mirrored");
      await builder.connect(flip, merged, 0, 0);
      await builder.connect(rest, merged, 0, 1);
      feed = merged;
    }

    // Smoothing (sample-preserving) then a Null as the canonical bind point (33 samples ×
    // tx/ty/tz/confidence). A Script CHOP blends each landmark with its previous frame — a Lag/
    // Filter CHOP would collapse the 33 landmarks to 1 (they filter the time axis).
    const smooth = await builder.add("scriptCHOP", "smooth");
    const smoothCb = await builder.add("textDAT", "smooth_cb");
    await builder.python(
      `_cb = op(${q(smoothCb)})\n_cb.text = ${q(smootherCallback(args.smoothing))}\nop(${q(smooth)}).par.callbacks = _cb.name`,
    );
    if (feed) await builder.connect(feed, smooth);
    const pose = await builder.add("nullCHOP", "pose");
    await builder.connect(smooth, pose);

    // A second output: named scalar channels for easy binding (no sample indexing).
    const keypoints = await builder.add("scriptCHOP", "keypoints");
    const kpcb = await builder.add("textDAT", "keypoints_cb");
    await builder.python(
      `_cb = op(${q(kpcb)})\n_cb.text = ${q(keypointsCallback(pose))}\nop(${q(keypoints)}).par.callbacks = _cb.name`,
    );

    // Keep the chain warm: the Script CHOPs read via op() references, so force-cook each frame.
    await installFrameCooker(builder, keypoints, "cooker");

    // The 'smooth' Script CHOP reads this 'Smoothing' par directly each cook, so it needs no
    // bind_to — the custom par just has to exist on the container.
    const controls: ControlSpec[] = args.expose_controls
      ? [{ name: "Smoothing", type: "float", min: 0, max: 0.95, default: args.smoothing }]
      : [];

    return finalize(ctx, {
      summary: `Built pose tracking (source: ${src.label}) → ${pose} (33 landmarks as samples; channels tx/ty/tz/confidence) and named scalar channels on ${keypoints} (e.g. r_wrist_y, hand_span, height). Feed ${pose} into create_pose_skeleton / create_body_reactive, or bind a parameter to op('${keypoints}')['r_wrist_y'].`,
      builder,
      outputPath: pose,
      // Output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        source: args.source,
        pose_path: pose,
        keypoints_path: keypoints,
        pose_channels: ["tx", "ty", "tz", "confidence"],
        landmark_count: 33,
        mirror: args.mirror,
        smoothing: args.smoothing,
      },
    });
  });
}

export const registerCreatePoseTracking: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pose_tracking",
    {
      title: "Create pose tracking",
      description:
        "Set up full-body pose tracking — the foundation for body-reactive visuals (the camera/skeleton counterpart to extract_audio_features). Produces a canonical pose CHOP (33 MediaPipe landmarks as samples, channels tx/ty/tz/confidence) plus a 'keypoints' CHOP of ready-to-bind scalar channels (r_wrist_y, l_wrist_x, hips_x, hand_span, height, …). Source defaults to a self-contained SYNTHETIC animated pose so it builds and previews with no camera and no plugin; switch to 'mediapipe' (the free torinmb/mediapipe-touchdesigner plugin), 'osc', or an existing pose CHOP for the real performer. Smoothing and Mirror included. Feed the output into create_pose_skeleton or create_body_reactive.",
      inputSchema: createPoseTrackingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPoseTrackingImpl(ctx, args),
  );
};

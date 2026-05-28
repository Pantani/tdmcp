import { z } from "zod";
import type { NetworkBuilder } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * The 33 MediaPipe Pose landmark names, in index order. The torinmb/mediapipe-touchdesigner
 * plugin (and MediaPipe itself) emit landmarks in exactly this order, so a sample index maps
 * to a body part the same way whether the data is synthetic, from the plugin, or over OSC.
 */
export const POSE_LANDMARKS: readonly string[] = [
  "nose",
  "left_eye_inner",
  "left_eye",
  "left_eye_outer",
  "right_eye_inner",
  "right_eye",
  "right_eye_outer",
  "left_ear",
  "right_ear",
  "mouth_left",
  "mouth_right",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_pinky",
  "right_pinky",
  "left_index",
  "right_index",
  "left_thumb",
  "right_thumb",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
  "left_foot_index",
  "right_foot_index",
];

/**
 * The MediaPipe POSE_CONNECTIONS edge set (35 bones) used to draw a skeleton: each pair is two
 * landmark indices that get joined by a line. Note MediaPipe has no neck bone, so the face
 * landmarks (0-10) form a small graph that floats above the shoulders — that is faithful to the
 * data, not a bug.
 */
export const POSE_CONNECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8],
  [9, 10],
  [11, 12],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 29],
  [27, 31],
  [29, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [28, 32],
  [30, 32],
];

/**
 * A neutral standing pose in TouchDesigner world coordinates (X right, Y up, origin near the
 * navel; the figure spans y∈[-0.95, 0.75], so a camera at tz≈4.6 frames the whole body in 16:9).
 * The synthetic source animates around these base positions. Validated live: 33 points render as
 * a recognisable human skeleton.
 */
export const POSE_BASE: readonly (readonly [number, number, number])[] = [
  [0.0, 0.7, 0.05],
  [0.03, 0.73, 0.04],
  [0.05, 0.73, 0.04],
  [0.07, 0.73, 0.04],
  [-0.03, 0.73, 0.04],
  [-0.05, 0.73, 0.04],
  [-0.07, 0.73, 0.04],
  [0.09, 0.71, 0.0],
  [-0.09, 0.71, 0.0],
  [0.03, 0.66, 0.04],
  [-0.03, 0.66, 0.04],
  [0.18, 0.45, 0.0],
  [-0.18, 0.45, 0.0],
  [0.26, 0.22, 0.0],
  [-0.26, 0.22, 0.0],
  [0.3, 0.0, 0.0],
  [-0.3, 0.0, 0.0],
  [0.32, -0.05, 0.0],
  [-0.32, -0.05, 0.0],
  [0.33, -0.04, 0.0],
  [-0.33, -0.04, 0.0],
  [0.3, -0.03, 0.0],
  [-0.3, -0.03, 0.0],
  [0.1, 0.0, 0.0],
  [-0.1, 0.0, 0.0],
  [0.12, -0.45, 0.0],
  [-0.12, -0.45, 0.0],
  [0.12, -0.9, 0.0],
  [-0.12, -0.9, 0.0],
  [0.11, -0.94, -0.03],
  [-0.11, -0.94, -0.03],
  [0.14, -0.95, 0.06],
  [-0.14, -0.95, 0.06],
];

/** Default camera distance that frames the whole standing figure in a 16:9 render (fov 45 is horizontal in TD). */
export const POSE_CAMERA_TZ = 4.6;

/**
 * Schema fields shared by every pose tool: where the 33-landmark stream comes from. Spread these
 * into a tool's own `z.object({ ... })`. 'synthetic' is the default so a tool builds and previews
 * with zero camera permission and without the plugin installed.
 */
export const poseSourceSchemaFields = {
  source: z
    .enum(["synthetic", "mediapipe", "osc", "existing_chop"])
    .default("synthetic")
    .describe(
      "Where the 33-landmark pose stream comes from. 'synthetic' (default) = a self-contained animated human pose that needs NO camera and NO plugin — use it to build and preview the look instantly. 'mediapipe' = the live CHOP from the free torinmb/mediapipe-touchdesigner plugin (point mediapipe_chop_path at its pose landmarks CHOP). 'osc' = landmarks arriving over OSC (osc_port). 'existing_chop' = a pose CHOP you already built (e.g. the output of create_pose_tracking).",
    ),
  mediapipe_chop_path: z
    .string()
    .optional()
    .describe(
      "Path to the MediaPipe plugin's pose-landmarks CHOP (source='mediapipe'). The plugin emits 33 samples with tx/ty/tz channels.",
    ),
  osc_port: z.coerce
    .number()
    .int()
    .positive()
    .default(7000)
    .describe("UDP port the OSC In CHOP listens on (source='osc')."),
  existing_chop_path: z
    .string()
    .optional()
    .describe(
      "Path of an existing pose CHOP — 33 samples, tx/ty/tz channels (source='existing_chop').",
    ),
};

/** The subset of a tool's args that selects/locates the pose source. */
export interface PoseSourceInput {
  source: "synthetic" | "mediapipe" | "osc" | "existing_chop";
  mediapipe_chop_path?: string;
  osc_port?: number;
  existing_chop_path?: string;
}

export interface PoseSource {
  /** Path of the canonical pose CHOP (33 samples; channels tx/ty/tz/confidence). */
  path: string;
  /** Human-readable description for the tool summary. */
  label: string;
  /** Whether a source node was created (false only for existing_chop). */
  createdNode: boolean;
}

/**
 * The Python onCook for the synthetic Script CHOP: emits 33 samples × tx/ty/tz/confidence from
 * POSE_BASE with a gentle breathing sway and alternating arm raise, so motion/skeleton chains read
 * live values. absTime makes the op time-dependent, so it re-cooks every frame on its own.
 */
function syntheticPoseCallback(): string {
  return [
    "import math",
    `BASE = ${JSON.stringify(POSE_BASE)}`,
    "ARMS_L = [13, 15, 17, 19, 21]",
    "ARMS_R = [14, 16, 18, 20, 22]",
    "",
    "def onCook(scriptOp):",
    "    scriptOp.clear()",
    "    n = len(BASE)",
    "    scriptOp.numSamples = n",
    "    tx = scriptOp.appendChan('tx')",
    "    ty = scriptOp.appendChan('ty')",
    "    tz = scriptOp.appendChan('tz')",
    "    cf = scriptOp.appendChan('confidence')",
    "    t = absTime.seconds",
    "    wave = math.sin(t * 1.6)",
    "    breathe = math.sin(t * 0.8) * 0.012",
    "    for i in range(n):",
    "        x, y, z = BASE[i]",
    "        ax = x + 0.012 * math.sin(t * 1.1 + i * 0.5)",
    "        ay = y + breathe",
    "        if i in ARMS_L:",
    "            ay = y + 0.20 * (wave * 0.5 + 0.5)",
    "        elif i in ARMS_R:",
    "            ay = y + 0.20 * ((-wave) * 0.5 + 0.5)",
    "        tx[i] = ax",
    "        ty[i] = ay",
    "        tz[i] = z",
    "        cf[i] = 1.0",
    "    return",
    "",
  ].join("\n");
}

/**
 * Builds (or references) the pose source and returns the path of the canonical pose CHOP — 33
 * samples, channels tx/ty/tz/confidence, in TD world coordinates. Every pose tool starts here so
 * they share one data contract: skeleton/reactive networks read the same channels regardless of
 * whether the data is synthetic, from the plugin, or over OSC.
 */
export async function buildPoseSource(
  builder: NetworkBuilder,
  args: PoseSourceInput,
): Promise<PoseSource> {
  if (args.source === "existing_chop") {
    // Reference the external pose CHOP by path through a Select CHOP, so the whole network stays
    // inside this container (no cross-container wiring, which the bridge can drop).
    const sel = await builder.add(
      "selectCHOP",
      "posein",
      args.existing_chop_path ? { chops: args.existing_chop_path } : {},
    );
    return {
      path: sel,
      label: `existing CHOP ${args.existing_chop_path ?? "(unset)"}`,
      createdNode: true,
    };
  }
  if (args.source === "mediapipe") {
    // Select the plugin's pose-landmarks CHOP by path. An empty path just yields no channels (no
    // error); the artist sets mediapipe_chop_path to the plugin's pose op.
    const sel = await builder.add(
      "selectCHOP",
      "posein",
      args.mediapipe_chop_path ? { chops: args.mediapipe_chop_path } : {},
    );
    return {
      path: sel,
      label: `MediaPipe plugin CHOP ${args.mediapipe_chop_path ?? "(set mediapipe_chop_path)"}`,
      createdNode: true,
    };
  }
  if (args.source === "osc") {
    const osc = await builder.add("oscinCHOP", "posein", { port: args.osc_port ?? 7000 });
    return { path: osc, label: `OSC in on port ${args.osc_port ?? 7000}`, createdNode: true };
  }
  // synthetic: a Script CHOP whose callback emits an animated 33-landmark pose.
  const sc = await builder.add("scriptCHOP", "posein");
  const cb = await builder.add("textDAT", "posein_cb");
  await builder.python(
    `_cb = op(${q(cb)})\n_cb.text = ${q(syntheticPoseCallback())}\nop(${q(sc)}).par.callbacks = _cb.name`,
  );
  return { path: sc, label: "device-free synthetic pose", createdNode: true };
}

/**
 * Installs a tiny Execute DAT that force-cooks `cookPath` every frame. Pose chains read the source
 * CHOP through op() references (Script SOP / Script CHOP) rather than wires, so without a puller
 * they would freeze; this keeps the whole network live even before anything is bound.
 */
export async function installFrameCooker(
  builder: NetworkBuilder,
  cookPath: string,
  name = "cooker",
): Promise<void> {
  const cooker = await builder.add("executeDAT", name);
  const body = `def onFrameStart(frame):\n\to = op('${cookPath}')\n\tif o is not None:\n\t\to.cook(force=True)\n\treturn\n`;
  await builder.python(
    `_c = op(${q(cooker)})\n_c.text = ${q(body)}\n_c.par.framestart = True\n_c.par.active = True`,
  );
}

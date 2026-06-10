import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";
import { buildPoseSource, installFrameCooker } from "./poseSource.js";

const q = (value: string): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createPoseControlnetDriverSchema = z.object({
  source: z
    .enum(["existing_tracker", "synthetic"])
    .default("existing_tracker")
    .describe(
      "Where the pose stream comes from. 'existing_tracker' reads a 33-sample pose CHOP at pose_chop_path. 'synthetic' auto-spins-up a synthetic Script CHOP inside this container for device-free preview.",
    ),
  pose_chop_path: z
    .string()
    .optional()
    .describe(
      "Required when source='existing_tracker'. Absolute TD path to the canonical 33-sample pose CHOP (tx/ty/tz/confidence).",
    ),
  resolution: z
    .enum(["512", "768", "1024"])
    .default("512")
    .describe("Square render size. ControlNet SD1.5 wants 512; SDXL wants 768/1024."),
  joint_radius: z
    .number()
    .min(1)
    .max(24)
    .default(6)
    .describe("Filled-disc radius (px) for each keypoint joint. Exposed as live JointRadius knob."),
  limb_thickness: z
    .number()
    .min(1)
    .max(24)
    .default(8)
    .describe("Line thickness (px) for each limb. Exposed as live LimbThickness knob."),
  coordinate_space: z
    .enum(["normalized", "world"])
    .default("normalized")
    .describe(
      "How to map landmark tx/ty to pixel space. 'normalized' maps [-1,+1] to full square. 'world' recenters using hip_midpoint and auto-scales to body height.",
    ),
  mirror: z
    .boolean()
    .default(false)
    .describe("Flip horizontally (selfie cam vs. ControlNet expectation)."),
  confidence_gate: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe(
      "Skip drawing landmarks/limbs whose endpoint confidence falls below this. Exposed as live knob.",
    ),
  color_preset: z
    .enum(["openpose_coco", "openpose_body25", "custom"])
    .default("openpose_coco")
    .describe("Canonical OpenPose 18-keypoint COCO palette by default."),
  custom_limb_colors: z
    .array(z.tuple([z.number(), z.number(), z.number()]))
    .optional()
    .describe("When color_preset='custom'. Length must equal 17 (limb count)."),
  custom_joint_colors: z
    .array(z.tuple([z.number(), z.number(), z.number()]))
    .optional()
    .describe("When color_preset='custom'. Length must equal 18 (joint count)."),
  output_mode: z
    .enum(["internal", "syphon_spout", "ndi"])
    .default("internal")
    .describe(
      "When 'internal' stops at a Null TOP. When 'syphon_spout'/'ndi' adds an FM-01 external sender.",
    ),
  sender_name: z
    .string()
    .default("tdmcp_controlnet_pose")
    .describe("Sender/source name advertised on the network when output_mode != 'internal'."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live JointRadius, LimbThickness, ConfidenceGate, Mirror knobs."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network for the pose_controlnet_driver baseCOMP."),
});

export type CreatePoseControlnetDriverArgs = z.infer<typeof createPoseControlnetDriverSchema>;

// ---------------------------------------------------------------------------
// GLSL shader
// ---------------------------------------------------------------------------

/** Canonical OpenPose-COCO per-limb RGB palette (17 limbs). */
const LIMB_RGB_COCO: readonly [number, number, number][] = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
];

/** Canonical OpenPose-COCO per-joint RGB palette (18 joints). Same ramp. */
const JOINT_RGB_COCO: readonly [number, number, number][] = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
  [255, 0, 85],
];

function toGlslVec3Array(colors: readonly [number, number, number][], name: string): string {
  const items = colors
    .map(
      ([r, g, b]) =>
        `vec3(${(r / 255).toFixed(4)},${(g / 255).toFixed(4)},${(b / 255).toFixed(4)})`,
    )
    .join(",\n  ");
  return `const vec3 ${name}[${colors.length}] = vec3[${colors.length}](\n  ${items}\n);`;
}

function buildGlslShader(
  limbColors: readonly [number, number, number][],
  jointColors: readonly [number, number, number][],
): string {
  const limbArray = toGlslVec3Array(limbColors, "LIMB_RGB");
  const jointArray = toGlslVec3Array(jointColors, "JOINT_RGB");

  return [
    "uniform sampler2D sTD2DInputs[1];",
    "uniform float uJointR;",
    "uniform float uLimbW;",
    "uniform float uGate;",
    "uniform vec2 uRes;",
    "",
    "const int L_NUM = 17;",
    "const int J_NUM = 18;",
    "",
    "const ivec2 LIMB_IDX[17] = ivec2[17](",
    "  ivec2(1,2), ivec2(2,3), ivec2(3,4), ivec2(1,5), ivec2(5,6), ivec2(6,7),",
    "  ivec2(1,8), ivec2(8,9), ivec2(9,10), ivec2(1,11), ivec2(11,12), ivec2(12,13),",
    "  ivec2(1,0), ivec2(0,14), ivec2(14,16), ivec2(0,15), ivec2(15,17)",
    ");",
    "",
    limbArray,
    "",
    jointArray,
    "",
    "vec3 readPt(int i) {",
    "  return texelFetch(sTD2DInputs[0], ivec2(i, 0), 0).rgb;",
    "}",
    "",
    "float segDist(vec2 p, vec2 a, vec2 b) {",
    "  vec2 ab = b - a;",
    "  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);",
    "  return length(p - (a + t * ab));",
    "}",
    "",
    "out vec4 fragColor;",
    "void main() {",
    "  vec3 col = vec3(0.0);",
    "  for (int i = 0; i < L_NUM; ++i) {",
    "    vec3 A = readPt(LIMB_IDX[i].x);",
    "    vec3 B = readPt(LIMB_IDX[i].y);",
    "    if (A.z < uGate || B.z < uGate) continue;",
    "    float d = segDist(gl_FragCoord.xy, A.xy * uRes, B.xy * uRes);",
    "    float w = smoothstep(uLimbW * 0.5 + 1.0, uLimbW * 0.5 - 1.0, d);",
    "    col = mix(col, LIMB_RGB[i], w);",
    "  }",
    "  for (int i = 0; i < J_NUM; ++i) {",
    "    vec3 K = readPt(i);",
    "    if (K.z < uGate) continue;",
    "    float d = distance(gl_FragCoord.xy, K.xy * uRes);",
    "    float w = smoothstep(uJointR + 1.0, uJointR - 1.0, d);",
    "    col = mix(col, JOINT_RGB[i], w);",
    "  }",
    "  fragColor = vec4(col, 1.0);",
    "}",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// pose_norm Python callback (33 MP landmarks → 18 OP-COCO keypoints)
// ---------------------------------------------------------------------------

function buildPoseNormCallback(posePath: string, mirror: boolean, coordSpace: string): string {
  return [
    "# MediaPipe-33 → OpenPose-COCO-18 remap + normalize",
    "# MAP18[i] = MP index, or ('neck', a, b) to average two landmarks",
    `MIRROR = ${mirror ? "True" : "False"}`,
    `COORD_SPACE = ${q(coordSpace)}`,
    "",
    "def onCook(scriptOp):",
    "    scriptOp.clear()",
    `    src = op(${q(posePath)})`,
    "    if src is None or src.numSamples < 33:",
    "        return",
    "    tx = src['tx']",
    "    ty = src['ty']",
    "    cf = src['confidence']",
    "    if tx is None or ty is None or cf is None:",
    "        return",
    "    MAP18 = [",
    "        0,",
    "        ('neck', 11, 12),",
    "        12, 14, 16,",
    "        11, 13, 15,",
    "        24, 26, 28,",
    "        23, 25, 27,",
    "        5, 2, 8, 7",
    "    ]",
    "    scriptOp.numSamples = 18",
    "    px = scriptOp.appendChan('px')",
    "    py = scriptOp.appendChan('py')",
    "    cc = scriptOp.appendChan('conf')",
    "    # For 'world' mode: compute hip midpoint and body height for auto-scale.",
    "    if COORD_SPACE == 'world':",
    "        hip_x = (float(tx[23]) + float(tx[24])) * 0.5",
    "        hip_y = (float(ty[23]) + float(ty[24])) * 0.5",
    "        nose_y = float(ty[0])",
    "        ankle_y = (float(ty[27]) + float(ty[28])) * 0.5",
    "        body_h = abs(nose_y - ankle_y) if abs(nose_y - ankle_y) > 0.01 else 1.0",
    "    for i, m in enumerate(MAP18):",
    "        if isinstance(m, tuple):",
    "            x = (float(tx[m[1]]) + float(tx[m[2]])) * 0.5",
    "            y = (float(ty[m[1]]) + float(ty[m[2]])) * 0.5",
    "            c = min(float(cf[m[1]]), float(cf[m[2]]))",
    "        else:",
    "            x = float(tx[m])",
    "            y = float(ty[m])",
    "            c = float(cf[m])",
    "        if MIRROR:",
    "            x = -x",
    "        if COORD_SPACE == 'world':",
    "            x = (x - hip_x) / body_h * 0.5 + 0.5",
    "            y = 1.0 - ((y - hip_y) / body_h * 0.5 + 0.5)",
    "        else:",
    "            x = x * 0.5 + 0.5",
    "            y = 1.0 - (y * 0.5 + 0.5)",
    "        px[i] = x",
    "        py[i] = y",
    "        cc[i] = c",
    "    return",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createPoseControlnetDriverImpl(
  ctx: ToolContext,
  args: CreatePoseControlnetDriverArgs,
) {
  // --- Input validation ---
  if (args.source === "existing_tracker" && !args.pose_chop_path) {
    return errorResult("pose_chop_path is required when source='existing_tracker'.");
  }

  if (args.color_preset === "custom") {
    if (args.custom_limb_colors !== undefined && args.custom_limb_colors.length !== 17) {
      return errorResult(`expected 17 limb colors, got ${args.custom_limb_colors.length}`);
    }
    if (args.custom_joint_colors !== undefined && args.custom_joint_colors.length !== 18) {
      return errorResult(`expected 18 joint colors, got ${args.custom_joint_colors.length}`);
    }
  }

  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "pose_controlnet_driver");
    const warnings: string[] = [];

    // Warn if synthetic + normalized (world is more sensible for synthetic)
    if (args.source === "synthetic" && args.coordinate_space === "normalized") {
      warnings.push(
        "synthetic source uses TD world coordinates; coordinate_space='world' is recommended. Continuing with 'normalized'.",
      );
    }

    // 1. Pose source
    let sourcePath: string;
    if (args.source === "synthetic") {
      const src = await buildPoseSource(builder, { source: "synthetic" });
      sourcePath = src.path;
    } else {
      // existing_tracker: Select CHOP at pose_chop_path (no cross-container wires)
      const sel = await builder.add("selectCHOP", "posein", {
        chop: args.pose_chop_path,
      });
      sourcePath = sel;
    }

    // 2. pose_norm Script CHOP (33-MP → 18-OP remap + normalize)
    const posePath = sourcePath;
    const poseNorm = await builder.add("scriptCHOP", "pose_norm");
    const poseNormCb = await builder.add("textDAT", "pose_norm_cb");
    await builder.python(
      `_cb = op(${q(poseNormCb)})\n_cb.text = ${q(buildPoseNormCallback(posePath, args.mirror, args.coordinate_space))}\nop(${q(poseNorm)}).par.callbacks = _cb.name`,
    );
    await builder.connect(sourcePath, poseNorm);

    // 3. chopToTOP — converts pose_norm's 18 samples × (px,py,conf) into a float texture
    const poseTex = await builder.add("choptoTOP", "pose_tex", {
      pixelformat: "fp32rgb",
      dataformat: "oneChannelPerPixel",
    });
    await builder.connect(poseNorm, poseTex);

    // 4. GLSL TOP skeleton renderer
    const limbColors =
      args.color_preset === "custom" && args.custom_limb_colors
        ? args.custom_limb_colors
        : LIMB_RGB_COCO;
    const jointColors =
      args.color_preset === "custom" && args.custom_joint_colors
        ? args.custom_joint_colors
        : JOINT_RGB_COCO;

    const glslShader = buildGlslShader(limbColors, jointColors);
    const res = Number(args.resolution);

    const skeleton = await builder.add("glslTOP", "skeleton", {
      outputresolution: "custom",
      resolutionw: res,
      resolutionh: res,
    });

    // Embed the shader via a Text DAT
    const fragDat = await builder.add("textDAT", "skeleton_frag");
    await builder.python(
      `op(${q(fragDat)}).text = ${q(glslShader)}\nop(${q(skeleton)}).par.pixeldat = op(${q(fragDat)}).name`,
    );

    // Wire the pose texture as the first input to the GLSL TOP
    await builder.connect(poseTex, skeleton);

    // Set uniforms via the vec sequence (uRes, uJointR, uLimbW, uGate)
    await builder.python(
      [
        `_sk = op(${q(skeleton)})`,
        "_sk.seq.vec.numBlocks = max(_sk.seq.vec.numBlocks, 4)",
        // Block 0: uRes (vec2 — valuex=w, valuey=h)
        "_sk.par.vec0name = 'uRes'",
        `_sk.par.vec0valuex = ${res}`,
        `_sk.par.vec0valuey = ${res}`,
        // Block 1: uJointR
        "_sk.par.vec1name = 'uJointR'",
        `_sk.par.vec1valuex = ${args.joint_radius}`,
        // Block 2: uLimbW
        "_sk.par.vec2name = 'uLimbW'",
        `_sk.par.vec2valuex = ${args.limb_thickness}`,
        // Block 3: uGate
        "_sk.par.vec3name = 'uGate'",
        `_sk.par.vec3valuex = ${args.confidence_gate}`,
      ].join("\n"),
    );

    // 5. Null TOP output
    const out1 = await builder.add("nullTOP", "out1");
    await builder.connect(skeleton, out1);

    // 6. Frame cooker keeps the chain live
    await installFrameCooker(builder, out1, "cooker");

    // 7. External output (syphon_spout / ndi)
    let senderInfo: { kind: "syphon_spout" | "ndi"; name: string; op_path: string } | undefined;

    if (args.output_mode === "syphon_spout") {
      try {
        const syphonOut = await builder.add("syphonspoutoutTOP", "syphon_out", {
          senderName: args.sender_name,
        });
        await builder.connect(out1, syphonOut);
        senderInfo = {
          kind: "syphon_spout",
          name: args.sender_name,
          op_path: syphonOut,
        };
      } catch (err) {
        warnings.push(
          `syphonspoutoutTOP not available on this platform — skipping Syphon/Spout sender. ${String(err)}`,
        );
      }
    } else if (args.output_mode === "ndi") {
      try {
        const ndiOut = await builder.add("ndioutTOP", "ndi_out", {
          senderName: args.sender_name,
        });
        await builder.connect(out1, ndiOut);
        senderInfo = {
          kind: "ndi",
          name: args.sender_name,
          op_path: ndiOut,
        };
      } catch (err) {
        warnings.push(`ndioutTOP not available — skipping NDI sender. ${String(err)}`);
      }
    }

    // 8. Expose live controls
    const controls: ControlSpec[] = [];
    if (args.expose_controls) {
      controls.push(
        { name: "JointRadius", type: "float", min: 1, max: 24, default: args.joint_radius },
        { name: "LimbThickness", type: "float", min: 1, max: 24, default: args.limb_thickness },
        {
          name: "ConfidenceGate",
          type: "float",
          min: 0,
          max: 1,
          default: args.confidence_gate,
        },
        { name: "Mirror", type: "toggle", default: args.mirror ? 1 : 0 },
      );
    }

    const extra: Record<string, unknown> = {
      container_path: builder.containerPath,
      output_top_path: out1,
      source_path: sourcePath,
      resolution: res,
      color_preset: args.color_preset,
      output_mode: args.output_mode,
      warnings: [...builder.warnings, ...warnings],
    };
    if (senderInfo !== undefined) extra.sender = senderInfo;

    return finalize(ctx, {
      summary: `Built pose ControlNet driver (${res}×${res}, ${args.color_preset}) inside ${builder.containerPath}. Output TOP: ${out1}. Source: ${args.source}${args.pose_chop_path ? ` (${args.pose_chop_path})` : ""}.${senderInfo ? ` Sender: ${senderInfo.kind} "${senderInfo.name}".` : ""}`,
      builder,
      outputPath: out1,
      capturePreviewImage: true,
      controls,
      extra,
    });
  });
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreatePoseControlnetDriver: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pose_controlnet_driver",
    {
      title: "Create pose ControlNet driver",
      description:
        "Render a canonical OpenPose-colored stick figure TOP (per-limb RGB lines + per-joint colored discs on a black background, default 512×512) from an existing pose CHOP produced by create_pose_tracking. The render is GPU-rasterized in a single GLSL TOP that samples the pose CHOP via a CHOP-to-TOP. Optionally auto-wires the output to a Syphon/Spout or NDI sender for a downstream Stable Diffusion / ComfyUI / StreamDiffusion ControlNet node. No model inference — this tool produces the driver conditioning image that ControlNet consumes.",
      inputSchema: createPoseControlnetDriverSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPoseControlnetDriverImpl(ctx, args),
  );
};

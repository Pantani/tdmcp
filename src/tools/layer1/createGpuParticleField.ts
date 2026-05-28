import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * GLSL ping-pong helpers — each "buffer" is an RGBA32float TOP that a feedbackTOP
 * holds frame-to-frame (the same trick createFeedbackNetwork uses for an image loop),
 * except here the texels are *data* (particle velocity / position) not pixels:
 *   - sTD2DInputs[0] in vel_update  = previous velocity (from vel_fb)
 *   - sTD2DInputs[0] in pos_update  = previous position (from pos_fb)
 *   - sTD2DInputs[1] in pos_update  = current velocity  (from vel_update)
 *
 * TouchDesigner GLSL TOP conventions used throughout (verified in createAudioReactive /
 * createMultiOutput): declare `out vec4 fragColor;`, sample `sTD2DInputs[i]`, write via
 * `TDOutputSwizzle(...)`, and there is NO built-in uTime — so this integrates with a fixed
 * dt rather than reading a clock. The shader text goes in a textDAT wired with
 * `op(glsl).par.pixeldat = op(frag).name`.
 */

// A cheap hash → pseudo-random vec3 in [-1,1], used both to seed positions and to drive the
// "noise" force without a noiseTOP input (keeps the default path fully self-contained).
const GLSL_HASH = `
vec3 hash33(vec3 p){
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}
`;

/**
 * Velocity-update fragment. Reads previous velocity from the feedback (sTD2DInputs[0]) and
 * adds the requested forces, then writes the new velocity. `vUV.st` is the particle's slot
 * in the side×side grid, used as a stable per-particle seed.
 *
 * Forces (all tuned in-shader, no external inputs on the default path):
 *  - "noise": a per-particle hash nudges velocity (Brownian-ish drift).
 *  - "curl":  a finite-difference curl of the hash field → swirling motion.
 *  - "gravity": a constant pull along -Y.
 * `damp` keeps velocities bounded so the sim does not blow up under feedback.
 */
function velocityShader(forces: readonly string[], reactive: boolean): string {
  const lines = [
    "out vec4 fragColor;",
    // uReact (0 when idle) is driven live from the audio/motion analysis when reactivity is on.
    ...(reactive ? ["uniform float uReact;"] : []),
    GLSL_HASH.trim(),
    "const float dt = 1.0 / 60.0;",
    "const float damp = 0.98;",
    "void main(){",
    "    vec2 uv = vUV.st;",
    "    vec3 vel = texture(sTD2DInputs[0], uv).xyz;",
    "    vec3 seed = vec3(uv, 0.0);",
    "    vec3 force = vec3(0.0);",
  ];
  if (forces.includes("noise")) {
    lines.push("    force += hash33(seed * 17.0) * 0.5;");
  }
  if (forces.includes("curl")) {
    // Curl of the hash field via central differences — divergence-free swirling.
    lines.push(
      "    float e = 0.01;",
      "    vec3 dx = hash33(seed + vec3(e, 0.0, 0.0)) - hash33(seed - vec3(e, 0.0, 0.0));",
      "    vec3 dy = hash33(seed + vec3(0.0, e, 0.0)) - hash33(seed - vec3(0.0, e, 0.0));",
      "    vec3 dz = hash33(seed + vec3(0.0, 0.0, e)) - hash33(seed - vec3(0.0, 0.0, e));",
      "    vec3 curl = vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);",
      "    force += curl * 1.5;",
    );
  }
  if (forces.includes("gravity")) {
    lines.push("    force += vec3(0.0, -0.6, 0.0);");
  }
  if (reactive) {
    // A per-particle impulse scaled by the live signal: louder audio / more camera motion
    // energises the whole field (uReact stays 0 when the source is quiet, so the field settles).
    lines.push("    force += hash33(seed * 31.0 + vec3(7.0)) * uReact * 6.0;");
  }
  lines.push(
    "    vel = vel * damp + force * dt;",
    "    fragColor = TDOutputSwizzle(vec4(vel, 1.0));",
    "}",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Position-update fragment. Reads previous position (sTD2DInputs[0], from pos_fb) and current
 * velocity (sTD2DInputs[1], from vel_update) and integrates position += velocity * dt.
 *
 * Seeding: a feedbackTOP starts black (all zeros) on its first frame, which would pile every
 * particle at the origin. While the previous position is still ~0 we substitute a hash-spread
 * initial position so the field starts as a cloud. This is a best-effort first-frame seed —
 * see the ⚠ warnings; a more robust seed uses a Reset pulse on pos_fb or a separate seed TOP.
 */
const POSITION_SHADER = `out vec4 fragColor;
${GLSL_HASH.trim()}
const float dt = 1.0 / 60.0;
void main(){
    vec2 uv = vUV.st;
    vec3 pos = texture(sTD2DInputs[0], uv).xyz;
    vec3 vel = texture(sTD2DInputs[1], uv).xyz;
    // First-frame seed: when the feedback buffer is still empty, scatter from a hash.
    if (dot(pos, pos) < 1e-8) {
        pos = hash33(vec3(uv, 1.0)) * 2.0;
    }
    pos += vel * dt;
    fragColor = TDOutputSwizzle(vec4(pos, 1.0));
}
`;

const FORCE_VALUES = ["noise", "gravity", "curl"] as const;

export const createGpuParticleFieldSchema = z.object({
  side: z.coerce
    .number()
    .int()
    .min(16)
    .max(512)
    .default(256)
    .describe(
      "Edge of the square particle buffer; the field is side×side particles (count = side², e.g. 256 → 65 536). Each particle is one texel of the RGBA32float position/velocity buffers.",
    ),
  forces: z
    .array(z.enum(FORCE_VALUES))
    .default(["noise"])
    .describe(
      "In-shader forces added to velocity each frame: 'noise' (per-particle random drift), 'gravity' (constant -Y pull), 'curl' (divergence-free swirling).",
    ),
  reactivity: z
    .enum(["none", "audio", "motion"])
    .default("none")
    .describe(
      "Optional external push that energises the field live, bound to the velocity shader's uReact uniform. 'none' (default) is fully self-contained. 'audio' drives it from mic/line RMS (Audio Device In → Analyze), 'motion' from camera frame-difference energy (Video Device In → mono → cache/difference → average). Either may pop a one-time macOS device-permission dialog — click Allow.",
    ),
  point_size: z.coerce
    .number()
    .positive()
    .default(0.02)
    .describe("Radius of each instanced dot (the sphere/circle SOP scale)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live PointSize and Zoom (camera distance) knobs on the system container.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent network where the particle-field container is created (default '/project1').",
    ),
});
type CreateGpuParticleFieldArgs = z.infer<typeof createGpuParticleFieldSchema>;

export async function createGpuParticleFieldImpl(
  ctx: ToolContext,
  args: CreateGpuParticleFieldArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "gpu_particle_field");
    const { side } = args;
    const bufParams = {
      outputresolution: "custom",
      resolutionw: side,
      resolutionh: side,
      format: "rgba32float",
    } as const;

    // --- VELOCITY loop ---------------------------------------------------------------------
    // vel_fb holds the previous velocity; vel_update reads it, adds forces, writes the new
    // velocity. Close the loop with feedbackTOP.par.top = vel_update (same trick as
    // createFeedbackNetwork). vel_fb is seeded from vel_update so its first frame has an input.
    const velFb = await builder.add("feedbackTOP", "vel_fb");
    const velUpdate = await builder.add("glslTOP", "vel_update", bufParams);
    const velFrag = await builder.add("textDAT", "vel_frag");
    const reactive = args.reactivity !== "none";
    await builder.python(
      `op(${q(velFrag)}).text = ${q(velocityShader(args.forces, reactive))}\nop(${q(velUpdate)}).par.pixeldat = op(${q(velFrag)}).name`,
    );
    await builder.connect(velFb, velUpdate, 0, 0);
    await builder.python(`op(${q(velFb)}).par.top = op(${q(velUpdate)}).name`);

    // --- POSITION loop ---------------------------------------------------------------------
    // pos_fb holds the previous position; pos_update reads it (input 0) plus the current
    // velocity (input 1) and integrates. Close with feedbackTOP.par.top = pos_update.
    const posFb = await builder.add("feedbackTOP", "pos_fb");
    const posUpdate = await builder.add("glslTOP", "pos_update", bufParams);
    const posFrag = await builder.add("textDAT", "pos_frag");
    await builder.python(
      `op(${q(posFrag)}).text = ${q(POSITION_SHADER)}\nop(${q(posUpdate)}).par.pixeldat = op(${q(posFrag)}).name`,
    );
    await builder.connect(posFb, posUpdate, 0, 0);
    await builder.connect(velUpdate, posUpdate, 0, 1);
    await builder.python(`op(${q(posFb)}).par.top = op(${q(posUpdate)}).name`);

    builder.warnings.push(
      "Feedback-loop seeding: both feedbackTOPs start at zero on frame 1; the position shader detects that and hash-scatters the particles into a cloud (validated live). If a fresh load ever collapses to the origin, pulse pos_fb/vel_fb's reset.",
    );

    // --- INSTANCING from the position TOP --------------------------------------------------
    // A Geometry COMP renders a tiny dot once per particle, instanced from the position buffer:
    // each texel's RGB becomes that instance's XYZ translate. The builder clears the COMP's
    // default torus on creation.
    const geo = await builder.add("geometryCOMP", "geo");
    // The dot size lives on the SOP itself (radx/y/z), not on per-instance scale: TOP instancing
    // applies translate but not scale here, so a unit sphere would render full-size and the cloud
    // would collapse into a solid white mass (validated live). A small radius keeps each particle
    // a crisp point.
    const dot = await builder.add(
      "sphereSOP",
      "dot",
      { radx: args.point_size, rady: args.point_size, radz: args.point_size },
      geo,
    );
    await builder.python(`_s = op(${q(dot)})\n_s.render = True\n_s.display = True`);

    // TOP instancing (validated live): instanceop = the position TOP sets the instance COUNT from
    // its texel grid (side² instances); instancetop names the TOP the per-instance translate reads
    // from; instancetx/ty/tz select its R/G/B channels for X/Y/Z. Scale is NOT set here — TOP
    // instancing applies translate only, so per-particle size lives on the dot SOP's radius above.
    await builder.setParams(geo, {
      instancing: 1,
      instanceop: posUpdate,
      instancetop: posUpdate,
      instancetx: "r",
      instancety: "g",
      instancetz: "b",
    });

    // A single near-white material so the dots read against the dark background.
    const mat = await builder.add("constantMAT", "mat");
    await builder.setParams(geo, { material: mat });

    const camDist = 6;
    const cam = await builder.add("cameraCOMP", "cam", { tz: camDist });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 4, tz: 4 });
    // Opaque near-black background so the bright dots are visible (same convention as
    // createParticleSystem). Set bgcolora back to 0 to composite the field over other layers.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      bgcolorr: 0.02,
      bgcolorg: 0.02,
      bgcolorb: 0.05,
      bgcolora: 1,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // --- Optional reactivity: drive the velocity shader's uReact uniform from a live signal ----
    // "none" leaves uReact unset (0) → the field is self-contained. audio/motion build a small
    // analysis chain ending on a single-value CHOP "react_level", then bind vel_update's uReact
    // uniform to it by expression so it updates every frame (the GLSL TOP's per-frame cook pulls
    // the chain, keeping it warm without a separate Execute DAT).
    let reactExpr: string | undefined;
    if (args.reactivity === "audio") {
      // Live mic/line → RMS Power = current loudness. (Creating the device may pop a one-time
      // macOS microphone-permission dialog — click Allow.)
      const audioIn = await builder.add("audiodeviceinCHOP", "audio_in");
      const rms = await builder.add("analyzeCHOP", "audio_rms", { function: "rmspower" });
      await builder.connect(audioIn, rms);
      await builder.add("nullCHOP", "react_level");
      await builder.connect(rms, builder.pathOf("react_level") as string);
      reactExpr = "op('react_level')[0] * 8.0";
    } else if (args.reactivity === "motion") {
      // Camera → frame-to-frame difference → average = motion energy (the create_motion_reactive
      // chain). Creating the camera may pop a one-time macOS camera-permission dialog — click Allow.
      const motionIn = await builder.add("videodeviceinTOP", "motion_in");
      const mono = await builder.add("monochromeTOP", "motion_mono", {
        outputresolution: "custom",
        resolutionw: 160,
        resolutionh: 160,
      });
      await builder.connect(motionIn, mono);
      const cache = await builder.add("cacheTOP", "motion_prev", {
        active: 1,
        cachesize: 2,
        outputindexunit: "indices",
        outputindex: -1,
      });
      await builder.connect(mono, cache);
      const diff = await builder.add("differenceTOP", "motion_diff");
      await builder.connect(mono, diff, 0, 0);
      await builder.connect(cache, diff, 0, 1);
      const energy = await builder.add("analyzeTOP", "motion_energy", { op: "average" });
      await builder.connect(diff, energy);
      await builder.add("toptoCHOP", "react_level", {
        top: energy,
        r: "motion",
        g: "",
        b: "",
        a: "",
      });
      reactExpr = "op('react_level')['motion'] * 40.0";
    }
    if (reactExpr) {
      // Name vel_update's first float uniform "uReact" and drive it from the analysis each frame.
      await builder.python(
        [
          `_v = op(${q(velUpdate)})`,
          "_seq = _v.seq.vec",
          "_seq.numBlocks = max(_seq.numBlocks, 1)",
          '_v.par.vec0name = "uReact"',
          `_v.par.vec0valuex.expr = ${q(reactExpr)}`,
        ].join("\n"),
      );
    }

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            // Resizes every particle by driving the dot SOP's radius (TOP instancing does not
            // apply per-instance scale, so size lives on the source sphere).
            name: "PointSize",
            type: "float",
            min: 0.001,
            max: 0.5,
            default: args.point_size,
            bind_to: [`${dot}.radx`, `${dot}.rady`, `${dot}.radz`],
          },
          {
            name: "Zoom",
            type: "float",
            min: 1,
            max: camDist * 3,
            default: camDist,
            bind_to: [`${cam}.tz`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a GPU particle field: ${side}×${side} = ${side * side} particles via position/velocity feedback TOPs + TOP-instancing (forces: ${args.forces.join(", ") || "none"}, reactivity: ${args.reactivity}), rendered to ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        side,
        count: side * side,
        forces: args.forces,
        reactivity: args.reactivity,
        output_path: out,
      },
    });
  });
}

export const registerCreateGpuParticleField: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_gpu_particle_field",
    {
      title: "Create GPU particle field",
      description:
        "Build a high-count GPU particle / point field: position and velocity are simulated entirely on the GPU in two RGBA32float feedback-TOP loops (velocity integrates forces — noise/curl/gravity; position integrates velocity), then a Geometry COMP instances a tiny dot once per texel, reading XYZ from the position texture. Creates a new baseCOMP under `parent_path` holding the velocity/position feedback loops, the instanced Geometry COMP, Camera, Light, and Render TOP ending in a Null output. Reaches counts (side², up to 512²≈262k) well beyond the CPU create_particle_system (use that for a simpler, lower-count CPU emitter). Exposes PointSize and Zoom knobs. Optional reactivity energises the field live: 'audio' drives it from mic/line RMS, 'motion' from camera frame-difference energy (both bound to the velocity shader's uReact uniform). Returns a summary plus a JSON block with the container path, created node paths, the particle count, the output path, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createGpuParticleFieldSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGpuParticleFieldImpl(ctx, args),
  );
};

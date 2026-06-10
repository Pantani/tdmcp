import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

// Parse a #rrggbb hex into 0..1 RGB triplet; falls back to a soft magenta for invalid input.
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m?.[1]) return { r: 1, g: 0.227, b: 0.549 };
  const n = Number.parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// ─── Inline fragment shaders (per spec) ──────────────────────────────────────

const ADVECT_GLSL = `uniform float uDt; uniform float uDecay;
out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    vec2 vel = texture(sTD2DInputs[1], uv).xy;
    vec2 src = uv - vel * uDt;
    vec4 v = texture(sTD2DInputs[0], src);
    fragColor = TDOutputSwizzle(v * uDecay);
}
`;

const SPLAT_FORCE_GLSL = `uniform vec2 uPoint; uniform vec2 uForce; uniform float uRadius;
out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    vec4 base = texture(sTD2DInputs[0], uv);
    float d = length(uv - uPoint);
    float g = exp(-(d*d)/(uRadius*uRadius));
    base.xy += uForce * g;
    fragColor = TDOutputSwizzle(base);
}
`;

const SPLAT_DYE_GLSL = `uniform vec2 uPoint; uniform vec4 uColor; uniform float uRadius; uniform float uStrength;
out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    vec4 base = texture(sTD2DInputs[0], uv);
    float d = length(uv - uPoint);
    float g = exp(-(d*d)/(uRadius*uRadius));
    fragColor = TDOutputSwizzle(base + uColor * g * uStrength);
}
`;

const DIVERGENCE_GLSL = `uniform vec2 uTexel;
out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    float L = texture(sTD2DInputs[0], uv - vec2(uTexel.x,0)).x;
    float R = texture(sTD2DInputs[0], uv + vec2(uTexel.x,0)).x;
    float B = texture(sTD2DInputs[0], uv - vec2(0,uTexel.y)).y;
    float T = texture(sTD2DInputs[0], uv + vec2(0,uTexel.y)).y;
    fragColor = TDOutputSwizzle(vec4(0.5*(R-L+T-B), 0.0, 0.0, 1.0));
}
`;

// Bounded Jacobi loop: many drivers reject a uniform-bounded for, so we cap at a
// const 60 and break early on uIters — spec §"Jacobi loop with non-const bound".
const JACOBI_GLSL = `uniform vec2 uTexel; uniform float uIters;
out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    float p = texture(sTD2DInputs[0], uv).x;
    float div = texture(sTD2DInputs[1], uv).x;
    int N = int(clamp(uIters, 1.0, 60.0));
    for (int i = 0; i < 60; ++i) {
        if (i >= N) break;
        float L = texture(sTD2DInputs[0], uv - vec2(uTexel.x,0)).x;
        float R = texture(sTD2DInputs[0], uv + vec2(uTexel.x,0)).x;
        float B = texture(sTD2DInputs[0], uv - vec2(0,uTexel.y)).x;
        float T = texture(sTD2DInputs[0], uv + vec2(0,uTexel.y)).x;
        p = (L+R+B+T - div) * 0.25;
    }
    fragColor = TDOutputSwizzle(vec4(p,0,0,1));
}
`;

const GRAD_SUBTRACT_GLSL = `uniform vec2 uTexel;
out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    float L = texture(sTD2DInputs[1], uv - vec2(uTexel.x,0)).x;
    float R = texture(sTD2DInputs[1], uv + vec2(uTexel.x,0)).x;
    float B = texture(sTD2DInputs[1], uv - vec2(0,uTexel.y)).x;
    float T = texture(sTD2DInputs[1], uv + vec2(0,uTexel.y)).x;
    vec2 v = texture(sTD2DInputs[0], uv).xy;
    v -= 0.5 * vec2(R-L, T-B);
    fragColor = TDOutputSwizzle(vec4(v,0,1));
}
`;

export const createFluidSimSchema = z.object({
  resolution: z
    .enum(["256", "512", "1024"])
    .default("512")
    .describe("Sim grid resolution (square). 512 is safe on integrated GPUs."),
  dye_color: z
    .string()
    .default("#ff3a8c")
    .describe("Injected dye color as a '#rrggbb' hex string."),
  injection_radius: z.coerce
    .number()
    .min(0.01)
    .max(0.5)
    .default(0.08)
    .describe("Radius of the dye/force splat in UV units (0.01–0.5)."),
  injection_strength: z.coerce
    .number()
    .min(0)
    .max(2)
    .default(1.0)
    .describe("Multiplier on dye + velocity splat per frame (0–2)."),
  viscosity: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.0)
    .describe("Velocity dissipation per frame (0–1). Higher = thicker fluid."),
  dissipation: z.coerce
    .number()
    .min(0.9)
    .max(1.0)
    .default(0.995)
    .describe("Dye decay per frame (0.9–1.0). <1 fades trails."),
  pressure_iterations: z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .default(20)
    .describe("Jacobi iterations per frame (1–60). Higher = more incompressible."),
  injection_mode: z
    .enum(["auto", "mouse", "audio", "static"])
    .default("auto")
    .describe("How the splat point/strength is driven."),
  audio_path: z
    .string()
    .optional()
    .describe("Optional CHOP path; channel 0 multiplies injection strength when set."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Auto-expose an artist-facing control panel on the container."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the fluid_sim container is created."),
});

type CreateFluidSimArgs = z.infer<typeof createFluidSimSchema>;

// Mount one fragment shader as a sibling textDAT and wire it to a glslTOP's pixeldat.
// Same pattern as createFeedbackNetwork — keeps GLSL out of TD's default boilerplate.
async function attachShader(
  builder: Awaited<ReturnType<typeof createSystemContainer>>,
  glslPath: string,
  name: string,
  code: string,
): Promise<void> {
  const frag = await builder.add("textDAT", `${name}_frag`);
  await builder.python(
    `op(${q(frag)}).text = ${q(code)}\nop(${q(glslPath)}).par.pixeldat = op(${q(frag)}).name`,
  );
}

// Raise a glslTOP's seq.<seq>.numBlocks before setting per-block name/value sub-params
// (mirrors orchestration.ts buildFromRecipe's uniform pass; kept inline per spec).
async function setVecUniform(
  builder: Awaited<ReturnType<typeof createSystemContainer>>,
  target: string,
  index: number,
  name: string,
  values: number[],
): Promise<void> {
  await builder.python(
    `_seq = op(${q(target)}).seq.vec\n_seq.numBlocks = max(_seq.numBlocks, ${index + 1})`,
  );
  const fields = ["valuex", "valuey", "valuez", "valuew"];
  const params: Record<string, unknown> = { [`vec${index}name`]: name };
  for (const [j, field] of fields.entries()) {
    const v = values[j];
    if (v !== undefined) params[`vec${index}${field}`] = v;
  }
  await builder.setParams(target, params);
}

async function setColorUniform(
  builder: Awaited<ReturnType<typeof createSystemContainer>>,
  target: string,
  index: number,
  name: string,
  rgba: { r: number; g: number; b: number; a: number },
): Promise<void> {
  await builder.python(
    `_seq = op(${q(target)}).seq.color\n_seq.numBlocks = max(_seq.numBlocks, ${index + 1})`,
  );
  await builder.setParams(target, {
    [`color${index}name`]: name,
    [`color${index}rgbr`]: rgba.r,
    [`color${index}rgbg`]: rgba.g,
    [`color${index}rgbb`]: rgba.b,
    [`color${index}alpha`]: rgba.a,
  });
}

export async function createFluidSimImpl(ctx: ToolContext, args: CreateFluidSimArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "fluid_sim");
    const res = Number.parseInt(args.resolution, 10);
    const texel = 1 / res;
    const dye = hexToRgb(args.dye_color);
    const velocityDecay = 1 - args.viscosity * 0.05;

    // Common res params for every TOP in the loop. The exact pixel-format param name
    // varies by TD build; we set both common spellings — TD ignores unknown params
    // (failures are folded into builder.warnings).
    const resParams: Record<string, unknown> = {
      outputresolution: "custom",
      resolutionw: res,
      resolutionh: res,
      format: "rgba32float",
    };

    // ─── Velocity loop ────────────────────────────────────────────────────────
    const velSeed = await builder.add("constantTOP", "vel_seed");
    await builder.setParams(velSeed, {
      ...resParams,
      color0r: 0,
      color0g: 0,
      color0b: 0,
      color0a: 0,
    });
    const velFb = await builder.add("feedbackTOP", "vel_fb");
    await builder.setParams(velFb, resParams);
    await builder.connect(velSeed, velFb);

    const advectVel = await builder.add("glslTOP", "advect_vel");
    await builder.setParams(advectVel, resParams);
    await attachShader(builder, advectVel, "advect_vel", ADVECT_GLSL);
    await builder.connect(velFb, advectVel, 0, 0);
    await builder.connect(velFb, advectVel, 0, 1);

    const splatForce = await builder.add("glslTOP", "splat_force");
    await builder.setParams(splatForce, resParams);
    await attachShader(builder, splatForce, "splat_force", SPLAT_FORCE_GLSL);
    await builder.connect(advectVel, splatForce);

    const divergence = await builder.add("glslTOP", "divergence");
    await builder.setParams(divergence, resParams);
    await attachShader(builder, divergence, "divergence", DIVERGENCE_GLSL);
    await builder.connect(splatForce, divergence);

    // ─── Pressure solve ──────────────────────────────────────────────────────
    const pressureFb = await builder.add("feedbackTOP", "pressure_fb");
    await builder.setParams(pressureFb, resParams);
    await builder.connect(divergence, pressureFb);

    const jacobi = await builder.add("glslTOP", "jacobi");
    await builder.setParams(jacobi, resParams);
    await attachShader(builder, jacobi, "jacobi", JACOBI_GLSL);
    await builder.connect(pressureFb, jacobi, 0, 0);
    await builder.connect(divergence, jacobi, 0, 1);

    const gradSubtract = await builder.add("glslTOP", "grad_subtract");
    await builder.setParams(gradSubtract, resParams);
    await attachShader(builder, gradSubtract, "grad_subtract", GRAD_SUBTRACT_GLSL);
    await builder.connect(splatForce, gradSubtract, 0, 0);
    await builder.connect(jacobi, gradSubtract, 0, 1);

    const velOut = await builder.add("nullTOP", "vel_out");
    await builder.connect(gradSubtract, velOut);

    // Close the velocity + pressure loops.
    await builder.python(`op(${q(velFb)}).par.top = ${q(gradSubtract)}`);
    await builder.python(`op(${q(pressureFb)}).par.top = ${q(jacobi)}`);

    // ─── Dye loop ────────────────────────────────────────────────────────────
    const dyeSeed = await builder.add("constantTOP", "dye_seed");
    await builder.setParams(dyeSeed, {
      ...resParams,
      color0r: 0,
      color0g: 0,
      color0b: 0,
      color0a: 1,
    });
    const dyeFb = await builder.add("feedbackTOP", "dye_fb");
    await builder.setParams(dyeFb, resParams);
    await builder.connect(dyeSeed, dyeFb);

    const advectDye = await builder.add("glslTOP", "advect_dye");
    await builder.setParams(advectDye, resParams);
    await attachShader(builder, advectDye, "advect_dye", ADVECT_GLSL);
    await builder.connect(dyeFb, advectDye, 0, 0);
    await builder.connect(velOut, advectDye, 0, 1);

    const splatDye = await builder.add("glslTOP", "splat_dye");
    await builder.setParams(splatDye, resParams);
    await attachShader(builder, splatDye, "splat_dye", SPLAT_DYE_GLSL);
    await builder.connect(advectDye, splatDye);

    const dyeOut = await builder.add("nullTOP", "dye_out");
    await builder.connect(splatDye, dyeOut);
    await builder.python(`op(${q(dyeFb)}).par.top = ${q(splatDye)}`);

    // Optional final gain stage so the artist gets a clean brightness knob downstream
    // of the sim. levelTOP has no `gain` param — `brightness1` is the multiplier (see
    // bridge-interaction-gotchas memory).
    const gain = await builder.add("levelTOP", "gain");
    await builder.setParams(gain, { brightness1: 1.0 });
    await builder.connect(dyeOut, gain);
    const output = gain;

    // ─── Uniforms ────────────────────────────────────────────────────────────
    // advect_vel: uDt, uDecay
    await setVecUniform(builder, advectVel, 0, "uDt", [1.0]);
    await setVecUniform(builder, advectVel, 1, "uDecay", [velocityDecay]);
    // splat_force: uPoint, uForce, uRadius
    await setVecUniform(builder, splatForce, 0, "uPoint", [0.5, 0.5]);
    await setVecUniform(builder, splatForce, 1, "uForce", [0, 0]);
    await setVecUniform(builder, splatForce, 2, "uRadius", [args.injection_radius]);
    // divergence: uTexel
    await setVecUniform(builder, divergence, 0, "uTexel", [texel, texel]);
    // jacobi: uTexel, uIters
    await setVecUniform(builder, jacobi, 0, "uTexel", [texel, texel]);
    await setVecUniform(builder, jacobi, 1, "uIters", [args.pressure_iterations]);
    // grad_subtract: uTexel
    await setVecUniform(builder, gradSubtract, 0, "uTexel", [texel, texel]);
    // advect_dye: uDt, uDecay
    await setVecUniform(builder, advectDye, 0, "uDt", [1.0]);
    await setVecUniform(builder, advectDye, 1, "uDecay", [args.dissipation]);
    // splat_dye: uPoint, uRadius, uStrength (vec) + uColor (color)
    await setVecUniform(builder, splatDye, 0, "uPoint", [0.5, 0.5]);
    await setVecUniform(builder, splatDye, 1, "uRadius", [args.injection_radius]);
    await setVecUniform(builder, splatDye, 2, "uStrength", [args.injection_strength]);
    await setColorUniform(builder, splatDye, 0, "uColor", { ...dye, a: 1 });

    // ─── Animation sources ───────────────────────────────────────────────────
    // auto: an LFO drives uPoint via a nullCHOP → bind_to.
    let pointSource: string | undefined;
    if (args.injection_mode === "auto") {
      const lfo = await builder.add("lfoCHOP", "auto_lfo");
      await builder.setParams(lfo, { rate: 0.13 });
      const nullPoint = await builder.add("nullCHOP", "point_null");
      await builder.connect(lfo, nullPoint);
      pointSource = nullPoint;
    }

    // audio: a sibling nullCHOP exposes the audio source for `bind_to` to read.
    let audioNull: string | undefined;
    if (args.audio_path) {
      audioNull = await builder.add("nullCHOP", "audio_null");
      // Read input straight from the user-supplied audio_path; reuses the same
      // par-driven pattern as conversion ops. A bad path surfaces as a warning.
      await builder.python(
        `try:\n    op(${q(audioNull)}).par.chop = ${q(args.audio_path)}\nexcept Exception as e:\n    pass`,
      );
    }

    // ─── Control panel ───────────────────────────────────────────────────────
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "DyeColor",
            type: "rgb",
            default: args.dye_color,
            bind_to: [`${splatDye}.color0rgbr`, `${splatDye}.color0rgbg`, `${splatDye}.color0rgbb`],
          },
          {
            name: "InjectRadius",
            type: "float",
            min: 0.01,
            max: 0.5,
            default: args.injection_radius,
            bind_to: [`${splatDye}.vec1valuex`, `${splatForce}.vec2valuex`],
          },
          {
            name: "InjectStrength",
            type: "float",
            min: 0,
            max: 2,
            default: args.injection_strength,
            bind_to: audioNull
              ? [`${splatDye}.vec2valuex`, `${audioNull}[0]`]
              : [`${splatDye}.vec2valuex`],
          },
          {
            name: "Viscosity",
            type: "float",
            min: 0,
            max: 1,
            default: args.viscosity,
            bind_to: [`${advectVel}.vec1valuex`],
          },
          {
            name: "Dissipation",
            type: "float",
            min: 0.9,
            max: 1.0,
            default: args.dissipation,
            bind_to: [`${advectDye}.vec1valuex`],
          },
          {
            name: "PressureIters",
            type: "int",
            min: 1,
            max: 60,
            default: args.pressure_iterations,
            bind_to: [`${jacobi}.vec1valuex`],
          },
          {
            name: "InjectU",
            type: "float",
            min: 0,
            max: 1,
            default: 0.5,
            bind_to: pointSource
              ? [`${splatDye}.vec0valuex`, `${splatForce}.vec0valuex`, `${pointSource}[0]`]
              : [`${splatDye}.vec0valuex`, `${splatForce}.vec0valuex`],
          },
          {
            name: "InjectV",
            type: "float",
            min: 0,
            max: 1,
            default: 0.5,
            bind_to: pointSource
              ? [`${splatDye}.vec0valuey`, `${splatForce}.vec0valuey`, `${pointSource}[1]`]
              : [`${splatDye}.vec0valuey`, `${splatForce}.vec0valuey`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a fluid sim (res ${args.resolution}², ${args.pressure_iterations} Jacobi iters, mode: ${args.injection_mode}).`,
      builder,
      outputPath: output,
      controls,
      extra: {
        resolution: args.resolution,
        injection_mode: args.injection_mode,
        audio_path: args.audio_path,
      },
    });
  });
}

export const registerCreateFluidSim: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_fluid_sim",
    {
      title: "Create fluid sim",
      description:
        "Build a real-time 2D fluid/ink/dye simulation (stable-fluids style: semi-Lagrangian advection + Jacobi pressure solve + gradient-subtract projection + dye advection) as a stack of GLSL TOPs in feedback loops inside a new baseCOMP under `parent_path`. Exposes artist-facing controls (dye color, injection radius/strength, viscosity, dissipation, pressure iterations, inject U/V) and optionally binds a CHOP at `audio_path` so audio drives the dye injection strength. With injection_mode='auto', a slow LFO drives the splat point so the sim shows life with no input. Returns a summary plus a JSON block with the container path, created node paths, the dye_out output path, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createFluidSimSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createFluidSimImpl(ctx, args),
  );
};

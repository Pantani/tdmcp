import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createTransitionSchema = z.object({
  name: z.string().default("transition").describe("Name for the transition system COMP."),
  parent_path: z.string().default("/project1").describe("Where to build it."),
  source_a: z
    .string()
    .optional()
    .describe(
      "TOP path for the A (outgoing) look. Omitted → a built-in test source (Constant/ramp) so it previews standalone.",
    ),
  source_b: z
    .string()
    .optional()
    .describe("TOP path for the B (incoming) look. Omitted → a contrasting built-in test source."),
  style: z
    .enum(["dissolve", "luma_wipe", "slide", "zoom", "glitch_cut"])
    .default("dissolve")
    .describe(
      "Transition style: dissolve (crossfade), luma_wipe (gradient-driven edge), slide (B pushes A), zoom (B scales in), glitch_cut (RGB-shift hard cut).",
    ),
  progress: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Initial transition position 0=full A, 1=full B (exposed as a live knob)."),
  duration: z.coerce
    .number()
    .min(0)
    .default(2)
    .describe(
      "Seconds for an auto Progress sweep when triggered (exposed as a knob; the knob can also be driven by manage_cue/bind_to_channel).",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [w,h]."),
});
type CreateTransitionArgs = z.infer<typeof createTransitionSchema>;

/**
 * GLSL pass that drives the luma-wipe matte. A and B arrive on inputs 0/1 and a vertical
 * gradient (a Ramp TOP) on input 2; the matte edge is `smoothstep` across the ramp's
 * luminance, centred on `uProgress`, so as Progress sweeps 0→1 the wipe edge travels across
 * the frame. `uSoft` widens the edge feather. Declares its own `out vec4 fragColor`,
 * writes through `TDOutputSwizzle`, reads inputs via `sTD2DInputs[i]`. Lowercase locals
 * avoid colliding with macros in TD's auto-prepended GLSL preamble.
 *
 * UNVERIFIED (TD offline): the exact look of the moving edge (gradient orientation, feather)
 * cannot be confirmed live — the math is the robust primitive (smoothstep over a Ramp's
 * luma) but the wipe direction/softness may need tuning against a real cook.
 */
const LUMA_WIPE_SHADER = `out vec4 fragColor;
uniform float uProgress;
uniform float uSoft;
void main(){
    vec2 uv = vUV.st;
    vec4 a = texture(sTD2DInputs[0], uv);
    vec4 b = texture(sTD2DInputs[1], uv);
    vec4 ramp = texture(sTD2DInputs[2], uv);
    float grad = dot(ramp.rgb, vec3(0.299, 0.587, 0.114));
    // Edge travels with uProgress (re-mapped so progress 0 shows all A, 1 shows all B even
    // with a feather). smoothstep gives a soft, anti-aliased wipe edge.
    float soft = max(uSoft, 0.001);
    float p = uProgress * (1.0 + soft) - soft * 0.5;
    float matte = smoothstep(p - soft * 0.5, p + soft * 0.5, grad);
    fragColor = TDOutputSwizzle(mix(a, b, matte));
}
`;

/**
 * GLSL pass for the glitch cut. A and B arrive on inputs 0/1; the output hard-switches from
 * A to B at `uProgress` >= 0.5, and near the cut (a narrow window around 0.5) it adds a
 * horizontal per-channel RGB split that peaks at the midpoint and fades out — a brief
 * digital tear at the moment of the cut. Self-contained, TD-ready fragment shader.
 */
const GLITCH_CUT_SHADER = `out vec4 fragColor;
uniform float uProgress;
uniform float uShift;
void main(){
    vec2 uv = vUV.st;
    // Hard cut at the midpoint.
    float pick = step(0.5, uProgress);
    // RGB-split intensity peaks at progress 0.5 and fades to 0 by ~0.35/0.65 (a brief tear).
    float nearCut = 1.0 - smoothstep(0.0, 0.15, abs(uProgress - 0.5));
    float o = uShift * nearCut;
    vec4 base = mix(
        vec4(texture(sTD2DInputs[0], uv + vec2(o, 0.0)).r,
             texture(sTD2DInputs[0], uv).g,
             texture(sTD2DInputs[0], uv - vec2(o, 0.0)).b,
             texture(sTD2DInputs[0], uv).a),
        vec4(texture(sTD2DInputs[1], uv + vec2(o, 0.0)).r,
             texture(sTD2DInputs[1], uv).g,
             texture(sTD2DInputs[1], uv - vec2(o, 0.0)).b,
             texture(sTD2DInputs[1], uv).a),
        pick);
    fragColor = TDOutputSwizzle(base);
}
`;

/** Sets a parameter to an expression that reads the container's Progress knob (with a
 * build-time fallback so it never errors before the control is exposed). Mirrors the
 * defensive `parent().par.X` pattern used across the Layer-1 generators. */
function progressExpr(fallback: number): string {
  return `(parent().par.Progress.eval() if hasattr(parent().par, 'Progress') else ${fallback})`;
}

/**
 * Brings a source TOP in by reference (a Select TOP, since wires can't cross COMPs), or
 * synthesises a contrasting built-in test source so the transition previews standalone:
 * a flat Constant for A, a Ramp gradient for B — two visually distinct looks.
 */
async function buildSource(
  builder: NetworkBuilder,
  path: string | undefined,
  fallbackType: "constantTOP" | "rampTOP",
  fallbackName: string,
  res: readonly [number, number],
): Promise<string> {
  if (path) {
    return builder.add("selectTOP", fallbackName, { top: path });
  }
  const params: Record<string, unknown> =
    fallbackType === "constantTOP"
      ? { colorr: 0.1, colorg: 0.3, colorb: 0.8, resolutionw: res[0], resolutionh: res[1] }
      : { resolutionw: res[0], resolutionh: res[1] };
  return builder.add(fallbackType, fallbackName, params);
}

/** Emits Python that sets one GLSL uniform block (name + first component) to a live
 * expression on the caller's `_g` (the GLSL TOP). The Vectors sequence (`vec`) has no
 * structured setter for numBlocks, so the caller raises it (and binds `_g`) first. */
function setUniformExpr(index: number, name: string, expr: string): string {
  return [
    `_g.par.vec${index}name = ${q(name)}`,
    `_g.par.vec${index}valuex.expr = ${q(expr)}`,
    `_g.par.vec${index}valuex.mode = type(_g.par.vec${index}valuex.mode).EXPRESSION`,
  ].join("\n");
}

export async function createTransitionImpl(ctx: ToolContext, args: CreateTransitionArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const res = args.resolution;

    // Two sources brought in (or built-in test looks): A = flat colour Constant, B = Ramp.
    const srcA = await buildSource(builder, args.source_a, "constantTOP", "sel_a", res);
    const srcB = await buildSource(builder, args.source_b, "rampTOP", "sel_b", res);

    let output: string;
    const extra: Record<string, unknown> = {};
    const unverified: string[] = [];

    if (args.style === "dissolve") {
      // Simplest, mechanically safe: a Cross TOP whose `cross` (0=A, 1=B) is the Progress knob.
      const cross = await builder.add("crossTOP", "dissolve", { cross: args.progress });
      await builder.connect(srcA, cross, 0, 0);
      await builder.connect(srcB, cross, 0, 1);
      await builder.python(
        `_p = op(${q(cross)}).par.cross\n_p.expr = ${q(progressExpr(args.progress))}\n_p.mode = type(_p.mode).EXPRESSION`,
      );
      output = cross;
    } else if (args.style === "slide") {
      // B slides in from the right: Transform TOP tx goes 1→0 as Progress 0→1, composited
      // over A (operand 'over', B on input 1 = on top). Mechanically safe (transformTOP `tx`).
      const slide = await builder.add("transformTOP", "slide", { tx: 1, ty: 0 });
      await builder.connect(srcB, slide);
      await builder.python(
        `_p = op(${q(slide)}).par.tx\n_p.expr = ${q(`(1.0 - ${progressExpr(args.progress)})`)}\n_p.mode = type(_p.mode).EXPRESSION`,
      );
      const comp = await builder.add("compositeTOP", "comp", { operand: "over" });
      await builder.connect(srcA, comp, 0, 0);
      await builder.connect(slide, comp, 0, 1);
      output = comp;
      extra.slide = slide;
    } else if (args.style === "zoom") {
      // B scales up from 0→1 (Transform TOP sx/sy) as Progress 0→1, composited over A.
      // Mechanically safe (transformTOP `sx`/`sy`, as in create_kinetic_text).
      const zoom = await builder.add("transformTOP", "zoom", { sx: 0, sy: 0 });
      await builder.connect(srcB, zoom);
      await builder.python(
        [
          `_t = op(${q(zoom)})`,
          `for _name in ('sx', 'sy'):`,
          `    _p = getattr(_t.par, _name)`,
          `    _p.expr = ${q(progressExpr(args.progress))}`,
          `    _p.mode = type(_p.mode).EXPRESSION`,
        ].join("\n"),
      );
      const comp = await builder.add("compositeTOP", "comp", { operand: "over" });
      await builder.connect(srcA, comp, 0, 0);
      await builder.connect(zoom, comp, 0, 1);
      output = comp;
      extra.zoom = zoom;
    } else if (args.style === "glitch_cut") {
      // A hard A→B switch at Progress >= 0.5 plus a brief RGB-split tear around the cut,
      // done in one GLSL pass (A on input 0, B on input 1). Reuses the create_glitch
      // inline-GLSL pattern (out fragColor + TDOutputSwizzle + bound vec uniforms).
      const glsl = await builder.add("glslTOP", "glitch_cut");
      const frag = await builder.add("textDAT", "glitch_cut_frag");
      await builder.python(
        `op(${q(frag)}).text = ${q(GLITCH_CUT_SHADER)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
      );
      await builder.connect(srcA, glsl, 0, 0);
      await builder.connect(srcB, glsl, 0, 1);
      await builder.python(
        [
          `_g = op(${q(glsl)})`,
          `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 2)`,
          setUniformExpr(0, "uProgress", progressExpr(args.progress)),
          setUniformExpr(1, "uShift", "0.03"),
        ].join("\n"),
      );
      output = glsl;
      extra.shader = frag;
    } else {
      // luma_wipe — a gradient-driven moving edge. A Ramp TOP is the gradient; a single GLSL
      // pass mixes A (input 0) and B (input 1) by a smoothstep matte over the ramp's luma,
      // centred on Progress. The matte math is the robust primitive but the edge look is
      // UNVERIFIED pending a live cook (see LUMA_WIPE_SHADER). Built defensively so a wrong
      // feather still yields a clean A↔B blend at the extremes.
      const ramp = await builder.add("rampTOP", "wipe_ramp", {
        resolutionw: res[0],
        resolutionh: res[1],
      });
      const glsl = await builder.add("glslTOP", "luma_wipe");
      const frag = await builder.add("textDAT", "luma_wipe_frag");
      await builder.python(
        `op(${q(frag)}).text = ${q(LUMA_WIPE_SHADER)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
      );
      await builder.connect(srcA, glsl, 0, 0);
      await builder.connect(srcB, glsl, 0, 1);
      await builder.connect(ramp, glsl, 0, 2);
      await builder.python(
        [
          `_g = op(${q(glsl)})`,
          `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 2)`,
          setUniformExpr(0, "uProgress", progressExpr(args.progress)),
          setUniformExpr(1, "uSoft", "0.15"),
        ].join("\n"),
      );
      output = glsl;
      extra.ramp = ramp;
      extra.shader = frag;
      unverified.push(
        "luma_wipe matte edge (gradient orientation + feather) is UNVERIFIED pending a live cook — built on the robust smoothstep-over-Ramp-luma primitive; tune uSoft/ramp direction in TD if the wipe edge isn't clean.",
      );
    }

    // Output Null, sized to the requested resolution so downstream stages inherit it.
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);

    // Progress is the headline knob (and the cue/audio bind target). Duration is a hint for
    // an external auto-sweep (manage_cue / bind_to_channel) — exposed as a knob but not wired
    // to a clock here, so any driver can ramp Progress over that many seconds.
    const controls: ControlSpec[] = [
      { name: "Progress", type: "float", min: 0, max: 1, default: args.progress },
      { name: "Duration", type: "float", min: 0, max: 30, default: args.duration },
    ];

    if (unverified.length) extra.unverified = unverified;

    return finalize(ctx, {
      summary: `Built a "${args.style}" A→B transition over a Progress knob (0=A, 1=B) → ${out}. Sweep op('${builder.containerPath}').par.Progress from 0→1 (over ~${args.duration}s, or drive it from manage_cue/bind_to_channel) to run the transition.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        style: args.style,
        progress: args.progress,
        duration: args.duration,
        source_a: args.source_a ?? "built-in constant",
        source_b: args.source_b ?? "built-in ramp",
        src_a: srcA,
        src_b: srcB,
        output_path: out,
        ...extra,
      },
    });
  });
}

export const registerCreateTransition: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_transition",
    {
      title: "Create transition (A→B)",
      description:
        "Build a parameterized A→B transition over a single 0–1 Progress knob — the executable core of VJ cutting. Creates a new baseCOMP under `parent_path` holding two sources (brought in via Select TOPs, or built-in contrasting test looks when omitted) and one of five transition styles: 'dissolve' (a Cross TOP crossfade), 'luma_wipe' (a Ramp-gradient-driven moving edge via GLSL), 'slide' (B pushes in from the right over A), 'zoom' (B scales in over A), or 'glitch_cut' (a hard A→B switch at 0.5 with a brief RGB-split tear). Progress 0 = full A, 1 = full B. Exposes live 'Progress' + 'Duration' knobs; drive Progress from manage_cue / bind_to_channel to run the transition on a beat or cue. Output is a Null ready for post-processing or setup_output. Returns a summary plus a JSON block with the container path, created node paths, the output path, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createTransitionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTransitionImpl(ctx, args),
  );
};

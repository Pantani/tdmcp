import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * The glitch look itself: per-channel horizontal RGB displacement plus noise-driven
 * horizontal band tearing, all scaled by a master amount. This is a self-contained,
 * TouchDesigner-ready fragment shader:
 *   - declares its own `out vec4 fragColor` and writes through `TDOutputSwizzle(...)`
 *     (required by the GLSL TOP);
 *   - reads the input via `sTD2DInputs[0]` and aspect via `uTD2DInfos[0].res` (built in,
 *     no binding needed);
 *   - reads three bound uniforms — `uShift` (per-channel offset in UV), `uAmount` (master
 *     intensity 0..1) and `uTime` (advances with absTime) — bound by buildGlsl below.
 * Variable names are lowercase to avoid colliding with macros in TD's auto-prepended GLSL
 * preamble (UPPERCASE short names like F1/F2 are reserved there).
 */
const GLITCH_SHADER = `out vec4 fragColor;
uniform float uShift;
uniform float uAmount;
uniform float uTime;
float hash11(float x){ return fract(sin(x * 127.1) * 43758.5453); }
void main(){
    vec2 uv = vUV.st;

    // Horizontal band tearing: quantise Y into bands, jump a subset of them sideways.
    // The active set drifts with uTime so the corruption flickers rather than holds still.
    float band = floor(uv.y * 24.0);
    // NB: 'active' is a reserved word in TD's GLSL — use a non-reserved name.
    float bandOn = step(0.72, hash11(band * 1.7 + floor(uTime * 8.0)));
    float tear = (hash11(band + floor(uTime * 8.0)) - 0.5) * 0.18 * bandOn;
    vec2 tuv = uv + vec2(tear * uAmount, 0.0);

    // Chromatic RGB split: sample R/G/B at increasing horizontal offsets. uShift is the
    // base channel offset in UV; uAmount scales the whole effect so 0 is a clean passthrough.
    float o = uShift * uAmount;
    float r = texture(sTD2DInputs[0], tuv + vec2(o, 0.0)).r;
    float g = texture(sTD2DInputs[0], tuv).g;
    float b = texture(sTD2DInputs[0], tuv - vec2(o, 0.0)).b;
    float a = texture(sTD2DInputs[0], tuv).a;
    fragColor = TDOutputSwizzle(vec4(r, g, b, a));
}
`;

export const createGlitchSchema = z.object({
  amount: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "Master glitch intensity (0..1). Scales both the block/slice displacement and the RGB channel split — 0 is a clean passthrough. Exposed as the 'Amount' knob and is the parameter to bind to audio/beat later.",
    ),
  speed: z.coerce
    .number()
    .min(0)
    .default(1)
    .describe(
      "Animation speed of the noise that drives the blocky tearing (drives the noise's tz).",
    ),
  rgb_shift: z.coerce
    .number()
    .min(0)
    .default(0.02)
    .describe(
      "Base per-channel horizontal offset in UV space (0..~0.1 is a useful range). Multiplied by Amount.",
    ),
  block_size: z.coerce
    .number()
    .positive()
    .default(8)
    .describe(
      "Scale of the displacement noise — smaller = larger, blockier tears; larger = finer grain. Sets the noise's period.",
    ),
  seed: z.coerce.number().default(1).describe("Random seed for the displacement noise."),
  input_path: z
    .string()
    .optional()
    .describe(
      "Absolute path of an existing TOP to glitch (e.g. '/project1/render/out1'). Pulled in via a Select TOP because wires cannot cross COMPs. If omitted, a self-contained animated colour-noise source is used so the system builds with zero device permissions (NOT a live webcam).",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live Amount/Speed/RGBShift/BlockSize knobs on the system container."),
  parent_path: z.string().default("/project1"),
});
type CreateGlitchArgs = z.infer<typeof createGlitchSchema>;

/**
 * The source TOP the glitch stack operates on. With an input_path we bring the external TOP
 * in by reference through a Select TOP (wires can't cross COMPs). Otherwise we synthesise a
 * coloured, animated noise field — a non-device source that needs no permissions and gives
 * the RGB-split/displace something with structure and hue to chew on (unlike a live webcam,
 * which can hang TD on a macOS permission modal).
 */
async function buildSource(builder: NetworkBuilder, args: CreateGlitchArgs): Promise<string> {
  if (args.input_path) {
    const select = await builder.add("selectTOP", "source");
    await builder.setParams(select, { top: args.input_path });
    return select;
  }
  // Coloured (non-monochrome) noise so the per-channel RGB split reads as colour fringing,
  // not just a grayscale smear. A slow drift keeps the test source alive on screen.
  const src = await builder.add("noiseTOP", "source", { monochrome: 0, period: 4 });
  await builder.python(
    `_p = op(${q(src)}).par.tz\n_PM = type(_p.mode)\n_p.expr = ${q("absTime.seconds * 0.15")}\n_p.mode = _PM.EXPRESSION`,
  );
  return src;
}

export async function createGlitchImpl(ctx: ToolContext, args: CreateGlitchArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "glitch");

    const source = await buildSource(builder, args);

    // Low-res, animated monochrome noise drives the blocky displacement. block_size sets its
    // period (spatial scale → block size); seed seeds it; tz drifts it over time at `speed`
    // so the tears move. A small resolution keeps the blocks chunky and the cook cheap.
    const driver = await builder.add("noiseTOP", "driver", {
      monochrome: 1,
      period: args.block_size,
      seed: args.seed,
      resolutionw: 64,
      resolutionh: 64,
      outputresolution: "custom",
    });
    await builder.python(
      `_p = op(${q(driver)}).par.tz\n_PM = type(_p.mode)\n_p.expr = ${q(`absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${args.speed})`)}\n_p.mode = _PM.EXPRESSION`,
    );

    // Block/slice displacement: input 0 = the source, input 1 = the noise driver (both wired —
    // a displaceTOP reads its displacement from input 1, not a source parameter). uvweight scales
    // how far pixels are pushed; bind it to Amount so the master knob drives the tearing strength.
    const displace = await builder.add("displaceTOP", "displace", { uvweight: args.amount * 0.2 });
    await builder.connect(source, displace, 0, 0);
    await builder.connect(driver, displace, 0, 1);
    // Let the Amount control drive displacement strength live (defensive lookup so the
    // expression never errors when no control is exposed). 0.2 keeps the max push tasteful.
    await builder.python(
      `_p = op(${q(displace)}).par.uvweight\n_PM = type(_p.mode)\n_p.expr = ${q(`0.2 * (parent().par.Amount.eval() if hasattr(parent().par, 'Amount') else ${args.amount})`)}\n_p.mode = _PM.EXPRESSION`,
    );

    // RGB channel split + horizontal band tearing in one GLSL pass over the displaced image.
    const rgbshift = await builder.add("glslTOP", "rgbshift");
    const frag = await builder.add("textDAT", "rgbshift_frag");
    await builder.python(
      `op(${q(frag)}).text = ${q(GLITCH_SHADER)}\nop(${q(rgbshift)}).par.pixeldat = op(${q(frag)}).name`,
    );
    await builder.connect(displace, rgbshift);
    // Bind the three uniforms. They live in the GLSL TOP's "Vectors" sequence (the `vec`
    // sequence), whose block count has no structured setter — raise numBlocks, then set each
    // block's name and its first component. uShift/uAmount get expressions referencing the
    // auto-exposed controls (defensive `parent().par.X` lookups, falling back to build-time
    // constants); uTime advances with absTime so the tearing animates.
    await builder.python(
      [
        `_g = op(${q(rgbshift)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 3)`,
        `_g.par.vec0name = 'uShift'`,
        `_g.par.vec0valuex.expr = ${q(`(parent().par.Rgbshift.eval() if hasattr(parent().par, 'Rgbshift') else ${args.rgb_shift})`)}`,
        `_g.par.vec0valuex.mode = type(_g.par.vec0valuex.mode).EXPRESSION`,
        `_g.par.vec1name = 'uAmount'`,
        `_g.par.vec1valuex.expr = ${q(`(parent().par.Amount.eval() if hasattr(parent().par, 'Amount') else ${args.amount})`)}`,
        `_g.par.vec1valuex.mode = type(_g.par.vec1valuex.mode).EXPRESSION`,
        `_g.par.vec2name = 'uTime'`,
        `_g.par.vec2valuex.expr = 'absTime.seconds'`,
        `_g.par.vec2valuex.mode = type(_g.par.vec2valuex.mode).EXPRESSION`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(rgbshift, out);

    // Amount is the headline knob (and the audio/beat bind target). Speed drives the noise
    // animation; RGBShift the channel offset; BlockSize the noise scale. Amount/Speed/RGBShift
    // are referenced by the expressions set above via their sanitized custom-par names
    // (Amount, Speed, Rgbshift) — so they are bare custom pars here (no bind_to, the
    // expressions read parent().par.<Name>). BlockSize has no expression of its own, so it
    // binds directly to the driver noise's period.
    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "Amount", type: "float", min: 0, max: 1, default: args.amount },
          { name: "Speed", type: "float", min: 0, max: 4, default: args.speed },
          { name: "RGBShift", type: "float", min: 0, max: 0.1, default: args.rgb_shift },
          {
            name: "BlockSize",
            type: "float",
            min: 1,
            max: 64,
            default: args.block_size,
            bind_to: [`${driver}.period`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a glitch system (${args.input_path ? `source: ${args.input_path}` : "self-contained noise source"}, amount ${args.amount}) → ${out}. Bind op('${builder.containerPath}').par.Amount to audio/beat to make the glitch pulse.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        amount: args.amount,
        speed: args.speed,
        rgb_shift: args.rgb_shift,
        block_size: args.block_size,
        seed: args.seed,
        source: args.input_path ?? "noise",
        output_path: out,
      },
    });
  });
}

export const registerCreateGlitch: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_glitch",
    {
      title: "Create glitch",
      description:
        "Build a glitch / corrupted-signal visual: RGB channel split, noise-driven blocky/slice displacement and horizontal band tearing over a source. With input_path it glitches an existing TOP (pulled in via a Select TOP); otherwise it uses a self-contained animated colour-noise source (no device permissions). Exposes Amount (master intensity — bind to audio/beat), Speed, RGBShift and BlockSize knobs. A signature live VJ look.",
      inputSchema: createGlitchSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGlitchImpl(ctx, args),
  );
};

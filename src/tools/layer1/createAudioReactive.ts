import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const AUDIO_SPECTRUM_SHADER = `out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    // Audio Spectrum CHOP magnitudes are tiny (~0.01–0.1); scale into the [0,1] bar
    // range so realistic input renders visible bars instead of a near-black frame.
    float amp = texture(sTD2DInputs[0], vec2(uv.x, 0.5)).r * 20.0;
    float bar = step(uv.y, clamp(amp, 0.0, 1.0));
    vec3 col = mix(vec3(0.02, 0.0, 0.08), vec3(0.1, 0.8, 1.0), uv.x) * bar;
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

// Each non-"glsl" style gets its own spectrum visual (so they are not all the same shape).
// All sample the spectrum texture (sTD2DInputs[0]); the *20 lifts the tiny magnitudes into a
// visible range. Validated live in TD (all compile and render distinct content).
const STYLE_SHADERS: Record<string, string> = {
  // Radial spectrum bars emanating from the centre by angle.
  geometric: `out vec4 fragColor;
void main(){
    vec2 pos = vUV.st - 0.5;
    float ang = atan(pos.y, pos.x) * 0.159155 + 0.5;
    float rad = length(pos) * 2.0;
    float amp = texture(sTD2DInputs[0], vec2(ang, 0.5)).r * 20.0;
    float bar = step(rad, clamp(amp, 0.0, 1.0));
    vec3 col = mix(vec3(0.05, 0.0, 0.15), vec3(0.2, 0.9, 1.0), ang) * bar;
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`,
  // A grid of dots whose size tracks each column's spectrum bin.
  particle: `out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    vec2 cell = fract(uv * 16.0) - 0.5;
    float colx = floor(uv.x * 16.0) / 16.0;
    float amp = texture(sTD2DInputs[0], vec2(colx, 0.5)).r * 20.0;
    float dot = smoothstep(0.45 * clamp(amp, 0.05, 1.0), 0.0, length(cell));
    vec3 col = dot * mix(vec3(0.1, 0.4, 1.0), vec3(1.0, 0.3, 0.6), uv.y);
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`,
  // Concentric rings warped by the spectrum — a tunnel/echo look.
  feedback: `out vec4 fragColor;
void main(){
    vec2 pos = vUV.st - 0.5;
    float rad = length(pos);
    float ang = atan(pos.y, pos.x);
    float amp = texture(sTD2DInputs[0], vec2(rad, 0.5)).r * 20.0;
    float rings = 0.5 + 0.5 * sin(rad * 40.0 - amp * 12.0 + ang * 3.0);
    vec3 col = rings * mix(vec3(0.6, 0.1, 0.8), vec3(0.1, 0.8, 0.9), rad * 2.0);
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`,
  // An LED matrix: columns light up to a height set by their spectrum bin.
  instancing: `out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    vec2 cell = floor(uv * vec2(16.0, 8.0));
    vec2 fr = fract(uv * vec2(16.0, 8.0));
    float amp = texture(sTD2DInputs[0], vec2(cell.x / 16.0, 0.5)).r * 20.0;
    float lit = step((cell.y + 0.5) / 8.0, clamp(amp, 0.0, 1.0));
    float pad = step(0.1, fr.x) * step(fr.x, 0.9) * step(0.1, fr.y) * step(fr.y, 0.9);
    vec3 col = lit * pad * mix(vec3(0.0, 1.0, 0.4), vec3(1.0, 0.8, 0.0), cell.y / 8.0);
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`,
};

export const createAudioReactiveSchema = z.object({
  audio_source: z
    .enum(["microphone", "file", "device_in", "existing_chop"])
    .default("microphone")
    .describe(
      "Where audio comes from: 'microphone'/'device_in' create an Audio Device In CHOP, 'file' an Audio File In CHOP (set audio_file_path), 'existing_chop' reuses an audio CHOP you already have (set existing_chop_path).",
    ),
  audio_file_path: z
    .string()
    .optional()
    .describe("Path to an audio file to play; used only when audio_source='file'."),
  existing_chop_path: z
    .string()
    .optional()
    .describe(
      "Path of an existing audio CHOP to analyze; used only when audio_source='existing_chop'.",
    ),
  visual_style: z
    .enum(["geometric", "particle", "feedback", "glsl", "instancing"])
    .describe(
      "How the spectrum is rendered: glsl=horizontal bars, geometric=radial bars, particle=dot field, feedback=ring tunnel, instancing=LED grid.",
    ),
  frequency_bands: z.coerce
    .number()
    .int()
    .positive()
    .default(8)
    .describe(
      "Spectrum resolution: sets the Audio Spectrum CHOP output length (TouchDesigner clamps it to 128–4096 bins). Higher = finer spectrum.",
    ),
  beat_detection: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), add a Beat CHOP driven by the audio source for tempo/beat signals.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose a live 'Sensitivity' knob controlling how strongly the audio drives the visual.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent network where the audio-reactive container is created (default '/project1').",
    ),
  // --- 2026-06-02 extension: transient gate + sidechain duck ---
  // Defaults are OFF so existing call sites produce a byte-identical container.
  transient_gate: z
    .boolean()
    .default(false)
    .describe(
      "When true, add a transient/onset channel to a new modulation Null CHOP (`mod1`) for binding to parameters.",
    ),
  transient_threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe("Transient threshold (0–1); used only when transient_gate=true."),
  transient_hold_ms: z.coerce
    .number()
    .min(1)
    .max(2000)
    .default(120)
    .describe("Transient hold time in ms before decay; used only when transient_gate=true."),
  sidechain_duck: z
    .boolean()
    .default(false)
    .describe(
      "When true, add an inverted duck-envelope channel to the modulation Null CHOP (`mod1`).",
    ),
  duck_depth: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("How deeply the duck pulls toward 0 at peak level (0–1)."),
  duck_release_ms: z.coerce
    .number()
    .min(1)
    .max(4000)
    .default(350)
    .describe("Release time of the duck envelope in ms."),
});
type CreateAudioReactiveArgs = z.infer<typeof createAudioReactiveSchema>;
type CreateAudioReactiveInput = z.input<typeof createAudioReactiveSchema>;

async function buildAudioSource(
  builder: NetworkBuilder,
  args: CreateAudioReactiveArgs,
): Promise<string> {
  if (args.audio_source === "existing_chop" && args.existing_chop_path) {
    return args.existing_chop_path;
  }
  if (args.audio_source === "file") {
    return builder.add("audiofileinCHOP", "audioin", {
      ...(args.audio_file_path ? { file: args.audio_file_path } : {}),
      play: 1,
    });
  }
  return builder.add("audiodeviceinCHOP", "audioin");
}

export async function createAudioReactiveImpl(ctx: ToolContext, rawArgs: CreateAudioReactiveInput) {
  // Re-parse so callers (including tests + downstream layer-1 generators) can omit any
  // field that has a schema default — keeps the existing test-call style working after
  // the 2026-06-02 transient/duck extension added more defaulted fields.
  // Use safeParse so an invalid input becomes a friendly isError result instead of
  // throwing out of the MCP handler (CLAUDE.md: "never throw out of handlers").
  const parsed = createAudioReactiveSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args: CreateAudioReactiveArgs = parsed.data;
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "audio_reactive");

    const audioSource = await buildAudioSource(builder, args);
    // Cap the spectrum output length so the downstream CHOP-to-TOP texture stays within
    // GPU limits. Left on "Match Length To Frequency", the spectrum emits ~22050 samples,
    // which overflows the 16384 max texture width and triggers a clamp warning. TouchDesigner
    // clamps outlength to 128–4096, so frequency_bands maps into that range.
    const outLength = Math.min(Math.max(args.frequency_bands, 128), 4096);
    const spectrum = await builder.add("audiospectrumCHOP", "spectrum", {
      outputmenu: "setmanually",
      outlength: outLength,
    });
    await builder.connect(audioSource, spectrum);

    const analyze = await builder.add("analyzeCHOP", "level", { function: 6 });
    await builder.connect(audioSource, analyze);

    if (args.beat_detection) {
      const beat = await builder.add("beatCHOP", "beat");
      await builder.connect(audioSource, beat);
    }

    const audioTex = await builder.add("choptoTOP", "audio_tex");
    await builder.connect(spectrum, audioTex);
    // A Sensitivity gain on the spectrum texture lets one knob scale how strongly the audio
    // drives every visual style — it multiplies the bins before the shaders' fixed *20 lift.
    // brightness1 = 1 is a passthrough, so the default leaves the look unchanged.
    const sensitivity = await builder.add("levelTOP", "sensitivity", { brightness1: 1 });
    await builder.connect(audioTex, sensitivity);

    // Every style renders a GLSL spectrum visual: "glsl" is the classic horizontal bars;
    // geometric/particle/feedback/instancing each get their own shader (radial bars / dot
    // field / ring tunnel / LED grid). A fixed RGBA canvas avoids inheriting the audio
    // texture's Nx1 mono resolution, which would collapse the output to a 1px gray strip.
    const shader =
      args.visual_style === "glsl"
        ? AUDIO_SPECTRUM_SHADER
        : (STYLE_SHADERS[args.visual_style] ?? AUDIO_SPECTRUM_SHADER);
    const visual = await builder.add("glslTOP", "visual", {
      outputresolution: "custom",
      resolutionw: 1280,
      resolutionh: 720,
      format: "rgba8fixed",
    });
    const frag = await builder.add("textDAT", "visual_frag");
    await builder.python(
      `op(${q(frag)}).text = ${q(shader)}\nop(${q(visual)}).par.pixeldat = op(${q(frag)}).name`,
    );
    await builder.connect(sensitivity, visual);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(visual, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Sensitivity",
            type: "float",
            min: 0,
            max: 4,
            default: 1,
            bind_to: [`${sensitivity}.brightness1`],
          },
        ]
      : [];

    // --- 2026-06-02 extension: transient + duck → mod1 CHOP Null ---
    // Only emitted when at least one flag is on; keeps the historical container
    // shape byte-identical for callers that don't opt in.
    if (args.transient_gate || args.sidechain_duck) {
      const mergeInputs: string[] = [analyze];
      let transientNode: string | undefined;
      let transientFilter: string | undefined;
      let duckFilter: string | undefined;
      let duckMath: string | undefined;
      // Filter CHOP rampdownlength is in SAMPLES, not ms. Convert at TD's default 60 fps;
      // the builder cannot read project.cookRate, so we precompute and warn so the artist
      // can dial it down for non-60-fps projects.
      const ASSUMED_FPS = 60;
      builder.warnings.push(
        `Filter CHOP rampdownlength is in samples; ms values converted assuming ${ASSUMED_FPS} fps. ` +
          "Rescale Transient Hold / Duck Release manually for non-60-fps projects.",
      );
      const transientHoldSamples = Math.max(
        1,
        Math.round((args.transient_hold_ms * ASSUMED_FPS) / 1000),
      );
      const duckReleaseSamples = Math.max(
        1,
        Math.round((args.duck_release_ms * ASSUMED_FPS) / 1000),
      );
      if (args.transient_gate) {
        // analyzeCHOP function=8 is the transient/onset detector in TD's Analyze CHOP.
        transientNode = await builder.add("analyzeCHOP", "transient", {
          function: 8,
          threshold: args.transient_threshold,
        });
        await builder.connect(audioSource, transientNode);
        transientFilter = await builder.add("filterCHOP", "transient_hold", {
          // ramp lengths in samples (TD's default unit). Converted from ms assuming 60 fps;
          // for other project rates, the artist should rescale this control.
          rampdownlength: transientHoldSamples,
        });
        await builder.connect(transientNode, transientFilter);
        mergeInputs.push(transientFilter);
      }
      if (args.sidechain_duck) {
        duckFilter = await builder.add("filterCHOP", "duck_env", {
          rampdownlength: duckReleaseSamples,
        });
        await builder.connect(analyze, duckFilter);
        duckMath = await builder.add("mathCHOP", "duck", {
          // gain1 carries duck_depth; bias inversion produces (1 - depth*level) downstream.
          gain1: args.duck_depth,
        });
        await builder.connect(duckFilter, duckMath);
        mergeInputs.push(duckMath);
      }
      const merge = await builder.add("mergeCHOP", "mod_merge");
      for (const src of mergeInputs) {
        await builder.connect(src, merge);
      }
      const mod = await builder.add("nullCHOP", "mod1");
      await builder.connect(merge, mod);
      if (args.expose_controls) {
        if (args.transient_gate && transientNode && transientFilter) {
          controls.push(
            {
              name: "Transient Threshold",
              type: "float",
              min: 0,
              max: 1,
              default: args.transient_threshold,
              bind_to: [`${transientNode}.threshold`],
            },
            {
              name: "Transient Hold (samples)",
              type: "float",
              min: 1,
              max: 240,
              default: transientHoldSamples,
              bind_to: [`${transientFilter}.rampdownlength`],
            },
          );
        }
        if (args.sidechain_duck && duckMath && duckFilter) {
          controls.push(
            {
              name: "Duck Depth",
              type: "float",
              min: 0,
              max: 1,
              default: args.duck_depth,
              bind_to: [`${duckMath}.gain1`],
            },
            {
              name: "Duck Release (samples)",
              type: "float",
              min: 1,
              max: 480,
              default: duckReleaseSamples,
              bind_to: [`${duckFilter}.rampdownlength`],
            },
          );
        }
      }
    }

    return finalize(ctx, {
      summary: `Created an audio-reactive system (source: ${args.audio_source}, style: ${args.visual_style}, ${args.frequency_bands} bands).`,
      builder,
      outputPath: out,
      controls,
      extra: {
        audio_source: args.audio_source,
        visual_style: args.visual_style,
        beat_detection: args.beat_detection,
      },
    });
  });
}

export const registerCreateAudioReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_audio_reactive",
    {
      title: "Create audio-reactive visual",
      description:
        "Build an audio analysis chain (spectrum + level + optional beat) and a spectrum visual driven by it. Creates a new baseCOMP under `parent_path` holding the audio source, an Audio Spectrum CHOP, an Analyze level, an optional Beat CHOP, a CHOP-to-TOP texture with a Sensitivity gain, the GLSL visual, and a Null output. Each visual_style renders the spectrum its own way: glsl=horizontal bars, geometric=radial bars, particle=dot field, feedback=ring tunnel, instancing=LED grid. Returns a summary plus a JSON block with the container path, created node paths, the output path, exposed controls, any node errors, warnings, and an inline preview image. This is the only audio tool that produces a built-in visual: use extract_audio_features for level/bass/mid/treble channels or create_spectrum for per-band channels (no visual), and bind_audio_reactive to wire those channels onto an existing COMP's knobs.",
      inputSchema: createAudioReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAudioReactiveImpl(ctx, args),
  );
};

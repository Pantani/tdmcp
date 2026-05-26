import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

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
  audio_source: z.enum(["microphone", "file", "device_in", "existing_chop"]).default("microphone"),
  audio_file_path: z.string().optional().describe("Audio file path (audio_source='file')."),
  existing_chop_path: z
    .string()
    .optional()
    .describe("Existing CHOP path (audio_source='existing_chop')."),
  visual_style: z.enum(["geometric", "particle", "feedback", "glsl", "instancing"]),
  frequency_bands: z.coerce
    .number()
    .int()
    .positive()
    .default(8)
    .describe(
      "Spectrum resolution: sets the Audio Spectrum CHOP output length (TouchDesigner clamps it to 128–4096 bins). Higher = finer spectrum.",
    ),
  beat_detection: z.boolean().default(true),
  parent_path: z.string().default("/project1"),
});
type CreateAudioReactiveArgs = z.infer<typeof createAudioReactiveSchema>;

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

export async function createAudioReactiveImpl(ctx: ToolContext, args: CreateAudioReactiveArgs) {
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
    await builder.connect(audioTex, visual);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(visual, out);

    return finalize(ctx, {
      summary: `Created an audio-reactive system (source: ${args.audio_source}, style: ${args.visual_style}, ${args.frequency_bands} bands).`,
      builder,
      outputPath: out,
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
        "Build an audio analysis chain (spectrum + level + optional beat) and a spectrum visual driven by it. Each visual_style renders the spectrum its own way: glsl=horizontal bars, geometric=radial bars, particle=dot field, feedback=ring tunnel, instancing=LED grid.",
      inputSchema: createAudioReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAudioReactiveImpl(ctx, args),
  );
};

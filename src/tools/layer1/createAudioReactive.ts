import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const AUDIO_SPECTRUM_SHADER = `out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    float amp = texture(sTD2DInputs[0], vec2(uv.x, 0.5)).r;
    float bar = step(uv.y, clamp(amp, 0.0, 1.0));
    vec3 col = mix(vec3(0.02, 0.0, 0.08), vec3(0.1, 0.8, 1.0), uv.x) * bar;
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

export const createAudioReactiveSchema = z.object({
  audio_source: z.enum(["microphone", "file", "device_in", "existing_chop"]).default("microphone"),
  audio_file_path: z.string().optional().describe("Audio file path (audio_source='file')."),
  existing_chop_path: z
    .string()
    .optional()
    .describe("Existing CHOP path (audio_source='existing_chop')."),
  visual_style: z.enum(["geometric", "particle", "feedback", "glsl", "instancing"]),
  frequency_bands: z.number().int().positive().default(8),
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
    const spectrum = await builder.add("audiospectrumCHOP", "spectrum");
    await builder.connect(audioSource, spectrum);

    const analyze = await builder.add("analyzeCHOP", "level", { function: 6 });
    await builder.connect(audioSource, analyze);

    if (args.beat_detection) {
      const beat = await builder.add("beatCHOP", "beat");
      await builder.connect(audioSource, beat);
    }

    const audioTex = await builder.add("choptoTOP", "audio_tex");
    await builder.connect(spectrum, audioTex);

    let visual: string;
    if (args.visual_style === "glsl") {
      visual = await builder.add("glslTOP", "visual");
      const frag = await builder.add("textDAT", "visual_frag");
      await builder.python(
        `op(${q(frag)}).text = ${q(AUDIO_SPECTRUM_SHADER)}\nop(${q(visual)}).par.pixeldat = op(${q(frag)}).name`,
      );
      await builder.connect(audioTex, visual);
    } else {
      visual = await builder.add("circleTOP", "visual", { radius: 0.3 });
      await builder.python(
        `c = op(${q(visual)})\nfor p in ('radiusx', 'radiusy'):\n    try:\n        par = getattr(c.par, p)\n        par.expr = "0.2 + op('level')['chan1'] * 0.6"\n        par.mode = ParMode.EXPRESSION\n    except Exception: pass`,
      );
      builder.warnings.push(
        `Visual style "${args.visual_style}" is approximated: a circle driven by the audio level. Refine the mapping for production.`,
      );
    }

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
        "Build an audio analysis chain (spectrum + level + optional beat) and a visual driven by it. The 'glsl' style renders a spectrum visualization; other styles are approximated.",
      inputSchema: createAudioReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAudioReactiveImpl(ctx, args),
  );
};

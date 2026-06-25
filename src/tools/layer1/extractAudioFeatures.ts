import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const extractAudioFeaturesSchema = z.object({
  source: z
    .enum(["device", "file", "oscillator", "existing_chop"])
    .default("device")
    .describe(
      "Audio source. 'device' = live microphone/line in (the real-world default; creating it may pop a one-time macOS microphone-permission dialog — click Allow). 'file' = an audio file. 'oscillator' = a synthetic tone, handy for testing without any device permission. 'existing_chop' = reuse a CHOP you already have.",
    ),
  audio_file_path: z.string().optional().describe("Audio file path (source='file')."),
  existing_chop_path: z
    .string()
    .optional()
    .describe("Path of an existing audio CHOP to analyze (source='existing_chop')."),
  bass_hz: z.coerce.number().positive().default(200).describe("Low-pass cutoff for the bass band."),
  mid_hz: z.coerce.number().positive().default(1500).describe("Band-pass centre for the mid band."),
  treble_hz: z.coerce
    .number()
    .positive()
    .default(4000)
    .describe("High-pass cutoff for the treble band."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose a live 'Sensitivity' knob (a gain over every feature channel)."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'audio_features' container is created inside."),
});
type ExtractAudioFeaturesArgs = z.infer<typeof extractAudioFeaturesSchema>;

async function buildSource(
  builder: NetworkBuilder,
  args: ExtractAudioFeaturesArgs,
): Promise<string> {
  if (args.source === "existing_chop" && args.existing_chop_path) {
    return args.existing_chop_path;
  }
  if (args.source === "file") {
    return builder.add("audiofileinCHOP", "audioin", {
      ...(args.audio_file_path ? { file: args.audio_file_path } : {}),
      play: 1,
    });
  }
  if (args.source === "oscillator") {
    // White noise has energy across all bands, so bass/mid/treble all read non-zero —
    // a self-contained signal for verifying the chain without any audio device.
    return builder.add("audiooscillatorCHOP", "audioin", { wavetype: "whitenoise", amp: 0.5 });
  }
  return builder.add("audiodeviceinCHOP", "audioin");
}

/** A band = audio filter → RMS analyze, with the output channel renamed to the band name. */
async function buildBand(
  builder: NetworkBuilder,
  source: string,
  name: string,
  filter: "lowpass" | "bandpass" | "highpass",
  cutoffHz: number,
): Promise<string> {
  const filt = await builder.add("audiofilterCHOP", `${name}_filter`, {
    filter,
    units: "frequency",
    cutofffrequency: cutoffHz,
  });
  await builder.connect(source, filt);
  const analyze = await builder.add("analyzeCHOP", name, {
    function: "rmspower",
    renamefrom: "*",
    renameto: name,
  });
  await builder.connect(filt, analyze);
  return analyze;
}

export async function extractAudioFeaturesImpl(ctx: ToolContext, args: ExtractAudioFeaturesArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "audio_features");
    const source = await buildSource(builder, args);

    // Overall loudness (RMS of the full-band signal), then three band energies.
    const level = await builder.add("analyzeCHOP", "level", {
      function: "rmspower",
      renamefrom: "*",
      renameto: "level",
    });
    await builder.connect(source, level);
    const bass = await buildBand(builder, source, "bass", "lowpass", args.bass_hz);
    const mid = await buildBand(builder, source, "mid", "bandpass", args.mid_hz);
    const treble = await buildBand(builder, source, "treble", "highpass", args.treble_hz);

    // Merge the four single-channel CHOPs into one, then a Sensitivity gain, then a Null as
    // the stable bind point. Other tools/expressions read op('…/features')['bass'] etc.
    const merge = await builder.add("mergeCHOP", "merged");
    await builder.connect(level, merge, 0, 0);
    await builder.connect(bass, merge, 0, 1);
    await builder.connect(mid, merge, 0, 2);
    await builder.connect(treble, merge, 0, 3);

    const gain = await builder.add("mathCHOP", "sensitivity", { gain: 1 });
    await builder.connect(merge, gain);
    const features = await builder.add("nullCHOP", "features");
    await builder.connect(gain, features);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Sensitivity",
            type: "float",
            min: 0,
            max: 8,
            default: 1,
            bind_to: [`${gain}.gain`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Extracted audio features (source: ${args.source}) → ${features} with channels level/bass/mid/treble. Bind a parameter to op('${features}')['bass'] (etc.) to make it react.`,
      builder,
      outputPath: features,
      // The output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        source: args.source,
        features_path: features,
        channels: ["level", "bass", "mid", "treble"],
        bands_hz: { bass: args.bass_hz, mid: args.mid_hz, treble: args.treble_hz },
      },
    });
  });
}

export const registerExtractAudioFeatures: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "extract_audio_features",
    {
      title: "Extract audio features",
      description:
        "Build an audio-analysis chain that exposes ready-to-bind reactive channels — overall level plus bass/mid/treble band energies — on a Null CHOP. Unlike create_audio_reactive (which renders a spectrum visual), this produces the raw signals so you can drive ANY parameter: bind a node parameter to op('…/audio_features/features')['bass'] and it pulses with the music. A Sensitivity knob scales all channels. Source can be the live device (mic/line — may prompt for macOS permission), an audio file, a synthetic oscillator (for testing), or an existing CHOP. Use create_spectrum for N fine per-band channels instead of these four coarse bands, and pass this Null as the source_chop to bind_audio_reactive to make a whole COMP react.",
      inputSchema: extractAudioFeaturesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => extractAudioFeaturesImpl(ctx, args),
  );
};

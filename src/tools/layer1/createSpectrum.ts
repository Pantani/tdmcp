import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

export const createSpectrumSchema = z.object({
  source: z
    .enum(["device", "file", "oscillator", "existing_chop"])
    .default("device")
    .describe(
      "Audio source. 'device' = live microphone/line in (the real-world default; creating it may pop a one-time macOS microphone-permission dialog — click Allow). 'file' = an audio file. 'oscillator' = a synthetic tone (white noise → energy in every band, handy for testing without any device permission). 'existing_chop' = reuse a CHOP you already have.",
    ),
  audio_file_path: z.string().optional().describe("Audio file path (source='file')."),
  existing_chop_path: z
    .string()
    .optional()
    .describe("Path of an existing audio CHOP to analyze (source='existing_chop')."),
  bands: z.coerce
    .number()
    .int()
    .min(1)
    .max(512)
    .default(16)
    .describe(
      "Number of frequency bins to expose as separate, bindable channels (band0..band{N-1}). 16 or 32 is typical; higher = finer frequency resolution.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose a live 'Sensitivity' knob (a gain over every band channel)."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'spectrum' container is created inside."),
});
type CreateSpectrumArgs = z.infer<typeof createSpectrumSchema>;

async function buildSource(builder: NetworkBuilder, args: CreateSpectrumArgs): Promise<string> {
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
    // White noise has energy across all frequencies, so every band reads non-zero —
    // a self-contained signal for verifying the chain without any audio device.
    return builder.add("audiooscillatorCHOP", "audioin", { wavetype: "whitenoise", amp: 0.5 });
  }
  return builder.add("audiodeviceinCHOP", "audioin");
}

export async function createSpectrumImpl(ctx: ToolContext, args: CreateSpectrumArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "spectrum");
    const source = await buildSource(builder, args);

    // FFT. The Audio Spectrum CHOP emits one channel of magnitude bins. TouchDesigner
    // clamps `outlength` into 128–4096, so a small `bands` value (e.g. 16) can NOT be set
    // here directly — we request a comfortably-sized FFT and rebin it down below.
    // Use audiospectrumCHOP — `spectrumCHOP` is not a createable operator.
    const fftLength = Math.min(Math.max(args.bands, 128), 4096);
    const fft = await builder.add("audiospectrumCHOP", "spectrum_fft", {
      outputmenu: "setmanually",
      outlength: fftLength,
    });
    await builder.connect(source, fft);

    // Rebin to exactly `bands` samples by resampling the single spectrum channel onto a
    // fixed sample interval [0, bands-1]. Linear interpolation averages neighbouring FFT
    // bins when reducing, giving smooth per-band energy regardless of the FFT length above.
    const rebin = await builder.add("resampleCHOP", "rebin", {
      relative: "abs",
      start: 0,
      end: args.bands - 1,
      startunit: "samples",
      endunit: "samples",
      interp: "linear",
    });
    await builder.connect(fft, rebin);

    // Transpose: 1 channel × N samples → N channels × 1 sample. The Shuffle CHOP's
    // "Sequence to Channels" method stores every sample index in its own channel.
    const split = await builder.add("shuffleCHOP", "split", { method: "seqtochan" });
    await builder.connect(rebin, split);

    // Name the N channels band0..band{N-1}. The Rename CHOP's numbered pattern expands
    // `band[0-K]` positionally across the matched channels.
    const rename = await builder.add("renameCHOP", "bands", {
      renamefrom: "*",
      renameto: `band[0-${args.bands - 1}]`,
    });
    await builder.connect(split, rename);

    // A Sensitivity gain over every band, then a Null as the stable bind point —
    // exactly like extract_audio_features' sensitivity→features tail.
    const gain = await builder.add("mathCHOP", "sensitivity", { gain: 1 });
    await builder.connect(rename, gain);
    const spectrum = await builder.add("nullCHOP", "spectrum");
    await builder.connect(gain, spectrum);

    const channels = Array.from({ length: args.bands }, (_, i) => `band${i}`);

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
      summary: `Built an FFT spectrum analyzer (source: ${args.source}) → ${spectrum} with ${args.bands} per-band channels band0..band${args.bands - 1}. Bind a parameter to op('${spectrum}')['band0'] (or any band) to make it react to that frequency.`,
      builder,
      outputPath: spectrum,
      // The output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        source: args.source,
        spectrum_path: spectrum,
        bands: args.bands,
        channels,
      },
    });
  });
}

export const registerCreateSpectrum: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_spectrum",
    {
      title: "Create audio spectrum",
      description:
        "Build an FFT audio-spectrum analyzer that exposes N separate, ready-to-bind frequency-bin channels (band0..band{N-1}) on a Null CHOP. This is the per-band complement to extract_audio_features (which only gives overall level + bass/mid/treble): bind a row of parameters to op('…/spectrum/spectrum')['band0'], ['band1'], … to drive a bank of bars, or pick one frequency. A Sensitivity knob scales every band. Source can be the live device (mic/line — may prompt for macOS permission), an audio file, a synthetic oscillator (for testing), or an existing CHOP.",
      inputSchema: createSpectrumSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSpectrumImpl(ctx, args),
  );
};

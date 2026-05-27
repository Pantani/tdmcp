import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

export const createWaveformSchema = z.object({
  source: z
    .enum(["device", "file", "oscillator", "existing_chop"])
    .default("device")
    .describe(
      "Audio source. 'device' = live microphone/line in (the real-world default; creating it may pop a one-time macOS microphone-permission dialog — click Allow). 'file' = an audio file. 'oscillator' = a synthetic tone, handy for testing the scope without any device permission. 'existing_chop' = reuse a CHOP you already have.",
    ),
  audio_file_path: z.string().optional().describe("Audio file path (source='file')."),
  existing_chop_path: z
    .string()
    .optional()
    .describe("Path of an existing audio CHOP to scope (source='existing_chop')."),
  color: z
    .string()
    .default("#00ff88")
    .describe(
      "Waveform colour as a hex string ('#00ff88' = classic phosphor green). Tints the mono trace via a Constant TOP multiplied over the CHOP-to-TOP image.",
    ),
  scale: z.coerce
    .number()
    .positive()
    .default(1)
    .describe(
      "Amplitude gain on the signal before it is drawn — the vertical zoom of the trace. Drives a Math CHOP's gain (1 = raw signal).",
    ),
  time_window: z.coerce
    .number()
    .positive()
    .default(1)
    .describe(
      "How much recent history the scrolling trace holds, in seconds — the horizontal time span. Drives the Trail CHOP's Window Length (wlength, units = seconds).",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live Color / Scale / TimeWindow controls bound to the right node parameters.",
    ),
  parent_path: z.string().default("/project1"),
});
type CreateWaveformArgs = z.infer<typeof createWaveformSchema>;

/** Parses '#rrggbb' / 'rrggbb' (3- or 6-digit) into 0..1 RGB. Falls back to green. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 1, b: 0.53 };
  let h = m[1] as string;
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const int = Number.parseInt(h, 16);
  return {
    r: ((int >> 16) & 0xff) / 255,
    g: ((int >> 8) & 0xff) / 255,
    b: (int & 0xff) / 255,
  };
}

/** Mirrors extractAudioFeatures.buildSource so the source enum behaves identically. */
async function buildSource(builder: NetworkBuilder, args: CreateWaveformArgs): Promise<string> {
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
    // A clean sine gives a textbook scrolling waveform, so the scope reads as a recognisable
    // wave with no audio device (and no microphone-permission prompt) attached.
    return builder.add("audiooscillatorCHOP", "audioin", { wavetype: "sine", amp: 0.5 });
  }
  return builder.add("audiodeviceinCHOP", "audioin");
}

export async function createWaveformImpl(ctx: ToolContext, args: CreateWaveformArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "waveform");
    const source = await buildSource(builder, args);

    // Amplitude gain (the vertical zoom of the trace). Math CHOP gain = `gain`.
    const gain = await builder.add("mathCHOP", "scale", { gain: args.scale });
    await builder.connect(source, gain);

    // Keep a scrolling buffer of the recent signal — this is what makes the trace move.
    // Trail CHOP window length is `wlength`; `wlengthunit` switches it to seconds so
    // time_window reads directly as a duration.
    const trail = await builder.add("trailCHOP", "trail", {
      wlength: args.time_window,
      wlengthunit: "seconds",
    });
    await builder.connect(gain, trail);

    // The Trail buffers at the audio rate (time_window × ~44.1k samples) — far more than a
    // texture can hold, so CHOP-to-TOP would clamp to 256px and warn. Resample down to a fixed
    // display rate first, so the whole window becomes a clean full-width trace with no warning.
    const rebin = await builder.add("resampleCHOP", "rebin", { rate: 1024 });
    await builder.connect(trail, rebin);

    // Render the buffered CHOP samples into an image. CHOP to TOP reads its source from a
    // `chop` PARAMETER (a path reference), NOT a wire — exactly like top-to-CHOP's `top`
    // param. The NetworkBuilder.connect() helper detects the conversion op and sets that
    // parameter automatically, so connect(rebin, scope) wires it correctly. The custom
    // resolution matches the resampled width so nothing is clamped.
    const scope = await builder.add("choptoTOP", "scope", {
      outputresolution: "custom",
      resolutionw: 1024,
      resolutionh: 256,
    });
    await builder.connect(rebin, scope);

    // The raw scope is a (near-mono) trace. A Level TOP lifts brightness so a quiet signal
    // is still visible; brightness1 is the Level TOP's brightness (NOT `gain`).
    const level = await builder.add("levelTOP", "brightness", { brightness1: 1 });
    await builder.connect(scope, level);

    // Tint the mono trace to the chosen colour: a flat Constant TOP of the colour multiplied
    // over the trace (operand 'multiply') stains the white waveform without touching shape.
    const rgb = hexToRgb(args.color);
    const tintColor = await builder.add("constantTOP", "tint", {
      colorr: rgb.r,
      colorg: rgb.g,
      colorb: rgb.b,
      alpha: 1,
    });
    const tint = await builder.add("compositeTOP", "tinted", { operand: "multiply" });
    // Input 0 = the trace, input 1 = the flat colour multiplied over it.
    await builder.connect(level, tint, 0, 0);
    await builder.connect(tintColor, tint, 0, 1);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(tint, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Color",
            type: "rgb",
            default: args.color,
            // rgb controls bind to the Constant TOP's RGB swatch via the panel builder.
            bind_to: [`${tintColor}.colorr`, `${tintColor}.colorg`, `${tintColor}.colorb`],
          },
          {
            name: "Scale",
            type: "float",
            min: 0,
            max: 8,
            default: args.scale,
            bind_to: [`${gain}.gain`],
          },
          {
            name: "TimeWindow",
            type: "float",
            min: 0.05,
            max: 10,
            default: args.time_window,
            bind_to: [`${trail}.wlength`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a waveform oscilloscope (source: ${args.source}, ${args.time_window}s window) → ${out}. The Trail CHOP scrolls the recent signal and a CHOP-to-TOP draws it as a moving trace.`,
      builder,
      outputPath: out,
      // Output is a TOP (the Null), so a preview image is captured.
      capturePreviewImage: true,
      controls,
      extra: {
        source: args.source,
        scale: args.scale,
        time_window: args.time_window,
        color: { r: rgb.r, g: rgb.g, b: rgb.b },
        trail_path: trail,
        scope_path: scope,
        output_path: out,
      },
    });
  });
}

export const registerCreateWaveform: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_waveform",
    {
      title: "Create waveform oscilloscope",
      description:
        "Build a time-domain audio waveform / oscilloscope — the actual audio signal scrolling left-to-right as a moving trace (the time-domain companion to create_spectrum's frequency bins and detect_onsets' transients). A Trail CHOP keeps a rolling buffer of recent samples (time_window seconds), a CHOP-to-TOP draws that buffer as an image, and a Constant TOP tints it to the chosen colour over a Level TOP. Unlike create_audio_reactive (which renders a spectrum), this shows the raw waveform. Source can be the live device (mic/line — may prompt for macOS permission), an audio file, a synthetic oscillator (for testing), or an existing CHOP. Output is a Null TOP. Scale is the vertical amplitude zoom; TimeWindow is the horizontal time span.",
      inputSchema: createWaveformSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createWaveformImpl(ctx, args),
  );
};

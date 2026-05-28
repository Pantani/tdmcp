import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

/** Quote a string as a Python literal for inline exec snippets (mirrors other Layer 1 tools). */
const q = (value: string): string => JSON.stringify(value);

/** Friendly waveform names → the Audio Oscillator CHOP `wavetype` menu values. */
const WAVE_MAP: Record<"sine" | "triangle" | "sawtooth" | "square", string> = {
  sine: "sine",
  triangle: "tri",
  sawtooth: "ramp",
  square: "square",
};

export const createGenerativeAudioSchema = z.object({
  synth: z
    .enum(["oscillator", "fm", "noise"])
    .default("oscillator")
    .describe(
      "Synthesis method. 'oscillator' = a single tone-generating Audio Oscillator CHOP. 'fm' = two oscillators where one modulates the other's frequency (classic FM, metallic/bell timbres). 'noise' = a Noise CHOP shaped by a low-pass Audio Filter (wind/hiss/percussive textures).",
    ),
  frequency: z.coerce
    .number()
    .positive()
    .default(220)
    .describe("Carrier / oscillator base frequency in Hz (e.g. 220 = A3)."),
  waveform: z
    .enum(["sine", "triangle", "sawtooth", "square"])
    .default("sine")
    .describe("Oscillator wave shape (ignored for the 'noise' synth)."),
  fm_ratio: z.coerce
    .number()
    .positive()
    .default(2)
    .describe(
      "(fm) Modulator frequency as a multiple of the carrier (modulator = frequency × ratio).",
    ),
  fm_depth: z.coerce
    .number()
    .min(0)
    .default(100)
    .describe("(fm) Modulation depth — the peak frequency deviation in Hz applied to the carrier."),
  volume: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "Output level, 0..1 (a gain on the final signal). Start moderate to protect ears/speakers.",
    ),
  to_device: z
    .boolean()
    .default(false)
    .describe(
      "Play the synthesized audio out through an Audio Device Out CHOP. Default OFF (opt-in) so the build never opens audio hardware — keeping it silent-safe and avoiding the macOS audio-permission prompt. Turn on only when you actually want sound out the speakers.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live Frequency / Volume knobs (and FmRatio / FmDepth for the fm synth)."),
  parent_path: z.string().default("/project1"),
});
type CreateGenerativeAudioArgs = z.infer<typeof createGenerativeAudioSchema>;

/**
 * Builds the raw signal source for the chosen synth and returns the path of the CHOP
 * carrying it (pre-volume). Fail-forward: connection/param failures are collected on the
 * builder as warnings, never thrown.
 */
async function buildSource(
  builder: NetworkBuilder,
  args: CreateGenerativeAudioArgs,
): Promise<string> {
  const wavetype = WAVE_MAP[args.waveform];

  if (args.synth === "noise") {
    // White-ish noise (full-spectrum) shaped by a low-pass filter at the cutoff so the
    // texture has a controllable "brightness". `rate` is pushed to audio sample rate so
    // the stream is audible rather than a slow control-rate wobble.
    const noise = await builder.add("noiseCHOP", "noise", { amp: 1, rate: 44100 });
    const filter = await builder.add("audiofilterCHOP", "filter", {
      filter: "lowpass",
      units: "frequency",
      cutofffrequency: args.frequency,
    });
    await builder.connect(noise, filter);
    // The cutoff is an expression reading the container's Frequency custom par, so the exposed
    // Frequency knob retunes the noise "brightness" (the only pitch-like control in noise mode).
    // This MODULATES the cutoff rather than binding Frequency straight onto cutofffrequency, which
    // keeps the same modulate-don't-clobber pattern the fm path uses for its modulator frequency.
    // The hasattr fallback keeps it cooking before exposeControls appends Frequency (and when
    // controls are off). Custom-par names are sanitized to Initialcap-then-lowercase, so the par
    // is `Frequency`.
    const container = builder.containerPath;
    const cutoffExpr = `op(${q(container)}).par.Frequency.eval() if hasattr(op(${q(container)}).par, 'Frequency') else ${args.frequency}`;
    await builder.python(`op(${q(filter)}).par.cutofffrequency.expr = ${q(cutoffExpr)}`);
    return filter;
  }

  if (args.synth === "fm") {
    // FM: a modulator oscillator drives the carrier's instantaneous frequency. The
    // modulator's bipolar output (-1..1) is scaled by fm_depth (Hz of deviation) and
    // offset by the carrier base frequency, producing a per-sample frequency CHOP that
    // feeds the carrier's first (pitch/frequency) input.
    const modulator = await builder.add("audiooscillatorCHOP", "modulator", {
      wavetype,
      frequency: args.frequency * args.fm_ratio,
      amp: 1,
    });
    const fmScale = await builder.add("mathCHOP", "fm_scale", {
      gain: args.fm_depth,
      postoff: args.frequency,
    });
    await builder.connect(modulator, fmScale);
    const carrier = await builder.add("audiooscillatorCHOP", "carrier", {
      wavetype,
      frequency: args.frequency,
      amp: 1,
    });
    // The Audio Oscillator's first CHOP input modulates its frequency.
    await builder.connect(fmScale, carrier, 0, 0);
    return carrier;
  }

  // Single oscillator.
  return builder.add("audiooscillatorCHOP", "oscillator", {
    wavetype,
    frequency: args.frequency,
    amp: 1,
  });
}

export async function createGenerativeAudioImpl(ctx: ToolContext, args: CreateGenerativeAudioArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "generative_audio");
    const source = await buildSource(builder, args);

    // A Math CHOP applies the master volume, then a Null is the stable signal endpoint
    // (feed it to a spectrum/waveform visual, bind_to_channel, or the device out).
    const volume = await builder.add("mathCHOP", "volume", { gain: args.volume });
    await builder.connect(source, volume);
    const audio = await builder.add("nullCHOP", "audio");
    await builder.connect(volume, audio);

    // Playback is opt-in: only open an audio device when explicitly asked, so the
    // default build stays silent and never trips a hardware/permission prompt.
    let deviceOut: string | undefined;
    if (args.to_device) {
      deviceOut = await builder.add("audiodeviceoutCHOP", "device_out");
      await builder.connect(audio, deviceOut);
    }

    const container = builder.containerPath;
    const controls: ControlSpec[] = [];
    if (args.expose_controls) {
      if (args.synth === "noise") {
        // Noise has no oscillator: the Frequency knob is read by the filter's cutoff EXPRESSION
        // (set in buildSource) to retune the texture's brightness. No bind_to — a direct bind would
        // overwrite that expression with a constant. This is the same modulate-don't-clobber shape
        // the fm path uses for FmRatio. Always emit it so the documented Frequency knob actually works.
        controls.push({
          name: "Frequency",
          type: "float",
          min: 20,
          max: 4000,
          default: args.frequency,
        });
      } else {
        const oscPath =
          args.synth === "fm" ? builder.pathOf("carrier") : builder.pathOf("oscillator");
        if (oscPath) {
          controls.push({
            name: "Frequency",
            type: "float",
            min: 20,
            max: 4000,
            default: args.frequency,
            bind_to: [`${oscPath}.frequency`],
          });
        }
      }
      controls.push({
        name: "Volume",
        type: "float",
        min: 0,
        max: 1,
        default: args.volume,
        bind_to: [`${volume}.gain`],
      });
      if (args.synth === "fm") {
        const modPath = builder.pathOf("modulator");
        const fmScalePath = builder.pathOf("fm_scale");
        if (modPath) {
          // The modulator frequency is an expression Frequency × Fmratio (both custom pars
          // on the container), so FmRatio MODULATES the ratio while staying locked to the
          // carrier: it tracks carrier × ratio live. Binding FmRatio straight onto the
          // modulator frequency (the old behaviour) retuned the modulator to the ratio
          // value itself (~2 Hz), breaking the FM relationship. Custom-par names are
          // sanitized to Initialcap-then-lowercase, so FmRatio → Fmratio.
          const modExpr = `(op(${q(container)}).par.Frequency.eval() if hasattr(op(${q(container)}).par, 'Frequency') else ${args.frequency}) * (op(${q(container)}).par.Fmratio.eval() if hasattr(op(${q(container)}).par, 'Fmratio') else ${args.fm_ratio})`;
          await builder.python(`op(${q(modPath)}).par.frequency.expr = ${q(modExpr)}`);
          controls.push({
            // FmRatio is read by the modulator-frequency expression above (carrier × ratio).
            // No bind_to: a direct bind would retune the modulator to the ratio value itself.
            name: "FmRatio",
            type: "float",
            min: 0.25,
            max: 16,
            default: args.fm_ratio,
          });
        }
        if (fmScalePath) {
          controls.push({
            name: "FmDepth",
            type: "float",
            min: 0,
            max: 2000,
            default: args.fm_depth,
            bind_to: [`${fmScalePath}.gain`],
          });
        }
      }
    }

    const synthLabel =
      args.synth === "fm"
        ? `FM (ratio ${args.fm_ratio}, depth ${args.fm_depth} Hz)`
        : args.synth === "noise"
          ? "filtered noise"
          : `${args.waveform} oscillator`;

    return finalize(ctx, {
      summary: `Synthesized audio (${synthLabel}) at ${args.frequency} Hz → ${audio}. Feed it to create_spectrum/create_waveform, bind_to_channel, or set to_device=true to hear it. Note: audio CHOPs are time-dependent — the signal is silent while the TD timeline is paused.`,
      builder,
      outputPath: audio,
      // The output is a CHOP (audio signal), not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        synth: args.synth,
        audio_path: audio,
        frequency: args.frequency,
        waveform: args.synth === "noise" ? undefined : args.waveform,
        to_device: args.to_device,
        device_out: deviceOut,
      },
    });
  });
}

export const registerCreateGenerativeAudio: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_generative_audio",
    {
      title: "Create generative audio",
      description:
        "SYNTHESIZE audio — generate sound rather than react to it. Builds an audio synthesis chain ending on a Null CHOP carrying the signal: 'oscillator' (a single tone, choose sine/triangle/sawtooth/square + frequency), 'fm' (two oscillators, one frequency-modulating the other for metallic/bell timbres), or 'noise' (a Noise CHOP shaped by a low-pass filter for textures). A Volume gain sets the level. Playback is opt-in: set to_device=true to route it to an Audio Device Out CHOP (default off, so the build stays silent and never prompts for audio hardware). The output Null feeds create_spectrum/create_waveform, bind_to_channel, or the speakers. Audio CHOPs are time-dependent — the signal is silent while the TD timeline is paused.",
      inputSchema: createGenerativeAudioSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGenerativeAudioImpl(ctx, args),
  );
};

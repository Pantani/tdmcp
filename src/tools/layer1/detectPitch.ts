import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

export const detectPitchSchema = z.object({
  source: z
    .enum(["device", "file", "oscillator", "existing_chop"])
    .default("device")
    .describe(
      "Audio source. 'device' = live microphone/line in (the real-world default; creating it may pop a one-time macOS microphone-permission dialog — click Allow). 'file' = an audio file. 'oscillator' = a synthetic tone (a SINE wave at a fixed frequency → a clean single peak, the ideal device-free test for pitch tracking). 'existing_chop' = reuse a CHOP you already have.",
    ),
  audio_file_path: z.string().optional().describe("Audio file path (source='file')."),
  existing_chop_path: z
    .string()
    .optional()
    .describe("Path of an existing audio CHOP to analyze (source='existing_chop')."),
  min_hz: z.coerce
    .number()
    .positive()
    .default(80)
    .describe(
      "Bottom of the frequency search range (Hz). The dominant-bin search ignores everything below this, so sub-bass rumble / DC offset can't masquerade as the pitch. 80 Hz ≈ low male voice / bass guitar E.",
    ),
  max_hz: z.coerce
    .number()
    .positive()
    .default(2000)
    .describe(
      "Top of the frequency search range (Hz). The search ignores everything above this. 2000 Hz comfortably covers the fundamental of most melodic instruments and voice; raise it for piccolo/whistle, lower it to reject high harmonics.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live 'Sensitivity' (magnitude gain) and 'Threshold' (minimum peak magnitude below which the pitch is treated as silence) knobs.",
    ),
  parent_path: z.string().default("/project1"),
});
type DetectPitchArgs = z.infer<typeof detectPitchSchema>;

async function buildSource(builder: NetworkBuilder, args: DetectPitchArgs): Promise<string> {
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
    // A pure SINE tone gives one clean spectral peak (unlike white noise, which has NO
    // single dominant bin) — the right self-contained signal to verify pitch tracking
    // without any audio device. ~440 Hz lands inside the default 80–2000 Hz search range,
    // so pitch_hz should read ≈440 immediately.
    return builder.add("audiooscillatorCHOP", "audioin", {
      wavetype: "sine",
      frequency: 440,
      amp: 0.5,
    });
  }
  return builder.add("audiodeviceinCHOP", "audioin");
}

export async function detectPitchImpl(ctx: ToolContext, args: DetectPitchArgs) {
  return runBuild(async () => {
    // Clamp the search range to a sane order (min < max) without rejecting the call.
    const minHz = Math.max(1, Math.min(args.min_hz, args.max_hz));
    const maxHz = Math.max(minHz + 1, Math.max(args.min_hz, args.max_hz));

    const builder = await createSystemContainer(ctx, args.parent_path, "pitch");
    const source = await buildSource(builder, args);

    // FFT in "1 sample == 1 Hz" mode. The Audio Spectrum CHOP, with Mode=visual and
    // Frequency<->Log Scaling=0, emits ONE magnitude sample per Hz (per TD docs: "the level
    // you see at sample 5000 is the level at 5 KHz"). So the SAMPLE INDEX of a bin IS its
    // frequency in Hz — which is what makes a stock-CHOP argmax→Hz possible at all.
    // We request outlength = max_hz so the channel spans 0..max_hz Hz, one sample each.
    // TD clamps outlength into 128..16384, so a tiny max_hz is widened (harmless — the extra
    // high bins are simply never searched) and an extreme one is capped (see flag below).
    const fftLength = Math.min(Math.max(Math.ceil(maxHz), 128), 16384);
    const fft = await builder.add("audiospectrumCHOP", "spectrum_fft", {
      mode: "visual",
      frequencylog: 0,
      outputmenu: "setmanually",
      outlength: fftLength,
    });
    await builder.connect(source, fft);

    // Restrict the argmax to the [min_hz, max_hz] band. Because index == Hz, trimming the
    // channel to the sample range [min_hz, max_hz] (absolute, in samples, discard exterior)
    // leaves exactly the searchable bins. The Trim CHOP RE-BASES indices to 0 at the window
    // start, so the peak index we read back is OFFSET FROM min_hz — we add min_hz below.
    // The Audio Spectrum (visual) spans [0, rate/2] across `fftLength` bins, so Hz ≈
    // index * (rate/2)/fftLength — NOT 1 Hz per sample (live-verified: a 440 Hz tone peaks
    // near bin 40, not 440). Convert the Hz search band to sample indices (assume 44.1 kHz for
    // the build-time window bounds; the index→Hz expression below reads the live rate for accuracy).
    const nyquistAssumed = 44100 / 2;
    const hzToSample = (hz: number) => Math.round((hz * fftLength) / nyquistAssumed);
    const bandStart = Math.max(0, Math.min(hzToSample(minHz), fftLength - 2));
    const bandEnd = Math.max(bandStart + 1, Math.min(hzToSample(maxHz), fftLength - 1));
    const band = await builder.add("trimCHOP", "search_band", {
      relative: "abs",
      start: bandStart,
      end: bandEnd,
      startunit: "samples",
      endunit: "samples",
      discard: "exterior",
    });
    await builder.connect(fft, band);

    // ARGMAX. "highestpeakindex" returns the sample index of the highest *peak* (a local
    // maximum) — more robust for a spectrum than "maximumindex" (the global max sample),
    // since a true fundamental is a peak, whereas the global max can sit on a broad shelf.
    // nopeakvalue=-1 means "no peak found" (e.g. silence) → surfaces as a negative Hz that
    // the Threshold gate below zeroes out. The result is one sample long.
    const peakIndex = await builder.add("analyzeCHOP", "peak_index", {
      function: "highestpeakindex",
      nopeakvalue: -1,
      renamefrom: "*",
      renameto: "pitch_hz",
    });
    await builder.connect(band, peakIndex);

    // index → Hz: add the band-start offset back to get the absolute bin, then multiply by the
    // live Hz-per-bin = (rate/2)/fftLength, read from the spectrum's actual sample rate at cook
    // time (so it's correct regardless of the device rate). Replaces the old `index + min_hz`,
    // which wrongly assumed 1 Hz per bin and made the tracker read the band floor (~80 Hz).
    const toHz = await builder.add("expressionCHOP", "to_hz", {
      expr0expr: `(me.inputVal + ${bandStart}) * (op('spectrum_fft').rate / 2.0) / ${fftLength}.0`,
    });
    await builder.connect(peakIndex, toHz);

    // Peak MAGNITUDE in the same band (parallel branch): a confidence signal. Loud, clearly-
    // pitched input → large magnitude; silence/noise → small. Drives the Threshold gate and
    // is exposed as `confidence` so callers can ignore the pitch when nothing is playing.
    const peakMag = await builder.add("analyzeCHOP", "peak_mag", {
      function: "maximum",
      renamefrom: "*",
      renameto: "confidence",
    });
    await builder.connect(band, peakMag);

    // Sensitivity knob: a gain over the magnitude so the Threshold reads on a comfortable
    // scale regardless of input level. (Applied to the confidence branch only — scaling Hz
    // would corrupt the pitch.)
    const sensitivity = await builder.add("mathCHOP", "sensitivity", { gain: 1 });
    await builder.connect(peakMag, sensitivity);

    // Threshold gate: 1 while the (scaled) magnitude is above `threshold`, else 0. boundmin
    // is the live Threshold knob target; a huge boundmax makes it a one-sided "≥" test.
    // Audio Spectrum (visual) magnitudes are tiny (a clear tone peaks ~0.001–0.01, noise floor
    // ~0.0001), so the gate threshold must sit between them — 0.02 muted everything. Tune live.
    const DEFAULT_THRESHOLD = 0.0005;
    const gate = await builder.add("logicCHOP", "gate", {
      convert: "bound",
      boundmin: DEFAULT_THRESHOLD,
      boundmax: 1000000,
      renamefrom: "*",
      renameto: "gate",
    });
    await builder.connect(sensitivity, gate);

    // Gated Hz: pitch_hz × gate. When the gate is 0 (silence / below threshold) the reported
    // pitch_hz collapses to 0 instead of holding a stale or garbage frequency. Same channel
    // name on both inputs (pitch_hz) so Combine multiply keeps one channel named pitch_hz.
    const gateHz = await builder.add("renameCHOP", "gate_as_hz", {
      renamefrom: "gate",
      renameto: "pitch_hz",
    });
    await builder.connect(gate, gateHz);
    const gatedHz = await builder.add("mathCHOP", "gated_hz", { chopop: "mul" });
    await builder.connect(toHz, gatedHz, 0, 0);
    await builder.connect(gateHz, gatedHz, 0, 1);

    // MIDI note number from Hz: note = 69 + 12*log2(hz/440). Guard hz<=0 (gated silence) →
    // emit 0 rather than -inf. me.inputVal is this sample's pitch_hz. Renamed to `note`.
    const note = await builder.add("expressionCHOP", "to_note", {
      expr0expr:
        "69 + 12*tdu.math.log(me.inputVal/440.0)/tdu.math.log(2) if me.inputVal > 0 else 0",
    });
    await builder.connect(gatedHz, note);
    const noteRename = await builder.add("renameCHOP", "note_named", {
      renamefrom: "*",
      renameto: "note",
    });
    await builder.connect(note, noteRename);

    // Merge the three single-sample channels (pitch_hz, note, confidence) into one CHOP,
    // then a Null as the stable bind point — exactly like the spectrum / audio-features tail.
    const merge = await builder.add("mergeCHOP", "merged");
    await builder.connect(gatedHz, merge, 0, 0);
    await builder.connect(noteRename, merge, 0, 1);
    await builder.connect(sensitivity, merge, 0, 2);
    const pitch = await builder.add("nullCHOP", "pitch");
    await builder.connect(merge, pitch);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Sensitivity",
            type: "float",
            min: 0,
            max: 32,
            default: 1,
            bind_to: [`${sensitivity}.gain`],
          },
          {
            name: "Threshold",
            type: "float",
            min: 0,
            max: 1,
            default: DEFAULT_THRESHOLD,
            bind_to: [`${gate}.boundmin`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built an EXPERIMENTAL monophonic pitch tracker (source: ${args.source}) → ${pitch} with channels pitch_hz / note / confidence. It finds the dominant FFT bin in the ${minHz}–${maxHz} Hz range and maps it to Hz (and a MIDI note). Bind a parameter to op('${pitch}')['pitch_hz'] to drive colour/params from the melody. Sensitivity scales the confidence; Threshold mutes the pitch (→0) when nothing is clearly playing. NOTE: this is approximate (resolution ≈1 Hz, no harmonic/octave correction) and must be tuned live per source.`,
      builder,
      outputPath: pitch,
      // The output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        source: args.source,
        pitch_path: pitch,
        channels: ["pitch_hz", "note", "confidence"],
        search_range_hz: { min: minHz, max: maxHz },
        argmax_method:
          "audiospectrum(visual,frequencylog=0 → 1 sample/Hz) → trim to band → analyze highestpeakindex → +min_hz",
        experimental: true,
        // True when max_hz exceeded TD's 16384-sample spectrum cap: bins above ~16 kHz can't
        // be represented, so the effective search ceiling was clamped to fftLength.
        search_ceiling_clamped: Math.ceil(maxHz) > 16384,
        notes: [
          "Resolution is ~1 Hz per bin (coarser musically at low frequencies — a semitone near 80 Hz is <5 Hz).",
          "No octave/harmonic correction: a strong overtone can be picked instead of the fundamental, or the fundamental's octave reported.",
          "Monophonic only — a chord/polyphonic input yields whichever partial is loudest, not a meaningful single pitch.",
          "Threshold default (0.02) and Sensitivity (1.0) are starting guesses; tune live against the real source.",
        ],
      },
    });
  });
}

export const registerDetectPitch: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "detect_pitch",
    {
      title: "Detect pitch (experimental)",
      description:
        "EXPERIMENTAL monophonic pitch tracker. Estimates the dominant musical pitch of live audio and exposes pitch_hz (frequency in Hz), note (MIDI note number), and confidence (peak magnitude) on a Null CHOP — bind a colour/parameter to op('…/pitch/pitch')['pitch_hz'] to drive visuals from a melody. Built entirely from stock CHOPs (the Pitch CHOP isn't createable in this build): an Audio Spectrum CHOP in 1-sample-per-Hz mode, trimmed to a [min_hz, max_hz] search band, then an Analyze CHOP argmax (highestpeakindex) whose index IS the frequency. A Threshold knob mutes the pitch when nothing is clearly playing and a Sensitivity knob scales the magnitude. Source can be the live device (mic/line — may prompt for macOS permission), an audio file, a synthetic sine oscillator (for testing), or an existing CHOP. Caveats: ~1 Hz resolution, no harmonic/octave correction, monophonic only — approximate and best tuned live.",
      inputSchema: detectPitchSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => detectPitchImpl(ctx, args),
  );
};

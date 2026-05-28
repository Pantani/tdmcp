import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const detectTempoSchema = z.object({
  source: z
    .enum(["device", "file", "synthetic", "existing"])
    .default("synthetic")
    .describe(
      "Audio source. Defaults to 'synthetic' (an internal gated tone at a known rate) because live device capture can hang TouchDesigner on a one-time macOS microphone-permission modal — same default rationale as extract_audio_features / detect_pitch. 'device' = live microphone/line in (creating it may pop that permission dialog — click Allow). 'file' = an audio file. 'existing' = reuse a CHOP you already have.",
    ),
  file: z.string().optional().describe("Audio file path (source='file')."),
  audio_in: z
    .string()
    .optional()
    .describe("Path of an existing audio CHOP to analyze (source='existing')."),
  sensitivity: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "Onset-detection sensitivity 0..1. Higher = lower threshold = more beats registered (and a faster, twitchier lock); lower = only strong transients count. It maps to the excess-over-baseline threshold the kick band must clear (band-RMS magnitudes are tiny, so the usable window is small — tune live per source).",
    ),
  min_bpm: z.coerce
    .number()
    .positive()
    .default(60)
    .describe(
      "Lower clamp on the reported tempo. Also rejects implausibly long gaps between beats (an interval longer than 60/min_bpm seconds is ignored, so a missed beat can't halve the tempo).",
    ),
  max_bpm: z.coerce
    .number()
    .positive()
    .default(200)
    .describe(
      "Upper clamp on the reported tempo. Also rejects too-short intervals (a double-trigger shorter than 60/max_bpm seconds is ignored, so a stray transient can't double the tempo).",
    ),
  drive_tempo: z
    .boolean()
    .default(false)
    .describe(
      "When true, the engine also writes the detected BPM to the project's global tempo (op('/').time.tempo), so every Beat CHOP downstream — create_tempo_sync, create_autopilot — follows the detected beat automatically (same write as sync_external_clock).",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live 'Threshold' (onset sensitivity — lower fires on more beats) and 'Smoothing' (how many recent intervals the median locks over — higher = steadier, slower to react) knobs.",
    ),
  name: z.string().default("detect_tempo").describe("Name for the generated system container."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the generated system container (see `name`) is created inside."),
});
type DetectTempoArgs = z.infer<typeof detectTempoSchema>;

// `sensitivity` (0..1, intuitive) → the Logic CHOP `boundmin` the kick-band excess must clear.
// Band-RMS magnitudes are small (detect_onsets found a steady tone reads ~0.002 live), so the
// usable threshold window is narrow — these bounds mirror detect_onsets' tuned default of 0.01.
// Higher sensitivity → lower threshold → more onsets register.
const THRESH_MIN = 0.004;
const THRESH_MAX = 0.05;
const thresholdFor = (sensitivity: number): number =>
  THRESH_MAX - sensitivity * (THRESH_MAX - THRESH_MIN);

const DEFAULT_SMOOTHING = 6;

/**
 * CHOP Execute callback (lives in TD, runs in the normal op context — not the exec
 * namespace — so it imports `td`). It watches the beat-pulse Null (a 0/1 spike on each
 * detected onset) and fires once on the rising edge. On each beat it measures the
 * inter-onset interval, keeps a recent window, reduces it to a stable BPM via the
 * MEDIAN (robust to the odd doubled/missed beat), clamps it into [min_bpm, max_bpm],
 * and writes it to the `bpm` Constant CHOP channel — exactly mirroring the tap-tempo
 * averaging in create_sync_external_clock, but triggered by detected onsets instead of
 * a manual Tap. All TD-globals (op, absTime) are kept inside the function so the module
 * imports cleanly. The interval window length is read live from the container's
 * `Smoothing` custom par (created by the control panel) so the Smoothing knob retunes
 * the lock without a rebuild. `__DRIVE_TEMPO__` is substituted with the global-tempo
 * write (or an empty string) at build time.
 */
function buildEngine(
  bpmValuePath: string,
  minBpm: number,
  maxBpm: number,
  driveTempo: boolean,
): string {
  // The interval bounds derive from the BPM clamp: BPM = 60/interval ⇒ interval = 60/BPM.
  // A faster max_bpm ⇒ a shorter minimum interval; a slower min_bpm ⇒ a longer maximum interval.
  const minInterval = 60 / maxBpm;
  const maxInterval = 60 / minBpm;
  const driveLine = driveTempo
    ? `    try:\n        op('/').time.tempo = bpm\n    except Exception:\n        pass\n`
    : "";
  return `import td

MIN_BPM = ${minBpm}
MAX_BPM = ${maxBpm}
MIN_INTERVAL = ${minInterval}
MAX_INTERVAL = ${maxInterval}
DEFAULT_SMOOTHING = ${DEFAULT_SMOOTHING}

def _median(values):
    s = sorted(values)
    n = len(s)
    if n == 0:
        return 0.0
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0

def _window_len(owner):
    try:
        return int(max(1, owner.parent().par.Smoothing.eval()))
    except Exception:
        return DEFAULT_SMOOTHING

def onValueChange(channel, sampleIndex, val, prev):
    # Rising edge only: a single onset is one prev<=0 -> val>0 transition.
    if val <= 0 or prev > 0:
        return
    owner = me
    now = absTime.seconds
    last = owner.fetch('tdmcp_last_onset', None)
    owner.store('tdmcp_last_onset', now)
    if last is None:
        return
    interval = now - last
    # Reject out-of-range intervals (a missed beat ~doubles it; a double-trigger ~halves it),
    # so the median locks onto the true beat period instead of chasing glitches.
    if interval < MIN_INTERVAL or interval > MAX_INTERVAL:
        return
    window = list(owner.fetch('tdmcp_intervals', []))
    window.append(interval)
    window = window[-_window_len(owner):]
    owner.store('tdmcp_intervals', window)
    med = _median(window)
    if med <= 0:
        return
    bpm = max(float(MIN_BPM), min(float(MAX_BPM), 60.0 / med))
    bpm = round(bpm, 1)
    try:
        op(${q(bpmValuePath)}).par.value0 = bpm
    except Exception:
        pass
${driveLine}    return
`;
}

async function buildSource(builder: NetworkBuilder, args: DetectTempoArgs): Promise<string> {
  if (args.source === "existing" && args.audio_in) {
    // Pull the external CHOP in through a Select CHOP living inside the container; a direct
    // builder.connect(externalPath, filt) would be rejected ("cannot wire across containers").
    // The Select CHOP's source par is `chops` (verified live). Named `audioin` so the rest of
    // the chain — which wires from the conventional source name — stays source-agnostic.
    return builder.add("selectCHOP", "audioin", { chops: args.audio_in });
  }
  if (args.source === "file") {
    return builder.add("audiofileinCHOP", "audioin", {
      ...(args.file ? { file: args.file } : {}),
      play: 1,
    });
  }
  if (args.source === "device") {
    return builder.add("audiodeviceinCHOP", "audioin");
  }
  // Synthetic source: a steady tone has NO transients, so the onset detector would never
  // fire and BPM would read 0. Gate a tone with a Beat CHOP pulse at a known tempo so the
  // chain produces clean rising edges device-free: a Beat CHOP `pulse` (1 per beat at the
  // global tempo) multiplies an audio oscillator, yielding a percussive, beat-rate signal.
  const beat = await builder.add("beatCHOP", "synth_beat", { unit: "samples" });
  const tone = await builder.add("audiooscillatorCHOP", "synth_tone", {
    wavetype: "sine",
    frequency: 120,
    amp: 0.8,
  });
  const gated = await builder.add("audiooscillatorCHOP", "audioin", {
    wavetype: "sine",
    frequency: 120,
    amp: 0.8,
  });
  // Multiply the tone by the beat pulse (same channel count) → a tone that only sounds on
  // the beat. Combine "mul": tone × pulse.
  const synth = await builder.add("mathCHOP", "synth_gate", { chopop: "mul" });
  await builder.connect(tone, synth, 0, 0);
  await builder.connect(beat, synth, 0, 1);
  // `audioin` is the conventional name downstream code wires from; route the gated signal
  // through it so the rest of the chain is source-agnostic.
  await builder.connect(synth, gated);
  return gated;
}

export async function detectTempoImpl(ctx: ToolContext, args: DetectTempoArgs) {
  return runBuild(async () => {
    // Order the BPM clamp without rejecting the call (mirrors detect_pitch's range guard).
    const minBpm = Math.max(1, Math.min(args.min_bpm, args.max_bpm));
    const maxBpm = Math.max(minBpm + 1, Math.max(args.min_bpm, args.max_bpm));
    const threshold = thresholdFor(args.sensitivity);

    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const source = await buildSource(builder, args);

    // --- Onset primitive (reuses detect_onsets' approach on the kick/beat band) ---
    // Isolate the low/beat band: the kick is the most reliable tempo carrier.
    const filt = await builder.add("audiofilterCHOP", "beat_filter", {
      filter: "lowpass",
      units: "frequency",
      cutofffrequency: 150,
    });
    await builder.connect(source, filt);

    // Instantaneous band energy.
    const env = await builder.add("analyzeCHOP", "beat_env", {
      function: "rmspower",
      renamefrom: "*",
      renameto: "env",
    });
    await builder.connect(filt, env);

    // Slow moving baseline: a long lag trails the energy, so a transient briefly exceeds it.
    const baseline = await builder.add("lagCHOP", "beat_baseline", {
      lag1: 0.12,
      lag2: 0.25,
      lagunit: "seconds",
    });
    await builder.connect(env, baseline);

    // excess = instantaneous − baseline (Combine "sub"). Same channel name on both inputs,
    // so name/index matching collapses them to one channel still named `env`.
    const excess = await builder.add("mathCHOP", "beat_excess", { chopop: "sub" });
    await builder.connect(env, excess, 0, 0);
    await builder.connect(baseline, excess, 0, 1);

    // Threshold compare → clean 0/1. "bound" returns 1 only when the value is within
    // [boundmin, boundmax]; boundmin = threshold (the live Threshold knob target) and a
    // huge boundmax makes it a one-sided "excess ≥ threshold" test.
    const gate = await builder.add("logicCHOP", "beat_gate", {
      convert: "bound",
      boundmin: threshold,
      boundmax: 1000000,
    });
    await builder.connect(excess, gate);

    // Widen the one-frame spike (hold briefly on the way down) so the CHOP Execute DAT
    // reliably catches the rising edge.
    const pulse = await builder.add("lagCHOP", "beat_pulse", {
      lag1: 0,
      lag2: 0.04,
      lagunit: "seconds",
    });
    await builder.connect(gate, pulse);

    // --- BPM reduction: a Constant CHOP holds the latest BPM; the engine DAT writes it ---
    const bpmValue = await builder.add("constantCHOP", "bpm_value", {
      name0: "bpm",
      value0: 0,
    });

    // The engine watches the beat pulse, measures inter-onset intervals, and writes the
    // median-locked BPM to the Constant CHOP (and optionally the global tempo). Same
    // Execute-DAT + me.store/fetch mechanism as create_sync_external_clock's tap engine.
    const engine = await builder.add("chopexecuteDAT", "tempo_engine", {
      chop: pulse,
      valuechange: 1,
      offtoon: 0,
      active: 1,
    });
    await builder.python(
      `op(${q(engine)}).text = ${q(buildEngine(bpmValue, minBpm, maxBpm, args.drive_tempo))}`,
    );

    // Null as the stable bind point — expressions read op('…/<name>/bpm')['bpm'].
    const bpm = await builder.add("nullCHOP", "bpm");
    await builder.connect(bpmValue, bpm);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Threshold",
            type: "float",
            min: 0,
            max: 1,
            default: threshold,
            // Lower = the kick band's excess clears the bar more easily = more beats register.
            bind_to: [`${gate}.boundmin`],
          },
          {
            name: "Smoothing",
            type: "int",
            min: 1,
            max: 16,
            default: DEFAULT_SMOOTHING,
            // Read live by the engine DAT (me.parent().par.Smoothing) as its median-window
            // length — more = a steadier BPM that reacts more slowly. Not bound to a node
            // parameter; the engine pulls it each beat.
            bind_to: [],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built EXPERIMENTAL auto-tempo detection (source: ${args.source}) → ${bpm} with a single \`bpm\` channel. It detects beat onsets (kick band → moving-baseline threshold), measures the time between them, and locks the median to a BPM in the ${minBpm}–${maxBpm} range — no tapping. Bind a parameter to op('${bpm}')['bpm'], or turn on drive_tempo to push it to the global tempo so every Beat CHOP follows.${args.drive_tempo ? " drive_tempo is ON: the global tempo (op('/').time.tempo) tracks the detected beat." : ""} Lower Threshold to register more beats, raise Smoothing for a steadier lock. NOTE: BPM stability depends on the threshold + smoothing window and must be tuned live — with default params it may read 0 (no onsets cross the bar) or jitter (double/half-time); it also reads 0 while the timeline is paused.`,
      builder,
      outputPath: bpm,
      // The output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        source: args.source,
        bpm_path: bpm,
        channels: ["bpm"],
        bpm_range: { min: minBpm, max: maxBpm },
        sensitivity: args.sensitivity,
        threshold,
        drives_global_tempo: args.drive_tempo,
        engine,
        method:
          "kick-band RMS → moving-baseline excess → threshold pulse → CHOP-Execute median of inter-onset intervals → BPM = 60/median",
        experimental: true,
        notes: [
          "Time-dependent: reads 0 while the TD timeline is paused (check time.play before concluding it's broken).",
          "BPM can jump to half/double time if beats are missed/double-triggered; the median + [min_bpm,max_bpm] interval rejection mitigate but don't eliminate it — tune Threshold + Smoothing live.",
          "Threshold default and Smoothing window are starting guesses; dial them against the real source.",
          "The synthetic source gates a tone with a Beat CHOP at the GLOBAL tempo, so with drive_tempo off it self-tests at whatever op('/').time.tempo is set to.",
        ],
      },
    });
  });
}

export const registerDetectTempo: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "detect_tempo",
    {
      title: "Detect tempo (auto-BPM, experimental)",
      description:
        "EXPERIMENTAL automatic tempo (BPM) detection WITHOUT manual tapping. Detects beat onsets in live audio (kick band → RMS energy → moving-baseline threshold, reusing detect_onsets' primitive), measures the time between beats, and reduces the recent inter-onset intervals to a stable tempo (median → BPM = 60/interval) exposed as a `bpm` channel on a Null CHOP — bind a parameter to op('…/detect_tempo/bpm')['bpm']. Complements sync_external_clock (which is tap-tempo) and detect_onsets (which flags hits but derives no tempo). With drive_tempo on, it writes the detected BPM to the global tempo (op('/').time.tempo) so every Beat CHOP — create_tempo_sync, create_autopilot — follows the music automatically. Source defaults to a synthetic gated tone (device capture can hang TD on a macOS permission modal); also accepts a file, an existing CHOP, or the live device. Caveats: time-dependent (reads 0 on a paused timeline), can lock to half/double time, and must be tuned live per source (Threshold + Smoothing knobs).",
      inputSchema: detectTempoSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => detectTempoImpl(ctx, args),
  );
};

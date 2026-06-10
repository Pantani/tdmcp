import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const detectOnsetsSchema = z.object({
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
  kick_hz: z.coerce
    .number()
    .positive()
    .default(120)
    .describe("Low-pass cutoff (Hz) isolating the kick/bass-drum band."),
  snare_hz: z.coerce
    .number()
    .positive()
    .default(1500)
    .describe("Band-pass centre (Hz) isolating the snare/body band."),
  hat_hz: z.coerce
    .number()
    .positive()
    .default(6000)
    .describe("High-pass cutoff (Hz) isolating the hi-hat/cymbal band."),
  threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.01)
    .describe(
      "How far an instant's band energy must rise above its own moving baseline (in RMS units) to count as a hit. Band-RMS magnitudes are small (a steady tone reads ~0.002 live), so the default is 0.01 — the old 0.15 was unreachable and never fired. Lower = more sensitive; raise it if a loud track double-triggers. Tune live per source (needs real percussive audio to dial in).",
    ),
  emit_events: z
    .boolean()
    .default(false)
    .describe(
      "Also broadcast an `onset` event over the bridge WebSocket on every detected hit (with the band name), so `tdmcp-agent watch` and the AI can react to drum hits live.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live 'Sensitivity' (output gain) and 'Threshold' (hit sensitivity) knobs."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'onsets' container is created inside."),
});
type DetectOnsetsArgs = z.infer<typeof detectOnsetsSchema>;

// CHOP Execute callback (lives in TD, runs in the normal op context — not the exec
// namespace — so it imports `td` for the operator classes). It watches every channel of
// the onsets Null (kick/snare/hat), each a 0/1 pulse, and fires once on the rising edge
// (prev <= 0, val > 0) of a hit. On each onset it broadcasts an `onset` event through the
// bridge's Web Server DAT (located by type so it works wherever the bridge was installed),
// mirroring the tempo-sync `beat` emitter exactly.
const ONSET_EMITTER = `import td

def _webserver():
    for w in op('/').findChildren(type=td.webserverDAT):
        return w
    return None

def onValueChange(channel, sampleIndex, val, prev):
    if val <= 0 or prev > 0:
        return
    ws = _webserver()
    if ws is None:
        return
    try:
        from mcp import events
        events.broadcast(ws, 'onset', {'band': channel.name, 'value': 1})
    except Exception:
        pass
    return
`;

async function buildSource(builder: NetworkBuilder, args: DetectOnsetsArgs): Promise<string> {
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
    // White noise has energy across all bands, so kick/snare/hat all read non-zero —
    // a self-contained signal for verifying the chain without any audio device.
    return builder.add("audiooscillatorCHOP", "audioin", { wavetype: "whitenoise", amp: 0.5 });
  }
  return builder.add("audiodeviceinCHOP", "audioin");
}

/**
 * One onset detector for a drum band, built entirely from primitives (no audioenvelope /
 * pitch CHOP — not creatable in this build). Returns both the gate node (the 0/1 pulse
 * output, channel renamed to `name`) and the Logic CHOP whose `boundmin` is the live
 * Threshold knob target.
 *
 * Chain: audiofilter (band) → analyze rmspower = instantaneous energy `env`.
 *   `env` splits two ways:
 *     • fast  = `env` itself (this frame's level)
 *     • slow  = lagCHOP(env), a trailing moving baseline (longer lag)
 *   math "sub" (fast − slow) = the transient *excess* over the baseline. A steady tone
 *   sits near zero (fast ≈ slow); a hit spikes the excess.
 *   logic convert="bound", boundmin=threshold, boundmax=huge → emits 1 only while the
 *   excess ≥ threshold, i.e. a clean 0→1 spike on the attack, 0 otherwise.
 *   A short lag (down only) on the gate widens the one-frame spike enough to be seen.
 */
async function buildOnsetBand(
  builder: NetworkBuilder,
  source: string,
  name: string,
  filter: "lowpass" | "bandpass" | "highpass",
  cutoffHz: number,
  threshold: number,
): Promise<{ gate: string; logic: string }> {
  const filt = await builder.add("audiofilterCHOP", `${name}_filter`, {
    filter,
    units: "frequency",
    cutofffrequency: cutoffHz,
  });
  await builder.connect(source, filt);

  // Instantaneous band energy, named after the band so the channel survives downstream.
  const env = await builder.add("analyzeCHOP", `${name}_env`, {
    function: "rmspower",
    renamefrom: "*",
    renameto: name,
  });
  await builder.connect(filt, env);

  // Slow moving baseline: a long lag trails the energy, so a transient briefly exceeds it.
  const baseline = await builder.add("lagCHOP", `${name}_baseline`, {
    lag1: 0.12,
    lag2: 0.25,
    lagunit: "seconds",
  });
  await builder.connect(env, baseline);

  // excess = instantaneous − baseline (Combine CHOPs: subtract). Same channel name on both
  // inputs, so name/index matching collapses them to one channel still named `name`.
  const excess = await builder.add("mathCHOP", `${name}_excess`, { chopop: "sub" });
  await builder.connect(env, excess, 0, 0);
  await builder.connect(baseline, excess, 0, 1);

  // Threshold compare → clean 0/1. "bound" returns 1 only when the value is within
  // [boundmin, boundmax]; with boundmin = Threshold and a huge boundmax that means
  // "excess ≥ Threshold". boundmin is the live Threshold knob target.
  const logic = await builder.add("logicCHOP", `${name}_gate`, {
    convert: "bound",
    boundmin: threshold,
    boundmax: 1000000,
  });
  await builder.connect(excess, logic);

  // Shape the spike: hold the pulse very briefly on the way down so a single-frame hit is
  // visible / catchable, without smearing it into a sustained level.
  const gate = await builder.add("lagCHOP", name, {
    lag1: 0,
    lag2: 0.04,
    lagunit: "seconds",
  });
  await builder.connect(logic, gate);
  return { gate, logic };
}

export async function detectOnsetsImpl(ctx: ToolContext, args: DetectOnsetsArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "onsets");
    const source = await buildSource(builder, args);

    const kick = await buildOnsetBand(
      builder,
      source,
      "kick",
      "lowpass",
      args.kick_hz,
      args.threshold,
    );
    const snare = await buildOnsetBand(
      builder,
      source,
      "snare",
      "bandpass",
      args.snare_hz,
      args.threshold,
    );
    const hat = await buildOnsetBand(
      builder,
      source,
      "hat",
      "highpass",
      args.hat_hz,
      args.threshold,
    );

    // Merge the three pulse channels into one, then a Sensitivity gain, then a Null as the
    // stable bind point. Expressions read op('…/onsets/onsets')['kick'] etc.
    const merge = await builder.add("mergeCHOP", "merged");
    await builder.connect(kick.gate, merge, 0, 0);
    await builder.connect(snare.gate, merge, 0, 1);
    await builder.connect(hat.gate, merge, 0, 2);

    const gain = await builder.add("mathCHOP", "sensitivity", { gain: 1 });
    await builder.connect(merge, gain);
    const onsets = await builder.add("nullCHOP", "onsets");
    await builder.connect(gain, onsets);

    let emitter: string | undefined;
    if (args.emit_events) {
      // Watch every channel of the onsets Null; the Python callback fires on the rising
      // edge of any band. Same Execute-DAT + events.broadcast mechanism as create_tempo_sync.
      emitter = await builder.add("chopexecuteDAT", "onset_emitter", {
        chop: onsets,
        valuechange: 1,
        offtoon: 0,
        active: 1,
      });
      await builder.python(`op(${q(emitter)}).text = ${q(ONSET_EMITTER)}`);
    }

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
          {
            name: "Threshold",
            type: "float",
            min: 0,
            max: 1,
            default: args.threshold,
            // One knob retunes the hit sensitivity of all three bands at once.
            bind_to: [`${kick.logic}.boundmin`, `${snare.logic}.boundmin`, `${hat.logic}.boundmin`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built onset detection (source: ${args.source}) → ${onsets} with per-band pulse channels kick/snare/hat (0→1 spike on each hit)${args.emit_events ? ", broadcasting `onset` events" : ""}. Bind a parameter to op('${onsets}')['kick'] (etc.) to flash/cut on the actual drum hit. Raise Threshold for fewer/stronger hits, lower it for more.`,
      builder,
      outputPath: onsets,
      // The output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        source: args.source,
        onsets_path: onsets,
        channels: ["kick", "snare", "hat"],
        bands_hz: { kick: args.kick_hz, snare: args.snare_hz, hat: args.hat_hz },
        threshold: args.threshold,
        emits_onset_events: args.emit_events,
        emitter,
      },
    });
  });
}

export const registerDetectOnsets: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "detect_onsets",
    {
      title: "Detect onsets",
      description:
        "Build a transient/onset detector that flags kick/snare/hi-hat hits in live audio and exposes a per-band pulse channel (a 0→1 spike on each hit) on a Null CHOP. Unlike create_tempo_sync (a fixed internal clock), this follows the ACTUAL audio: bind a parameter to op('…/onsets/onsets')['kick'] to flash or cut exactly on the kick drum. Each band is built from primitives (band filter → RMS energy → moving-baseline compare → threshold), so a Threshold knob tunes hit sensitivity and a Sensitivity knob scales the output. Source can be the live device (mic/line — may prompt for macOS permission), an audio file, a synthetic oscillator (for testing), or an existing CHOP. With emit_events on, it also broadcasts an `onset` event over the bridge WebSocket on each hit. The audio-following complement to create_tempo_sync.",
      inputSchema: detectOnsetsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => detectOnsetsImpl(ctx, args),
  );
};

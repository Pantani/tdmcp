import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const PRIMITIVE_SOP: Record<string, string> = {
  box: "boxSOP",
  sphere: "sphereSOP",
};

export const create3dAudioReactiveSchema = z.object({
  source: z
    .enum(["device", "file", "oscillator", "existing_chop"])
    .default("device")
    .describe(
      "Audio source. 'device' = live microphone/line in (the real-world default; creating it may pop a one-time macOS microphone-permission dialog — click Allow). 'file' = an audio file. 'oscillator' = a synthetic tone (white noise → energy in every band, handy for testing without any device permission). 'existing_chop' = reuse a CHOP you already have.",
    ),
  audio_file_path: z
    .string()
    .optional()
    .describe("Path to an audio file to play; used only when source='file'."),
  existing_chop_path: z
    .string()
    .optional()
    .describe("Path of an existing audio CHOP to analyze; used only when source='existing_chop'."),
  mode: z
    .enum(["instanced_bars", "bass_pulse"])
    .default("instanced_bars")
    .describe(
      "'instanced_bars' = a row of `bands` boxes/spheres, each one's height driven by one frequency bin (a 3D spectrum bar-graph). 'bass_pulse' = a single primitive that swells with the low-frequency energy (the guaranteed-visible fallback).",
    ),
  bands: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(16)
    .describe("Number of bars in 'instanced_bars' mode — one per frequency bin."),
  primitive: z
    .enum(["box", "sphere"])
    .default("box")
    .describe("Geometry rendered for each bar / the pulsing object."),
  spin: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe(
      "Whole-scene rotation around Y in degrees/sec (0 = still). Spins the entire bar row / object over time.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live Sensitivity (audio gain), Zoom (camera distance), and Spin knobs.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the scene container is created (default '/project1')."),
});
type Create3dAudioReactiveArgs = z.infer<typeof create3dAudioReactiveSchema>;

/** Builds the audio input CHOP, mirroring createSpectrum's source semantics. */
async function buildSource(
  builder: NetworkBuilder,
  args: Create3dAudioReactiveArgs,
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
    // White noise has energy across all frequencies, so every band reads non-zero —
    // a self-contained signal for verifying the chain without any audio device.
    return builder.add("audiooscillatorCHOP", "audioin", { wavetype: "whitenoise", amp: 0.5 });
  }
  return builder.add("audiodeviceinCHOP", "audioin");
}

export async function create3dAudioReactiveImpl(ctx: ToolContext, args: Create3dAudioReactiveArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "audio3d");
    const source = await buildSource(builder, args);

    // FFT spectrum tail (same shape as create_spectrum): one channel of magnitude bins,
    // rebinned to exactly `bands` samples, then a Sensitivity gain and a Null bind point.
    // TouchDesigner clamps `outlength` into 128–4096, so request a comfortable FFT and
    // resample it down. Kept as 1 channel × N *samples* (NOT shuffled to channels): this
    // is the per-instance driver — bar i reads sample i of this single channel.
    const fftLength = Math.min(Math.max(args.bands, 128), 4096);
    const fft = await builder.add("audiospectrumCHOP", "spectrum_fft", {
      outputmenu: "setmanually",
      outlength: fftLength,
    });
    await builder.connect(source, fft);

    const rebin = await builder.add("resampleCHOP", "rebin", {
      relative: "abs",
      start: 0,
      end: args.bands - 1,
      startunit: "samples",
      endunit: "samples",
      interp: "linear",
    });
    await builder.connect(fft, rebin);

    const gain = await builder.add("mathCHOP", "sensitivity", { gain: 1 });
    await builder.connect(rebin, gain);
    const spectrum = await builder.add("nullCHOP", "spectrum");
    await builder.connect(gain, spectrum);

    // Geometry COMP (the builder clears its default torus on creation).
    const geo = await builder.add("geometryCOMP", "geo");
    const primSop = PRIMITIVE_SOP[args.primitive] as string;
    const bar = await builder.add(primSop, "bar", {}, geo);
    await builder.python(`_s = op(${q(bar)})\n_s.render = True\n_s.display = True`);

    let camDist: number;

    if (args.mode === "instanced_bars") {
      // Per-bar layout and height both come from a CHOP instance source: one *sample* per bar,
      // carrying a `tx` channel (the X position) and a `sy` channel (the bar height = that band's
      // magnitude). The Geometry COMP instances `bar` once per sample, reading tx/sy by channel
      // name. This is what actually gives each bar its own height — a per-instance *expression*
      // is evaluated only once, so instancesy must read a channel, not an indexed expression
      // (validated live in TD: a ramp source produces a staircase of bars).
      const spacing = 1.0;
      const span = Math.max(1, args.bands - 1) * spacing;

      // X positions: a ramp across the row, centred on the origin. The pattern's length tracks the
      // spectrum's actual sample count (the FFT rebin may not land on exactly `bands`), so the
      // position channel always matches the height channel sample-for-sample.
      const barx = await builder.add("patternCHOP", "bar_x", {
        wavetype: "ramp",
        amp: span,
        offset: -span / 2,
        channelname: "tx",
      });
      await builder.python(`op(${q(barx)}).par.length.expr = "op('spectrum').numSamples"`);

      // Heights: lift the tiny FFT magnitudes into a visible bar range, then rename the channel to
      // `sy` so the instancer reads it as per-bar Y scale. (Sensitivity still scales the source.)
      const heights = await builder.add("mathCHOP", "bar_height", { gain: 12 });
      await builder.connect(spectrum, heights);
      const barsy = await builder.add("renameCHOP", "bar_sy", { renamefrom: "*", renameto: "sy" });
      await builder.connect(heights, barsy);

      // Merge tx + sy into one N-sample instance source. align="start" lines both channels up
      // from sample 0 — the spectrum chain and the pattern start at different sample indices, and
      // the default "auto" align would rotate the bins (scrambling the bar order).
      const inst = await builder.add("mergeCHOP", "bar_inst", { align: "start" });
      await builder.connect(barx, inst, 0, 0);
      await builder.connect(barsy, inst, 0, 1);

      await builder.setParams(geo, {
        instancing: 1,
        instanceop: inst,
        instancetx: "tx",
        instancety: "",
        instancetz: "",
        instancesx: 0.4,
        instancesy: "sy",
        instancesz: 0.4,
      });

      camDist = span + 8;
    } else {
      // bass_pulse: a single rendered primitive (no instancing). An Analyze CHOP takes the
      // RMS of the source as a bass-energy proxy; the geo's uniform scale swells with it.
      const bass = await builder.add("analyzeCHOP", "bass", { function: "rmspower" });
      await builder.connect(source, bass);
      const bassNull = await builder.add("nullCHOP", "bass_level");
      await builder.connect(bass, bassNull);

      // Bind overall scale to 1 + bass * k. sx/sy/sz auto-switch to EXPRESSION mode.
      const k = 6;
      const scaleExpr = `1 + op(${q(bassNull)})[0] * ${k}`;
      await builder.python(
        `_g = op(${q(geo)})\nfor _ax in ("sx", "sy", "sz"):\n    getattr(_g.par, _ax).expr = ${q(scaleExpr)}`,
      );
      builder.warnings.push(
        `Bass pulse mapping may need tuning for your material: geo sx/sy/sz are bound to '${scaleExpr}' (Analyze CHOP RMS Power of the source). Adjust the ×${k} multiplier, or swap the driver to a low-band reference like op('${spectrum}')[0] if you want a specific frequency to drive the swell.`,
      );

      camDist = 6;
    }

    const cam = await builder.add("cameraCOMP", "cam", { tz: camDist });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    // Render TOP reads its scene from parameters (paths), not wires.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Whole-scene spin: an expression on the Geometry COMP's ry (auto-switches to
    // EXPRESSION mode) rotates the entire bar row / object over time.
    if (args.spin > 0) {
      await builder.python(`op(${q(geo)}).par.ry.expr = ${q(`absTime.seconds * ${args.spin}`)}`);
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
            name: "Zoom",
            type: "float",
            min: 1,
            max: camDist * 3,
            default: camDist,
            bind_to: [`${cam}.tz`],
          },
          ...(args.spin > 0
            ? [
                {
                  name: "Spin",
                  type: "float" as const,
                  min: 0,
                  max: 360,
                  default: args.spin,
                  bind_to: [`${geo}.ry`],
                },
              ]
            : []),
        ]
      : [];

    const modeNote =
      args.mode === "instanced_bars"
        ? `${args.bands} ${args.primitive} bars`
        : `a pulsing ${args.primitive}`;
    return finalize(ctx, {
      summary: `Built a 3D audio-reactive scene (${modeNote}, source: ${args.source}) rendered to ${out} — FFT spectrum → Geometry + Camera + Light + Render TOP.${args.spin > 0 ? ` Whole scene spins ${args.spin}°/s.` : ""}`,
      builder,
      outputPath: out,
      controls,
      extra: {
        mode: args.mode,
        bands: args.bands,
        source: args.source,
        spin: args.spin,
        audio_source: source,
        spectrum_path: spectrum,
        geometry: geo,
        camera: cam,
        render,
        output_path: out,
      },
    });
  });
}

export const registerCreate3dAudioReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_3d_audio_reactive",
    {
      title: "Create 3D audio-reactive scene",
      description:
        "Build a 3D scene that reacts to sound — the 3D counterpart of create_audio_reactive (use that for a 2D spectrum visual instead). Creates a new baseCOMP under `parent_path`. An FFT spectrum chain feeds geometry: 'instanced_bars' renders a row of `bands` boxes/spheres whose individual heights track each frequency bin (a 3D spectrum bar-graph), while 'bass_pulse' swells a single primitive with the low-frequency energy. Includes a Camera, Light, and Render TOP, output as a Null TOP. Exposes Sensitivity (audio gain), Zoom (camera distance), and Spin (whole-scene rotation) knobs. Source can be the live device (mic/line — may prompt for macOS permission), an audio file, a synthetic oscillator (for testing), or an existing CHOP. Returns a summary plus a JSON block with the container path, created node paths, the spectrum/geometry/camera/render/output paths, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: create3dAudioReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => create3dAudioReactiveImpl(ctx, args),
  );
};

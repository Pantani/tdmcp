import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

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
      "Waveform colour as a hex string ('#00ff88' = classic phosphor green). Tints the rendered scope line via a Constant TOP multiplied over the Render TOP image.",
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

    // CHOP-to-SOP maps channels to point attributes BY NAME. Rename the single signal channel to
    // "ty" (the per-point Y translate) so the sample value deflects each point vertically — the
    // trace. X is laid out left→right by startposx→endposx below. (Live-verified with a sine
    // pattern: a channel named "ty" deflects Y; "P(1)"/"chan1" leave the line flat.)
    const ypos = await builder.add("renameCHOP", "ypos", { renamefrom: "*", renameto: "ty" });
    await builder.connect(rebin, ypos);

    // Render the buffered samples as a real oscilloscope LINE rather than a brightness strip.
    // A flat/constant material lets the line render at full, unlit brightness (no shading
    // falloff that would dim the trace). Kept white here; the chosen colour is applied as a
    // tint after the render so the live Color control still drives one Constant TOP swatch.
    const mat = await builder.add("constantMAT", "mat", {
      colorr: 1,
      colorg: 1,
      colorb: 1,
      alpha: 1,
    });

    // A Geometry COMP renders the line SOP, so the SOP must live INSIDE the COMP.
    // createSystemContainer's builder cleared the COMP's default torus on add.
    const geo = await builder.add("geometryCOMP", "geo");

    // CHOP-to-SOP in DEFAULT mode: one point per sample, auto-spread across X in [-1, 1] by sample
    // index, with the "ty" channel (renamed above) deflecting each point's Y — a real scope trace.
    // (Live-verified: default mode gives X-spread + Y-deflection; setting startposx/endposx forces
    // explicit positions that OVERRIDE the ty deflection and flatten the line, so we leave the
    // positions at their defaults.) CHOP-to-SOP reads its source from a `chop` PARAMETER (not a
    // wire); NetworkBuilder.connect() detects the converter and patches it, so connect(ypos, line)
    // points the SOP at the renamed signal.
    const line = await builder.add("choptoSOP", "line", {}, geo);
    await builder.connect(ypos, line);

    // Flag the line SOP render+display and point the COMP's `material` param at the constant
    // MAT (mirrors create_3d_scene / create_particle_system).
    await builder.python(
      [
        `_l = op(${q(line)})`,
        "_l.render = True",
        "_l.display = True",
        `op(${q(geo)}).par.material = ${q(mat)}`,
      ].join("\n"),
    );

    // Orthographic camera so the trace keeps its true left→right / up-down shape with no
    // perspective foreshortening (a scope must not bow). orthowidth ≈ the X span (2) plus a
    // little margin frames [-1,1] full-width; default tz=1 already looks down -Z at origin,
    // and the line sits at z=0 so it faces the camera. A light is created for the render
    // scene even though the constant MAT is unlit.
    const cam = await builder.add("cameraCOMP", "cam", {
      projection: "ortho",
      orthowidth: 2.2,
      tz: 5,
    });
    const lightComp = await builder.add("lightCOMP", "light", { tx: 0, ty: 0, tz: 5 });
    // Render TOP reads its scene from PARAMETERS (camera/geometry/lights), not wires — and an
    // opaque near-black background gives the classic dark-scope look (and contrast for the
    // multiply tint). The custom resolution keeps a wide scope aspect.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: lightComp,
      bgcolorr: 0.01,
      bgcolorg: 0.02,
      bgcolorb: 0.02,
      bgcolora: 1,
      outputresolution: "custom",
      resolutionw: 1024,
      resolutionh: 256,
    });

    // Tint the white line to the chosen colour: a flat Constant TOP of the colour multiplied
    // over the render (operand 'multiply') stains the trace without touching its shape, and
    // leaves the dark background dark. Input 0 = the render, input 1 = the flat colour.
    const rgb = hexToRgb(args.color);
    const tintColor = await builder.add("constantTOP", "tint", {
      colorr: rgb.r,
      colorg: rgb.g,
      colorb: rgb.b,
      alpha: 1,
    });
    const tint = await builder.add("compositeTOP", "tinted", { operand: "multiply" });
    await builder.connect(render, tint, 0, 0);
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
      summary: `Built a waveform oscilloscope (source: ${args.source}, ${args.time_window}s window) → ${out}. The Trail CHOP scrolls the recent signal, a CHOP-to-SOP turns the samples into a deflected scope line (x=time, y=amplitude), and a Render TOP draws it as a glowing trace tinted to ${args.color}.`,
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
        line_path: line,
        render_path: render,
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
        "Build a time-domain audio waveform / oscilloscope — the actual audio signal scrolling left-to-right as a moving trace (the time-domain companion to create_spectrum's frequency bins and detect_onsets' transients). A Trail CHOP keeps a rolling buffer of recent samples (time_window seconds), a CHOP-to-SOP turns those samples into a real scope LINE (x=time, y=amplitude) rendered by a Geometry COMP through an orthographic Camera + Render TOP, and a Constant TOP tints the trace to the chosen colour. Unlike create_audio_reactive (which renders a spectrum), this shows the raw waveform. Source can be the live device (mic/line — may prompt for macOS permission), an audio file, a synthetic oscillator (for testing), or an existing CHOP. Output is a Null TOP. Scale is the vertical amplitude zoom; TimeWindow is the horizontal time span.",
      inputSchema: createWaveformSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createWaveformImpl(ctx, args),
  );
};

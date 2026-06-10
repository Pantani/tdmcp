import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const createKineticTextSchema = z.object({
  text: z
    .string()
    .default("DUQUESA")
    .describe(
      "The word or line to animate (the lyric flash). Rendered by a Text TOP. For multiple lines use \\n.",
    ),
  mode: z
    .enum(["flash", "pulse", "slide"])
    .default("flash")
    .describe(
      "Animation style: 'flash' = hard on/off blink (a square LFO gates the alpha/opacity — the classic lyric-flash, the text vanishes between flashes rather than going black); 'pulse' = breathing scale-up + alpha fade driven by a sine LFO; 'slide' = the text scrolls horizontally across the frame.",
    ),
  size: z.coerce
    .number()
    .positive()
    .default(120)
    .describe("Font size in pixels (drives the Text TOP's fontsizex / fontsizey)."),
  color: z
    .string()
    .default("#ffffff")
    .describe(
      "Text colour as a hex string ('#ffffff' = white). Sets the Text TOP's fontcolorr/g/b.",
    ),
  rate_hz: z.coerce
    .number()
    .positive()
    .default(2)
    .describe(
      "Animation rate in cycles per second (Hz) — the LFO frequency. Free-running for v1; bind it to a beat CHOP to fire on the actual beat.",
    ),
  input_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute path of a source TOP to lay the text OVER. Pulled in via a Select TOP (TD wires don't cross containers) and composited under the text. If omitted, the text animates on a transparent frame.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live Text / Size / Color / Rate controls bound to the right node parameters.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the kinetic-text container is created (default '/project1')."),
});
type CreateKineticTextArgs = z.infer<typeof createKineticTextSchema>;

/** Parses '#rrggbb' / 'rrggbb' (3- or 6-digit) into 0..1 RGB. Falls back to white. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 1, g: 1, b: 1 };
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

export async function createKineticTextImpl(ctx: ToolContext, args: CreateKineticTextArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "kinetic_text");
    const rgb = hexToRgb(args.color);

    // The word itself. Text TOP param names (verified against text_top.json): `text`,
    // `fontsizex`/`fontsizey`, `fontcolorr/g/b`, `alignx`/`aligny` (centre it in frame).
    const textTop = await builder.add("textTOP", "text", {
      text: args.text,
      fontsizex: args.size,
      fontsizey: args.size,
      fontcolorr: rgb.r,
      fontcolorg: rgb.g,
      fontcolorb: rgb.b,
      alignx: "center",
      aligny: "center",
    });

    // The animation driver. flash uses a square wave (hard gate); pulse/slide use a sine
    // (smooth motion). channelname 'chan1' so the brightness/transform expressions can
    // reference op(lfo)['chan1'] by ABSOLUTE path (param expressions evaluate relative to
    // the node's PARENT, so a relative name would not resolve).
    const lfo = await builder.add("lfoCHOP", "anim_lfo", {
      wavetype: args.mode === "flash" ? "square" : "sine",
      frequency: args.rate_hz,
      amp: 1,
      offset: 0,
      channelname: "chan1",
    });

    // Build the animation per mode. `animated` is the TOP carrying the moving text; the
    // node whose opacity the flash/fade gates is `level` (when present).
    let animated = textTop;
    let levelNode: string | undefined;
    let transformNode: string | undefined;

    if (args.mode === "flash") {
      // Hard on/off: the square LFO swings [-1, 1]; treat >0 as "on" so the text snaps
      // fully on then fully off (a crisp flash, not a fade). Gate the Level TOP's `opacity`
      // (the alpha multiplier — verified in level_top.json: `level.par.opacity`), NOT
      // brightness1: brightness only darkens the RGB, so "off" left a BLACK text silhouette
      // composited over a background. opacity 0 multiplies the glyph alpha to zero, so the
      // whole layer truly vanishes (RGB / font colour is untouched). Switch it to EXPRESSION
      // mode the way animate_parameter does — `type(par.mode).EXPRESSION` (ParMode isn't a
      // bridge global).
      const level = await builder.add("levelTOP", "level", { opacity: 1 });
      await builder.connect(textTop, level);
      const expr = `(1 if op(${q(lfo)})['chan1'] > 0 else 0)`;
      await builder.python(
        `_p = op(${q(level)}).par.opacity\n_p.expr = ${q(expr)}\n_p.mode = type(_p.mode).EXPRESSION`,
      );
      levelNode = level;
      animated = level;
    } else if (args.mode === "pulse") {
      // Breathing scale + fade. The sine LFO (chan1, [-1, 1]) drives a Transform TOP's
      // sx/sy (scale, NOT scalex/scaley) between ~0.8 and ~1.2, and a Level TOP's `opacity`
      // between ~0.4 and 1.0 — the word swells and fades in/out, then recedes. Fading the
      // alpha (opacity), not brightness1, so the text fades to transparent (not to black)
      // over a background; RGB / font colour stays intact.
      const transform = await builder.add("transformTOP", "scale", { sx: 1, sy: 1 });
      await builder.connect(textTop, transform);
      const scaleExpr = `(1 + 0.2 * op(${q(lfo)})['chan1'])`;
      await builder.python(
        [
          `_t = op(${q(transform)})`,
          `for _name in ('sx', 'sy'):`,
          `    _p = getattr(_t.par, _name)`,
          `    _p.expr = ${q(scaleExpr)}`,
          `    _p.mode = type(_p.mode).EXPRESSION`,
        ].join("\n"),
      );
      const level = await builder.add("levelTOP", "level", { opacity: 1 });
      await builder.connect(transform, level);
      const fadeExpr = `(0.7 + 0.3 * op(${q(lfo)})['chan1'])`;
      await builder.python(
        `_p = op(${q(level)}).par.opacity\n_p.expr = ${q(fadeExpr)}\n_p.mode = type(_p.mode).EXPRESSION`,
      );
      transformNode = transform;
      levelNode = level;
      animated = level;
    } else {
      // Horizontal scroll. Drive the Transform TOP's tx (translate X, NOT translatex) with
      // the sine LFO so the word slides left↔right across the frame (±0.5 of the frame
      // width). For a continuous one-way scroll, bind tx to a Speed CHOP/ramp instead.
      const transform = await builder.add("transformTOP", "slide", { tx: 0, ty: 0 });
      await builder.connect(textTop, transform);
      const slideExpr = `(0.5 * op(${q(lfo)})['chan1'])`;
      await builder.python(
        `_p = op(${q(transform)}).par.tx\n_p.expr = ${q(slideExpr)}\n_p.mode = type(_p.mode).EXPRESSION`,
      );
      transformNode = transform;
      animated = transform;
    }

    // Optionally composite the animated text OVER an external source. The source can live
    // in another container, so it must be pulled in by a Select TOP (`top` = absolute path)
    // rather than a (cross-container-illegal) wire. operand 'over' = alpha compositing,
    // with the text on input 1 (on top) and the source on input 0 (background).
    let output = animated;
    if (args.input_path) {
      const src = await builder.add("selectTOP", "src", { top: args.input_path });
      const comp = await builder.add("compositeTOP", "comp", { operand: "over" });
      await builder.connect(src, comp, 0, 0);
      await builder.connect(animated, comp, 0, 1);
      output = comp;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Text",
            type: "string",
            default: args.text,
            bind_to: [`${textTop}.text`],
          },
          {
            name: "Size",
            type: "float",
            min: 0,
            max: 500,
            default: args.size,
            // Keep X and Y in lockstep so the knob scales the glyphs uniformly.
            bind_to: [`${textTop}.fontsizex`, `${textTop}.fontsizey`],
          },
          {
            // A single float over all three RGB components (a whiteness / brightness knob);
            // the build-time `color` sets the actual hue. 'rgb' controls can't bind, so a
            // float driving fontcolorr/g/b is the bindable way to live-tweak the colour.
            name: "Color",
            type: "float",
            min: 0,
            max: 1,
            default: Math.max(rgb.r, rgb.g, rgb.b),
            bind_to: [`${textTop}.fontcolorr`, `${textTop}.fontcolorg`, `${textTop}.fontcolorb`],
          },
          {
            name: "Rate",
            type: "float",
            min: 0,
            max: 30,
            default: args.rate_hz,
            bind_to: [`${lfo}.frequency`],
          },
        ]
      : [];

    const modeBlurb =
      args.mode === "flash"
        ? `flashing on/off at ${args.rate_hz} Hz`
        : args.mode === "pulse"
          ? `pulsing (scale + fade) at ${args.rate_hz} Hz`
          : `sliding horizontally at ${args.rate_hz} Hz`;

    return finalize(ctx, {
      summary: `Built kinetic text "${args.text}" ${modeBlurb}${
        args.input_path ? ` over ${args.input_path}` : ""
      } → ${out}. Rate is free-running for v1 — bind op('${lfo}').par.frequency to a beat CHOP, or bind a Trigger to a detect_onsets channel, to fire on the actual beat.`,
      builder,
      outputPath: out,
      // Output is a TOP (the Null), so a preview image is captured.
      capturePreviewImage: true,
      controls,
      extra: {
        text: args.text,
        mode: args.mode,
        size: args.size,
        color: { r: rgb.r, g: rgb.g, b: rgb.b },
        rate_hz: args.rate_hz,
        text_path: textTop,
        lfo_path: lfo,
        level_path: levelNode,
        transform_path: transformNode,
        output_path: out,
        input_path: args.input_path,
      },
    });
  });
}

export const registerCreateKineticText: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_kinetic_text",
    {
      title: "Create kinetic text",
      description:
        "Build a self-contained animated / kinetic typography layer — a word or line that flashes, pulses, or slides, the signature live-VJ lyric-flash effect. A Text TOP renders the text; an LFO CHOP at the given Rate (Hz) drives the animation: 'flash' gates a Level TOP's alpha/opacity hard on/off (a square wave — the text vanishes between flashes rather than turning black, so it pops cleanly in and out over a background), 'pulse' drives a Transform TOP's scale plus a Level TOP alpha fade (a sine, the text breathes), and 'slide' scrolls the Transform TOP's translate-X. Creates a new baseCOMP under `parent_path` holding the Text TOP, the LFO, the per-mode Transform/Level nodes, an optional Composite, and a Null output. With an input_path the text is composited OVER that source (pulled in by a Select TOP, so it can live in another container); without one it animates on a transparent frame. Rate is free-running for v1 — bind the LFO's frequency to a beat CHOP (or a Trigger to a detect_onsets channel) to lock the flashes to the tempo. Returns a summary plus a JSON block with the container path, created node paths, the text/lfo/output paths, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createKineticTextSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createKineticTextImpl(ctx, args),
  );
};

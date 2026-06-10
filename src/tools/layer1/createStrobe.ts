import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const createStrobeSchema = z.object({
  rate_hz: z.coerce
    .number()
    .positive()
    .default(8)
    .describe("Strobe rate in flashes per second (Hz) — the LFO CHOP square-wave frequency."),
  intensity: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Brightness of the flash when it is on (0..1). Drives the Level TOP's brightness1."),
  color: z
    .string()
    .default("#ffffff")
    .describe(
      "Flash colour as a hex string ('#ffffff' = white, the classic strobe). Sets the Constant TOP's RGB.",
    ),
  duty: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "On-time fraction of each cycle (0..1, 0.5 = even on/off). Mapped to the LFO CHOP's Bias, which rectangularises the square wave.",
    ),
  input_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute path of a source TOP to flash OVER. Pulled in via a Select TOP (TD wires don't cross containers) and composited under the flash. If omitted, the bare flash is output.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live Rate / Intensity / Duty knobs bound to the right node parameters."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'strobe' container is created inside."),
});
type CreateStrobeArgs = z.infer<typeof createStrobeSchema>;

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

export async function createStrobeImpl(ctx: ToolContext, args: CreateStrobeArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "strobe");
    const rgb = hexToRgb(args.color);

    // The flash colour (a flat, full-frame TOP). Default white = the classic strobe.
    const flash = await builder.add("constantTOP", "flash", {
      colorr: rgb.r,
      colorg: rgb.g,
      colorb: rgb.b,
      alpha: 1,
    });

    // The strobe signal: a square-wave LFO whose Bias controls duty (rectangularity).
    // square swings [-1, 1] (verified in animate_parameter); the brightness expression
    // below treats anything > 0 as "on", giving a crisp hard on/off rather than a fade.
    // Bias 0 = even 50% duty; map duty 0..1 → bias -1..1.
    const bias = (args.duty - 0.5) * 2;
    const lfo = await builder.add("lfoCHOP", "strobe_lfo", {
      wavetype: "square",
      frequency: args.rate_hz,
      amp: 1,
      offset: 0,
      bias,
      channelname: "chan1",
    });

    // Drive the flash brightness on/off from the LFO. Param expressions evaluate relative
    // to the node's PARENT, so reference the LFO channel by ABSOLUTE path. The Level TOP's
    // brightness param is `brightness1` (NOT `gain`). Switch the param to EXPRESSION mode
    // the same way animate_parameter does: `type(par.mode).EXPRESSION` (ParMode isn't in
    // the bridge exec globals).
    const blink = await builder.add("levelTOP", "blink", { brightness1: args.intensity });
    await builder.connect(flash, blink);
    const expr = `(${args.intensity} if op(${q(lfo)})['chan1'] > 0 else 0)`;
    await builder.python(
      `_p = op(${q(blink)}).par.brightness1\n_p.expr = ${q(expr)}\n_p.mode = type(_p.mode).EXPRESSION`,
    );

    // Optionally composite the blinking flash OVER an external source. The source can live
    // in another container, so it must be pulled in by a Select TOP (`top` = absolute path)
    // rather than a (cross-container-illegal) wire. operand 'over' = alpha compositing.
    let output = blink;
    if (args.input_path) {
      const src = await builder.add("selectTOP", "src", { top: args.input_path });
      const comp = await builder.add("compositeTOP", "comp", { operand: "over" });
      // Input 0 = background (the source), input 1 = the flash on top.
      await builder.connect(src, comp, 0, 0);
      await builder.connect(blink, comp, 0, 1);
      output = comp;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Rate",
            type: "float",
            min: 0,
            max: 30,
            default: args.rate_hz,
            bind_to: [`${lfo}.frequency`],
          },
          {
            name: "Intensity",
            type: "float",
            min: 0,
            max: 1,
            default: args.intensity,
            // brightness1 is driven by the expression above; the knob is its multiplier
            // input (the expression's `intensity` literal is the build-time default).
            bind_to: [`${blink}.brightness1`],
          },
          {
            // Duty maps to the LFO's Bias (square-wave rectangularity): -1 = mostly off,
            // 0 = even 50/50, +1 = mostly on. Exposed across the full bias range.
            name: "Duty",
            type: "float",
            min: -1,
            max: 1,
            default: bias,
            bind_to: [`${lfo}.bias`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a strobe (${args.rate_hz} Hz square-wave LFO, duty ${args.duty})${
        args.input_path ? ` flashing over ${args.input_path}` : ""
      } → ${out}. Bind op('${lfo}').par.frequency to a beat CHOP to lock it to the tempo.`,
      builder,
      outputPath: out,
      // Output is a TOP (the Null), so a preview image is captured.
      capturePreviewImage: true,
      controls,
      extra: {
        rate_hz: args.rate_hz,
        intensity: args.intensity,
        duty: args.duty,
        color: { r: rgb.r, g: rgb.g, b: rgb.b },
        lfo_path: lfo,
        flash_path: flash,
        output_path: out,
        input_path: args.input_path,
      },
    });
  });
}

export const registerCreateStrobe: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_strobe",
    {
      title: "Create strobe",
      description:
        "Build a beat-syncable strobe / flash layer — a full-frame colour flash that pulses hard on/off, the signature live-VJ strobe effect. A square-wave LFO CHOP at the given Rate (Hz) drives a Level TOP's brightness so a Constant TOP (the flash colour, white by default) blinks; Duty sets the on-time fraction. With an input_path the flash is composited OVER that source (pulled in by a Select TOP, so it can live in another container); without one, the bare flash is output. Output is a Null TOP. Rate is free-running for v1 — bind the LFO's frequency to a beat CHOP later to lock it to the tempo.",
      inputSchema: createStrobeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createStrobeImpl(ctx, args),
  );
};

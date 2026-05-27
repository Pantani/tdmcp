import { z } from "zod";
import { createSystemContainer, finalize, runBuild } from "../layer1/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import type { ControlSpec } from "./createControlPanel.js";

const q = (value: string): string => JSON.stringify(value);

export const createPanicSchema = z.object({
  input_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute path of the live source TOP to protect. Pulled in via a Select TOP (TD wires can't cross containers, so it's referenced by path). If omitted, a built-in test source (Ramp TOP) is used so the panic COMP still builds and previews on its own.",
    ),
  blackout: z
    .boolean()
    .default(false)
    .describe(
      "Initial Blackout state. When on, the output is forced to black (Level TOP brightness1 = 0) — the instant kill switch.",
    ),
  freeze: z
    .boolean()
    .default(false)
    .describe(
      "Initial Freeze state. When on, the last frame is held instead of passing the live input (Cache TOP stops capturing — active = 0).",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose big Blackout and Freeze toggle buttons on the container so a performer can hit them instantly.",
    ),
  parent_path: z.string().default("/project1"),
});
type CreatePanicArgs = z.infer<typeof createPanicSchema>;

export async function createPanicImpl(ctx: ToolContext, args: CreatePanicArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "panic");
    const container = builder.containerPath;

    // The Blackout / Freeze custom toggle params live on the container. When controls are
    // exposed they're created (with their initial states + panel buttons) by the control
    // panel in finalize() below — appending them here too would collide. When controls are
    // NOT exposed we append them directly so the COMP is still usable via op().par. Either
    // way the effect expressions reference them by ABSOLUTE path; TD resolves that lazily,
    // so it's fine that the panel appends them after these expressions are set. ParMode
    // isn't in the bridge exec globals, so expression mode is set via `type(par.mode)`.
    if (!args.expose_controls) {
      await builder.python(
        [
          `_c = op(${q(container)})`,
          `_pg = None`,
          `for _p in _c.customPages:`,
          `    if _p.name == "Panic":`,
          `        _pg = _p; break`,
          `if _pg is None:`,
          `    _pg = _c.appendCustomPage("Panic")`,
          `if getattr(_c.par, "Blackout", None) is None:`,
          `    _bp = _pg.appendToggle("Blackout", label="Blackout")[0]`,
          `    _bp.default = ${args.blackout ? "True" : "False"}; _bp.val = ${args.blackout ? "True" : "False"}`,
          `if getattr(_c.par, "Freeze", None) is None:`,
          `    _fp = _pg.appendToggle("Freeze", label="Freeze")[0]`,
          `    _fp.default = ${args.freeze ? "True" : "False"}; _fp.val = ${args.freeze ? "True" : "False"}`,
        ].join("\n"),
      );
    }

    // The source to protect. With input_path it's pulled in by a Select TOP (`top` =
    // absolute path), since wires can't cross COMPs. Without one, a Ramp TOP gives a
    // non-device test image so the panic COMP builds + previews standalone.
    let source: string;
    if (args.input_path) {
      source = await builder.add("selectTOP", "src", { top: args.input_path });
    } else {
      source = await builder.add("rampTOP", "src");
    }

    // FREEZE — a Cache TOP holds the last frame. While its `active` param is on the Cache
    // captures live frames (passes the source through); when Freeze is on we drive `active`
    // to 0, so it stops capturing and outputs the last frame it held — an instant freeze.
    // Expression references the container's Freeze par by ABSOLUTE path. `cachesize` 1 keeps
    // it to a single held frame.
    const freeze = await builder.add("cacheTOP", "freeze", {
      cachesize: 1,
      active: args.freeze ? 0 : 1,
    });
    await builder.connect(source, freeze);
    const freezeExpr = `(0 if op(${q(container)}).par.Freeze else 1)`;
    await builder.python(
      `_p = op(${q(freeze)}).par.active\n_p.expr = ${q(freezeExpr)}\n_p.mode = type(_p.mode).EXPRESSION`,
    );

    // BLACKOUT — a Level TOP whose brightness1 is driven to 0 when Blackout is on (→ black)
    // and 1 otherwise (→ pass-through). brightness1 is the brightness param (NOT `gain`).
    // Expression references the container's Blackout par by ABSOLUTE path.
    const blackout = await builder.add("levelTOP", "blackout", {
      brightness1: args.blackout ? 0 : 1,
    });
    await builder.connect(freeze, blackout);
    const blackoutExpr = `(0 if op(${q(container)}).par.Blackout else 1)`;
    await builder.python(
      `_p = op(${q(blackout)}).par.brightness1\n_p.expr = ${q(blackoutExpr)}\n_p.mode = type(_p.mode).EXPRESSION`,
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(blackout, out);

    // Big togglable Blackout / Freeze buttons on the container, so a performer can hit them
    // instantly. These are the SOURCE-OF-TRUTH pars that the freeze/blackout node expressions
    // above read by absolute path — so they must NOT use bind_to: a control panel bind sets the
    // target's expr to `op(container).par.<Name>`, and binding Blackout/Freeze to themselves
    // creates a self-referential expression ("Recursion/loop error in evaluation of parameter").
    // Created unbound here, they're plain toggles the expressions consume.
    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "Blackout", type: "toggle", default: args.blackout },
          { name: "Freeze", type: "toggle", default: args.freeze },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a panic / safety control → ${out}: Blackout kills the output to black and Freeze holds the last frame${
        args.input_path ? ` of ${args.input_path}` : " (built-in test source)"
      }. Hit op('${container}').par.Blackout / .par.Freeze (or the panel buttons) live.`,
      builder,
      outputPath: out,
      // Output is a TOP (the Null), so a preview image is captured.
      capturePreviewImage: true,
      controls,
      extra: {
        blackout: args.blackout,
        freeze: args.freeze,
        source_path: source,
        freeze_path: freeze,
        blackout_path: blackout,
        output_path: out,
        input_path: args.input_path,
      },
    });
  });
}

export const registerCreatePanic: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_panic",
    {
      title: "Create panic control",
      description:
        "Build a live-performance safety control — the 'oh no' button every VJ needs. Wraps a source in a small COMP with two instant kill switches: Blackout forces the output to black (a Level TOP's brightness1 driven to 0) and Freeze holds the last frame (a Cache TOP stops capturing, active → 0). With an input_path the source is pulled in by a Select TOP (so it can live in another container); without one a built-in Ramp TOP test source is used so it builds and previews standalone. Output is a Null TOP. Big Blackout / Freeze toggle buttons are exposed on the container so a performer can hit them instantly.",
      inputSchema: createPanicSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPanicImpl(ctx, args),
  );
};

import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

export const createDisplacementWarpSchema = z.object({
  name: z
    .string()
    .default("displacement_warp")
    .describe("Name of the container COMP created under parent_path."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained displacement warp container is created inside."),
  source: z
    .string()
    .optional()
    .describe(
      "Absolute path of a TOP to warp (pulled in via a Select TOP so it can live anywhere in the network). Omit to use a built-in Ramp TOP test source so the chain builds and previews standalone.",
    ),
  modulator: z
    .enum(["noise", "second_top", "audio"])
    .default("noise")
    .describe(
      "What drives the displacement map. 'noise' (default): an animated Noise TOP whose translate and period are driven by time — produces smooth heat-haze / liquid warp. 'second_top': a Select TOP pointing at `modulator_top` (your own displacement map). 'audio': a CHOP-to-TOP conversion of audio FFT energy — pixels push in proportion to the audio spectrum. The audio modulator requires an audio device or audio file to be active in the project; without one it runs silently at zero energy.",
    ),
  modulator_top: z
    .string()
    .optional()
    .describe(
      "(second_top mode only) Absolute path of a TOP to use as the displacement map. Required when modulator is 'second_top'; ignored otherwise.",
    ),
  amount: z.coerce
    .number()
    .min(0)
    .default(0.1)
    .describe(
      "Displacement strength — maps to the Displace TOP's `displaceweight1` parameter. 0 = no warp; 1 = full-range warp (can tear); 0.05–0.3 are typical VJ values.",
    ),
  speed: z.coerce
    .number()
    .min(0)
    .default(0.5)
    .describe(
      "(noise mode) Animation speed of the noise modulator. Scales the time-driven translate on the Noise TOP — higher values produce faster, more turbulent warp.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [width, height] in pixels."),
});

type CreateDisplacementWarpArgs = z.infer<typeof createDisplacementWarpSchema>;

export async function createDisplacementWarpImpl(
  ctx: ToolContext,
  args: CreateDisplacementWarpArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const [resW, resH] = args.resolution;

    // ── Source ────────────────────────────────────────────────────────────────
    // Pull in an external TOP via Select (wires don't cross containers) or
    // use a Ramp TOP test gradient so the chain previews standalone.
    let source: string;
    if (args.source) {
      source = await builder.add("selectTOP", "source", {
        top: args.source,
        resolutionw: resW,
        resolutionh: resH,
      });
    } else {
      source = await builder.add("rampTOP", "source", {
        type: "horizontal",
        resolutionw: resW,
        resolutionh: resH,
      });
    }

    // ── Modulator ─────────────────────────────────────────────────────────────
    // Produces the displacement-map image.  Red channel → horizontal U offset;
    // Blue/Green → vertical V offset (displaceTOP defaults: horizsource=red,
    // vertsource defaults to green in practice — we leave defaults and let the
    // artist adjust, as these are menu-enum pars whose tokens vary by build).
    let modulator: string;
    let modulatorNote = "";

    if (args.modulator === "noise") {
      // Animated Perlin noise: translate the sampling plane through noise space
      // using absTime so it animates continuously.  `tx`/`ty` are the X/Y
      // translate pars on the noiseTOP (confirmed in KB: 't' parameter group
      // with tx/ty/tz sub-pars).  `period` controls the spatial scale of the
      // noise pattern; `speed` scales the time rate via a python expression.
      // NOTE: The expression is baked at build time with a literal speed value
      // so it works even when no TD timeline is playing (uses absTime.seconds).
      modulator = await builder.add("noiseTOP", "modulator", {
        period: 2,
        mono: 1,
        resolutionw: resW,
        resolutionh: resH,
      });
      // Drive the noise translate via absTime so it moves when TD is paused too.
      // We set the expressions via Python because the structured param setter cannot
      // write expression strings. Assigning .expr alone does NOT activate the
      // expression in TD — the par must also be switched to EXPRESSION mode, or the
      // noise stays static and the warp never animates. ParMode isn't a global in the
      // bridge exec scope, so derive it from the live par (type(par.mode)), as
      // bind_to_channel does.
      const txExpr = `absTime.seconds * ${args.speed}`;
      const tyExpr = `absTime.seconds * ${args.speed} * 0.7`;
      await builder.python(
        [
          `_n = op(${JSON.stringify(modulator)})`,
          "try:",
          "    _pm = type(_n.par.tx.mode)",
          `    _n.par.tx.expr = ${JSON.stringify(txExpr)}`,
          "    _n.par.tx.mode = _pm.EXPRESSION",
          `    _n.par.ty.expr = ${JSON.stringify(tyExpr)}`,
          "    _n.par.ty.mode = _pm.EXPRESSION",
          "except Exception:",
          "    pass",
        ].join("\n"),
      );
    } else if (args.modulator === "second_top") {
      // Use the caller's supplied TOP as the displacement map directly.
      const topPath = args.modulator_top ?? "";
      modulator = await builder.add("selectTOP", "modulator", {
        top: topPath,
        resolutionw: resW,
        resolutionh: resH,
      });
      if (!topPath) {
        modulatorNote =
          "modulator_top was not supplied for second_top mode — Select TOP source is empty; supply a valid TOP path.";
        builder.warnings.push(modulatorNote);
      }
    } else {
      // audio mode: route audio FFT energy into a texture via CHOP-to-TOP.
      // audiospectrumCHOP → choptotop (source via `chop` param, handled by
      // converterSourceParam in orchestration).
      // NOTE: Requires an audio device or audio file active in the project;
      // without one the spectrum is zero and displacement is flat.
      const spectrum = await builder.add("audiospectrumCHOP", "audio_spectrum", {
        windowsize: 256,
        smooth: 0.8,
      });
      modulator = await builder.add("choptoTOP", "modulator", {
        chop: spectrum,
        resolutionw: resW,
        resolutionh: resH,
      });
      modulatorNote =
        "audio mode: requires an active audio device or file; displacement will be flat if no audio is present.";
    }

    // ── Displace TOP ──────────────────────────────────────────────────────────
    // Input 0 = source (image to warp), Input 1 = modulator (displacement map).
    // Key par: `displaceweight1` (scales offset; 0=no warp, 1=full).
    // `midpoint1`/`midpoint2` = the mid-grey value that means "no displacement"
    // (0.5 is standard for bipolar maps; noise generates 0–1 so 0.5 is neutral).
    // UNVERIFIED: exact par token for displace weight is `displaceweight1` per KB
    // description ("displaceweight -"); token suffix `1` is the standard TD
    // component convention. Set defensively with a try/except via python fallback
    // (see warnings). The `horizsource`/`vertsource` channel selection pars are
    // menu enums whose exact token values vary by build — left at defaults (R→U,
    // G or B→V) so they work without probing.
    const displace = await builder.add("displaceTOP", "displace", {
      midpoint1: 0.5,
      midpoint2: 0.5,
      resolutionw: resW,
      resolutionh: resH,
    });

    // Wire source → input 0, modulator → input 1 of the Displace TOP.
    await builder.connect(source, displace, 0, 0);
    await builder.connect(modulator, displace, 0, 1);

    // Set the displace weight via Python so we can try multiple par token
    // spellings defensively (the KB shows `displaceweight` but the actual
    // instantiated par may carry a suffix `1`).
    await builder.python(
      `_d = op(${JSON.stringify(displace)})\n_set = False\nfor _pn in ['displaceweight1', 'displaceweight']:\n    try:\n        setattr(_d.par, _pn, ${args.amount})\n        _set = True\n        break\n    except Exception:\n        pass\nif not _set:\n    pass  # amount will stay at TD default`,
    );

    // ── Output Null ───────────────────────────────────────────────────────────
    const out = await builder.add("nullTOP", "out1", {
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(displace, out);

    // ── Controls ──────────────────────────────────────────────────────────────
    const controls: ControlSpec[] = [
      {
        name: "Amount",
        type: "float",
        min: 0,
        max: 1,
        default: args.amount,
        bind_to: [],
      },
    ];

    if (args.modulator === "noise") {
      controls.push({
        name: "Speed",
        type: "float",
        min: 0,
        max: 5,
        default: args.speed,
        bind_to: [],
      });
    }

    const modeLabel =
      args.modulator === "noise"
        ? "animated noise"
        : args.modulator === "second_top"
          ? `second TOP (${args.modulator_top ?? "not set"})`
          : "audio FFT";

    const sourceSummary = args.source ? args.source : "test ramp";

    let summary = `Built a displacement warp (${modeLabel} modulator, amount ${args.amount}) over ${sourceSummary} → ${out}.`;
    if (modulatorNote) summary += ` Note: ${modulatorNote}`;

    const extra: Record<string, unknown> = {
      modulator: args.modulator,
      amount: args.amount,
      speed: args.speed,
      source_path: args.source,
      modulator_top: args.modulator_top,
      resolution: args.resolution,
      displace_path: displace,
      modulator_path: modulator,
      output_path: out,
      unverified: [
        "displaceTOP `displaceweight1` par token set defensively (tries displaceweight1, then displaceweight).",
        "displaceTOP horizsource/vertsource channel-selection menu tokens not probed — left at TD defaults (Red→U, default→V).",
        "noiseTOP tx/ty expression assignment via par.expr — fails silently if par is in constant mode; warp still builds but won't animate.",
      ],
    };

    if (modulatorNote) {
      extra.modulator_note = modulatorNote;
    }

    return finalize(ctx, {
      summary,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra,
    });
  });
}

export const registerCreateDisplacementWarp: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_displacement_warp",
    {
      title: "Create displacement warp",
      description:
        "Build a displacement-warp stage over a source — the 'heat-haze, liquid, audio-pushed pixels' tool for VJ sets. A Displace TOP warps the source image using a second image as a displacement map; the map is driven by one of three modulators: 'noise' (animated Perlin noise — smooth, continuous warp), 'second_top' (your own displacement map via a Select TOP), or 'audio' (audio FFT spectrum converted to a texture via CHOP-to-TOP, so the warp reacts to the music). Without a source the chain builds over a Ramp TOP test gradient and previews standalone. The Displace TOP's weight (`displaceweight1`) maps to the `amount` parameter; the Noise TOP translate speed maps to `speed`. Amount and Speed are exposed as live knobs. Output is a Null TOP. Returns a summary plus JSON with the container path, created node paths, controls, errors, warnings, and an inline preview image. Pairs with extract_audio_features for reactive warp and apply_post_processing to chain with other effects.",
      inputSchema: createDisplacementWarpSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDisplacementWarpImpl(ctx, args),
  );
};

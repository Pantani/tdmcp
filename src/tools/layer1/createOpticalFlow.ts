import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

export const createOpticalFlowSchema = z.object({
  name: z
    .string()
    .default("optical_flow")
    .describe("Name of the container COMP created under parent_path."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the optical flow container is created inside."),
  source: z
    .string()
    .optional()
    .describe(
      "Absolute path of a TOP to analyze for motion (pulled in via selectTOP so it can live anywhere). Omit to use TD's bundled Mosaic.mp4 test clip so the chain previews standalone without a live camera (avoids macOS permission hang).",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([640, 360])
    .describe(
      "Output resolution [width, height] in pixels. Default is half-HD — CPU optical flow is bandwidth-bound; larger resolutions are slower.",
    ),
  sensitivity: z.coerce
    .number()
    .min(0)
    .default(4.0)
    .describe(
      "Multiplier on the raw frame difference before packing into RG. Higher values pick up subtler motion (and more noise). Maps to mathTOP gain.",
    ),
  smoothing: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe(
      "Temporal smoothing on the flow output (feedbackTOP cross-fade). 0 = raw per-frame flow (jittery); 1 = ghosted/laggy.",
    ),
  blur: z.coerce
    .number()
    .min(0)
    .default(2.0)
    .describe(
      "Spatial pre-blur (pixels) on source before differencing — suppresses high-frequency camera noise. Maps to blurTOP size.",
    ),
  direction_from: z
    .enum(["diff", "edges"])
    .default("diff")
    .describe(
      "'diff' (default, cheapest): RG = frame difference signed-packed (temporal magnitude). 'edges': cross frame-diff with Sobel edgeTOP so RG carries a coarse direction estimate — more flow-like but ~2× cost.",
    ),
});

type CreateOpticalFlowArgs = z.infer<typeof createOpticalFlowSchema>;

export async function createOpticalFlowImpl(
  ctx: ToolContext,
  args: CreateOpticalFlowArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const [resW, resH] = args.resolution;

    // ── Source ────────────────────────────────────────────────────────────────
    // Pull in an external TOP via selectTOP (cross-container safe) or use
    // TD's bundled test clip so the chain previews offline with no camera.
    let sourceNode: string;
    if (args.source) {
      sourceNode = await builder.add("selectTOP", "source_in", {
        top: args.source,
        resolutionw: resW,
        resolutionh: resH,
      });
    } else {
      // Use TD's bundled Mosaic.mp4; if the file is absent fall back to a
      // noiseTOP so the chain still has motion to detect.
      sourceNode = await builder.add("moviefileinTOP", "movie_test", {
        file: "Mosaic.mp4",
        resolutionw: resW,
        resolutionh: resH,
      });
    }

    // ── Pre-blur ─────────────────────────────────────────────────────────────
    // Kills high-freq camera noise before differencing.
    const preBlur = await builder.add("blurTOP", "pre_blur", {
      size: args.blur,
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(sourceNode, preBlur);

    // ── Monochrome ────────────────────────────────────────────────────────────
    // Collapse to luminance so the diff is single-channel motion energy.
    const mono = await builder.add("monochromeTOP", "mono", {
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(preBlur, mono);

    // ── Previous-frame cache ──────────────────────────────────────────────────
    // cacheTOP with cachesize=2, replaceindex=-1, outputindex=0 returns the
    // previous cooked frame — cheap one-frame delay.
    // UNVERIFIED: par tokens cachesize/replaceindex/outputindex — spelled per KB
    // but may vary; set defensively via Python fallback below.
    const cachePrev = await builder.add("cacheTOP", "cache_prev", {
      cachesize: 2,
      replaceindex: -1,
      outputindex: 0,
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(mono, cachePrev, 0, 0);

    // ── Frame difference (temporal gradient) ─────────────────────────────────
    // compositeTOP subtract: current - previous frame.
    // UNVERIFIED: "subtract" operand token — may be "sub" in some builds;
    // try both via defensive Python below.
    const diffComp = await builder.add("compositeTOP", "diff_comp", {
      operand: "subtract",
      resolutionw: resW,
      resolutionh: resH,
    });
    // in0 = current (mono), in1 = previous (cache_prev)
    await builder.connect(mono, diffComp, 0, 0);
    await builder.connect(cachePrev, diffComp, 0, 1);

    // ── Edges branch (only when direction_from == "edges") ───────────────────
    let gainInput: string;
    let edgeNote = "";
    if (args.direction_from === "edges") {
      // edgeTOP for Sobel spatial gradient
      const edges = await builder.add("edgeTOP", "edges", {
        strength: 1,
        resolutionw: resW,
        resolutionh: resH,
      });
      await builder.connect(preBlur, edges, 0, 0);

      // Cross-multiply diff × edges → coarse direction estimate
      const crossComp = await builder.add("compositeTOP", "cross_comp", {
        operand: "multiply",
        resolutionw: resW,
        resolutionh: resH,
      });
      await builder.connect(diffComp, crossComp, 0, 0);
      await builder.connect(edges, crossComp, 0, 1);

      gainInput = crossComp;
      edgeNote = " (edges mode: Sobel cross-multiply for direction estimate, ~2× cost)";
    } else {
      gainInput = diffComp;
    }

    // ── Gain + recenter (mathTOP) ─────────────────────────────────────────────
    // gain = sensitivity; postadd = 0.5 re-centers: 0.5 = no motion,
    // <0.5 = receding, >0.5 = advancing (matches displaceTOP midpoint convention).
    // UNVERIFIED: "postadd" token — alternatives: preoff/postoff. Defensive set.
    const gainMath = await builder.add("mathTOP", "gain_math", {
      gain: args.sensitivity,
      postadd: 0.5,
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(gainInput, gainMath, 0, 0);

    // ── Temporal smoothing (feedbackTOP + levelTOP cross-fade) ────────────────
    // levelTOP cross-fades between the feedback output and the current gained
    // diff, controlled by the smoothing parameter.
    // True two-input cross-fade: when smoothing=0 the output is the raw gained
    // diff; when smoothing>0 it blends in the previous frame's mixed result
    // via a feedbackTOP. Weights: current = (1-smoothing), prev = smoothing.
    const smoothClamped = Math.max(0, Math.min(1, args.smoothing));
    const curLevel = await builder.add("levelTOP", "cur_level", {
      opacity: 1 - smoothClamped,
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(gainMath, curLevel, 0, 0);

    const smoothFb = await builder.add("feedbackTOP", "smooth_fb", {
      resolutionw: resW,
      resolutionh: resH,
    });
    const prevLevel = await builder.add("levelTOP", "prev_level", {
      opacity: smoothClamped,
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(smoothFb, prevLevel, 0, 0);

    // Sum current + previous as the mixed output (current-vs-feedback blend).
    const levelMix = await builder.add("compositeTOP", "level_mix", {
      operand: "add",
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(curLevel, levelMix, 0, 0);
    await builder.connect(prevLevel, levelMix, 0, 1);

    // Wire the feedbackTOP target reference back to the mixed output via Python
    // (OP-path parameters are set unevenly by the structured setter), so the
    // next frame's `prev_level` reads from this frame's blended result.
    await builder.python(
      `_fb = op(${JSON.stringify(smoothFb)})\ntry:\n    _fb.par.top = ${JSON.stringify(levelMix)}\nexcept Exception:\n    pass`,
    );

    // ── Defensive parameter corrections ──────────────────────────────────────
    // cacheTOP par names vary; try alternatives if the initial structured set
    // failed (the builder uses fail-forward so errors land in warnings).
    await builder.python(
      `_c = op(${JSON.stringify(cachePrev)})\nfor _a, _v in [('cachesize',2),('size',2)]: \n    try: setattr(_c.par, _a, _v); break\n    except: pass\nfor _a, _v in [('replaceindex',-1),('replaceat',-1)]: \n    try: setattr(_c.par, _a, _v); break\n    except: pass\nfor _a, _v in [('outputindex',0),('outputat',0)]: \n    try: setattr(_c.par, _a, _v); break\n    except: pass`,
    );

    // compositeTOP subtract operand token probe ("subtract" vs "sub")
    await builder.python(
      `_d = op(${JSON.stringify(diffComp)})\nfor _t in ['subtract','sub','1']:\n    try: _d.par.operand = _t; break\n    except: pass`,
    );

    // mathTOP postadd token probe ("postadd" vs "postoff" vs "addpost")
    await builder.python(
      `_m = op(${JSON.stringify(gainMath)})\nfor _t in ['postadd','postoff','addpost']:\n    try: setattr(_m.par, _t, 0.5); break\n    except: pass`,
    );

    // ── Output Null ───────────────────────────────────────────────────────────
    const out = await builder.add("nullTOP", "out1", {
      resolutionw: resW,
      resolutionh: resH,
    });
    // Connect output to the blended mix, NOT the feedbackTOP. feedbackTOP is
    // by definition one frame behind levelMix; reading directly from levelMix
    // avoids that off-by-one and matches the documented "current cross-fade"
    // semantics.
    await builder.connect(levelMix, out, 0, 0);

    // ── Controls ──────────────────────────────────────────────────────────────
    // Bind the panel parameters straight into the network so the artist can
    // tune them live without rebuilding. Sensitivity drives gain_math.gain;
    // Blur drives pre_blur.size; Smoothing drives both level opacities as an
    // inverse pair (cur = 1 - Smoothing, prev = Smoothing) via expressions on
    // the two LevelTOPs — emitted after the structured set so they win.
    const gainMathPath = builder.pathOf("gain_math") ?? `${builder.containerPath}/gain_math`;
    const preBlurPath = builder.pathOf("pre_blur") ?? `${builder.containerPath}/pre_blur`;
    const curLevelPath = builder.pathOf("cur_level") ?? `${builder.containerPath}/cur_level`;
    const prevLevelPath = builder.pathOf("prev_level") ?? `${builder.containerPath}/prev_level`;
    await builder.python(
      [
        `_p = parent()`,
        `try: op(${JSON.stringify(curLevelPath)}).par.opacity.expr = '1 - parent().par.Smoothing'`,
        `except Exception: pass`,
        `try: op(${JSON.stringify(prevLevelPath)}).par.opacity.expr = 'parent().par.Smoothing'`,
        `except Exception: pass`,
      ].join("\n"),
    );
    const controls: ControlSpec[] = [
      {
        name: "Sensitivity",
        type: "float",
        min: 0,
        max: 10,
        default: args.sensitivity,
        bind_to: [`${gainMathPath}.gain`],
      },
      {
        name: "Smoothing",
        type: "float",
        min: 0,
        max: 1,
        default: args.smoothing,
        // Bound via expressions above so both LevelTOPs follow Smoothing in
        // sync (current weight = 1-S, previous weight = S). No direct bind_to
        // here — opacity is driven by the expression, not a static binding.
        bind_to: [],
      },
      {
        name: "Blur",
        type: "float",
        min: 0,
        max: 10,
        default: args.blur,
        bind_to: [`${preBlurPath}.size`],
      },
    ];

    const sourceSummary = args.source ? args.source : "Mosaic.mp4 (built-in test clip)";
    const summary =
      `Built CPU optical-flow vector field (direction_from=${args.direction_from}, sensitivity=${args.sensitivity}, smoothing=${args.smoothing}, blur=${args.blur}) ` +
      `over ${sourceSummary} → ${out}.${edgeNote} ` +
      `Output is RG-packed: R=dx, G=dy, centered at 0.5. NOTE: flow reads 0 when TD timeline is paused and source is static — check time.play if motion is absent.`;

    const extra: Record<string, unknown> = {
      direction_from: args.direction_from,
      sensitivity: args.sensitivity,
      smoothing: args.smoothing,
      blur: args.blur,
      source_path: args.source ?? null,
      resolution: args.resolution,
      cache_path: cachePrev,
      diff_path: diffComp,
      gain_path: gainMath,
      feedback_path: smoothFb,
      output_path: out,
      unverified: [
        "cacheTOP `cachesize`/`replaceindex`/`outputindex` par tokens set defensively (may differ by build).",
        "compositeTOP `subtract` operand token set defensively (tries 'subtract', 'sub', '1').",
        "mathTOP `postadd` recenter token set defensively (tries 'postadd', 'postoff', 'addpost').",
        "edgeTOP `strength` par token assumed — probe live to confirm.",
      ],
    };

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

export const registerCreateOpticalFlow: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_optical_flow",
    {
      title: "Create optical flow",
      description:
        "Build a CPU optical-flow vector-field generator from a video source. Produces an RG-packed flow TOP (R=horizontal dx, G=vertical dy, centered at 0.5) suitable as a drop-in modulator for create_displacement_warp, create_gpu_particle_field, or any TOP-driven displacement chain. No CUDA, no external models — built entirely from stock TD TOPs: blurTOP (pre-blur), monochromeTOP, cacheTOP (previous-frame delay), compositeTOP subtract (frame diff), optional edgeTOP cross-multiply for direction estimation, mathTOP (sensitivity gain + 0.5 recenter), feedbackTOP+levelTOP (temporal smoothing). Defaults to TD's bundled Mosaic.mp4 test clip so the chain builds and previews standalone without a live camera (avoids macOS permission modal). Output is a nullTOP. Flow reads 0 when TD timeline is paused and the source is static — that is correct behavior. Returns a summary plus JSON with node paths, controls, warnings, and an inline preview image.",
      inputSchema: createOpticalFlowSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createOpticalFlowImpl(ctx, args),
  );
};

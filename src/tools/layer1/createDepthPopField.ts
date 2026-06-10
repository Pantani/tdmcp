import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { setupSegmentationImpl } from "../layer2/setupSegmentation.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

// POP op type strings (Experimental — same caveat as createPopField.ts).
const POP_TYPES = {
  pointGenerator: "pointgeneratorPOP",
  noise: "noisePOP",
  transform: "transformPOP",
  lookupTexture: "lookuptexturePOP",
  popToSop: "poptoSOP",
} as const;

/** Set parameters defensively, fail-forward: same pattern as createPopField. */
function setParsDefensively(path: string, pairs: Array<[string, unknown]>): string {
  return (
    `_o = op(${q(path)})\n` +
    `for _pn, _v in ${JSON.stringify(pairs)}:\n` +
    `    try:\n        setattr(_o.par, _pn, _v)\n    except Exception:\n        pass`
  );
}

/**
 * Extract the JSON data block from a `jsonResult` / `errorResult` text.
 * The text format is:
 *   <summary>
 *
 *   ```json
 *   { ... }
 *   ```
 */
function extractJsonBlock(text: string): Record<string, unknown> | undefined {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export const createDepthPopFieldSchema = z.object({
  name: z
    .string()
    .default("depth_pop_field")
    .describe("Name for the self-contained container created under parent_path."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the depth-pop-field container is created."),
  depth_top_path: z
    .string()
    .optional()
    .describe(
      "Absolute path of an existing depth/mask TOP (luminance = depth, bright = near by default). " +
        "When omitted, the tool auto-spins-up a setup_segmentation chain inside the container " +
        "and uses its mask Null TOP as the depth source. Future W4: pass create_depth_from_2d output here.",
    ),
  particle_density: z
    .number()
    .int()
    .min(100)
    .max(500_000)
    .default(20_000)
    .describe("Approximate point count fed to pointgeneratorPOP.numpoints (100–500 000)."),
  scatter_mode: z
    .enum(["displace", "emit", "both"])
    .default("displace")
    .describe(
      "'displace' = uniform depth-scale proxy on the point cloud; " +
        "'emit' = emission-like scatter jitter around the sampled depth field; " +
        "'both' = depth-scale proxy + scatter jitter. True depth-weighted birth is unverified.",
    ),
  depth_scale: z
    .number()
    .min(0)
    .max(5)
    .default(1.0)
    .describe(
      "Multiplier on the depth-driven displacement amount along +Z for displace/both scatter modes. Exposed as DepthScale knob when that displacement proxy is active.",
    ),
  color_by_depth: z
    .boolean()
    .default(true)
    .describe(
      "When true, copies sampled RGBA into POP Color attribute via a second lookup_texture_pop " +
        "(near = bright / far = dark).",
    ),
  invert_depth: z
    .boolean()
    .default(false)
    .describe(
      "Treat dark as near instead of bright. Implemented via Level TOP invert on a proxy feed.",
    ),
  point_size: z
    .number()
    .min(0)
    .max(32)
    .default(2)
    .describe("Render TOP point size, exposed as PointSize knob."),
  spin: z
    .number()
    .default(8)
    .describe(
      "Y-rotation of the field in deg/sec, animated via transformPOP ry expression. Exposed as Spin knob.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Render TOP resolution [width, height]."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Build the live artist knobs panel for the active depth field controls."),
});

type CreateDepthPopFieldArgs = z.infer<typeof createDepthPopFieldSchema>;

export async function createDepthPopFieldImpl(ctx: ToolContext, args: CreateDepthPopFieldArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const containerPath = builder.containerPath;
    const [width, height] = args.resolution;

    // -----------------------------------------------------------------------
    // 1. Resolve depth source
    // -----------------------------------------------------------------------
    let resolvedDepthPath: string;
    let depthSourceMode: "external" | "auto_segmentation";
    let autoSegReport: Record<string, unknown> | undefined;

    if (args.depth_top_path !== undefined) {
      resolvedDepthPath = args.depth_top_path;
      depthSourceMode = "external";
    } else {
      // Auto-spin-up: call setupSegmentationImpl inline, then read mask_top.
      const segResult = await setupSegmentationImpl(ctx, {
        parent_path: containerPath,
        name: "mp_segmentation",
        publish_prekeyed: false,
        model: "general",
        smooth: true,
        invert_mask: false,
        feather_px: 2,
      });
      if (segResult.isError) {
        // Surface the error verbatim — do NOT silently fall through.
        return segResult;
      }
      const textBlock = segResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text",
      );
      const data = textBlock ? extractJsonBlock(textBlock.text) : undefined;
      const maskTop =
        typeof data?.mask_top === "string"
          ? data.mask_top
          : `${containerPath}/mp_segmentation/mask`;
      autoSegReport = data;
      resolvedDepthPath = maskTop;
      depthSourceMode = "auto_segmentation";
    }

    // -----------------------------------------------------------------------
    // 2. Depth proxy chain: in_depth (selectTOP) → inv (levelTOP) → proxy_depth (nullTOP)
    // -----------------------------------------------------------------------
    const inDepth = await builder.add("selectTOP", "in_depth");
    await builder.python(setParsDefensively(inDepth, [["top", resolvedDepthPath]]));

    const inv = await builder.add("levelTOP", "inv");
    await builder.connect(inDepth, inv);
    await builder.python(setParsDefensively(inv, [["invert", args.invert_depth ? 1 : 0]]));

    const proxyDepth = await builder.add("nullTOP", "proxy_depth");
    await builder.connect(inv, proxyDepth);

    // -----------------------------------------------------------------------
    // 3. POP chain: generator → depth_lookup → jitter → displace
    // -----------------------------------------------------------------------
    const generator = await builder.add(POP_TYPES.pointGenerator, "generator");
    await builder.python(
      setParsDefensively(generator, [
        ["numpoints", args.particle_density],
        ["distribution", "random"],
      ]),
    );

    // depth_lookup: lookup_texture_pop reads proxy_depth, outputs a "depth01" attribute
    const depthLookup = await builder.add(POP_TYPES.lookupTexture, "depth_lookup");
    await builder.connect(generator, depthLookup);
    await builder.python(
      setParsDefensively(depthLookup, [
        ["top", proxyDepth],
        // U/V mapped from P.x / P.y (defensive — actual par names are UNVERIFIED)
        ["lookupattr0", "P.x"],
        ["lookupattr1", "P.y"],
        ["outputattrscope", "depth01"],
      ]),
    );

    // jitter: low-amplitude Noise POP breaks lattice for emit/both modes
    const jitter = await builder.add(POP_TYPES.noise, "jitter");
    await builder.connect(depthLookup, jitter);
    await builder.python(
      setParsDefensively(jitter, [["amp", args.scatter_mode !== "displace" ? 0.15 : 0.02]]),
    );

    // displace: Transform POP — tz expr from depth01 (displace/both), ry for spin
    const displace = await builder.add(POP_TYPES.transform, "displace");
    await builder.connect(jitter, displace);

    if (args.scatter_mode === "displace" || args.scatter_mode === "both") {
      // Live TD: transformPOP has no `me.inputPoint` / `me.curPoint` / `me.inputAttr` —
      // per-point expressions referencing a depth attr aren't available. Apply a uniform
      // z-scale as a coarse displacement proxy; per-point depth displacement requires
      // routing depth into P.z upstream (e.g. via attributePOP/mathPOP) — flagged as
      // unverified below.
      await builder.python(
        setParsDefensively(displace, [
          ["sz", args.depth_scale],
          ["tz", 0],
        ]),
      );
    }

    if (args.spin !== 0) {
      await builder.python(
        `_d = op(${q(displace)})\n` +
          `for _pn in ['ry', 'ry1', 'r2']:\n` +
          `    try:\n` +
          `        _d.par[_pn].expr = ${q(`absTime.seconds * ${args.spin}`)}\n` +
          `        break\n` +
          `    except Exception:\n` +
          `        pass`,
      );
    }

    let head = displace;

    // -----------------------------------------------------------------------
    // 4. Optional color_by_depth branch: second lookup_texture_pop → Color attr
    // -----------------------------------------------------------------------
    if (args.color_by_depth) {
      const colorLookup = await builder.add(POP_TYPES.lookupTexture, "color_lookup");
      await builder.connect(head, colorLookup);
      await builder.python(
        setParsDefensively(colorLookup, [
          ["top", proxyDepth],
          ["lookupattr0", "P.x"],
          ["lookupattr1", "P.y"],
          ["outputattrscope", "Color"],
        ]),
      );
      head = colorLookup;
    }

    // -----------------------------------------------------------------------
    // 5. Render path: poptoSOP → geometryCOMP → camera + light + renderTOP → nullTOP
    // -----------------------------------------------------------------------
    const geo = await builder.add("geometryCOMP", "geo");
    const toSop = await builder.add(POP_TYPES.popToSop, "to_sop", {}, geo);
    await builder.python(setParsDefensively(toSop, [["pop", head]]));
    await builder.python(`_s = op(${q(toSop)})\n_s.render = True\n_s.display = True`);

    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });

    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      resolutionw: width,
      resolutionh: height,
    });
    await builder.python(
      setParsDefensively(render, [
        ["pointsize", args.point_size],
        ["pointscale", args.point_size],
      ]),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // -----------------------------------------------------------------------
    // 6. Controls
    // -----------------------------------------------------------------------
    const controls: ControlSpec[] = args.expose_controls
      ? [
          ...(args.scatter_mode === "displace" || args.scatter_mode === "both"
            ? [
                {
                  name: "DepthScale",
                  type: "float",
                  min: 0,
                  max: 5,
                  default: args.depth_scale,
                  bind_to: [`${displace}.sz`],
                } satisfies ControlSpec,
              ]
            : []),
          {
            name: "PointSize",
            type: "float",
            min: 0,
            max: 32,
            default: args.point_size,
            bind_to: [`${render}.pointsize`],
          },
          {
            name: "Spin",
            type: "float",
            min: -360,
            max: 360,
            default: args.spin,
            bind_to: [`${displace}.ry`],
          },
        ]
      : [];

    const extra: Record<string, unknown> = {
      scatter_mode: args.scatter_mode,
      particle_density: args.particle_density,
      color_by_depth: args.color_by_depth,
      invert_depth: args.invert_depth,
      depth_source: {
        mode: depthSourceMode,
        depth_top_path: resolvedDepthPath,
        ...(autoSegReport !== undefined ? { auto_segmentation_report: autoSegReport } : {}),
      },
      unverified: {
        pop_op_types: [
          POP_TYPES.pointGenerator,
          POP_TYPES.lookupTexture,
          POP_TYPES.noise,
          POP_TYPES.transform,
          POP_TYPES.popToSop,
        ],
        lookup_attr_contract:
          "Used P.x/P.y as lookupattr0/1; lookup_texture_pop docs say 0-1 range — probe whether unnormalised P works or if remap is required.",
        tz_expr_per_point:
          "transformPOP has no me.inputPoint/curPoint/inputAttr — per-point tz expression is unsupported. Using uniform sz=depth_scale as a coarse proxy; for true per-point depth displacement, route depth into P.z via attributePOP/mathPOP upstream of the transformPOP.",
        emit_mode:
          "emit/both modes currently use depth lookup plus higher jitter as an emission-like scatter proxy; true depth-weighted particle birth remains unverified.",
        future_hook:
          "depth_top_path will accept create_depth_from_2d (Depth Anything) output in W4.",
      },
    };

    const depthLabel =
      depthSourceMode === "auto_segmentation" ? "auto MediaPipe mask" : resolvedDepthPath;

    return finalize(ctx, {
      summary:
        `Built a depth-driven POP field (${args.scatter_mode}, ~${args.particle_density} pts, ` +
        `depth=${depthLabel}) rendered to ${out}. ` +
        `POPs are Experimental — live-validate render path and per-point tz expression.`,
      builder,
      outputPath: out,
      controls,
      extra,
    });
  });
}

export const registerCreateDepthPopField: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_depth_pop_field",
    {
      title: "Create depth-driven POP field",
      description:
        "Build a depth-driven GPU POP scatter field: consumes a depth/mask TOP and uses " +
        "lookup_texture_pop to sample depth for displacement/scatter proxies (and optionally color). " +
        "When depth_top_path is omitted, auto-spins-up a setup_segmentation MediaPipe chain inside " +
        "the container and uses its mask Null TOP as the depth source. " +
        "Scatter modes: 'displace' applies a uniform depth-scale proxy, 'emit' adds an emission-like jitter scatter proxy, 'both' does both. " +
        "Forward-compatible: pass create_depth_from_2d (Depth Anything, W4) output as depth_top_path. " +
        "NOTE: POPs are Experimental — op types and par names are fail-forward, probe on a live TD. " +
        "Returns a JSON block with container path, depth source info, controls, warnings, and unverified probe record.",
      inputSchema: createDepthPopFieldSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDepthPopFieldImpl(ctx, args),
  );
};

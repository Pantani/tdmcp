import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);
const py = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// POP op type strings — derived from the <basename>POP convention, unverified against live TD.
const POP_TYPES = {
  pointGenerator: "pointgeneratorPOP",
  grid: "gridPOP",
  sphere: "spherePOP",
  noise: "noisePOP",
  transform: "transformPOP",
  neighbor: "neighborPOP",
  popToSop: "poptoSOP",
} as const;

// Defensive per-param set: POPs are Experimental; unknown par names → warnings, not crashes.
function setParsDefensively(path: string, pairs: Array<[string, unknown]>): string {
  return (
    `_o = op(${q(path)})\n` +
    `for _pn, _v in ${JSON.stringify(pairs)}:\n` +
    `    try:\n        setattr(_o.par, _pn, _v)\n    except Exception:\n        pass`
  );
}

// Script SOP callback body, parameterised at build time.
function scriptSopBody(
  toSopPath: string,
  neighborPath: string,
  maxLines: number,
  colorMode: "flat" | "by_distance" | "by_neighbor_count",
  color: readonly [number, number, number],
): string {
  const byDist = colorMode === "by_distance";
  const byIsol = colorMode === "by_neighbor_count";
  const cr = color[0];
  const cg = color[1];
  const cb = color[2];
  return (
    `import traceback\n` +
    `def cook(scriptOp):\n` +
    `    scriptOp.clear()\n` +
    `    src = op(${q(toSopPath)})\n` +
    `    if src is None:\n        return\n` +
    `    pts = src.points\n` +
    `    nbr_attr = src.attr('Nebr')\n` +
    `    dist_attr = src.attr('Dist') if ${byDist ? "True" : "False"} else None\n` +
    `    nbr = op(${py(neighborPath)})\n` +
    `    max_lines = ${maxLines}\n` +
    `    try:\n` +
    `        max_dist = float(nbr.par.maxdistance.eval()) if nbr is not None else 1.0\n` +
    `    except Exception:\n` +
    `        max_dist = 1.0\n` +
    `    try:\n` +
    `        max_neighbors = int(nbr.par.maxneighbors.eval()) if nbr is not None else 1\n` +
    `    except Exception:\n` +
    `        max_neighbors = 1\n` +
    `    by_dist = ${byDist ? "True" : "False"}\n` +
    `    by_isol = ${byIsol ? "True" : "False"}\n` +
    `    color = (${cr}, ${cg}, ${cb})\n` +
    `    scriptOp.copyPoints(src)\n` +
    `    emitted = 0\n` +
    `    seen = set()\n` +
    `    for i, p in enumerate(pts):\n` +
    `        if emitted >= max_lines: break\n` +
    `        nebrs = nbr_attr[i] if nbr_attr is not None else ()\n` +
    `        for k_idx, j in enumerate(nebrs if nebrs is not None else ()):\n` +
    `            if j is None or j < 0 or j == i: continue\n` +
    `            a, b = (i, j) if i < j else (j, i)\n` +
    `            key = a * 1000003 + b\n` +
    `            if key in seen: continue\n` +
    `            seen.add(key)\n` +
    `            prim = scriptOp.appendPoly(2, closed=False, addPoints=False)\n` +
    `            prim[0].point = scriptOp.points[a]\n` +
    `            prim[1].point = scriptOp.points[b]\n` +
    `            if by_dist and dist_attr is not None:\n` +
    `                try:\n` +
    `                    d = float(dist_attr[i][k_idx])\n` +
    `                    t = max(0.0, min(1.0, d / max(max_dist, 0.0001)))\n` +
    `                    cd = (color[0]*(1-t)+0.1*t, color[1]*(1-t)+0.2*t, color[2]*(1-t)+0.6*t, 1)\n` +
    `                    scriptOp.points[a].Cd = cd\n` +
    `                    scriptOp.points[b].Cd = cd\n` +
    `                except Exception: pass\n` +
    `            emitted += 1\n` +
    `            if emitted >= max_lines: break\n` +
    `    if by_isol and nbr_attr is not None:\n` +
    `        for i, p in enumerate(scriptOp.points):\n` +
    `            try:\n` +
    `                n = len(nbr_attr[i]) if nbr_attr[i] is not None else 0\n` +
    `                t = min(1.0, n / max(max_neighbors, 1))\n` +
    `                p.Cd = (color[0]*t, color[1]*t, color[2]*t, 1)\n` +
    `            except Exception: pass\n`
  );
}

const vec3Color = (def: readonly [number, number, number]) =>
  z
    .tuple([z.coerce.number(), z.coerce.number(), z.coerce.number()])
    .default([def[0], def[1], def[2]]);

export const createPopLinesPointcloudSchema = z.object({
  name: z
    .string()
    .default("pop_lines")
    .describe("Container base name; final path uses TD auto-suffix."),
  parent_path: z.string().default("/project1").describe("Parent network for the system container."),
  source_path: z
    .string()
    .optional()
    .describe(
      "If set, must point to an existing POP/SOP that produces a point cloud. " +
        "When omitted, a point cloud is auto-generated per auto_pattern.",
    ),
  auto_pattern: z
    .enum(["noise", "sphere", "grid"])
    .default("noise")
    .describe(
      "Used only when source_path is undefined. " +
        "noise = pointgeneratorPOP + noisePOP; sphere = spherePOP; grid = gridPOP.",
    ),
  count: z
    .number()
    .int()
    .min(16)
    .max(8192)
    .default(512)
    .describe(
      "Approx point count when auto-generating. Hard-capped at 8192 (line emission is O(N·k) on CPU).",
    ),
  max_distance: z
    .number()
    .min(0)
    .max(10)
    .default(0.5)
    .describe(
      "Radius (POP world units) the Neighbor POP searches for neighbors. Drives Plexus density.",
    ),
  max_neighbors: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4)
    .describe("Per-point neighbor cap (neighborPOP.maxneighbors). Higher = denser web."),
  max_lines: z
    .number()
    .int()
    .min(100)
    .max(50000)
    .default(5000)
    .describe("Hard cap on emitted line primitives in the Script SOP (after dedupe)."),
  color_mode: z
    .enum(["flat", "by_distance", "by_neighbor_count"])
    .default("flat")
    .describe(
      "Drives Cd attribute on the SOP. flat = single color; by_distance = per-line gradient; " +
        "by_neighbor_count = per-point ramp on isolation.",
    ),
  color: vec3Color([1, 1, 1]).describe(
    "Line color used directly in flat mode, as warm endpoint in by_distance, " +
      "as dense endpoint in by_neighbor_count.",
  ),
  line_alpha: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("Constant MAT alpha; < 1 lets lines additively glow."),
  spin: z
    .number()
    .min(-180)
    .max(180)
    .default(10)
    .describe("Y-axis degrees/sec spin of the whole field via Transform POP ry expression."),
  point_size: z
    .number()
    .min(0)
    .max(16)
    .default(1.5)
    .describe("Optional point overlay size rendered in addition to lines. 0 hides points."),
  resolution: z
    .tuple([z.number().int(), z.number().int()])
    .default([1280, 720])
    .describe("Render TOP resolution [width, height]."),
  expose_controls: z.boolean().default(true).describe("Skip control panel exposure when false."),
});

export type CreatePopLinesPointcloudArgs = z.infer<typeof createPopLinesPointcloudSchema>;

export async function createPopLinesPointcloudImpl(
  ctx: ToolContext,
  args: CreatePopLinesPointcloudArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const [width, height] = args.resolution;
    const attempted: string[] = [];

    // 1) Point cloud source — auto-gen or external.
    let head: string;
    if (args.source_path !== undefined) {
      // Sourced path: Transform POP reads from the external source.
      // We cannot cross-container-wire a POP input, so the spin transformPOP is
      // placed at container level and its input param is set to the source path.
      head = args.source_path;
      attempted.push(`sourced: ${args.source_path}`);
    } else if (args.auto_pattern === "grid") {
      const cols = Math.max(2, Math.round(Math.sqrt(args.count)));
      const rows = Math.max(2, Math.ceil(args.count / cols));
      head = await builder.add(POP_TYPES.grid, "generator");
      await builder.python(
        setParsDefensively(head, [
          ["rows", rows],
          ["cols", cols],
        ]),
      );
      attempted.push(`${POP_TYPES.grid} (rows=${rows}, cols=${cols})`);
    } else if (args.auto_pattern === "sphere") {
      const cols = Math.max(3, Math.round(Math.sqrt(args.count)));
      const rows = Math.max(3, Math.ceil(args.count / cols));
      head = await builder.add(POP_TYPES.sphere, "generator");
      await builder.python(
        setParsDefensively(head, [
          ["rows", rows],
          ["cols", cols],
        ]),
      );
      attempted.push(`${POP_TYPES.sphere} (rows=${rows}, cols=${cols})`);
    } else {
      // noise: Point Generator POP + Noise POP
      head = await builder.add(POP_TYPES.pointGenerator, "generator");
      await builder.python(
        setParsDefensively(head, [
          ["numpoints", args.count],
          ["distribution", "random"],
        ]),
      );
      attempted.push(`${POP_TYPES.pointGenerator} (numpoints=${args.count})`);

      const noise = await builder.add(POP_TYPES.noise, "noise");
      await builder.connect(head, noise);
      await builder.python(setParsDefensively(noise, [["amp", 0.3]]));
      attempted.push(POP_TYPES.noise);
      head = noise;
    }

    // 2) Transform POP — animated Y-spin.
    const spinPop = await builder.add(POP_TYPES.transform, "spin");
    if (args.source_path !== undefined) {
      // Cross-network source: set via param, not wire.
      await builder.python(setParsDefensively(spinPop, [["pop", args.source_path]]));
    } else {
      await builder.connect(head, spinPop);
    }
    await builder.python(
      `_x = op(${q(spinPop)})\nfor _pn in ['ry', 'r2', 'ry1']:\n    try:\n        _x.par[_pn].expr = ${q(`absTime.seconds * ${args.spin}`)}\n        break\n    except Exception:\n        pass`,
    );
    attempted.push(`${POP_TYPES.transform} (ry = absTime.seconds * ${args.spin})`);
    head = spinPop;

    // 3) Neighbor POP — fills per-point Nebr + Dist array attributes.
    const nbrPop = await builder.add(POP_TYPES.neighbor, "nbr");
    await builder.connect(head, nbrPop);
    await builder.python(
      setParsDefensively(nbrPop, [
        ["maxneighbors", args.max_neighbors],
        ["maxdistance", args.max_distance],
        ["dodist", 1],
        ["nebrattrname", "Nebr"],
        ["distattrname", "Dist"],
      ]),
    );
    attempted.push(
      `${POP_TYPES.neighbor} (maxneighbors=${args.max_neighbors}, maxdistance=${args.max_distance})`,
    );

    // 4) Render path: poptoSOP → scriptSOP → materialSOP → nullSOP inside geometryCOMP.
    const geo = await builder.add("geometryCOMP", "geo");

    const toSop = await builder.add(POP_TYPES.popToSop, "to_sop", {}, geo);
    await builder.python(setParsDefensively(toSop, [["pop", nbrPop]]));
    attempted.push(`${POP_TYPES.popToSop} → geometryCOMP`);

    // Script SOP DAT (Text DAT holds the callback Python).
    const scriptDat = await builder.add("textDAT", "lines_script", {}, geo);
    const sopBody = scriptSopBody(toSop, nbrPop, args.max_lines, args.color_mode, args.color);
    await builder.python(`op(${q(scriptDat)}).text = ${q(sopBody)}`);

    // Script SOP itself.
    const scriptSop = await builder.add("scriptSOP", "lines", {}, geo);
    await builder.connect(toSop, scriptSop);
    await builder.python(
      `_ss = op(${q(scriptSop)})\n` +
        `try:\n    _ss.par.callbacks = op(${q(scriptDat)})\nexcept Exception:\n    pass`,
    );
    attempted.push("scriptSOP (line primitives from Nebr attribute)");

    // Material.
    const [cr, cg, cb] = args.color;
    const lineMat = await builder.add("constantMAT", "line_mat", {
      colorr: cr,
      colorg: cg,
      colorb: cb,
    });
    await builder.python(
      setParsDefensively(lineMat, [
        ["alpha", args.line_alpha],
        ["colorr", cr],
        ["colorg", cg],
        ["colorb", cb],
      ]),
    );

    const matSop = await builder.add("materialSOP", "matsop", {}, geo);
    await builder.connect(scriptSop, matSop);
    await builder.python(setParsDefensively(matSop, [["material", lineMat]]));

    const nullSop = await builder.add("nullSOP", "out_sop", {}, geo);
    await builder.connect(matSop, nullSop);
    await builder.python(`_n = op(${q(nullSop)})\n_n.render = True\n_n.display = True`);

    // 5) Camera + Light + Render TOP + output Null TOP.
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

    // 6) Live controls.
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "MaxDistance",
            type: "float",
            min: 0,
            max: 10,
            default: args.max_distance,
            bind_to: [`${nbrPop}.maxdistance`],
          },
          {
            name: "MaxNeighbors",
            type: "int",
            min: 1,
            max: 16,
            default: args.max_neighbors,
            bind_to: [`${nbrPop}.maxneighbors`],
          },
          {
            name: "Spin",
            type: "float",
            min: -180,
            max: 180,
            default: args.spin,
            bind_to: [`${spinPop}.ry`],
          },
          {
            name: "PointSize",
            type: "float",
            min: 0,
            max: 16,
            default: args.point_size,
            bind_to: [`${render}.pointsize`],
          },
          {
            name: "LineAlpha",
            type: "float",
            min: 0,
            max: 1,
            default: args.line_alpha,
            bind_to: [`${lineMat}.alpha`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary:
        `Built Plexus-style POP lines (${args.source_path !== undefined ? "sourced" : args.auto_pattern}, ` +
        `max_distance=${args.max_distance}, max_neighbors=${args.max_neighbors}, ` +
        `color_mode=${args.color_mode}) rendered to ${out}. ` +
        `POPs are Experimental — live-validate par names and Nebr attribute survival through poptoSOP.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        source_mode: args.source_path !== undefined ? "sourced" : "auto",
        auto_pattern: args.auto_pattern,
        count: args.count,
        max_distance: args.max_distance,
        max_neighbors: args.max_neighbors,
        max_lines: args.max_lines,
        color_mode: args.color_mode,
        spin: args.spin,
        point_size: args.point_size,
        resolution: [width, height],
        neighbor_path: nbrPop,
        to_sop_path: toSop,
        lines_sop_path: scriptSop,
        geometry_path: geo,
        render_path: render,
        output_path: out,
        unverified: {
          pop_op_types: attempted,
          render_path:
            "poptoSOP → scriptSOP → materialSOP → nullSOP → geometryCOMP → renderTOP → nullTOP " +
            "(mirrors createPopField's SOP render route)",
          note:
            "neighbor_pop par names (maxneighbors/maxdistance/dodist/nebrattrname) are Experimental — " +
            "live-probe required. Nebr array-attribute survival through poptoSOP is unverified; " +
            "fallback: read attr off POP directly in the Script SOP. " +
            "scriptSOP.appendPoly(2, closed=False, addPoints=False) spelling assumed stable. " +
            "CPU line emission is O(N·k); at count=8192 and max_neighbors=16 that is ~131k iterations/cook — " +
            "keep max_lines<=5000 and max_neighbors<=8 for real-time performance.",
        },
      },
    });
  });
}

export const registerCreatePopLinesPointcloud: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pop_lines_pointcloud",
    {
      title: "Create POP lines pointcloud (Plexus)",
      description:
        "Plexus-style line-web visual built on the POP family. A POP point cloud " +
        "(auto-generated or sourced) is fed to a Neighbor POP that fills a per-point " +
        "Nebr array attribute with closest-neighbor indices. A Script SOP converts that " +
        "index list into deduplicated line primitives, rendered as a Geometry COMP through " +
        "a Render TOP to a Null TOP — the classic Plexus look without third-party plugins. " +
        "auto_pattern: 'noise' (default) = pointgeneratorPOP + noisePOP; 'sphere' = spherePOP; " +
        "'grid' = gridPOP. count is hard-capped at 8192 (CPU O(N·k) line emission). " +
        "color_mode: flat | by_distance (warm→cool gradient) | by_neighbor_count (isolation ramp). " +
        "Exposes live controls: MaxDistance, MaxNeighbors, Spin, PointSize, LineAlpha. " +
        "POPs are Experimental — par names and Nebr array-attribute survival through poptoSOP " +
        "are probe-first unverified; result carries extra.unverified.",
      inputSchema: createPopLinesPointcloudSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPopLinesPointcloudImpl(ctx, args),
  );
};

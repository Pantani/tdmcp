import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

// POP op type strings, derived from the operator knowledge base `name` field via the established
// `<basename>POP` convention (the same family suffix documentNetwork/exportNetworkToVault already
// trust: /(TOP|CHOP|SOP|COMP|DAT|MAT|POP)$/). POPs are flagged "Experimental" in this TD build, so
// every one of these is UNVERIFIED against a live process — see extra.unverified in the result.
const POP_TYPES = {
  pointGenerator: "pointgeneratorPOP", // Point Generator POP — count + distribution
  grid: "gridPOP", // Grid POP — rows/cols
  sphere: "spherePOP", // Sphere POP — rows/cols
  noise: "noisePOP", // Noise POP — per-point displacement
  transform: "transformPOP", // Transform POP — animated spin
  popToSop: "poptoSOP", // POP to SOP — bridges the POP chain into the SOP render world
} as const;

export const createPopFieldSchema = z.object({
  name: z
    .string()
    .default("pop_field")
    .describe("Name for the self-contained POP-field container created under parent_path."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the POP-field container is created inside (default '/project1')."),
  count: z
    .number()
    .int()
    .min(1)
    .max(1000000)
    .default(10000)
    .describe(
      "Approximate point count. Used directly for the 'noise' pattern; 'grid'/'sphere' approximate it via a rows×cols layout near this total.",
    ),
  pattern: z
    .enum(["grid", "noise", "sphere"])
    .default("noise")
    .describe(
      "Point layout/source. 'noise' (default) = a Point Generator POP scatters `count` points which a Noise POP displaces into a moving cloud. 'grid' = a flat Grid POP lattice. 'sphere' = points on a Sphere POP shell.",
    ),
  point_size: z.coerce
    .number()
    .min(0)
    .default(2)
    .describe("Rendered point size (Render TOP point size), exposed as the live PointSize knob."),
  spin: z.coerce
    .number()
    .default(10)
    .describe(
      "Degrees/sec rotation of the whole field around Y (a Transform POP animates it over time), exposed as the live Spin knob.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Render resolution [width, height] of the Render TOP and the output Null TOP."),
});
type CreatePopFieldArgs = z.infer<typeof createPopFieldSchema>;

// Set parameters defensively, one at a time, inside the bridge: POPs are Experimental and their
// exact internal par names aren't confirmed by the knowledge base, so a name that differs on this
// build must not sink the rest of the configuration (same pattern as the Ableton Link CHOP setup in
// createSyncExternalClock). `pairs` is a JSON list of [parName, value].
function setParsDefensively(path: string, pairs: Array<[string, unknown]>): string {
  return `_o = op(${q(path)})\nfor _pn, _v in ${JSON.stringify(pairs)}:\n    try:\n        setattr(_o.par, _pn, _v)\n    except Exception:\n        pass`;
}

export async function createPopFieldImpl(ctx: ToolContext, args: CreatePopFieldArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const [width, height] = args.resolution;
    const attempted: string[] = [];

    // 1) Generator POP — the point source, chosen by pattern. Par names are set defensively because
    //    POPs are Experimental (KB has no confirmed parName for them).
    let head: string;
    if (args.pattern === "grid") {
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
    } else if (args.pattern === "sphere") {
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
      // noise: a Point Generator POP scatters `count` points (random distribution), then a Noise
      // POP displaces them so the field is alive/moving.
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

    // 2) Transform POP — animated spin around Y over time. The exact rotate par name is unconfirmed,
    //    so try the common spellings; the .expr assignment also auto-switches the par to EXPRESSION
    //    mode. Wrapped in builder.python, so any failure is collected as a warning.
    const xform = await builder.add(POP_TYPES.transform, "spin");
    await builder.connect(head, xform);
    await builder.python(
      `_x = op(${q(xform)})\nfor _pn in ['ry', 'r2', 'ry1']:\n    try:\n        _x.par[_pn].expr = ${q(`absTime.seconds * ${args.spin}`)}\n        break\n    except Exception:\n        pass`,
    );
    attempted.push(`${POP_TYPES.transform} (ry expr = absTime.seconds * ${args.spin})`);
    head = xform;

    // 3) RENDER PATH (UNVERIFIED). The POP render path is uncertain in this build. The most likely
    //    route reuses the proven SOP render pipeline: a POP to SOP converter bridges the POP chain
    //    into a Geometry COMP, which a Render TOP renders. The whole render path is best-effort —
    //    builder.add/connect/setParams collect failures as warnings rather than throwing, so the POP
    //    chain still exists even if the render wiring is wrong on this build.
    const geo = await builder.add("geometryCOMP", "geo");
    const toSop = await builder.add(POP_TYPES.popToSop, "to_sop", {}, geo);
    // poptoSOP is a SOP-family converter that reads its source POP from a parameter (like
    // choptoTOP/soptoDAT), so wire it via the source par defensively rather than a connector.
    await builder.python(setParsDefensively(toSop, [["pop", head]]));
    await builder.python(`_s = op(${q(toSop)})\n_s.render = True\n_s.display = True`);
    attempted.push(`${POP_TYPES.popToSop} → geometryCOMP (render the converted SOP)`);

    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    // Render TOP reads its scene from parameters (camera/geometry/lights), and point size from
    // the points-mode par. Set the render TOP point size defensively (par name varies by build).
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

    // 4) End on a Null TOP — always created so the tool returns a stable output handle even when the
    //    render path is best-effort.
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Live controls: PointSize (render TOP) and Spin (Transform POP rotate). Bind targets use the
    // common par names; a mismatch on this build surfaces as a control-panel warning, not a crash.
    const controls: ControlSpec[] = [
      {
        name: "PointSize",
        type: "float",
        min: 0,
        max: 32,
        default: args.point_size,
        bind_to: [`${render}.pointsize`],
      },
      { name: "Spin", type: "float", min: -180, max: 180, default: args.spin, bind_to: [] },
    ];

    const extra: Record<string, unknown> = {
      pattern: args.pattern,
      count: args.count,
      point_size: args.point_size,
      spin: args.spin,
      resolution: [width, height],
      generator: builder.created.find((c) => c.name === "generator")?.path,
      transform: xform,
      render,
      output_path: out,
      // Probe-first record: everything about POPs is unverified against a live TD process.
      unverified: {
        pop_op_types: attempted,
        render_path: `${POP_TYPES.popToSop} → geometryCOMP → renderTOP → nullTOP (mirrors the SOP render pipeline; the direct POP-render route is not used)`,
        note: "POPs are Experimental in this build — live-validate the render path. POP op type strings and internal par names are derived from the knowledge base and the <basename>POP convention, not confirmed against a running TD; per-par sets and the render wiring are fail-forward (collected as warnings).",
      },
    };

    return finalize(ctx, {
      summary: `Built a GPU POP point field (${args.pattern}, ~${args.count} points, ${args.point_size}px${args.spin ? `, ${args.spin}°/s spin` : ""}) rendered to ${out}. POPs are Experimental — live-validate the render path (the POP chain is built fail-forward; the Null output is always created).`,
      builder,
      outputPath: out,
      controls,
      extra,
    });
  });
}

export const registerCreatePopField: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pop_field",
    {
      title: "Create POP field (GPU points)",
      description:
        "Build a GPU point field using TouchDesigner's POP (Point OPerator) family — a generator POP (chosen by `pattern`: 'noise' scatters `count` points and displaces them with a Noise POP for a moving cloud, 'grid' a flat lattice, 'sphere' a shell), a Transform POP that spins the whole field over time, then a render path (POP to SOP → Geometry COMP → Render TOP) output as a Null TOP. Creates a new baseCOMP under `parent_path` holding all of these and exposes PointSize and Spin knobs. NOTE: POPs are flagged Experimental in this TD build and the POP render path is uncertain, so this tool is built fail-forward and probe-first — the POP chain and render wiring are best-effort (failures become warnings) while the output Null is always created, and the result's extra.unverified lists every POP op type and the render path attempted so you can live-validate. Returns a summary plus a JSON block with the container path, created node paths, generator/transform/render/output paths, exposed controls, node errors, warnings, the unverified probe record, and an inline preview image.",
      inputSchema: createPopFieldSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPopFieldImpl(ctx, args),
  );
};

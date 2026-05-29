import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Parses '#rrggbb' / 'rrggbb' (3- or 6-digit) into 0..1 RGB. Falls back to white.
 * Copied from createKineticText — keep in sync if the pattern evolves.
 */
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

export const createText3dSchema = z.object({
  name: z
    .string()
    .default("text_3d")
    .describe("Base name for the self-contained container COMP (default 'text_3d')."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the text-3D container is created (default '/project1')."),
  text: z
    .string()
    .default("HELLO")
    .describe("The text to render in 3D. Use \\n for multiple lines."),
  depth: z.coerce
    .number()
    .min(0)
    .default(0.2)
    .describe(
      "Extrusion depth in geometry units (controls the Extrude SOP's depthscale). 0 = flat polygons, 0.2 = typical title-card look.",
    ),
  spin: z.coerce
    .number()
    .default(20)
    .describe(
      "Continuous Y-axis rotation in degrees per second (0 = static). Driven by an expression on the Geometry COMP's ry parameter.",
    ),
  color: z
    .string()
    .default("#ffffff")
    .describe(
      "Text material colour as a hex string ('#ffffff' = white). Sets the Constant MAT's colorr/g/b.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Render TOP output resolution as [width, height] in pixels (default [1280, 720])."),
});
type CreateText3dArgs = z.infer<typeof createText3dSchema>;

export async function createText3dImpl(ctx: ToolContext, args: CreateText3dArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const rgb = hexToRgb(args.color);

    // --- Geometry COMP ---
    // Holds the text SOP pipeline. The builder auto-clears the default torus1 from
    // every fresh geometryCOMP (see NetworkBuilder.add → geometrycomp check).
    const geo = await builder.add("geometryCOMP", "geo");

    // --- Text SOP ---
    // text_sop.json confirms: `text` (string), `fontsizex`/`fontsizey`, `alignx`.
    // Output mode 'triangles' (the default) produces a mesh suitable for shaded
    // renders and for the Extrude SOP to cap properly.
    const textSop = await builder.add(
      "textSOP",
      "text",
      {
        text: args.text,
        fontsizex: 1,
        fontsizey: 1,
        alignx: "center",
      },
      geo,
    );
    await builder.python(`_s = op(${q(textSop)})\n_s.render = False\n_s.display = False`);

    // --- Extrude SOP ---
    // extrude_sop.json confirms: `depthscale` controls extrusion depth along the
    // face normals. depth=0 → flat (no visible extrusion); depth=0.2 → typical
    // 3D title card look. We connect textSOP → extrudeSOP then flag extrudeSOP for
    // render + display so the COMP renders the extruded geometry.
    //
    // UNVERIFIED (TD OFFLINE): the precise slug for `depthscale` is confirmed in the
    // KB description ("depthscale - Scales the cross-section in the direction of the
    // source geometry's normals"), but we set it defensively via Python in case the
    // short-name differs from the param label. We try both `depthscale` and `dist`
    // (an older alias seen in some TD versions) and silently ignore the failing one.
    const extrude = await builder.add("extrudeSOP", "extrude", {}, geo);
    await builder.connect(textSop, extrude);
    await builder.python(
      [
        `_e = op(${q(extrude)})`,
        `for _pn in ['depthscale', 'dist']:`,
        `    try:`,
        `        setattr(_e.par, _pn, ${args.depth})`,
        `        break`,
        `    except Exception:`,
        `        pass`,
        `_e.render = True`,
        `_e.display = True`,
      ].join("\n"),
    );

    // --- Constant MAT ---
    // constant_mat.json confirms: `color` group → `colorr`, `colorg`, `colorb`.
    // We create the MAT in the same container as the Geometry COMP (not inside
    // geo), then point the Geometry COMP's `material` parameter at it so the
    // renderer picks it up. This mirrors how create3dScene assigns materials.
    const mat = await builder.add("constantMAT", "mat", {
      colorr: rgb.r,
      colorg: rgb.g,
      colorb: rgb.b,
    });

    // Assign material + spin expression on the geo COMP. The geo's `ry` param is
    // driven by `me.time.seconds * spin` (same pattern as create3dScene's instancery
    // and createSyncExternalClock). spin=0 means the expression evaluates to 0 every
    // frame — static text.
    // UNVERIFIED (TD OFFLINE): `material` par slug on geometryCOMP is confirmed in
    // geo_text_comp.json for Geo Text COMP ("material - Selects a MAT to apply to
    // the geometry inside") and should be the same on geometryCOMP, but we probe
    // defensively.
    const spinExpr = `me.time.seconds * ${args.spin}`;
    await builder.python(
      [
        `_g = op(${q(geo)})`,
        // Assign material — try the par name from the KB; fall back silently.
        `for _matpar in ['material', 'mat']:`,
        `    try:`,
        `        setattr(_g.par, _matpar, ${q(mat)})`,
        `        break`,
        `    except Exception:`,
        `        pass`,
        // Spin expression on ry (Y-axis rotation), matching create3dScene's pattern.
        `_p = _g.par.ry`,
        `_p.expr = ${q(spinExpr)}`,
        `_p.mode = type(_p.mode).EXPRESSION`,
      ].join("\n"),
    );

    // --- Camera, Light, Render TOP, Null output ---
    // render_top.json confirms: `camera`, `geometry`, `lights` par names.
    // Camera at tz=4 gives a comfortable framing of unit-scale text glyphs.
    const cam = await builder.add("cameraCOMP", "cam", { tz: 4 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      w: args.resolution[0],
      h: args.resolution[1],
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // --- Controls ---
    const controls: ControlSpec[] = [
      {
        name: "Spin",
        type: "float",
        min: -360,
        max: 360,
        default: args.spin,
        // Bind to the Geometry COMP's ry parameter so the knob overrides the
        // expression (when the user drags the knob, TD auto-switches ry to constant
        // mode — which is the expected live-tweaking behaviour).
        bind_to: [`${geo}.ry`],
      },
      {
        name: "Depth",
        type: "float",
        min: 0,
        max: 2,
        default: args.depth,
        // The extrudeSOP param name is probed at build time; we record the node
        // path so the bind target is resolvable. The depthscale par is the correct
        // slug per KB — if it aliased on this build the build-time probe already
        // set a value, and the bind is best-effort.
        bind_to: [`${extrude}.depthscale`],
      },
    ];

    const spinNote = args.spin !== 0 ? `, spinning at ${args.spin}°/s` : "";
    return finalize(ctx, {
      summary: `Built 3D extruded text "${args.text}" (depth ${args.depth}${spinNote}) rendered via textSOP → extrudeSOP → geometryCOMP + Camera + Light + Render TOP → ${out}. Expose Spin/Depth controls for live tweaking.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        text: args.text,
        depth: args.depth,
        spin: args.spin,
        color: { r: rgb.r, g: rgb.g, b: rgb.b },
        resolution: args.resolution,
        geometry: geo,
        text_sop: textSop,
        extrude_sop: extrude,
        material: mat,
        camera: cam,
        light,
        render,
        output_path: out,
        render_path: "textSOP → extrudeSOP → geometryCOMP + Camera + Light + renderTOP",
        unverified:
          "depthscale/dist par slug probed at build time; material par slug probed defensively (TD OFFLINE)",
      },
    });
  });
}

export const registerCreateText3d: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_text_3d",
    {
      title: "Create 3D extruded text",
      description:
        "Build a self-contained 3D text scene: a Text SOP generates the glyph outlines, an Extrude SOP gives them depth (the `depth` parameter controls depthscale), and a Geometry COMP holds the pipeline with a Constant MAT for colour. A Camera, a Light, and a Render TOP complete the 3D render, output as a Null TOP. Optional continuous Y-axis spin (`spin` degrees/sec) is driven by a time expression on the Geometry COMP's ry parameter. Exposes Spin and Depth as live knobs. The classic signature look for title cards, lyric reveals, and 3D text drops — use create_kinetic_text instead for flat 2D animated text. Returns a summary plus a JSON block with the container path, created node paths, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createText3dSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createText3dImpl(ctx, args),
  );
};

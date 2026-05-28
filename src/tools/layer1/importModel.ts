import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

// SOP used when no model_path is supplied, so the network still builds and previews
// with zero file dependencies (matches create_3d_scene's default primitive).
const FALLBACK_SOP = "sphereSOP";

export const importModelSchema = z.object({
  model_path: z
    .string()
    .optional()
    .describe(
      "Path to a 3D model file (.obj/.fbx/.usd) read by a File In SOP. Omit to fall back to a default primitive so the network still builds and previews with no file dependency.",
    ),
  rotate_y: z.coerce
    .number()
    .min(0)
    .max(360)
    .default(0)
    .describe("Initial rotation of the model around Y in degrees (exposed as the RotateY knob)."),
  zoom: z.coerce
    .number()
    .min(1)
    .default(5)
    .describe("Camera distance from the model along Z (exposed as the Zoom knob)."),
  scale: z.coerce
    .number()
    .positive()
    .default(1)
    .describe("Uniform scale applied to the model (1 = imported size)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live RotateY (spin), Zoom (camera distance) and Scale knobs."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'model' container is created inside."),
});
type ImportModelArgs = z.infer<typeof importModelSchema>;

export async function importModelImpl(ctx: ToolContext, args: ImportModelArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "model");

    // Geometry COMP (the builder clears its default torus). When a model_path is given we
    // feed a File In SOP into it; otherwise we drop in a default primitive so the COMP still
    // has something renderable. Either source SOP is flagged render + display so the COMP
    // renders it. The File In SOP reads the geometry file via its `file` parameter.
    const geo = await builder.add("geometryCOMP", "geo");
    const hasModel = typeof args.model_path === "string" && args.model_path.length > 0;
    const source = hasModel
      ? await builder.add("fileinSOP", "model", { file: args.model_path }, geo)
      : await builder.add(FALLBACK_SOP, "model", {}, geo);
    await builder.python(`_s = op(${q(source)})\n_s.render = True\n_s.display = True`);

    // Uniform scale + initial rotation live on the Geometry COMP's transform.
    const geoParams: Record<string, unknown> = { ry: args.rotate_y };
    if (args.scale !== 1) {
      geoParams.scale = args.scale;
      geoParams.sx = args.scale;
      geoParams.sy = args.scale;
      geoParams.sz = args.scale;
    }
    await builder.setParams(geo, geoParams);

    const cam = await builder.add("cameraCOMP", "cam", { tz: args.zoom });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    // Render TOP reads its scene from parameters (not wires): camera, geometry, lights.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "RotateY",
            type: "float",
            min: 0,
            max: 360,
            default: args.rotate_y,
            bind_to: [`${geo}.ry`],
          },
          {
            name: "Zoom",
            type: "float",
            min: 1,
            max: args.zoom * 3,
            default: args.zoom,
            bind_to: [`${cam}.tz`],
          },
          {
            name: "Scale",
            type: "float",
            min: 0.01,
            max: Math.max(2, args.scale * 3),
            default: args.scale,
            bind_to: [`${geo}.scale`],
          },
        ]
      : [];

    const sourceNote = hasModel
      ? `model "${args.model_path}"`
      : "default primitive (no model_path)";
    return finalize(ctx, {
      summary: `Imported ${sourceNote} rendered to ${out} — Geometry (File In SOP) + Camera + Light + Render TOP.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        model_path: args.model_path,
        has_model: hasModel,
        rotate_y: args.rotate_y,
        zoom: args.zoom,
        scale: args.scale,
        source_sop: source,
        geometry: geo,
        camera: cam,
        render,
        output_path: out,
      },
    });
  });
}

export const registerImportModel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "import_model",
    {
      title: "Import 3D model",
      description:
        "Import a 3D model file (.obj/.fbx/.usd) and render it to a TOP: a File In SOP reading `model_path`, fed into a Geometry COMP, with a Camera, a Light, and a Render TOP output as a Null. Omit `model_path` to fall back to a default primitive so the network still builds with no dependencies. Exposes RotateY (spin), Zoom (camera distance) and Scale knobs — the imported-model sibling of create_3d_scene.",
      inputSchema: importModelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => importModelImpl(ctx, args),
  );
};

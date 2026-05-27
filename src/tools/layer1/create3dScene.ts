import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const PRIMITIVE_SOP: Record<string, string> = {
  sphere: "sphereSOP",
  box: "boxSOP",
  grid: "gridSOP",
};

export const create3dSceneSchema = z.object({
  primitive: z.enum(["sphere", "box", "grid"]).default("sphere").describe("Geometry to render."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live RotateY (spin) and Zoom (camera distance) knobs."),
  parent_path: z.string().default("/project1"),
});
type Create3dSceneArgs = z.infer<typeof create3dSceneSchema>;

export async function create3dSceneImpl(ctx: ToolContext, args: Create3dSceneArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "scene3d");

    // Geometry COMP (the builder clears its default torus), with the chosen primitive SOP
    // inside it, flagged for render + display so the COMP renders it.
    const geo = await builder.add("geometryCOMP", "geo");
    const shape = await builder.add(PRIMITIVE_SOP[args.primitive] as string, "shape", {}, geo);
    await builder.python(`_s = op(${q(shape)})\n_s.render = True\n_s.display = True`);

    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
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
          { name: "RotateY", type: "float", min: 0, max: 360, default: 0, bind_to: [`${geo}.ry`] },
          { name: "Zoom", type: "float", min: 1, max: 20, default: 5, bind_to: [`${cam}.tz`] },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a 3D scene (${args.primitive}) rendered to ${out} — Geometry + Camera + Light + Render TOP.`,
      builder,
      outputPath: out,
      controls,
      extra: { primitive: args.primitive, geometry: geo, camera: cam, render, output_path: out },
    });
  });
}

export const registerCreate3dScene: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_3d_scene",
    {
      title: "Create 3D scene",
      description:
        "Build a renderable 3D scene: a Geometry COMP holding the chosen primitive (sphere/box/grid), a Camera, a Light, and a Render TOP, output as a Null. Exposes RotateY (spin) and Zoom (camera distance) knobs. The starting point for 3D visuals — bind RotateY to a tempo ramp or an audio feature to make it move.",
      inputSchema: create3dSceneSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => create3dSceneImpl(ctx, args),
  );
};

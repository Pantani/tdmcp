import { extname } from "node:path";
import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const SUPPORTED_EXTENSIONS = new Set([".blend", ".fbx", ".obj", ".gltf", ".glb", ".usd", ".usdz"]);
const FALLBACK_SOP = "boxSOP";

export const blenderSceneImportSchema = z.object({
  scene_path: z
    .string()
    .optional()
    .describe(
      "Path to a Blender scene or exported model file (.blend/.fbx/.obj/.gltf/.glb/.usd/.usdz). Omit to create a renderable fallback primitive.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the self-contained Blender import container is created."),
  name: z
    .string()
    .default("blender_scene")
    .describe("Name for the generated container under parent_path."),
  import_scale: z.coerce
    .number()
    .positive()
    .default(1)
    .describe("Uniform scale applied to the imported scene geometry."),
  rotate_y: z.coerce
    .number()
    .min(0)
    .max(360)
    .default(0)
    .describe("Initial Y rotation of the imported scene in degrees."),
  camera_distance: z.coerce
    .number()
    .positive()
    .default(6)
    .describe("Camera distance from the scene along Z."),
  material_mode: z
    .enum(["pbr", "clay"])
    .default("pbr")
    .describe("pbr keeps metallic/roughness controls; clay uses a neutral matte material."),
  base_color: z
    .tuple([
      z.coerce.number().min(0).max(1),
      z.coerce.number().min(0).max(1),
      z.coerce.number().min(0).max(1),
    ])
    .default([0.78, 0.8, 0.84])
    .describe("RGB material base color, normalized 0..1."),
  metallic: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.15)
    .describe("PBR metallic amount. Ignored for material_mode=clay."),
  roughness: z.coerce.number().min(0).max(1).default(0.45).describe("PBR roughness amount."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose RotateY, CameraDistance, Scale, Metallic, and Roughness controls."),
});
type BlenderSceneImportArgs = z.infer<typeof blenderSceneImportSchema>;

function extensionWarning(scenePath: string | undefined): string | undefined {
  if (!scenePath) return undefined;
  const ext = extname(scenePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return `Unsupported or uncommon Blender scene extension "${ext || "(none)"}"; File In SOP will still be created, but TouchDesigner may not read the asset.`;
  }
  if (ext === ".blend") {
    return "TouchDesigner's File In SOP may not read .blend files directly on every install; export glTF, FBX, OBJ, or USD from Blender if the node reports a load error.";
  }
  return undefined;
}

export async function blenderSceneImportImpl(ctx: ToolContext, args: BlenderSceneImportArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const warnings: string[] = [];
    const warning = extensionWarning(args.scene_path);
    if (warning) warnings.push(warning);

    const geo = await builder.add("geometryCOMP", "geo");
    const hasScene = typeof args.scene_path === "string" && args.scene_path.trim().length > 0;
    const source = hasScene
      ? await builder.add("fileinSOP", "scene_file", { file: args.scene_path }, geo)
      : await builder.add(FALLBACK_SOP, "scene_file", {}, geo);
    await builder.python(`_s = op(${q(source)})\n_s.render = True\n_s.display = True`);

    const [r, g, b] = args.base_color;
    const materialParams =
      args.material_mode === "clay"
        ? { baser: r, baseg: g, baseb: b, metallic: 0, roughness: 0.82 }
        : { baser: r, baseg: g, baseb: b, metallic: args.metallic, roughness: args.roughness };
    const mat = await builder.add("pbrMAT", "mat", materialParams);
    await builder.setParams(geo, {
      material: mat,
      ry: args.rotate_y,
      scale: args.import_scale,
    });

    const env = await builder.add("constantTOP", "env_color", {
      colorr: 0.08,
      colorg: 0.09,
      colorb: 0.1,
      resolutionw: 64,
      resolutionh: 64,
    });
    const envLight = await builder.add("environmentlightCOMP", "env_light", {
      tx: -3,
      ty: 4,
      tz: 4,
    });
    await builder.setParams(envLight, { envmap: env });
    const keyLight = await builder.add("lightCOMP", "key_light", {
      tx: 3,
      ty: 4,
      tz: 5,
      lightcolorr: 1,
      lightcolorg: 0.95,
      lightcolorb: 0.86,
    });
    const cam = await builder.add("cameraCOMP", "cam", { ty: 1.2, tz: args.camera_distance });
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: `${keyLight} ${envLight}`,
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
            name: "CameraDistance",
            type: "float",
            min: 1,
            max: Math.max(12, args.camera_distance * 3),
            default: args.camera_distance,
            bind_to: [`${cam}.tz`],
          },
          {
            name: "Scale",
            type: "float",
            min: 0.01,
            max: Math.max(2, args.import_scale * 3),
            default: args.import_scale,
            bind_to: [`${geo}.scale`],
          },
          {
            name: "Metallic",
            type: "float",
            min: 0,
            max: 1,
            default: args.material_mode === "clay" ? 0 : args.metallic,
            bind_to: [`${mat}.metallic`],
          },
          {
            name: "Roughness",
            type: "float",
            min: 0,
            max: 1,
            default: args.material_mode === "clay" ? 0.82 : args.roughness,
            bind_to: [`${mat}.roughness`],
          },
        ]
      : [];

    if (warnings.length) builder.warnings.push(...warnings);
    const sourceNote = hasScene
      ? `scene "${args.scene_path}"`
      : "fallback primitive (no scene_path)";
    return finalize(ctx, {
      summary: `Imported Blender-oriented ${sourceNote} to ${out} with a PBR material, environment light, camera, and render TOP.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        scene_path: args.scene_path,
        has_scene: hasScene,
        material_mode: args.material_mode,
        source_sop: source,
        geometry: geo,
        material: mat,
        camera: cam,
        render,
        output_path: out,
      },
    });
  });
}

export const registerBlenderSceneImport: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "blender_scene_import",
    {
      title: "Blender scene import",
      description:
        "Create a self-contained TouchDesigner render scaffold for a Blender scene or Blender-exported asset: File In SOP (or fallback primitive), Geometry COMP, PBR material, environment/key lights, Camera, Render TOP, and Null TOP output. Supports .blend/.fbx/.obj/.gltf/.glb/.usd/.usdz paths and warns when a .blend may need export from Blender first.",
      inputSchema: blenderSceneImportSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => blenderSceneImportImpl(ctx, args),
  );
};

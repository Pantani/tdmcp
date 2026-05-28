import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

// A 0..1 RGB triple as "#rrggbb" — the BaseColor swatch's default. The control panel's
// _parse_rgb accepts a hex string, and `string` fits ControlSpec.default's union (a
// raw [r,g,b] tuple does not), so this seeds the swatch without a type cast.
const toHex = (rgb: readonly [number, number, number]): string =>
  `#${rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(1, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

// Primitive → SOP, mirroring create_3d_scene. `torusSOP` and `boxSOP`/`sphereSOP`
// are all stock SOPs verified createable in this build.
const PRIMITIVE_SOP: Record<string, string> = {
  sphere: "sphereSOP",
  torus: "torusSOP",
  box: "boxSOP",
};

// An RGB triple in 0..1, used for both the PBR base colour and the environment
// (image-based-lighting) colour. Defaults keep the scene neutral and visibly lit.
const rgb01 = (r: number, g: number, b: number) =>
  z
    .tuple([
      z.coerce.number().min(0).max(1),
      z.coerce.number().min(0).max(1),
      z.coerce.number().min(0).max(1),
    ])
    .default([r, g, b]);

export const createPbrSceneSchema = z.object({
  shape: z
    .enum(["sphere", "torus", "box"])
    .default("sphere")
    .describe("Geometry to render with the PBR material."),
  metallic: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.9)
    .describe(
      "PBR metalness: 0 = dielectric (plastic/clay), 1 = metal. Bound to the Metallic knob.",
    ),
  roughness: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe(
      "PBR roughness: 0 = mirror-sharp reflections, 1 = fully diffuse/matte. Bound to the Roughness knob.",
    ),
  base_color: rgb01(0.8, 0.8, 0.85).describe(
    "PBR base/albedo colour as [r,g,b] in 0..1 (light gray by default). Also seeds the BaseColor swatch.",
  ),
  env_color: rgb01(0.9, 0.95, 1.0).describe(
    "Colour of the environment light used for image-based lighting, as [r,g,b] in 0..1 (soft white). With no HDRI this drives a Constant TOP fed into the Environment Light.",
  ),
  rotate: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe(
      "Continuous spin of the whole object around Y in degrees/sec (0 = still). Shows off the PBR reflections as the surface turns.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("When true (default), expose live Metallic, Roughness, BaseColor and Spin controls."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the PBR-scene container is created (default '/project1')."),
});
type CreatePbrSceneArgs = z.infer<typeof createPbrSceneSchema>;

export async function createPbrSceneImpl(ctx: ToolContext, args: CreatePbrSceneArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "pbrscene");
    const container = builder.containerPath;
    const [br, bg, bb] = args.base_color;
    const [er, eg, eb] = args.env_color;

    // Environment light rig (image-based lighting). With no HDRI file we feed a
    // Constant TOP of `env_color` into the Environment Light COMP's `envlightmap`
    // so the PBR surface still receives lit colour from all directions. `dimmer`
    // is its overall intensity. (Optypes/params verified live: environmentlightCOMP,
    // envlightmap, dimmer — there is no plain colorr/g/b on this COMP.)
    const envmap = await builder.add("constantTOP", "envmap", {
      colorr: er,
      colorg: eg,
      colorb: eb,
    });
    const envlight = await builder.add("environmentlightCOMP", "envlight", {
      envlightmap: envmap,
      dimmer: 1,
    });

    // PBR material: base colour + metalness + roughness. Param names (basecolorr/g/b,
    // metallic, roughness) verified against a live pbrMAT — the optype is `pbrMAT`.
    const mat = await builder.add("pbrMAT", "pbr", {
      basecolorr: br,
      basecolorg: bg,
      basecolorb: bb,
      metallic: args.metallic,
      roughness: args.roughness,
    });

    // Geometry COMP (the builder clears its default torus) holding the chosen
    // primitive, flagged render + display, shaded by the PBR material.
    const geo = await builder.add("geometryCOMP", "geo");
    const shape = await builder.add(PRIMITIVE_SOP[args.shape] as string, "shape", {}, geo);
    await builder.python(`_s = op(${q(shape)})\n_s.render = True\n_s.display = True`);
    // Assign the material to the Geometry COMP (mirrors create_3d_scene / create_waveform).
    await builder.python(`op(${q(geo)}).par.material = ${q(mat)}`);

    // Continuous spin, MODULATED by the Spin control. ry is an expression reading the
    // container's Spin custom par as degrees/sec (absTime.seconds × Spin) so turning the
    // knob changes the spin rate live — rather than binding Spin directly onto ry, which
    // would replace this time expression with a static value and freeze the object. The
    // `hasattr` fallback keeps it cooking before exposeControls appends Spin (and when
    // controls are off). Always emitted so the exposed Spin knob actually drives motion.
    const spinExpr = `absTime.seconds * (op(${q(container)}).par.Spin.eval() if hasattr(op(${q(container)}).par, 'Spin') else ${args.rotate})`;
    await builder.python(`op(${q(geo)}).par.ry.expr = ${q(spinExpr)}`);

    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
    // A key Light COMP complements the environment light so highlights read crisply.
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    // Render TOP reads its scene from parameters (not wires). Multiple lights bind as
    // a space-joined string of their paths — verified that the env light + key light
    // both contribute to a lit result this way.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: `${light} ${envlight}`,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Metallic / Roughness / Spin are float knobs bound to live params. BaseColor is an
    // RGB swatch seeded from `base_color`; an rgb control is display-only (it cannot
    // drive a single parameter via bind_to — same convention as other Layer 1 tools).
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Metallic",
            type: "float",
            min: 0,
            max: 1,
            default: args.metallic,
            bind_to: [`${mat}.metallic`],
          },
          {
            name: "Roughness",
            type: "float",
            min: 0,
            max: 1,
            default: args.roughness,
            bind_to: [`${mat}.roughness`],
          },
          { name: "BaseColor", type: "rgb", default: toHex([br, bg, bb]) },
          {
            // Spin (deg/sec) is read by geo.ry's absTime expression above, so it MODULATES
            // the spin rate. No bind_to: a direct bind would overwrite ry's time expression
            // with a constant and stop the rotation.
            name: "Spin",
            type: "float",
            min: 0,
            max: 720,
            default: args.rotate,
          },
        ]
      : [];

    const spinNote = args.rotate > 0 ? `, ${args.rotate}°/s spin` : "";
    return finalize(ctx, {
      summary: `Built a PBR 3D scene (${args.shape}, metallic ${args.metallic}, roughness ${args.roughness}${spinNote}) rendered to ${out} — Geometry + PBR MAT + Environment Light + key Light + Camera + Render TOP.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        shape: args.shape,
        metallic: args.metallic,
        roughness: args.roughness,
        base_color: args.base_color,
        env_color: args.env_color,
        rotate: args.rotate,
        material: mat,
        env_light: envlight,
        env_map: envmap,
        geometry: geo,
        camera: cam,
        render,
        output_path: out,
      },
    });
  });
}

export const registerCreatePbrScene: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pbr_scene",
    {
      title: "Create PBR scene",
      description:
        "Build a physically-based 3D scene: a Geometry COMP holding the chosen primitive (sphere/torus/box) shaded by a PBR MAT (base colour, metallic, roughness), lit by an Environment Light for image-based lighting (fed a Constant TOP of `env_color` so it works with no HDRI file) plus a key Light, framed by a Camera and rendered to a Null. Creates a new baseCOMP under `parent_path` holding the Environment Light + envmap Constant TOP, the PBR MAT, a Geometry COMP, a key Light, a Camera, a Render TOP, and a Null output. Use create_3d_scene instead for basic (non-PBR) shading or GPU instancing. Exposes Metallic, Roughness, BaseColor and Spin controls; set `rotate` to turn the object so its reflections move. Returns a summary plus a JSON block with the container path, created node paths, the material/lights/geometry/camera/render/output paths, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createPbrSceneSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPbrSceneImpl(ctx, args),
  );
};

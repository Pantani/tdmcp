import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const EMITTER_SOP = {
  point: "addSOP",
  line: "lineSOP",
  circle: "circleSOP",
  sphere: "sphereSOP",
  mesh: "boxSOP",
  image: "gridSOP",
} as const;

export const createParticleSystemSchema = z.object({
  emitter_shape: z.enum(["point", "line", "circle", "sphere", "mesh", "image"]).default("point"),
  particle_count: z.number().int().positive().default(10000),
  forces: z
    .array(z.enum(["gravity", "noise", "attract", "repel", "vortex", "turbulence", "drag"]))
    .default(["noise", "gravity"]),
  render_style: z
    .enum(["points", "sprites", "lines", "trails", "instanced_geo"])
    .default("sprites"),
  lifetime: z.number().positive().default(3),
  parent_path: z.string().default("/project1"),
});
type CreateParticleSystemArgs = z.infer<typeof createParticleSystemSchema>;

export async function createParticleSystemImpl(ctx: ToolContext, args: CreateParticleSystemArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "particle_system");

    // Geometry COMP holds the particle SOP chain so the renderer can see it.
    const geo = await builder.add("geometryCOMP", "geo");

    const emitter = await ctx.client.createNode({
      parent_path: geo,
      type: EMITTER_SOP[args.emitter_shape],
      name: "emitter",
    });
    const particle = await ctx.client.createNode({
      parent_path: geo,
      type: "particleSOP",
      name: "particle",
      parameters: { life: args.lifetime },
    });
    builder.created.push(
      { name: "emitter", path: emitter.path, type: emitter.type },
      { name: "particle", path: particle.path, type: particle.type },
    );
    // The "point" emitter is an Add SOP, which ships with zero points — so the particle
    // SOP would have no source to birth from and the system renders empty. Enable a point
    // (its count is a parameter *sequence*, set via numBlocks rather than a plain par).
    if (args.emitter_shape === "point") {
      await builder.python(
        `_e = op(${q(emitter.path)})\n_e.par.addpts = True\n_e.seq.point.numBlocks = max(_e.seq.point.numBlocks, 1)`,
      );
    }
    await builder.connect(emitter.path, particle.path);

    const mat = await builder.add(
      args.render_style === "sprites" ? "pointspriteMAT" : "constantMAT",
      "mat",
    );
    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 4, tz: 4 });
    // Opaque near-black background so the (white, point-sized) particles are visible.
    // Left transparent, white particles vanish against a light compositing backdrop; set
    // bgcolora back to 0 if you want to composite the particles over other layers.
    const render = await builder.add("renderTOP", "render", {
      bgcolorr: 0.02,
      bgcolorg: 0.02,
      bgcolorb: 0.05,
      bgcolora: 1,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    await builder.python(
      [
        `g = op(${q(geo)})`,
        "p = op(g.path + '/particle')",
        "p.render = True",
        "p.display = True",
        `g.par.material = ${q(mat)}`,
        `r = op(${q(render)})`,
        `r.par.geometry = ${q(geo)}`,
        `r.par.camera = ${q(cam)}`,
        `r.par.lights = ${q(light)}`,
      ].join("\n"),
    );

    builder.warnings.push(
      `Particle forces (${args.forces.join(", ")}), exact count (${args.particle_count}) and the "${args.render_style}" render style are scaffolded; tune the particleSOP and material for production.`,
    );

    return finalize(ctx, {
      summary: `Created a particle system (emitter: ${args.emitter_shape}, ~${args.particle_count} particles, render: ${args.render_style}).`,
      builder,
      outputPath: out,
      extra: {
        emitter_shape: args.emitter_shape,
        forces: args.forces,
        render_style: args.render_style,
      },
    });
  });
}

export const registerCreateParticleSystem: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_particle_system",
    {
      title: "Create particle system",
      description:
        "Build a particle system: an emitter feeds a particle SOP inside a Geometry COMP, rendered with a camera + light. Forces and render style are scaffolded for further tuning.",
      inputSchema: createParticleSystemSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createParticleSystemImpl(ctx, args),
  );
};

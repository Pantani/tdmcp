import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
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

const q2 = (n: number): string => (Number.isFinite(n) ? n.toString() : "0");

/**
 * Builds the Python that turns a bare Particle SOP into a real, immediately-visible system:
 * - `normals = True` makes each particle inherit its source point's normal as initial
 *   velocity, so a sphere/circle/box emitter actually sprays into a cloud (a single-point
 *   emitter has no normal, so it stays a turbulence-driven stream — that's expected).
 * - `timepreroll = lifetime` pre-simulates the sim so frame 1 is already fully populated
 *   instead of slowly filling in over the first few seconds.
 * - A baseline drag keeps the cloud contained within the camera frame.
 * - `birth` is derived from particle_count so the requested count is honored at steady state.
 * Forces map to native params where the legacy Particle SOP supports them (gravity → external,
 * noise/turbulence → turbulence, drag → drag); attract/repel/vortex have no native equivalent
 * and are approximated with turbulence (+ a little wind for vortex).
 */
interface ParticleDynamics {
  birth: number;
  drag: number;
  turb: number;
  gravity: number;
  wind: number;
  lifevar: number;
}

/** Single source of truth for the Particle SOP dynamics derived from the requested forces. */
function computeParticleDynamics(args: CreateParticleSystemArgs): ParticleDynamics {
  const f = new Set(args.forces);
  const birth = Math.max(1, Math.round(args.particle_count / args.lifetime));
  let drag = 2.0;
  if (f.has("drag")) drag = 3.5;
  if (f.has("repel")) drag = 1.0;
  let turb = 0;
  if (f.has("noise")) turb = 1.0;
  if (f.has("turbulence")) turb = 1.8;
  if (f.has("attract") || f.has("repel") || f.has("vortex")) turb = Math.max(turb, 1.2);
  const gravity = f.has("gravity") ? -0.6 : 0;
  const wind = f.has("vortex") ? 0.5 : 0;
  const lifevar = Number((args.lifetime * 0.25).toFixed(3));
  return { birth, drag, turb, gravity, wind, lifevar };
}

function particleDynamicsPython(
  particlePath: string,
  args: CreateParticleSystemArgs,
  dyn: ParticleDynamics,
): string {
  return [
    `_p = op(${q(particlePath)})`,
    `_p.par.birth = ${dyn.birth}`,
    `_p.par.lifevar = ${q2(dyn.lifevar)}`,
    "_p.par.normals = True",
    "_p.par.jitter = True",
    `_p.par.timepreroll = ${q2(args.lifetime)}`,
    "_p.par.dodrag = True",
    `_p.par.drag = ${q2(dyn.drag)}`,
    `_p.par.turbx = ${q2(dyn.turb)}`,
    `_p.par.turby = ${q2(dyn.turb)}`,
    `_p.par.turbz = ${q2(dyn.turb)}`,
    "_p.par.period = 3.0",
    `_p.par.externaly = ${q2(dyn.gravity)}`,
    `_p.par.windx = ${q2(dyn.wind)}`,
    "_p.par.reset.pulse()",
  ].join("\n");
}

export const createParticleSystemSchema = z.object({
  // Default to "sphere": its varied normals give particles a radial initial velocity, so the
  // out-of-the-box system is a full cloud. ("point" has no normals and stays a thin stream.)
  emitter_shape: z.enum(["point", "line", "circle", "sphere", "mesh", "image"]).default("sphere"),
  particle_count: z.coerce.number().int().positive().default(10000),
  forces: z
    .array(z.enum(["gravity", "noise", "attract", "repel", "vortex", "turbulence", "drag"]))
    .default(["noise", "gravity"]),
  render_style: z
    .enum(["points", "sprites", "lines", "trails", "instanced_geo"])
    .default("sprites"),
  lifetime: z.coerce.number().positive().default(3),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live Drag / Turbulence / Gravity / Lifetime knobs on the system container."),
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

    // Turn the bare Particle SOP into an immediately-visible, moving system (initial velocity
    // from normals, pre-roll population, force mapping, containment drag).
    const dynamics = computeParticleDynamics(args);
    await builder.python(particleDynamicsPython(particle.path, args, dynamics));

    const mat = await builder.add(
      args.render_style === "sprites" ? "pointspriteMAT" : "constantMAT",
      "mat",
    );
    const cam = await builder.add("cameraCOMP", "cam", { tz: 6 });
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

    const approximated = args.forces.filter(
      (x) => x === "attract" || x === "repel" || x === "vortex",
    );
    if (approximated.length > 0) {
      builder.warnings.push(
        `Forces ${approximated.join(", ")} have no native Particle SOP equivalent and are approximated with turbulence.`,
      );
    }
    if (args.render_style !== "points" && args.render_style !== "sprites") {
      builder.warnings.push(
        `Render style "${args.render_style}" falls back to point/sprite rendering in this version.`,
      );
    }

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Drag",
            type: "float",
            min: 0,
            max: 8,
            default: dynamics.drag,
            bind_to: [`${particle.path}.drag`],
          },
          {
            name: "Turbulence",
            type: "float",
            min: 0,
            max: 4,
            default: dynamics.turb,
            bind_to: [
              `${particle.path}.turbx`,
              `${particle.path}.turby`,
              `${particle.path}.turbz`,
            ],
          },
          {
            name: "Gravity",
            type: "float",
            min: -3,
            max: 3,
            default: dynamics.gravity,
            bind_to: [`${particle.path}.externaly`],
          },
          {
            name: "Lifetime",
            type: "float",
            min: 0.1,
            max: 10,
            default: args.lifetime,
            bind_to: [`${particle.path}.life`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a particle system (emitter: ${args.emitter_shape}, ~${args.particle_count} particles, render: ${args.render_style}).`,
      builder,
      outputPath: out,
      controls,
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

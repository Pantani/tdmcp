import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Boids-style GPU flocking — the behavioural complement to createGpuParticleField
 * (which is curl-noise / gravity drift). It reuses the exact same position/velocity
 * ping-pong feedback-TOP architecture (each texel = one agent's pos/vel in an
 * RGBA32float buffer, held frame-to-frame by a feedbackTOP), but the velocity-update
 * shader implements the three classic boids rules — separation, alignment, cohesion —
 * over the particle texture instead of a noise force.
 *
 * TouchDesigner GLSL TOP conventions reused here (validated in createGpuParticleField /
 * createAudioReactive): declare `out vec4 fragColor;`, sample `sTD2DInputs[i]`, write via
 * `TDOutputSwizzle(...)`, and there is NO built-in uTime — the sim integrates with a fixed
 * dt. The shader text goes in a textDAT wired with `op(glsl).par.pixeldat = op(frag).name`.
 *
 * Input wiring (mirrors the GPU field, plus one extra wire so the brain can see positions):
 *   - sTD2DInputs[0] in vel_update = previous velocity (from vel_fb)
 *   - sTD2DInputs[1] in vel_update = current positions  (from pos_fb) — the neighbour field
 *   - sTD2DInputs[0] in pos_update = previous position  (from pos_fb)
 *   - sTD2DInputs[1] in pos_update = current velocity   (from vel_update)
 */

// A cheap hash → pseudo-random vec3 in [-1,1], used to seed positions on the first frame
// (same trick as the GPU field, so a fresh feedbackTOP starts as a cloud not a point).
const GLSL_HASH = `
vec3 hash33(vec3 p){
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}
`;

// Half-width of the neighbour stencil scanned per agent: a (2R+1)² window of texels of the
// agent buffer (R=3 → 7×7 = 49 taps, minus self). This is the perf hot spot AND the
// approximation: texel adjacency in the buffer is NOT world adjacency, so the flock is a
// school of texture-local cliques (the accepted fragment-shader-boids trade-off). Probe live
// before raising it — cost is taps × texels × 60fps. See the ⚠ warnings.
const NEIGHBOUR_RADIUS = 3;

/**
 * Velocity-update fragment — the boids brain. Reads the agent's previous velocity from the
 * feedback (sTD2DInputs[0]) and the whole position field (sTD2DInputs[1]) plus, for alignment,
 * its own previous velocity, then scans a fixed (2R+1)² stencil of neighbouring texels and
 * accumulates the three boids accelerations:
 *  - separation: steer away from close neighbours (inverse-distance weighted).
 *  - alignment:  match the average neighbour heading.
 *  - cohesion:   steer toward the neighbour centroid.
 * The weighted sum integrates into velocity, which is then renormalised toward uSpeed so the
 * school cruises at a stable speed. uRes (= count) lets the stencil step exactly one texel.
 *
 * Alignment reads each neighbour's velocity from the velocity feedback (sTD2DInputs[0]), which
 * holds every agent's previous velocity — exactly what alignment needs. Separation and cohesion
 * read neighbour positions from the position field (sTD2DInputs[1]).
 */
const VELOCITY_SHADER = `out vec4 fragColor;
uniform float uSeparation;
uniform float uAlignment;
uniform float uCohesion;
uniform float uSpeed;
uniform float uRes;
const float dt = 1.0 / 60.0;
const int R = ${NEIGHBOUR_RADIUS};
void main(){
    vec2 uv = vUV.st;
    vec3 vel = texture(sTD2DInputs[0], uv).xyz;
    vec3 pos = texture(sTD2DInputs[1], uv).xyz;
    float step = 1.0 / max(uRes, 1.0);

    vec3 sep = vec3(0.0);
    vec3 aliSum = vec3(0.0);
    vec3 cohSum = vec3(0.0);
    float n = 0.0;
    for (int dy = -R; dy <= R; dy++) {
        for (int dx = -R; dx <= R; dx++) {
            if (dx == 0 && dy == 0) continue;
            vec2 nuv = uv + vec2(float(dx), float(dy)) * step;
            vec3 npos = texture(sTD2DInputs[1], nuv).xyz;
            vec3 nvel = texture(sTD2DInputs[0], nuv).xyz;
            vec3 off = pos - npos;
            float d = length(off) + 1e-5;
            // Separation: stronger the closer the neighbour (inverse distance).
            sep += off / (d * d);
            aliSum += nvel;
            cohSum += npos;
            n += 1.0;
        }
    }
    vec3 acc = vec3(0.0);
    if (n > 0.0) {
        vec3 ali = aliSum / n - vel;            // match average heading
        vec3 coh = cohSum / n - pos;            // steer toward centroid
        acc += sep * uSeparation;
        acc += ali * uAlignment;
        acc += coh * uCohesion;
    }
    vel += acc * dt;
    // Renormalise toward the cruise speed so the school does not stall or blow up.
    float spd = length(vel);
    if (spd > 1e-5) {
        vel = vel / spd * uSpeed;
    }
    fragColor = TDOutputSwizzle(vec4(vel, 1.0));
}
`;

/**
 * Position-update fragment. Reads previous position (sTD2DInputs[0], from pos_fb) and current
 * velocity (sTD2DInputs[1], from vel_update) and integrates position += velocity * dt.
 *
 * Seeding: a feedbackTOP starts black (all zeros) on its first frame, which would pile every
 * agent at the origin. While the previous position is still ~0 we substitute a hash-spread
 * initial position so the flock starts as a cloud (best-effort first-frame seed — see the ⚠
 * warnings). A soft pull back toward the origin keeps the flock inside the camera frame.
 */
const POSITION_SHADER = `out vec4 fragColor;
${GLSL_HASH.trim()}
const float dt = 1.0 / 60.0;
const float BOUND = 4.0;
void main(){
    vec2 uv = vUV.st;
    vec3 pos = texture(sTD2DInputs[0], uv).xyz;
    vec3 vel = texture(sTD2DInputs[1], uv).xyz;
    // First-frame seed: when the feedback buffer is still empty, scatter from a hash.
    if (dot(pos, pos) < 1e-8) {
        pos = hash33(vec3(uv, 1.0)) * 2.0;
    }
    pos += vel * dt;
    // Soft containment: gently pull agents that stray past BOUND back toward the origin so the
    // flock stays on-screen instead of escaping the camera frame.
    float r = length(pos);
    if (r > BOUND) {
        pos -= normalize(pos) * (r - BOUND) * 0.05;
    }
    fragColor = TDOutputSwizzle(vec4(pos, 1.0));
}
`;

const rgb = z.coerce.number().min(0).max(1);

export const createParticleFlockSchema = z.object({
  count: z.coerce
    .number()
    .int()
    .min(8)
    .max(256)
    .default(64)
    .describe(
      "Edge of the square agent buffer; the flock is count×count agents (agents = count², e.g. 64 → 4096). Each agent is one texel of the RGBA32float position/velocity buffers. Capped at 256 (65 536 agents) because the per-agent neighbour scan cost grows with the texture.",
    ),
  separation: z.coerce
    .number()
    .min(0)
    .max(2)
    .default(1.0)
    .describe("Boids separation weight: steer away from close neighbours (collision avoidance)."),
  alignment: z.coerce
    .number()
    .min(0)
    .max(2)
    .default(1.0)
    .describe("Boids alignment weight: steer toward the average heading of nearby neighbours."),
  cohesion: z.coerce
    .number()
    .min(0)
    .max(2)
    .default(1.0)
    .describe("Boids cohesion weight: steer toward the centroid (average position) of neighbours."),
  speed: z.coerce
    .number()
    .positive()
    .default(1.0)
    .describe(
      "Cruise speed the velocity is renormalised toward each frame, so the school flies at a stable pace.",
    ),
  color: z
    .tuple([rgb, rgb, rgb])
    .default([0.4, 0.8, 1.0])
    .describe("RGB colour (0..1) of the instanced dots — the colour of the school."),
  point_size: z.coerce
    .number()
    .positive()
    .default(0.02)
    .describe("Radius of each instanced dot (the sphere SOP scale)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live Separation / Alignment / Cohesion / Speed knobs on the system container.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the flock container is created (default '/project1')."),
});
type CreateParticleFlockArgs = z.infer<typeof createParticleFlockSchema>;

export async function createParticleFlockImpl(ctx: ToolContext, args: CreateParticleFlockArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "particle_flock");
    const { count } = args;
    const bufParams = {
      outputresolution: "custom",
      resolutionw: count,
      resolutionh: count,
      format: "rgba32float",
    } as const;

    // --- VELOCITY loop (the boids brain) ---------------------------------------------------
    // vel_fb holds the previous velocity; vel_update reads it (input 0) plus the whole position
    // field (input 1, from pos_fb) so it can scan neighbours, applies the three boids rules, and
    // writes the new velocity. Close the loop with feedbackTOP.par.top = vel_update.
    const velFb = await builder.add("feedbackTOP", "vel_fb");
    const posFb = await builder.add("feedbackTOP", "pos_fb");
    const velUpdate = await builder.add("glslTOP", "vel_update", bufParams);
    const velFrag = await builder.add("textDAT", "vel_frag");
    await builder.python(
      `op(${q(velFrag)}).text = ${q(VELOCITY_SHADER)}\nop(${q(velUpdate)}).par.pixeldat = op(${q(velFrag)}).name`,
    );
    await builder.connect(velFb, velUpdate, 0, 0);
    await builder.connect(posFb, velUpdate, 0, 1);
    await builder.python(`op(${q(velFb)}).par.top = op(${q(velUpdate)}).name`);

    // Name vel_update's four float uniforms and seed them with the requested weights. The control
    // knobs below bind to vec{i}valuex so dragging a knob re-weights the rule live. uRes lets the
    // stencil step exactly one texel. (Same vec-sequence binding as orchestration.ts / the GPU
    // field's uReact path — the block count must be raised before the sub-parameters exist.)
    await builder.python(
      [
        `_v = op(${q(velUpdate)})`,
        "_seq = _v.seq.vec",
        "_seq.numBlocks = max(_seq.numBlocks, 5)",
        '_v.par.vec0name = "uSeparation"',
        `_v.par.vec0valuex = ${args.separation}`,
        '_v.par.vec1name = "uAlignment"',
        `_v.par.vec1valuex = ${args.alignment}`,
        '_v.par.vec2name = "uCohesion"',
        `_v.par.vec2valuex = ${args.cohesion}`,
        '_v.par.vec3name = "uSpeed"',
        `_v.par.vec3valuex = ${args.speed}`,
        '_v.par.vec4name = "uRes"',
        `_v.par.vec4valuex = ${count}`,
      ].join("\n"),
    );

    // --- POSITION loop ---------------------------------------------------------------------
    // pos_fb holds the previous position; pos_update reads it (input 0) plus the current velocity
    // (input 1, from vel_update) and integrates. Close with feedbackTOP.par.top = pos_update.
    const posUpdate = await builder.add("glslTOP", "pos_update", bufParams);
    const posFrag = await builder.add("textDAT", "pos_frag");
    await builder.python(
      `op(${q(posFrag)}).text = ${q(POSITION_SHADER)}\nop(${q(posUpdate)}).par.pixeldat = op(${q(posFrag)}).name`,
    );
    await builder.connect(posFb, posUpdate, 0, 0);
    await builder.connect(velUpdate, posUpdate, 0, 1);
    await builder.python(`op(${q(posFb)}).par.top = op(${q(posUpdate)}).name`);

    builder.warnings.push(
      "Boids neighbour scan is approximate: it samples a fixed texel stencil, so flock 'neighbours' are texture-local, not true spatial neighbours — tune the weights live for a school that reads as flocking. The feedback loops only evolve while the TD timeline plays (a paused timeline freezes the flock — expected, check time.play). Both feedbackTOPs start at zero on frame 1; the position shader hash-scatters the agents into a cloud (validated trick on the GPU field). If a fresh load collapses to the origin, pulse pos_fb/vel_fb's reset.",
    );

    // --- INSTANCING from the position TOP --------------------------------------------------
    // A Geometry COMP renders a tiny dot once per agent, instanced from the position buffer:
    // each texel's RGB becomes that instance's XYZ translate. NetworkBuilder.add clears the
    // COMP's default torus on creation.
    const geo = await builder.add("geometryCOMP", "geo");
    // The dot size lives on the SOP itself (radx/y/z), not on per-instance scale: TOP instancing
    // applies translate but NOT scale here (validated live on the GPU field), so a unit sphere
    // would render full-size and the cloud would collapse into a solid mass. A small radius keeps
    // each agent a crisp point.
    const dot = await builder.add(
      "sphereSOP",
      "dot",
      { radx: args.point_size, rady: args.point_size, radz: args.point_size },
      geo,
    );
    await builder.python(`_s = op(${q(dot)})\n_s.render = True\n_s.display = True`);

    // TOP instancing (validated live on the GPU field): instanceop = the position TOP sets the
    // instance COUNT from its texel grid (count² instances); instancetop names the TOP the
    // per-instance translate reads from; instancetx/ty/tz select its R/G/B channels for X/Y/Z.
    // Scale is NOT set here — TOP instancing applies translate only, so per-agent size lives on
    // the dot SOP's radius above.
    await builder.setParams(geo, {
      instancing: 1,
      instanceop: posUpdate,
      instancetop: posUpdate,
      instancetx: "r",
      instancety: "g",
      instancetz: "b",
    });

    // A constant material tinted with the requested colour so the school reads against the dark bg.
    const [cr, cg, cb] = args.color;
    const mat = await builder.add("constantMAT", "mat", { colorr: cr, colorg: cg, colorb: cb });
    await builder.setParams(geo, { material: mat });

    const camDist = 6;
    const cam = await builder.add("cameraCOMP", "cam", { tz: camDist });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 4, tz: 4 });
    // Opaque near-black background so the bright dots are visible (same convention as the GPU
    // field). Set bgcolora back to 0 to composite the flock over other layers.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      bgcolorr: 0.02,
      bgcolorg: 0.02,
      bgcolorb: 0.05,
      bgcolora: 1,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Separation",
            type: "float",
            min: 0,
            max: 2,
            default: args.separation,
            bind_to: [`${velUpdate}.vec0valuex`],
          },
          {
            name: "Alignment",
            type: "float",
            min: 0,
            max: 2,
            default: args.alignment,
            bind_to: [`${velUpdate}.vec1valuex`],
          },
          {
            name: "Cohesion",
            type: "float",
            min: 0,
            max: 2,
            default: args.cohesion,
            bind_to: [`${velUpdate}.vec2valuex`],
          },
          {
            name: "Speed",
            type: "float",
            min: 0,
            max: Math.max(4, args.speed * 2),
            default: args.speed,
            bind_to: [`${velUpdate}.vec3valuex`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a GPU boids flock: ${count}×${count} = ${count * count} agents via position/velocity feedback TOPs, the velocity shader running separation/alignment/cohesion over the agent texture (weights ${args.separation}/${args.alignment}/${args.cohesion}, speed ${args.speed}), instanced as dots and rendered to ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        count,
        agents: count * count,
        separation: args.separation,
        alignment: args.alignment,
        cohesion: args.cohesion,
        speed: args.speed,
        output_path: out,
      },
    });
  });
}

export const registerCreateParticleFlock: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_particle_flock",
    {
      title: "Create particle flock",
      description:
        "Build a boids-style GPU particle flock: position and velocity are simulated entirely on the GPU in two RGBA32float feedback-TOP loops, where the velocity shader implements the three classic boids rules — separation, alignment, cohesion — by scanning a stencil of neighbouring texels in the agent texture (each texel is one agent), then renormalising toward a cruise speed. Positions drive TOP-instancing of a tiny dot once per agent. Creates a new baseCOMP under `parent_path` holding the velocity/position feedback loops, the instanced Geometry COMP, Camera, Light, and Render TOP ending in a Null output. The behavioural complement to create_gpu_particle_field (use that instead for curl-noise/gravity drift rather than flocking). Exposes live Separation / Alignment / Cohesion / Speed knobs. Note: the flock only evolves while the TD timeline plays. Returns a summary plus a JSON block with the container path, created node paths, the agent count, the output path, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createParticleFlockSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createParticleFlockImpl(ctx, args),
  );
};

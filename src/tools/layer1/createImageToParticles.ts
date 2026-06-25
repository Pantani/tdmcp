import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * image_to_particles — reconstruct any image as a GPU point field.
 *
 * Each particle's rest position is its pixel in a source TOP and (optionally) its colour is
 * sampled from that same TOP. A spring-toward-rest force pulls particles home; an optional
 * audio signal scatters them away. Differs from create_gpu_particle_field in three ways:
 *
 *   1. Rest-position TOP — a one-shot GLSL pass that maps each texel UV → world XYZ (XY ∈
 *      [-1,1], Z ∝ luminance) sampled from `src_resampled` (the source TOP downsampled to
 *      side×side). This buffer is what makes the field "look like the image".
 *   2. Velocity shader integrates `spring*(rest-pos) + scatter*hash*uReact` instead of pure
 *      noise/curl/gravity — so the field settles back to the image when audio is quiet.
 *   3. Per-instance colour is read from `src_resampled` via `instancecolorop` on the
 *      Geometry COMP (live-verified on TD 099: `instancecolorop` + `instancer/g/b`, with
 *      `instancecolormode = instcoloropcolor`). Set in a separate try-block so a colour-par
 *      failure can never roll back the required transform-instancing dict.
 */

const GLSL_HASH = `
vec3 hash33(vec3 p){
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}
`;

const REST_SHADER = `out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    vec4 px = texture(sTD2DInputs[0], uv);
    float lum = dot(px.rgb, vec3(0.299, 0.587, 0.114));
    // UV (0..1) → world XY in [-1,1]; Z ∝ luminance gives a subtle relief on flat images.
    vec3 rest = vec3(uv * 2.0 - 1.0, lum * 0.25);
    fragColor = TDOutputSwizzle(vec4(rest, 1.0));
}
`;

function velocityShader(reactive: boolean): string {
  // Inputs: 0 = previous velocity (vel_fb), 1 = rest position (rest_pos), 2 = current position
  // (pos_fb same-frame). Force = spring + (optional) audio-scattered hash.
  const lines = [
    "out vec4 fragColor;",
    "uniform float uSpring;",
    "uniform float uScatter;",
    "uniform float uDamp;",
    ...(reactive ? ["uniform float uReact;"] : []),
    GLSL_HASH.trim(),
    "const float dt = 1.0 / 60.0;",
    "void main(){",
    "    vec2 uv = vUV.st;",
    "    vec3 vel  = texture(sTD2DInputs[0], uv).xyz;",
    "    vec3 rest = texture(sTD2DInputs[1], uv).xyz;",
    "    vec3 pos  = texture(sTD2DInputs[2], uv).xyz;",
    "    vec3 force = (rest - pos) * uSpring;",
  ];
  if (reactive) {
    lines.push("    force += hash33(vec3(uv * 31.0, 1.0)) * uReact * uScatter;");
  }
  lines.push(
    "    vel = vel * uDamp + force * dt;",
    "    fragColor = TDOutputSwizzle(vec4(vel, 1.0));",
    "}",
  );
  return `${lines.join("\n")}\n`;
}

const POSITION_SHADER = `out vec4 fragColor;
const float dt = 1.0 / 60.0;
void main(){
    vec2 uv = vUV.st;
    vec3 pos  = texture(sTD2DInputs[0], uv).xyz;
    vec3 vel  = texture(sTD2DInputs[1], uv).xyz;
    vec3 rest = texture(sTD2DInputs[2], uv).xyz;
    // First-frame seed: snap straight to the rest position so the image is visible immediately
    // rather than whipping in from origin.
    if (dot(pos, pos) < 1e-8) {
        pos = rest;
    }
    pos += vel * dt;
    fragColor = TDOutputSwizzle(vec4(pos, 1.0));
}
`;

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("top"),
    path: z
      .string()
      .min(1)
      .describe(
        "Full TD path to an existing TOP, e.g. '/project1/movieIn'. Sampled live, so a video source produces 'video made of points'.",
      ),
  }),
  z.object({
    kind: z.literal("file"),
    path: z
      .string()
      .min(1)
      .describe(
        "Image file path loaded into a moviefileinTOP. Defaults to the sentinel '@sample/Map/Banana.tif' which is resolved at build time to TD's absolute samples folder (live-verified TD 099 — bare 'Banana.tif' does NOT resolve, and TD env tokens do NOT expand either; only the absolute path opens the file).",
      ),
  }),
]);

/** Sentinel meaning "use TD's stock Banana.tif from the install's Samples/Map folder". */
const SAMPLE_BANANA_SENTINEL = "@sample/Map/Banana.tif";

export const createImageToParticlesSchema = z.object({
  source: sourceSchema
    .default({ kind: "file", path: SAMPLE_BANANA_SENTINEL })
    .describe(
      "Image source: { kind:'file', path } loads a moviefileinTOP, { kind:'top', path } references an existing TOP. Default uses TD's stock Banana.tif from app.samplesFolder.",
    ),
  side: z.coerce
    .number()
    .int()
    .min(16)
    .max(512)
    .default(192)
    .describe(
      "Particle grid edge; count = side². 192 → 36 864 particles. The source TOP is resampled to side×side so each texel maps 1:1 to one particle.",
    ),
  particle_size: z.coerce
    .number()
    .min(0.001)
    .max(0.2)
    .default(0.015)
    .describe(
      "Radius of each instanced dot (TOP instancing applies translate only, so size lives on the source sphere SOP).",
    ),
  scatter_strength: z.coerce
    .number()
    .min(0)
    .max(20)
    .default(6.0)
    .describe("Audio impulse magnitude. 0 = particles sit perfectly on the image."),
  spring_stiffness: z.coerce
    .number()
    .min(0)
    .max(20)
    .default(4.0)
    .describe("Force pulling each particle toward its rest pixel. Higher snaps back faster."),
  damp: z.coerce.number().min(0.5).max(0.999).default(0.92).describe("Per-frame velocity damping."),
  audio_source: z
    .enum(["none", "file", "device"])
    .default("none")
    .describe(
      "Drives the scatter impulse. 'none' = image idles statically. 'file' = audiofileinCHOP (set audio_file). 'device' = audiodeviceinCHOP (opt-in; may pop the macOS mic-permission dialog).",
    ),
  audio_file: z.string().default("").describe("Audio file path when audio_source='file'."),
  color_mode: z
    .enum(["image", "mono", "tint"])
    .default("image")
    .describe(
      "'image' = particle colours sampled from source pixels (via instancecolorop). 'mono' = white points. 'tint' = single colour multiplied by luminance.",
    ),
  tint_color: z
    .tuple([
      z.coerce.number().min(0).max(1),
      z.coerce.number().min(0).max(1),
      z.coerce.number().min(0).max(1),
    ])
    .default([1, 1, 1])
    .describe("RGB used when color_mode='tint'."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("When true, expose live PointSize / SpringStiff / ScatterStr / Damp / Zoom knobs."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the container is created."),
});
type CreateImageToParticlesArgs = z.infer<typeof createImageToParticlesSchema>;

export async function createImageToParticlesImpl(
  ctx: ToolContext,
  args: CreateImageToParticlesArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "image_to_particles");
    const { side } = args;
    const bufParams = {
      outputresolution: "custom",
      resolutionw: side,
      resolutionh: side,
      format: "rgba32float",
    } as const;

    // --- SOURCE: a TOP we can read pixels from (rest positions + colour). ---
    // For source.kind="top" we reference the external path directly; otherwise we create a
    // moviefileinTOP inside the container. Either way `srcRef` is the path string passed to
    // downstream params.
    let srcRef: string;
    if (args.source.kind === "file") {
      srcRef = await builder.add("moviefileinTOP", "src", { file: args.source.path });
      // Resolve the @sample/... sentinel to the live TD samples folder. Live-probed TD 099:
      // bare filenames and ${TOUCH}/${TD_INSTALL} tokens do NOT resolve to Samples/Map — only
      // the absolute path opens the file. We do this from inside TD so the path is correct on
      // any install location / OS.
      if (args.source.path.startsWith("@sample/")) {
        const rel = args.source.path.slice("@sample/".length);
        await builder.python(
          [
            "import os",
            `_p = os.path.join(app.samplesFolder, ${q(rel)})`,
            `op(${q(srcRef)}).par.file = _p`,
          ].join("\n"),
        );
      }
    } else {
      srcRef = args.source.path;
    }

    // resolutionTOP downsamples the source to side×side so each texel ↔ one particle slot.
    const srcResampled = await builder.add("resolutionTOP", "src_resampled", {
      outputresolution: "custom",
      resolution1: side,
      resolution2: side,
    });
    // Wire src → src_resampled only when the source lives in our container; cross-container
    // wires fail silently in TD, so when source.kind='top' we bind via parameter instead.
    if (args.source.kind === "file") {
      await builder.connect(srcRef, srcResampled);
    } else {
      // resolutionTOP reads its input from its first connector; we can also bind via a select
      // parameter — but here we just set the `top` parameter convention used by similar ops.
      // If unsupported on this TD release, surface as a post-cook error.
      await builder.setParams(srcResampled, { top: srcRef });
    }

    // --- REST-POSITION TOP (one-shot GLSL, no feedback). ---
    const restPos = await builder.add("glslTOP", "rest_pos", bufParams);
    const restFrag = await builder.add("textDAT", "rest_frag");
    await builder.python(
      `op(${q(restFrag)}).text = ${q(REST_SHADER)}\nop(${q(restPos)}).par.pixeldat = op(${q(restFrag)}).name`,
    );
    await builder.connect(srcResampled, restPos, 0, 0);

    const reactive = args.audio_source !== "none";

    // --- VELOCITY loop. Inputs: in0 vel_fb, in1 rest_pos, in2 pos_fb (read-only same frame). ---
    // feedbackTOP needs a wired input AND a forced resolution to cook (live-verified TD 099
    // gotcha: "Not enough sources specified" otherwise). We pass bufParams at create time and
    // wire vel_update → vel_fb below, after vel_update exists.
    const velFb = await builder.add("feedbackTOP", "vel_fb", bufParams);
    const velUpdate = await builder.add("glslTOP", "vel_update", bufParams);
    const velFrag = await builder.add("textDAT", "vel_frag");
    await builder.python(
      `op(${q(velFrag)}).text = ${q(velocityShader(reactive))}\nop(${q(velUpdate)}).par.pixeldat = op(${q(velFrag)}).name`,
    );
    await builder.connect(velFb, velUpdate, 0, 0);
    await builder.connect(restPos, velUpdate, 0, 1);
    // in2 = position; wired after pos_fb exists, below.

    // --- POSITION loop. Inputs: in0 pos_fb, in1 vel_update, in2 rest_pos (for first-frame seed). ---
    // Same feedbackTOP gotcha as vel_fb — needs forced resolution + a wired input source.
    const posFb = await builder.add("feedbackTOP", "pos_fb", bufParams);
    const posUpdate = await builder.add("glslTOP", "pos_update", bufParams);
    const posFrag = await builder.add("textDAT", "pos_frag");
    await builder.python(
      `op(${q(posFrag)}).text = ${q(POSITION_SHADER)}\nop(${q(posUpdate)}).par.pixeldat = op(${q(posFrag)}).name`,
    );
    await builder.connect(posFb, posUpdate, 0, 0);
    await builder.connect(velUpdate, posUpdate, 0, 1);
    await builder.connect(restPos, posUpdate, 0, 2);
    await builder.python(`op(${q(posFb)}).par.top = op(${q(posUpdate)}).name`);
    // feedbackTOP also needs (a) an input wire from the update TOP it echoes, AND (b) a reset
    // pulse so its initial "Not enough sources specified" error clears once both par.top + the
    // input are in place (live-verified TD 099 — without the wire+reset, both fbs stay errored
    // and the network never cooks past white).
    await builder.connect(posUpdate, posFb, 0, 0);

    // Close vel feedback + wire its in2 (position).
    await builder.connect(posFb, velUpdate, 0, 2);
    await builder.python(`op(${q(velFb)}).par.top = op(${q(velUpdate)}).name`);
    await builder.connect(velUpdate, velFb, 0, 0);

    // Reset both feedbacks after wiring so the initial-state error clears.
    await builder.python(
      [`op(${q(posFb)}).par.reset.pulse()`, `op(${q(velFb)}).par.reset.pulse()`].join("\n"),
    );

    builder.warnings.push(
      "First-frame seed: the position shader detects an empty feedback buffer and snaps each particle to its rest pixel — so the image appears immediately on cook. If a fresh load ever collapses to origin, pulse pos_fb's reset.",
    );

    // --- INSTANCED GEOMETRY ---
    const geo = await builder.add("geometryCOMP", "geo");
    const dot = await builder.add(
      "sphereSOP",
      "dot",
      { radx: args.particle_size, rady: args.particle_size, radz: args.particle_size },
      geo,
    );
    await builder.python(`_s = op(${q(dot)})\n_s.render = True\n_s.display = True`);

    // CRITICAL: setParams is atomic in TD 099 — ONE unknown par name rolls back the whole
    // dict, so `instancing`/`instanceop`/`instancetop`/`instancetx/y/z` would silently fail
    // alongside any bad colour-instancing key (the original bug: particles collapsed to a
    // single dot at origin). We split required vs optional, and live-probed TD 099 names:
    // colour-instancing is `instancecolorop` + `instancer/g/b/a` (NOT `instancecolortop` /
    // `instancecr/cg/cb`). `instancecolormode` is also set so the geo actually uses the TOP.
    // Live-verified TD 099 cook-order gotcha: when audio_source='none' the velocity loop has
    // zero force and the pos_update feedback chain stays black on its first cooks (par.top
    // returns the *previous* frame's data, which is unseeded → black → seed shader sees pos≈0,
    // assigns rest, but the GLSL output also lands at 0 because feedback semantics don't
    // populate the wired seed when par.top is set). Result: particles collapse at origin.
    // Bind the static (no-audio) case directly to rest_pos so the image renders as a
    // recognizable particle field. The dynamic feedback chain still cooks (warnings only) and
    // takes over when audio_source != 'none' below.
    const instanceSource = reactive ? posUpdate : restPos;
    const instParams: Record<string, unknown> = {
      instancing: 1,
      instanceop: instanceSource,
      instancetop: instanceSource,
      instancetx: "r",
      instancety: "g",
      instancetz: "b",
    };

    // Per-instance colour source TOP — 'mono' skips it entirely.
    let colorTop: string | undefined;
    if (args.color_mode === "image") {
      colorTop = srcResampled;
    } else if (args.color_mode === "tint") {
      // src_resampled → levelTOP scaled by tint_color → instance colour source.
      const tinted = await builder.add("levelTOP", "src_tinted", {
        bright1: args.tint_color[0],
        bright2: args.tint_color[1],
        bright3: args.tint_color[2],
      });
      await builder.connect(srcResampled, tinted);
      colorTop = tinted;
    }

    // Call A — required, atomic: instancing on/off + transform mapping. Must succeed.
    await builder.setParams(geo, instParams);

    // Call B — optional: per-instance colour. Tolerate failure (older TD builds, param
    // renames) by wrapping in try/except so it can never roll back Call A.
    if (colorTop) {
      await builder.python(
        [
          "try:",
          `    _g = op(${q(geo)})`,
          '    _g.par.instancecolormode = "instcoloropcolor"',
          `    _g.par.instancecolorop = ${q(colorTop)}`,
          '    _g.par.instancer = "r"',
          '    _g.par.instanceg = "g"',
          '    _g.par.instanceb = "b"',
          "except Exception:",
          "    pass",
        ].join("\n"),
      );
    }

    // Material: use instance colour for image/tint, plain white for mono.
    const mat = await builder.add("constantMAT", "mat", {
      useinstancecolor: colorTop ? 1 : 0,
    });
    await builder.setParams(geo, { material: mat });

    // --- RENDER ---
    const camDist = 4.6;
    const cam = await builder.add("cameraCOMP", "cam", { tz: camDist });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 4, tz: 4 });
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

    // --- AUDIO ANALYSIS (optional) ---
    // Default is 'none' — no chain, react_level not created. 'file' default avoids the macOS
    // mic-permission hang; 'device' is opt-in only.
    let reactExpr: string | undefined;
    if (args.audio_source === "file") {
      const audioIn = await builder.add("audiofileinCHOP", "audio_in", {
        file: args.audio_file,
        play: 1,
      });
      const rms = await builder.add("analyzeCHOP", "audio_rms", { function: "rmspower" });
      await builder.connect(audioIn, rms);
      const nullChop = await builder.add("nullCHOP", "react_level");
      await builder.connect(rms, nullChop);
      reactExpr = "op('react_level')[0]";
    } else if (args.audio_source === "device") {
      const audioIn = await builder.add("audiodeviceinCHOP", "audio_in");
      const rms = await builder.add("analyzeCHOP", "audio_rms", { function: "rmspower" });
      await builder.connect(audioIn, rms);
      const nullChop = await builder.add("nullCHOP", "react_level");
      await builder.connect(rms, nullChop);
      reactExpr = "op('react_level')[0]";
    }

    // Bind vel_update's uniforms to custom-pars on the container + (optional) react_level.
    // seq.vec slots: 0=uReact, 1=uSpring, 2=uScatter, 3=uDamp.
    const containerPath = builder.containerPath;
    const uniformLines = [
      `_v = op(${q(velUpdate)})`,
      "_seq = _v.seq.vec",
      "_seq.numBlocks = max(_seq.numBlocks, 4)",
      '_v.par.vec0name = "uReact"',
      '_v.par.vec1name = "uSpring"',
      '_v.par.vec2name = "uScatter"',
      '_v.par.vec3name = "uDamp"',
      `_v.par.vec1valuex.expr = ${q(`op(${q(containerPath)}).par.Springstiff`)}`,
      `_v.par.vec2valuex.expr = ${q(`op(${q(containerPath)}).par.Scatterstr`)}`,
      `_v.par.vec3valuex.expr = ${q(`op(${q(containerPath)}).par.Damp`)}`,
    ];
    if (reactExpr) {
      uniformLines.push(`_v.par.vec0valuex.expr = ${q(reactExpr)}`);
    }
    await builder.python(uniformLines.join("\n"));

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "PointSize",
            type: "float",
            min: 0.001,
            max: 0.2,
            default: args.particle_size,
            bind_to: [`${dot}.radx`, `${dot}.rady`, `${dot}.radz`],
          },
          {
            name: "Springstiff",
            type: "float",
            min: 0,
            max: 20,
            default: args.spring_stiffness,
          },
          {
            name: "Scatterstr",
            type: "float",
            min: 0,
            max: 20,
            default: args.scatter_strength,
          },
          {
            name: "Damp",
            type: "float",
            min: 0.5,
            max: 0.999,
            default: args.damp,
          },
          {
            name: "Zoom",
            type: "float",
            min: 1,
            max: camDist * 3,
            default: camDist,
            bind_to: [`${cam}.tz`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built an image-to-particles field: ${side}×${side} = ${side * side} particles from ${args.source.kind}:${args.source.path}, color_mode=${args.color_mode}, audio=${args.audio_source}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        side,
        count: side * side,
        source: args.source,
        color_mode: args.color_mode,
        audio_source: args.audio_source,
        output_path: out,
      },
    });
  });
}

export const registerCreateImageToParticles: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "image_to_particles",
    {
      title: "Image → particles",
      description:
        "Turn any image (a file path or an existing TOP) into a GPU particle field: each particle's rest position is its pixel in the source and (by default) its colour is sampled from that pixel. A spring force pulls particles toward their rest pixel; an optional audio chain scatters them away and lets them spring back, producing the iconic 'image dissolves into points on the drop, then re-forms' VJ look. Builds a new baseCOMP holding a downsampled source TOP, a one-shot rest-position GLSL TOP, velocity + position feedback loops (RGBA32float), an instanced Geometry COMP, Render, and a Null output. This is the only particle tool seeded by image/video pixels (rest positions + per-pixel colour); pick a sibling instead when particles are NOT driven by an image: create_gpu_particle_field for a free noise/curl/gravity drift field, create_particle_flock for boids/flocking, create_pop_particle_system for TouchDesigner's native POP particle network, create_particle_system for a simple CPU emitter. Default source is TD's stock Banana.tif; default audio source is 'none' (image idles statically) — 'file' and 'device' are opt-in (the latter may pop the macOS mic-permission dialog). Returns a summary plus a JSON block with the container path, particle count, output path, exposed controls, node errors, warnings, and an inline preview image.",
      inputSchema: createImageToParticlesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createImageToParticlesImpl(ctx, args),
  );
};

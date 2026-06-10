import { z } from "zod";
import { buildPopChainImpl } from "../layer2/buildPopChain.js";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createPopParticleSystemSchema = z.object({
  name: z
    .string()
    .default("pop_particle_system")
    .describe("Container basename created under parent_path."),
  parent_path: z.string().default("/project1").describe("Parent COMP path (default '/project1')."),
  emission_rate: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .default(5000)
    .describe(
      "Particle birth rate per second; mapped to particle_pop birthrate and exposed as EmissionRate knob.",
    ),
  lifetime: z
    .number()
    .min(0.05)
    .max(120)
    .default(4.0)
    .describe(
      "Particle lifetime in seconds; mapped to particle_pop life/lifeexpect. Exposed as Lifetime knob.",
    ),
  force_texture_path: z
    .string()
    .optional()
    .describe(
      "Existing TOP path to drive the force field via lookup_texture_pop.par.top. " +
        "If omitted, a noiseTOP is created inside the container as the default force source.",
    ),
  feedback_gain: z
    .number()
    .min(0)
    .max(1)
    .default(0.92)
    .describe(
      "Feedback strength on feedback_pop (mapped to inputmul). Exposed as FeedbackGain knob.",
    ),
  output: z
    .enum(["particles", "field", "composite"])
    .default("particles")
    .describe(
      "Which TOP the output nullTOP mirrors. " +
        "'particles' = render of particle_pop chain; " +
        "'field' = rendered field_pop visualization; " +
        "'composite' = compositeTOP (add) of both.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Render TOP resolution [width, height]."),
});

type CreatePopParticleSystemArgs = z.infer<typeof createPopParticleSystemSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setPar(path: string, parName: string, value: unknown): string {
  return (
    `try:\n    op(${JSON.stringify(path)}).par[${JSON.stringify(parName)}].val = ` +
    `${JSON.stringify(value)}\nexcept Exception:\n    pass`
  );
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createPopParticleSystemImpl(
  ctx: ToolContext,
  args: CreatePopParticleSystemArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const container = builder.containerPath;
    const [width, height] = args.resolution;

    // 1) Optional default force noiseTOP — created before buildPopChain so the path resolves.
    let forcePath: string;
    if (args.force_texture_path) {
      forcePath = args.force_texture_path;
    } else {
      const noiseNode = await builder.add("noiseTOP", "force_default", {
        resolutionw: width,
        resolutionh: height,
      });
      forcePath = noiseNode;
    }

    // 2) Delegate POP chain to Layer 2 — do NOT re-implement the chain here.
    const chainResult = await buildPopChainImpl(ctx, {
      parent: container,
      name: args.name,
      chain: [
        {
          // Emitter seed — particle_pop needs an input that defines birth
          // positions. point_generator_pop produces a points cloud the
          // particles spawn from, eliminating the "Not enough sources" cook
          // error seen on a bare particle_pop.
          type: "point_generator_pop",
          name: "seed",
        },
        {
          type: "particle_pop",
          name: "particles",
          params: { birthrate: args.emission_rate, life: args.lifetime },
        },
        {
          type: "feedback_pop",
          name: "trail",
          // Live TD: feedbackPOP has `inputmul` (not `gain`/`mix`).
          params: { inputmul: args.feedback_gain },
        },
        {
          type: "lookup_texture_pop",
          name: "force_lookup",
          extra_inputs: [forcePath], // Wave-2 fix at buildPopChain.ts:469-489 writes to par.top
        },
        {
          type: "field_pop",
          name: "field_viz",
        },
        {
          type: "null_pop",
          name: "out_pop",
        },
      ],
    });

    // Parse the chain result text to extract warnings and output path.
    const chainText = chainResult.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const chainWarnings: string[] = [];
    let chainOutputPath: string | null = null;
    const chainJsonMatch = /```json\n([\s\S]*?)\n```/.exec(chainText);
    if (chainJsonMatch?.[1]) {
      try {
        const parsed = JSON.parse(chainJsonMatch[1]) as {
          warnings?: string[];
          output_path?: string | null;
        };
        if (Array.isArray(parsed.warnings)) {
          chainWarnings.push(...(parsed.warnings as string[]));
        }
        if (parsed.output_path) chainOutputPath = parsed.output_path;
      } catch {
        chainWarnings.push("Could not parse buildPopChain JSON block");
      }
    }

    const outPopPath = chainOutputPath ?? `${container}/out_pop`;

    // 3) Render rig — SOP bridge (same as createPopField).
    const geo = await builder.add("geometryCOMP", "geo");
    const toSop = await builder.add("poptoSOP", "to_sop", {}, geo);
    await builder.python(setPar(toSop, "pop", outPopPath));
    await builder.python(`_s = op(${JSON.stringify(toSop)})\n_s.render = True\n_s.display = True`);

    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      resolutionw: width,
      resolutionh: height,
    });

    // 4) Output wiring per mode.
    let finalRender = render;
    if (args.output === "field" || args.output === "composite") {
      const geo2 = await builder.add("geometryCOMP", "geo_field");
      const toSop2 = await builder.add("poptoSOP", "to_sop_field", {}, geo2);
      await builder.python(setPar(toSop2, "pop", `${container}/field_viz`));
      await builder.python(
        `_s2 = op(${JSON.stringify(toSop2)})\n_s2.render = True\n_s2.display = True`,
      );
      const render2 = await builder.add("renderTOP", "render_field", {
        camera: cam,
        geometry: geo2,
        lights: light,
        resolutionw: width,
        resolutionh: height,
      });

      if (args.output === "composite") {
        const comp = await builder.add("compositeTOP", "composite", { operand: "add" });
        await builder.connect(render, comp);
        await builder.connect(render2, comp);
        finalRender = comp;
      } else {
        finalRender = render2;
      }
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(finalRender, out);

    // 5) Exposed controls.
    const controls: ControlSpec[] = [
      {
        name: "EmissionRate",
        type: "float",
        min: 0,
        max: 100000,
        default: args.emission_rate,
        bind_to: [`${container}/particles.birthrate`],
      },
      {
        name: "Lifetime",
        type: "float",
        min: 0.05,
        max: 120,
        default: args.lifetime,
        bind_to: [`${container}/particles.life`],
      },
      {
        name: "FeedbackGain",
        type: "float",
        min: 0,
        max: 1,
        default: args.feedback_gain,
        bind_to: [`${container}/trail.inputmul`],
      },
      {
        name: "ForceTexture",
        type: "string",
        min: 0,
        max: 1,
        default: forcePath,
        bind_to: [`${container}/force_lookup.top`],
      },
    ];

    const extra: Record<string, unknown> = {
      container_path: container,
      chain_output: outPopPath,
      force_path: forcePath,
      output_mode: args.output,
      resolution: [width, height],
      output_top_path: out,
      warnings: chainWarnings,
      unverified: {
        pop_op_types: [
          "pointgeneratorPOP",
          "particlePOP",
          "feedbackPOP",
          "lookuptexturePOP",
          "fieldPOP",
          "nullPOP",
        ],
        note: "POPs are Experimental — live-validate.",
      },
    };

    const summary =
      `Built a POP particle system (~${args.emission_rate}/s emission, ${args.lifetime}s lifetime, ` +
      `force=${forcePath}) rendered to ${out}. Output mode: ${args.output}. ` +
      (chainWarnings.length ? `${chainWarnings.length} chain warning(s). ` : "") +
      "POPs are Experimental — live-validate the render path.";

    return finalize(ctx, { summary, builder, outputPath: out, controls, extra });
  });
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreatePopParticleSystem: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "create_pop_particle_system",
    {
      title: "Create POP particle system",
      description:
        "Build a complete POP particle simulation (particle_pop → feedback_pop → " +
        "lookup_texture_pop → field_pop → null_pop) inside a new baseCOMP, wire a " +
        "render rig (poptoSOP → geometryCOMP → renderTOP → nullTOP), and expose " +
        "EmissionRate, Lifetime, FeedbackGain, and ForceTexture live controls. " +
        "When force_texture_path is omitted, a noiseTOP is created inside the container " +
        "as the default force source so the chain always cooks. " +
        "Supports three output modes: 'particles' (particle render), 'field' " +
        "(field_pop visualization), and 'composite' (compositeTOP add of both). " +
        "POP chain creation is delegated to build_pop_chain (Layer 2); " +
        "this tool adds only the render rig and control exposure. " +
        "NOTE: POPs are Experimental — the result carries an unverified marker; live-validate.",
      inputSchema: createPopParticleSystemSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPopParticleSystemImpl(ctx, args),
  );

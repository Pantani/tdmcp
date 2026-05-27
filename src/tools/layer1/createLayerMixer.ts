import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

export const createLayerMixerSchema = z.object({
  inputs: z
    .array(z.string())
    .default([])
    .describe(
      "Paths of source TOPs to mix (brought in via Select TOPs, so they can live in other containers). With fewer than 2, demo sources (noise + ramp) are created so you can see it working.",
    ),
  blend: z
    .enum([
      "crossfade",
      "add",
      "difference",
      "hardlight",
      "glow",
      "lightercolor",
      "darkercolor",
      "average",
      "exclude",
    ])
    .default("crossfade")
    .describe(
      "'crossfade' = an A/B Cross TOP with a Crossfade knob; any other value composites all inputs with that blend mode.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose a live 'Crossfade' knob (crossfade mode only)."),
  parent_path: z.string().default("/project1"),
});
type CreateLayerMixerArgs = z.infer<typeof createLayerMixerSchema>;

export async function createLayerMixerImpl(ctx: ToolContext, args: CreateLayerMixerArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "layer_mixer");

    // Bring each external source in through a Select TOP (TD wires don't cross containers).
    // With fewer than two real inputs, drop in two distinct demo sources so the mix is visible.
    const sources: string[] = [];
    if (args.inputs.length >= 2) {
      for (const input of args.inputs) {
        sources.push(await builder.add("selectTOP", undefined, { top: input }));
      }
    } else {
      sources.push(await builder.add("noiseTOP", "srcA"));
      sources.push(await builder.add("rampTOP", "srcB"));
    }

    let output: string;
    const controls: ControlSpec[] = [];
    if (args.blend === "crossfade" && sources.length === 2) {
      const cross = await builder.add("crossTOP", "mix", { cross: 0.5 });
      await builder.connect(sources[0] as string, cross, 0, 0);
      await builder.connect(sources[1] as string, cross, 0, 1);
      output = cross;
      if (args.expose_controls) {
        controls.push({
          name: "Crossfade",
          type: "float",
          min: 0,
          max: 1,
          default: 0.5,
          bind_to: [`${cross}.cross`],
        });
      }
    } else {
      const operand = args.blend === "crossfade" ? "add" : args.blend;
      const composite = await builder.add("compositeTOP", "mix", { operand });
      for (const [i, source] of sources.entries()) {
        await builder.connect(source, composite, 0, i);
      }
      output = composite;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);

    return finalize(ctx, {
      summary: `Built a layer mixer (${args.blend}) over ${sources.length} source(s) → ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: { blend: args.blend, sources, output_path: out },
    });
  });
}

export const registerCreateLayerMixer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_layer_mixer",
    {
      title: "Create layer mixer",
      description:
        "Build a VJ-style layer mixer: combine source TOPs into one output. 'crossfade' makes an A/B Cross TOP with a Crossfade knob (the classic two-deck mix); any other blend mode composites the inputs (add, difference, hardlight, glow, …). Sources are pulled in via Select TOPs so they can live anywhere; with fewer than two, demo sources are created. Output is a Null ready for post-processing or setup_output.",
      inputSchema: createLayerMixerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLayerMixerImpl(ctx, args),
  );
};

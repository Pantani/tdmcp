import { z } from "zod";
import { createSystemContainer, finalize, runBuild } from "../layer1/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import type { ControlSpec } from "./createControlPanel.js";

export const createDecksSchema = z.object({
  deck_a: z
    .string()
    .optional()
    .describe(
      "Absolute path of the source TOP for deck A (pulled in via a Select TOP, so it can live in another container). If omitted, a built-in test source (Noise TOP) is created so the mixer builds standalone.",
    ),
  deck_b: z
    .string()
    .optional()
    .describe(
      "Absolute path of the source TOP for deck B (pulled in via a Select TOP). If omitted, a built-in test source (Ramp TOP) is created so the mixer builds standalone.",
    ),
  crossfade: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Master crossfader position: 0 = full deck A, 1 = full deck B, 0.5 = even blend."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live 'Crossfader' + per-deck 'GainA'/'GainB' knobs on the container so the mix is playable on arrival.",
    ),
  parent_path: z.string().default("/project1"),
});
type CreateDecksArgs = z.infer<typeof createDecksSchema>;

/**
 * DJ-style two-deck VJ mixer. Each deck is a small labeled sub-chain — a Select TOP that
 * pulls its source (TD wires don't cross containers) into a per-deck Level TOP for
 * gain/opacity — and both decks feed a master Cross TOP whose `cross` parameter is the
 * crossfader (0 = A, 1 = B). A master Level TOP after the Cross gives a single output FX /
 * trim, terminating in a Null ready for post-processing or setup_output.
 */
export async function createDecksImpl(ctx: ToolContext, args: CreateDecksArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "decks");

    // --- Deck A ---------------------------------------------------------------
    // Pull the source in (or drop in a distinct test source) → per-deck gain/opacity Level.
    const srcA = args.deck_a
      ? await builder.add("selectTOP", "deckA_src", { top: args.deck_a })
      : await builder.add("noiseTOP", "deckA_src");
    const deckA = await builder.add("levelTOP", "deckA_gain", { brightness1: 1, opacity: 1 });
    await builder.connect(srcA, deckA);

    // --- Deck B ---------------------------------------------------------------
    const srcB = args.deck_b
      ? await builder.add("selectTOP", "deckB_src", { top: args.deck_b })
      : await builder.add("rampTOP", "deckB_src");
    const deckB = await builder.add("levelTOP", "deckB_gain", { brightness1: 1, opacity: 1 });
    await builder.connect(srcB, deckB);

    // --- Master crossfader ----------------------------------------------------
    // Cross TOP blends input 0 (A) → input 1 (B). `cross` is the crossfader: 0 = A, 1 = B.
    const cross = await builder.add("crossTOP", "crossfader", { cross: args.crossfade });
    await builder.connect(deckA, cross, 0, 0);
    await builder.connect(deckB, cross, 0, 1);

    // Master FX / output trim after the blend, then the output Null.
    const master = await builder.add("levelTOP", "master_fx", { brightness1: 1, opacity: 1 });
    await builder.connect(cross, master);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(master, out);

    const controls: ControlSpec[] = [];
    if (args.expose_controls) {
      controls.push(
        {
          name: "Crossfader",
          type: "float",
          min: 0,
          max: 1,
          default: args.crossfade,
          bind_to: [`${cross}.cross`],
        },
        {
          name: "GainA",
          label: "Gain A",
          type: "float",
          min: 0,
          max: 2,
          default: 1,
          bind_to: [`${deckA}.brightness1`],
        },
        {
          name: "GainB",
          label: "Gain B",
          type: "float",
          min: 0,
          max: 2,
          default: 1,
          bind_to: [`${deckB}.brightness1`],
        },
      );
    }

    return finalize(ctx, {
      summary: `Built DJ-style A/B decks with a crossfader (${args.crossfade}) → ${out}.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        deck_a: { source: srcA, gain: deckA, external: Boolean(args.deck_a) },
        deck_b: { source: srcB, gain: deckB, external: Boolean(args.deck_b) },
        crossfader: cross,
        master: master,
        crossfade: args.crossfade,
        output_path: out,
      },
    });
  });
}

export const registerCreateDecks: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_decks",
    {
      title: "Create DJ-style A/B decks",
      description:
        "Build a DJ-style VJ mixer: deck A and deck B each pull in a source TOP (via a Select TOP, so sources can live anywhere) through a per-deck gain/opacity Level, and a master Crossfader (a Cross TOP, 0 = A, 1 = B) blends them, followed by a master FX Level and an output Null. Either deck falls back to a built-in test source (Noise for A, Ramp for B) so it builds standalone. Exposes live 'Crossfader' + per-deck 'GainA'/'GainB' knobs. Output is a Null ready for post-processing or setup_output.",
      inputSchema: createDecksSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDecksImpl(ctx, args),
  );
};

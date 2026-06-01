import { z } from "zod";
import { createSystemContainer, finalize, runBuild } from "../layer1/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import type { ControlSpec } from "./createControlPanel.js";

const deckSpecSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Human label for this deck, used in exposed controls and structured output."),
  source: z
    .string()
    .optional()
    .describe(
      "Absolute path of the source TOP for this deck. If omitted, a built-in test source is created.",
    ),
  gain: z.coerce
    .number()
    .min(0)
    .max(2)
    .default(1)
    .describe("Initial per-deck gain/brightness, exposed as a live control when enabled."),
  fx_send: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Initial per-deck send amount into the additive FX-send bus."),
  mix: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "For deck 3 and later, the initial blend amount into the running program mix. Decks 1-2 use crossfade.",
    ),
});

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
  decks: z
    .array(deckSpecSchema)
    .min(2)
    .max(8)
    .optional()
    .describe(
      "Optional N-channel deck list. When supplied, create_decks builds a 2-8 deck mixer with per-deck gain, FX sends, a running blend chain, and a hard-cut switch bus.",
    ),
  cut_deck: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Zero-based deck index selected by the hard transition-cut bus in N-channel mode."),
  cut_mix: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Blend between the continuous program mix and the hard transition-cut bus: 0 = program mix, 1 = cut bus.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live 'Crossfader' + per-deck 'GainA'/'GainB' knobs on the container so the mix is playable on arrival.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP the mixer container is built inside (default '/project1')."),
});
type CreateDecksArgs = z.input<typeof createDecksSchema>;
type DeckSpec = z.input<typeof deckSpecSchema>;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.trunc(clampNumber(value, min, max, fallback));
}

function deckLabel(spec: DeckSpec, index: number): string {
  const raw = spec.name?.trim() || `Deck ${index + 1}`;
  return raw.replace(/\s+/g, " ");
}

function testSourceType(index: number): "noiseTOP" | "rampTOP" {
  return index % 2 === 0 ? "noiseTOP" : "rampTOP";
}

/**
 * DJ-style two-deck VJ mixer. Each deck is a small labeled sub-chain — a Select TOP that
 * pulls its source (TD wires don't cross containers) into a per-deck Level TOP for
 * gain/opacity — and both decks feed a master Cross TOP whose `cross` parameter is the
 * crossfader (0 = A, 1 = B). A master Level TOP after the Cross gives a single output FX /
 * trim, terminating in a Null ready for post-processing or setup_output.
 */
export async function createDecksImpl(ctx: ToolContext, args: CreateDecksArgs) {
  return runBuild(async () => {
    const decks = args.decks;
    if (decks?.length) {
      return createNChannelDecks(ctx, args, decks);
    }

    const parentPath = args.parent_path ?? "/project1";
    const crossfade = clampNumber(args.crossfade, 0, 1, 0.5);
    const exposeControls = args.expose_controls ?? true;
    const builder = await createSystemContainer(ctx, parentPath, "decks");

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
    const cross = await builder.add("crossTOP", "crossfader", { cross: crossfade });
    await builder.connect(deckA, cross, 0, 0);
    await builder.connect(deckB, cross, 0, 1);

    // Master FX / output trim after the blend, then the output Null.
    const master = await builder.add("levelTOP", "master_fx", { brightness1: 1, opacity: 1 });
    await builder.connect(cross, master);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(master, out);

    const controls: ControlSpec[] = [];
    if (exposeControls) {
      controls.push(
        {
          name: "Crossfader",
          type: "float",
          min: 0,
          max: 1,
          default: crossfade,
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
      summary: `Built DJ-style A/B decks with a crossfader (${crossfade}) → ${out}.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        deck_a: { source: srcA, gain: deckA, external: Boolean(args.deck_a) },
        deck_b: { source: srcB, gain: deckB, external: Boolean(args.deck_b) },
        crossfader: cross,
        master: master,
        crossfade,
        output_path: out,
      },
    });
  });
}

async function createNChannelDecks(ctx: ToolContext, args: CreateDecksArgs, deckSpecs: DeckSpec[]) {
  if (deckSpecs.length < 2 || deckSpecs.length > 8) {
    throw new Error("create_decks decks[] mode requires between 2 and 8 decks.");
  }

  const parentPath = args.parent_path ?? "/project1";
  const crossfade = clampNumber(args.crossfade, 0, 1, 0.5);
  const cutDeck = clampInt(args.cut_deck, 0, deckSpecs.length - 1, 0);
  const cutMix = clampNumber(args.cut_mix, 0, 1, 0);
  const exposeControls = args.expose_controls ?? true;
  const builder = await createSystemContainer(ctx, parentPath, "decks");

  const builtDecks: Array<{
    index: number;
    label: string;
    source: string;
    gain: string;
    fxSend: string;
    external: boolean;
    gainValue: number;
    fxSendValue: number;
    mixValue: number;
  }> = [];

  for (const [i, spec] of deckSpecs.entries()) {
    const index = i + 1;
    const gainValue = clampNumber(spec.gain, 0, 2, 1);
    const fxSendValue = clampNumber(spec.fx_send, 0, 1, 0);
    const mixValue = clampNumber(spec.mix, 0, 1, 0);
    const source = spec.source
      ? await builder.add("selectTOP", `deck${index}_src`, { top: spec.source })
      : await builder.add(testSourceType(i), `deck${index}_src`);
    const gain = await builder.add("levelTOP", `deck${index}_gain`, {
      brightness1: gainValue,
      opacity: 1,
    });
    await builder.connect(source, gain);

    const fxSend = await builder.add("levelTOP", `deck${index}_fx_send`, {
      brightness1: 1,
      opacity: fxSendValue,
    });
    await builder.connect(gain, fxSend);

    builtDecks.push({
      index,
      label: deckLabel(spec, i),
      source,
      gain,
      fxSend,
      external: Boolean(spec.source),
      gainValue,
      fxSendValue,
      mixValue,
    });
  }

  const firstCross = await builder.add("crossTOP", "crossfader", { cross: crossfade });
  const [deckOne, deckTwo] = builtDecks;
  if (!deckOne || !deckTwo) {
    throw new Error("create_decks decks[] mode requires at least two normalized decks.");
  }
  await builder.connect(deckOne.gain, firstCross, 0, 0);
  await builder.connect(deckTwo.gain, firstCross, 0, 1);

  let programMix = firstCross;
  const extraMixes: Array<{ deck: number; path: string; value: number }> = [];
  for (const deck of builtDecks.slice(2)) {
    const mix = await builder.add("crossTOP", `deck${deck.index}_mix`, {
      cross: deck.mixValue,
    });
    await builder.connect(programMix, mix, 0, 0);
    await builder.connect(deck.gain, mix, 0, 1);
    extraMixes.push({ deck: deck.index, path: mix, value: deck.mixValue });
    programMix = mix;
  }

  const transitionCut = await builder.add("switchTOP", "transition_cut", { index: cutDeck });
  for (const [i, deck] of builtDecks.entries()) {
    await builder.connect(deck.gain, transitionCut, 0, i);
  }

  const programCut = await builder.add("crossTOP", "program_cut_mix", { cross: cutMix });
  await builder.connect(programMix, programCut, 0, 0);
  await builder.connect(transitionCut, programCut, 0, 1);

  const fxSendBus = await builder.add("compositeTOP", "fx_send_bus", { operand: "add" });
  for (const [i, deck] of builtDecks.entries()) {
    await builder.connect(deck.fxSend, fxSendBus, 0, i);
  }

  const fxReturn = await builder.add("compositeTOP", "fx_return", { operand: "add" });
  await builder.connect(programCut, fxReturn, 0, 0);
  await builder.connect(fxSendBus, fxReturn, 0, 1);

  const master = await builder.add("levelTOP", "master_fx", { brightness1: 1, opacity: 1 });
  await builder.connect(fxReturn, master);

  const out = await builder.add("nullTOP", "out1");
  await builder.connect(master, out);

  const controls: ControlSpec[] = [];
  if (exposeControls) {
    controls.push(
      {
        name: "Crossfader",
        type: "float",
        min: 0,
        max: 1,
        default: crossfade,
        bind_to: [`${firstCross}.cross`],
      },
      {
        name: "CutDeck",
        label: "Cut deck",
        type: "int",
        min: 0,
        max: builtDecks.length - 1,
        default: cutDeck,
        bind_to: [`${transitionCut}.index`],
      },
      {
        name: "CutMix",
        label: "Cut mix",
        type: "float",
        min: 0,
        max: 1,
        default: cutMix,
        bind_to: [`${programCut}.cross`],
      },
    );

    for (const deck of builtDecks) {
      controls.push(
        {
          name: `GainDeck${deck.index}`,
          label: `${deck.label} gain`,
          type: "float",
          min: 0,
          max: 2,
          default: deck.gainValue,
          bind_to: [`${deck.gain}.brightness1`],
        },
        {
          name: `FxSendDeck${deck.index}`,
          label: `${deck.label} FX send`,
          type: "float",
          min: 0,
          max: 1,
          default: deck.fxSendValue,
          bind_to: [`${deck.fxSend}.opacity`],
        },
      );
    }

    for (const mix of extraMixes) {
      controls.push({
        name: `MixDeck${mix.deck}`,
        label: `Deck ${mix.deck} mix`,
        type: "float",
        min: 0,
        max: 1,
        default: mix.value,
        bind_to: [`${mix.path}.cross`],
      });
    }
  }

  return finalize(ctx, {
    summary: `Built ${builtDecks.length}-channel DJ/VJ decks with transition cut + FX-send bus → ${out}.`,
    builder,
    outputPath: out,
    capturePreviewImage: true,
    controls,
    extra: {
      decks: builtDecks.map((deck) => ({
        index: deck.index,
        label: deck.label,
        source: deck.source,
        gain: deck.gain,
        fx_send: deck.fxSend,
        external: deck.external,
        gain_value: deck.gainValue,
        fx_send_value: deck.fxSendValue,
      })),
      crossfader: firstCross,
      extra_mixes: extraMixes,
      transition_cut: transitionCut,
      program_cut_mix: programCut,
      fx_send_bus: fxSendBus,
      fx_return: fxReturn,
      master,
      crossfade,
      cut_deck: cutDeck,
      cut_mix: cutMix,
      output_path: out,
    },
  });
}

export const registerCreateDecks: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_decks",
    {
      title: "Create DJ-style decks",
      description:
        "Build a DJ-style VJ mixer. Without decks[], it preserves the legacy A/B Cross TOP mixer with GainA/GainB controls. With decks[], it builds a 2-8 deck mixer: every deck pulls a source TOP (or a test source) through gain and FX-send Level TOPs, decks 3+ blend into a running Cross TOP chain, a Switch TOP provides hard transition cuts, a final Cross TOP blends program vs cut, and an additive FX-send bus returns per-deck sends into the master. Output is a Null ready for post-processing or setup_output.",
      inputSchema: createDecksSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDecksImpl(ctx, args),
  );
};

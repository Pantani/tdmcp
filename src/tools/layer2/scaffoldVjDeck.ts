import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createControlSurfaceImpl } from "./createControlSurface.js";
import { createDecksImpl } from "./createDecks.js";
import { createExternalIoImpl } from "./createExternalIo.js";

const midiMapSchema = z.object({
  channel: z
    .string()
    .describe(
      "MIDI input channel name (e.g. 'ch1c7') that this control listens to. Wiggle the control and read the midiinCHOP to learn it.",
    ),
  control: z
    .enum(["crossfader", "gain_a", "gain_b"])
    .describe("Which VJ-deck control this MIDI channel drives."),
});

export const scaffoldVjDeckSchema = z.object({
  name: z.string().default("vj_deck").describe("Base name for the VJ-deck container COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP the VJ deck is scaffolded inside (default '/project1')."),
  deck_a: z
    .string()
    .optional()
    .describe(
      "Absolute path of the source TOP for deck A. If omitted, a built-in test source is created.",
    ),
  deck_b: z
    .string()
    .optional()
    .describe(
      "Absolute path of the source TOP for deck B. If omitted, a built-in test source is created.",
    ),
  crossfade: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Initial crossfader position: 0 = full deck A, 1 = full deck B."),
  midi: z
    .boolean()
    .default(true)
    .describe(
      "Create a midiinCHOP control surface and bind its channels to the deck controls (MIDI-mappable VJ deck).",
    ),
  midi_map: z
    .array(midiMapSchema)
    .optional()
    .describe(
      "Explicit MIDI channel → control bindings. When omitted, a sensible default map (ch1c1→crossfader, ch1c2→gain_a, ch1c3→gain_b) is used.",
    ),
  faders: z
    .boolean()
    .default(true)
    .describe(
      "Add an on-screen fader control surface (crossfader + per-deck gain faders) inside the container.",
    ),
});

export type ScaffoldVjDeckArgs = z.infer<typeof scaffoldVjDeckSchema>;

const DEFAULT_MIDI_MAP: Array<{ channel: string; control: "crossfader" | "gain_a" | "gain_b" }> = [
  { channel: "ch1c1", control: "crossfader" },
  { channel: "ch1c2", control: "gain_a" },
  { channel: "ch1c3", control: "gain_b" },
];

// Pull the JSON fence out of a tool result's text block and parse it. Tool results from the
// composed Impls carry their structured report in a ```json fence appended to the summary.
function parseFence<T>(result: CallToolResult): T | undefined {
  const text = result.content?.find((c) => c.type === "text") as { text?: string } | undefined;
  if (!text?.text) return undefined;
  const match = text.text.match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return undefined;
  }
}

interface DecksReport {
  container?: string;
  crossfader?: string;
  deck_a?: { gain?: string };
  deck_b?: { gain?: string };
  output?: string;
  output_path?: string;
}

export async function scaffoldVjDeckImpl(
  ctx: ToolContext,
  args: ScaffoldVjDeckArgs,
): Promise<CallToolResult> {
  const warnings: string[] = [];

  // 1) Build the deck primitive (create_decks). This is the core mixer.
  const decksResult = await createDecksImpl(ctx, {
    deck_a: args.deck_a,
    deck_b: args.deck_b,
    crossfade: args.crossfade,
    expose_controls: true,
    parent_path: args.parent_path,
  });
  if (decksResult.isError) {
    return errorResult(
      "scaffold_vj_deck: create_decks failed — see the deck build output.",
      parseFence(decksResult) ?? {},
    );
  }
  const decks = parseFence<DecksReport>(decksResult);
  const container = decks?.container;
  const crossfader = decks?.crossfader;
  const gainA = decks?.deck_a?.gain;
  const gainB = decks?.deck_b?.gain;
  if (!container) {
    return errorResult(
      "scaffold_vj_deck: could not resolve the deck container path from create_decks output.",
      { decks },
    );
  }

  // Map a logical control name to the concrete 'nodePath.parName' the decks build exposes.
  const targetFor = (control: "crossfader" | "gain_a" | "gain_b"): string | undefined => {
    if (control === "crossfader") return crossfader ? `${crossfader}.cross` : undefined;
    if (control === "gain_a") return gainA ? `${gainA}.brightness1` : undefined;
    return gainB ? `${gainB}.brightness1` : undefined;
  };

  // 2) Optional on-screen fader surface, built inside the deck container.
  let surfacePath: string | undefined;
  if (args.faders) {
    const faders = (["crossfader", "gain_a", "gain_b"] as const)
      .map((c) => {
        const param = targetFor(c);
        return param
          ? {
              param,
              label: c === "crossfader" ? "Crossfade" : c === "gain_a" ? "Gain A" : "Gain B",
              min: 0,
              max: c === "crossfader" ? 1 : 2,
            }
          : undefined;
      })
      .filter((f): f is NonNullable<typeof f> => f !== undefined);
    const surfaceResult = await createControlSurfaceImpl(ctx, {
      comp_path: container,
      name: "surface",
      align: "horizlr",
      faders,
      cue_buttons: [],
    });
    if (surfaceResult.isError) {
      warnings.push("Fader surface build failed; deck + MIDI still wired.");
    } else {
      const surf = parseFence<{ surface?: string }>(surfaceResult);
      surfacePath = surf?.surface;
    }
  }

  // 3) Optional MIDI map: a midiinCHOP bound to the deck controls (external control surface).
  let midiPath: string | undefined;
  let midiBindings = 0;
  if (args.midi) {
    const map = args.midi_map?.length ? args.midi_map : DEFAULT_MIDI_MAP;
    const bindTo = map
      .map((m) => {
        const target = targetFor(m.control);
        return target ? { channel: m.channel, target } : undefined;
      })
      .filter((b): b is { channel: string; target: string } => b !== undefined);
    const ioResult = await createExternalIoImpl(ctx, {
      kind: "midi_in",
      parent_path: container,
      name: "midi",
      normalize: "0to1",
      bind_to: bindTo,
      interface: "artnet",
      universe: 1,
    });
    if (ioResult.isError) {
      warnings.push("MIDI-in build failed; deck + faders still wired.");
    } else {
      const io = parseFence<{ node?: string; bound?: unknown[] }>(ioResult);
      midiPath = io?.node;
      midiBindings = io?.bound?.length ?? 0;
    }
  }

  const output = decks?.output ?? decks?.output_path;
  const summary = `Scaffolded VJ deck '${args.name}' in ${container}: A/B decks + crossfader${
    surfacePath ? " + on-screen fader surface" : ""
  }${args.midi ? ` + MIDI map (${midiBindings} binding(s))` : ""} → output ${output ?? "out1"}${
    warnings.length ? `, ${warnings.length} warning(s)` : ""
  }.`;

  return jsonResult(summary, {
    name: args.name,
    container,
    crossfader,
    gain_a: gainA,
    gain_b: gainB,
    surface: surfacePath,
    midi: midiPath,
    midi_bindings: midiBindings,
    output,
    warnings,
  });
}

export const registerScaffoldVjDeck: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "scaffold_vj_deck",
    {
      title: "Scaffold a MIDI-mappable VJ deck",
      description:
        "Compose a complete, playable VJ deck UI in one call: it builds a DJ-style A/B deck mixer (create_decks) with a crossfader, adds an on-screen fader control surface (create_control_surface) with crossfade + per-deck gain faders, and creates a midiinCHOP control surface (create_external_io) whose channels are bound to the same crossfader/gain parameters for hands-on MIDI control. Pass deck_a/deck_b source TOP paths (or omit for test sources), and an optional midi_map of channel→control bindings (defaults to ch1c1→crossfader, ch1c2→gain_a, ch1c3→gain_b). This is the deck-scaffold layer on top of the create_decks primitive — it wires the existing deck, surface, and I/O tools into one UI container.",
      inputSchema: scaffoldVjDeckSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => scaffoldVjDeckImpl(ctx, args),
  );
};

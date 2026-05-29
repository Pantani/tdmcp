import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerGenreVisualLanguage: PromptRegistrar = (server) => {
  server.registerPrompt(
    "genre_visual_language",
    {
      title: "Genre visual language",
      description:
        "Pick IDIOMATIC looks for a music genre instead of generic ones — encodes genre→visual conventions (techno = monochrome strobing geometry; ambient = slow organic feedback; DnB = RGB glitch; footwork = fast cut-up) and maps them onto concrete tdmcp tools.",
      argsSchema: {
        genre: z
          .string()
          .optional()
          .describe(
            "The genre/scene, e.g. 'peak-time techno', 'liquid DnB', 'ambient', 'footwork', 'synthwave'.",
          ),
        target: z
          .string()
          .optional()
          .describe("An existing show/COMP to steer toward the genre, if any."),
      },
    },
    ({ genre, target }) =>
      userPrompt(
        [
          `Translate ${genre ? `the genre "${genre}"` : "the given genre"} into a concrete visual language using tdmcp tools — make it read as authentic to the scene, not a generic 'music visualizer'.${target ? ` Apply it to ${target}.` : ""}`,
          "",
          "1. State the conventions first (briefly): for this genre, what are the hallmark motion, palette, density, and texture? Examples to reason from (don't copy blindly): techno → monochrome/red, hard strobes, rigid geometry, high contrast; ambient → slow organic feedback, soft gradients, low contrast, long trails; DnB/neurofunk → RGB glitch, warehouse grit, sharp cuts; footwork/juke → fast cut-up, stutter, bold type; synthwave → grids, sunsets, chrome, scanlines.",
          "2. Map each convention to specific tools + settings: e.g. techno → create_kaleidoscope + create_strobe (beat-synced) + a monochrome create_palette + hard create_transition glitch_cut; ambient → create_feedback_tunnel/create_feedback_network with high decay + slow create_simulation + warm low-contrast grade. Name the tools and the key params, not just the mood.",
          "3. Set reactivity to taste: how hard should it hit the beat? Techno = aggressive (high bind_audio_reactive intensity, strobe on the kick); ambient = gentle (slow attack/release, energy not transients).",
          "4. Build or steer: if a target exists, adjust it toward the language (don't rebuild what works); otherwise scaffold it (consider scaffold_genre as a starting skeleton) and layer the genre choices on top.",
          "5. get_preview and sanity-check it 'feels' like the genre; report the convention→tool map so the artist learns the vocabulary, not just the result.",
        ].join("\n"),
      ),
  );
};

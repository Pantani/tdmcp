import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerColorStory: PromptRegistrar = (server) => {
  server.registerPrompt(
    "color_story",
    {
      title: "Color story",
      description:
        "Design a cohesive palette + color-grade ARC across a set or its sections (warm intro → cold drop → strobe-white peak) and wire it with create_palette + create_color_grade — instead of picking colors per-scene ad hoc.",
      argsSchema: {
        arc: z
          .string()
          .optional()
          .describe(
            "The emotional/energy arc, e.g. 'warm hopeful intro → tense build → cold hard drop → white-out peak → calm outro'.",
          ),
        sections: z
          .string()
          .optional()
          .describe("Named sections/cues to color, if they already exist (comma-separated)."),
      },
    },
    ({ arc, sections }) =>
      userPrompt(
        [
          `Design a COLOR STORY — a palette and grade that evolves across the set so it reads as one piece, not a pile of looks.${arc ? ` The arc: ${arc}.` : ""}${sections ? ` Sections: ${sections}.` : ""}`,
          "",
          "1. Define a base palette and a small set of accent palettes for the arc's beats. Use harmony rules (complementary/triad/analogous) — generate them with create_palette (it makes a Ramp TOP + swatch CHOP you can reuse). Keep a through-line: shift hue/temperature/saturation between sections, don't swap to unrelated palettes.",
          "2. Map the arc to grades: per section decide lift/gamma/gain + saturation + temperature, and build/adjust them with create_color_grade on the master (or per-layer) output. Cold = lower temp + desaturate; peak = lift + high contrast + near-white; calm = warm + soft.",
          "3. Make the transitions between color states deliberate: tie each grade change to a cue (manage_cue store/morph) so the color crossfades on the musical boundary, not abruptly — pair with create_transition if you're also switching looks.",
          "4. Sanity-check contrast and legibility: text/foreground must stay readable against the graded background at every section (get_preview each section's look). Avoid an all-mud or all-blown-out section.",
          "5. Report the palette + per-section grade as a short table (section → palette → grade intent) so the artist can recall or tweak it, and so it can be saved (save_recipe_to_vault / a cue list).",
        ].join("\n"),
      ),
  );
};

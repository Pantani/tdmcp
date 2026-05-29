import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerColorStory: PromptRegistrar = (server) => {
  server.registerPrompt(
    "color_story",
    {
      title: "Color story",
      description:
        "Turn a show mood into a coherent palette/grade plan across scenes and transitions.",
      argsSchema: {
        mood: z.string().describe("Narrative mood or reference palette."),
        target: z.string().default("/project1").describe("Network/show scope to color-design."),
      },
    },
    ({ mood, target }) =>
      userPrompt(
        [
          `Create a color story for ${target}: ${mood}.`,
          "",
          "Use concrete tdmcp tools:",
          "1. Inspect current outputs/previews and note dominant colors.",
          "2. Generate or adapt a palette with create_palette.",
          "3. Apply grades with create_color_grade or update existing color nodes.",
          "4. Map palette shifts to cues/sections so the color arc changes over time.",
          "5. Verify with before/after previews and avoid crushing blacks or clipping highlights.",
        ].join("\n"),
      ),
  );
};

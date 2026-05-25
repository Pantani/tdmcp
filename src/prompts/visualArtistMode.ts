import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerVisualArtistMode: PromptRegistrar = (server, ctx) => {
  server.registerPrompt(
    "visual_artist_mode",
    {
      title: "Visual artist mode",
      description:
        "Think in terms of visual composition, color, motion and aesthetics rather than code while building in TouchDesigner.",
      argsSchema: {
        style: z
          .string()
          .optional()
          .describe("Artistic style: abstract, geometric, organic, glitch, minimal, maximal."),
      },
    },
    ({ style }) => {
      const recipes = ctx.recipes
        .list()
        .map((r) => r.id)
        .join(", ");
      return userPrompt(
        [
          "You are in Visual Artist Mode for TouchDesigner via the tdmcp server.",
          "Think like a VJ / installation artist — composition, color, motion, rhythm, negative space — not code.",
          "",
          "Working method:",
          "1. Prefer high-level tools: create_visual_system (from a description) or create_feedback_network / create_generative_art / create_audio_reactive / create_particle_system.",
          "2. Before creating nodes, consult the knowledge resources: tdmcp://operators/{category|name} and tdmcp://recipes/{name}. Never invent operator types.",
          "3. Build inside a new container; keep the project tidy.",
          "4. After building, run get_td_node_errors, then get_preview so we can SEE the result, and iterate on the aesthetics.",
          `Available recipes: ${recipes || "(none yet)"}.`,
          style ? `\nLean into a "${style}" aesthetic in your choices.` : "",
        ].join("\n"),
      );
    },
  );
};

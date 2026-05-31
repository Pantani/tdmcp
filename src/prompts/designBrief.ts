import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerDesignBrief: PromptRegistrar = (server) => {
  server.registerPrompt(
    "design_brief",
    {
      title: "Set a standing design brief for this session",
      description:
        "Establish a persistent aesthetic direction the assistant honors across every build and tweak for the rest of the session, until the artist changes it.",
      argsSchema: {
        direction: z
          .string()
          .describe(
            "The aesthetic direction to honor across this session, e.g. 'moody cyberpunk, deep blues + magenta, slow breathing motion, high contrast'.",
          ),
      },
    },
    ({ direction }) =>
      userPrompt(
        [
          `Adopt this as a STANDING design brief for the rest of this session: ${direction}.`,
          "",
          "First, restate the direction as concrete, reusable parameters so you can apply it consistently:",
          "1. Palette — list the key colors as hex with a role for each (background, primary, accent, highlight).",
          "2. Motion — name the tempo and feel (e.g. slow breathing, sharp staccato) and rough amounts (feedback/trail length, animation speed).",
          "3. Contrast & brightness — state the bias (e.g. high contrast, dark/crushed blacks, blown highlights vs. soft and even).",
          "4. Texture & grain — note any grain, bloom, scanlines, or surface quality the look calls for.",
          "5. Reference touchstones — a few artists, films, scenes, or genres that anchor the vibe.",
          "",
          "Then confirm, in one line, that you will apply this brief to EVERY subsequent build and tweak this session unless the artist gives a new direction.",
          "",
          "Use the brief to bias your tool choices and parameters going forward, for example:",
          "- Push the palette and contrast/brightness bias into color-grade and look tools (e.g. `create_color_grade`, `apply_post_processing`).",
          "- Match the motion feel with feedback/trail and animation amounts (e.g. `create_feedback_network`, `animate_parameter`).",
          "- Keep backgrounds as dark or as bright as the brief implies, and lean toward operators and effects that reinforce the texture and grain.",
          "",
          "Do not build a specific network now — just establish and restate the direction, then wait for the next request and honor this brief when it arrives.",
        ].join("\n"),
      ),
  );
};

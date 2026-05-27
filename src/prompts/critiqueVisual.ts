import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerCritiqueVisual: PromptRegistrar = (server) => {
  server.registerPrompt(
    "critique_visual",
    {
      title: "Critique visual",
      description:
        "Evaluate a visual system and suggest concrete aesthetic and performance improvements.",
      argsSchema: {
        target_path: z.string().describe("Path of the visual system to critique."),
      },
    },
    ({ target_path }) =>
      userPrompt(
        [
          `Critique the visual system at ${target_path} and propose concrete improvements.`,
          "",
          `1. Look at it: get_preview of its output, get_td_topology under "${target_path}", and get_td_performance to see cook cost.`,
          "2. Judge it on:",
          "   - Composition & contrast: is there a focal point, or is it flat/muddy? Is the value range used?",
          "   - Color: is the palette intentional and harmonious, or accidental?",
          "   - Motion & life: does it evolve, or sit static? Is the movement musical/organic?",
          "   - Performance: any node with a high cook time? Resolution or feedback that's heavier than it needs to be?",
          "3. Give 3–5 specific, ranked suggestions — each naming the parameter or tool to change (e.g. 'add apply_post_processing bloom', 'raise contrast on level1', 'drop render res to 1280×720', 'bind feedback gain to the beat'). Avoid vague advice.",
          "4. Offer to apply the top suggestion, and only change things if the user agrees.",
        ].join("\n"),
      ),
  );
};

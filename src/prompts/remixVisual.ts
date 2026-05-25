import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerRemixVisual: PromptRegistrar = (server) => {
  server.registerPrompt(
    "remix_visual",
    {
      title: "Remix visual",
      description:
        "Take an existing visual system and create variations — change colors, swap techniques, add effects, alter timing.",
      argsSchema: {
        source_path: z.string().describe("Path of the visual system to remix."),
        remix_direction: z
          .string()
          .describe("What to change, e.g. 'make it darker', 'add glitch', 'slow it down'."),
      },
    },
    ({ source_path, remix_direction }) =>
      userPrompt(
        [
          `Remix the visual system at ${source_path}. Direction: "${remix_direction}".`,
          `1. Inspect it first: get_td_nodes and get_td_node_parameters under "${source_path}" to understand the current setup.`,
          "2. Plan changes that match the direction (palette via level/hsv_adjust, motion via transform/feedback gain, texture via added effects).",
          "3. Prefer non-destructive edits: update parameters, or use apply_post_processing to add effects after the output. Do not delete the original unless asked.",
          "4. After editing, run get_td_node_errors and get_preview to show the remixed result, and describe what changed.",
        ].join("\n"),
      ),
  );
};

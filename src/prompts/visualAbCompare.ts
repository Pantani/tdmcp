import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerVisualAbCompare: PromptRegistrar = (server) => {
  server.registerPrompt(
    "visual_ab_compare",
    {
      title: "Visual A/B compare",
      description:
        "Capture two looks/cues (or before/after a tweak) with get_preview and judge which better matches a stated goal (palette, energy, focal point) — the comparative VJ decision critique_visual doesn't do.",
      argsSchema: {
        a: z
          .string()
          .optional()
          .describe("First option: a cue name to recall, or a node path to preview."),
        b: z
          .string()
          .optional()
          .describe("Second option: a cue name to recall, or a node path to preview."),
        goal: z
          .string()
          .optional()
          .describe(
            "What you're optimizing for, e.g. 'higher energy for the drop' or 'cleaner focal point'.",
          ),
      },
    },
    ({ a, b, goal }) =>
      userPrompt(
        [
          `Compare two visual options${a && b ? ` — A (${a}) vs B (${b})` : ""} and recommend the keeper${goal ? ` for this goal: ${goal}` : ""}.`,
          "",
          "1. Capture both, fairly. If A and B are cues, recall A (manage_cue recall), get_preview the output, THEN recall B and get_preview — you need each state captured while it is live (sequence the recalls; don't preview both before switching). If they're two node paths, preview each directly. Note: confirm the timeline is playing so motion-dependent looks aren't captured frozen.",
          "2. Judge against the goal on concrete axes: palette/color, overall energy/density, focal point and readability, motion feel, and fit to the stated goal. Be specific about what each image actually shows — reference the previews, don't speak generically.",
          "3. Pick a winner and say WHY in one or two lines, plus the single biggest weakness of the loser. If it's close or context-dependent (e.g. 'A for the build, B for the drop'), say that.",
          "4. Offer one quick improvement to the winner (a param tweak) if there's an obvious one — but keep the recommendation decisive.",
          "5. If a cue was recalled to capture it, leave the project where the user wants it (ask or restore the original state).",
        ].join("\n"),
      ),
  );
};

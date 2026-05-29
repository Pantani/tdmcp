import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerMatchReferenceLoop: PromptRegistrar = (server) => {
  server.registerPrompt(
    "match_reference_loop",
    {
      title: "Match reference (scored loop)",
      description:
        "Converge a build toward a reference image as an explicit scored loop (build → preview → self-score on named axes → adjust → re-preview) — the disciplined version of image_to_visual / style_reference's loose one-pass 'compare and adjust'.",
      argsSchema: {
        reference: z
          .string()
          .optional()
          .describe(
            "The reference image (path/attachment) or a precise text description of the target look.",
          ),
        target_path: z
          .string()
          .optional()
          .describe("An existing network to converge (omit to build one first)."),
      },
    },
    ({ reference, target_path }) =>
      userPrompt(
        [
          `Recreate the reference look and CONVERGE to it with a scored loop, not a single guess.${reference ? ` Reference: ${reference}.` : " (Ask for the reference image or description.)"}${target_path ? ` Work on ${target_path}.` : ""}`,
          "",
          "1. Decompose the reference into named axes you can score 0–10: palette/color, dominant forms/shapes, texture/grain, composition/focal point, and motion (if implied). Write the target for each axis.",
          "2. Build a first attempt (or take the existing target): pick the closest generator(s) and rough params — lean on image_to_visual / style_reference for the initial mapping.",
          "3. SCORE loop (like auto_fix's detect→fix→re-check): get_preview the current output, score each axis against the reference, name the single biggest gap, make the smallest targeted change that closes it (one axis at a time — change palette via create_palette/create_color_grade, forms via the generator's params, texture via post-fx), then re-preview and re-score.",
          "4. Stop when every axis is 'close enough' (e.g. ≥7/10) or two iterations produce no improvement — don't chase diminishing returns or oscillate. Cap at ~4–5 iterations.",
          "5. Report the final per-axis scores, what you changed each iteration, and any axis you couldn't match (and why — e.g. a photographic texture that's out of reach for a generator). Offer to save the result (save_recipe_to_vault).",
        ].join("\n"),
      ),
  );
};

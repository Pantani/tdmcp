import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerStyleReference: PromptRegistrar = (server) => {
  server.registerPrompt(
    "style_reference",
    {
      title: "Style reference",
      description:
        "Recreate a reference look or aesthetic — from a style description alone or an image the user shared — as a real TouchDesigner network.",
      argsSchema: {
        reference: z
          .string()
          .describe(
            "The look to capture: a style description (e.g. 'Drum & bass warehouse rave — strobes, RGB glitch, dark') or 'the image I shared'.",
          ),
        target: z
          .string()
          .optional()
          .describe("Where to build (defaults to /project1), or a system path to restyle."),
      },
    },
    ({ reference, target }) =>
      userPrompt(
        [
          `Capture this reference look as a TouchDesigner network${target ? ` at ${target}` : ""}: ${reference}.`,
          "",
          "Aim for the aesthetic, not a single frame. This works from a text description alone — if no image is attached, reason from the words.",
          "1. Analyze the reference. Name its palette (2–3 dominant colors plus any accent), its motion (fast/slow, steady/staccato, smooth/jittery), its texture (clean/grainy/glitchy/glowing) and its overall energy (calm ambient → aggressive high-energy).",
          "2. Map those qualities to concrete tool calls with concrete params:",
          "   - base generator → create_generative_art (pick a style and pass the dominant colors and a speed that matches the energy); reach for a feedback or particle generator instead if the look clearly implies it.",
          "   - palette → create_palette to lock the dominant colors so the rest of the build can reuse them.",
          "   - texture & energy → create_glitch (RGB split / block glitch for a glitchy look), create_strobe (rate tied to the energy or tempo), create_color_grade (contrast, saturation and temperature to match the mood).",
          "   - use search_operators if you're unsure which operator gives an effect — don't invent operator types.",
          "3. Build in order: generator first, then palette and create_color_grade, then create_glitch / create_strobe layered on top. Give real starting values (a specific glitch amount, strobe rate, grade contrast), not vague directions.",
          "4. Verify and critique: get_preview, then compare the result to the reference's palette, motion, texture and energy. Refine (adjust the palette, glitch amount, strobe rate, grade contrast) and re-preview until it reads like the style. Tell the user what matched and what's approximate.",
        ].join("\n"),
      ),
  );
};

import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerImageToVisual: PromptRegistrar = (server) => {
  server.registerPrompt(
    "image_to_visual",
    {
      title: "Image to visual",
      description:
        "Recreate the look of a reference image (one the user shared) as a real TouchDesigner network.",
      argsSchema: {
        reference: z
          .string()
          .describe("The reference: 'the image I shared', or a description of the look to match."),
        parent_path: z.string().optional().describe("Where to build (defaults to /project1)."),
      },
    },
    ({ reference, parent_path }) =>
      userPrompt(
        [
          `Recreate this reference as a TouchDesigner network${parent_path ? ` under ${parent_path}` : ""}: ${reference}.`,
          "",
          "Work from the image, don't guess:",
          "1. Read the reference. Name its palette (2–3 dominant colors), the kind of forms (organic/geometric/particle/3D/typographic), the texture (sharp/soft/grainy/glowing), the composition (centered/scattered/layered) and any implied motion.",
          "2. Pick the closest generator: feedback/organic → create_feedback_network or create_simulation; fields/patterns → create_generative_art; points/sparkle → create_particle_system; depth/objects → create_3d_scene; bars/plots → create_data_visualization. Use search_operators if unsure which operator gives an effect.",
          "3. Build it, passing the reference's colors where the tool takes them, then apply_post_processing for bloom/grade to match the texture.",
          "4. get_preview and compare to the reference. Adjust parameters (palette via level/hsv_adjust, density, blur, contrast) and re-preview until it reads like the reference. Tell the user what matched and what's approximate.",
        ].join("\n"),
      ),
  );
};

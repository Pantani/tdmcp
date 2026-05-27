import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerTweakVisual: PromptRegistrar = (server) => {
  server.registerPrompt(
    "tweak_visual",
    {
      title: "Tweak visual",
      description:
        "Adjust an existing visual in plain language ('darker', 'faster', 'more chaotic') by changing the right parameters.",
      argsSchema: {
        target_path: z.string().describe("Path of the visual system to adjust."),
        direction: z
          .string()
          .describe("Plain-language change, e.g. 'darker and slower', 'more chaotic', 'punchier'."),
      },
    },
    ({ target_path, direction }) =>
      userPrompt(
        [
          `Adjust the visual at ${target_path}. Direction: "${direction}".`,
          "",
          `1. Inspect first: get_td_nodes and get_td_node_parameters under "${target_path}" to see what's actually adjustable (and which controls were exposed).`,
          "2. Map the words to parameters:",
          "   - darker/brighter → a level/HSV brightness or feedback decay; faster/slower → LFO period, feedback gain, speed, tempo period",
          "   - more chaotic/turbulent → noise amplitude, displace weight, particle turbulence; calmer → the opposite",
          "   - punchier/contrastier → contrast/gamma, bloom; softer → blur, lower contrast",
          "   - warmer/cooler/more colorful → HSV hue/saturation or the palette inputs",
          "3. Prefer the exposed custom controls when they exist; otherwise set the underlying node parameters with update_td_node_parameters. Make proportional moves, not extremes.",
          "4. get_preview to check, refine, and tell the user exactly which parameters you changed so they can dial it further.",
        ].join("\n"),
      ),
  );
};

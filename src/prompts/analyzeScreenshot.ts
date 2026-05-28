import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerAnalyzeScreenshot: PromptRegistrar = (server) => {
  server.registerPrompt(
    "analyze_screenshot",
    {
      title: "Analyze screenshot / diagnose output",
      description:
        "Look at a node's actual output and diagnose what it shows — or why it looks wrong (e.g. 'why is it black?', 'why is it frozen?') — by combining the live preview image with the network topology and node errors.",
      argsSchema: {
        node_path: z
          .string()
          .describe("The TOP (or COMP) whose output to capture and diagnose, e.g. /project1/out1."),
        concern: z
          .string()
          .optional()
          .describe(
            "Optional specific worry to focus on, e.g. 'why is it black?', 'why is it frozen?', 'the colors look washed out'.",
          ),
      },
    },
    ({ node_path, concern }) =>
      userPrompt(
        [
          `Diagnose the output of ${node_path} in TouchDesigner${concern ? ` — the artist asks: "${concern}".` : "."}`,
          "",
          "Gather the evidence first, then reason from it — don't guess from the node name alone:",
          `1. get_preview of "${node_path}" to see what it actually renders right now.`,
          `2. get_td_topology (or get_td_nodes) around "${node_path}" to map what feeds it and how it's wired.`,
          `3. get_td_node_errors for "${node_path}" (and its upstream chain) to catch cook errors/warnings — check AFTER a cook, not just creation.`,
          "",
          "Then explain what you see and, if it's wrong, the most likely cause. Common culprits to rule in/out:",
          "   - Black / empty: an unwired input, display/render flag off, 0×0 or tiny resolution, a Null with nothing cooking upstream, a feedback TOP that was never seeded, or a source pointing at a missing file.",
          "   - Frozen / not animating: the timeline is paused (time.play == 0) — motion/feedback/frame-difference chains read 0 when paused — or a Speed/rate parameter at 0.",
          "   - Wrong colors/levels: an unintended Level/Math op, a LUT, premultiply/alpha issues, or a clamped range.",
          "",
          "Give a short, plain-language diagnosis: what it shows, the single most likely cause (with the evidence that points to it), and 1–3 concrete fixes naming the node + parameter to change. Offer to apply the top fix; only change things if the artist agrees.",
        ].join("\n"),
      ),
  );
};

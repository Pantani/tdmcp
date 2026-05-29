import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerAutoVjDirector: PromptRegistrar = (server) => {
  server.registerPrompt(
    "auto_vj_director",
    {
      title: "Auto VJ director",
      description:
        "Plan and wire an auto-VJ layer: looks, cues, beat cadence, dashboard, and autopilot.",
      argsSchema: {
        style: z.string().describe("Musical/aesthetic direction for the automated set."),
        target_comp: z
          .string()
          .default("/project1")
          .describe("Where to build or control the show."),
      },
    },
    ({ style, target_comp }) =>
      userPrompt(
        [
          `Design an auto-VJ director for ${target_comp}: ${style}.`,
          "",
          "Build in this order:",
          "1. Inspect existing visuals/cues and tempo with snapshot_td_graph/get_td_nodes.",
          "2. Choose or create 2-4 compatible looks using existing generators; keep it playable, not maximal.",
          "3. Store cues with manage_cue and set musical morph/quantize values.",
          "4. Add create_autopilot for beat-driven cue cycling or control randomization.",
          "5. Add create_stage_dashboard or create_clip_launcher only when useful.",
          "6. Verify errors, preview the master output, and state how to disable or retime the director live.",
        ].join("\n"),
      ),
  );
};

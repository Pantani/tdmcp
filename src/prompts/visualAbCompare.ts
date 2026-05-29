import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerVisualAbCompare: PromptRegistrar = (server) => {
  server.registerPrompt(
    "visual_ab_compare",
    {
      title: "Visual A/B compare",
      description:
        "Compare two visuals or before/after states using snapshots, previews, errors, and performance.",
      argsSchema: {
        a: z.string().describe("First TOP/COMP/snapshot scope."),
        b: z.string().describe("Second TOP/COMP/snapshot scope."),
        goal: z
          .string()
          .optional()
          .describe("What to judge for: clarity, energy, performance, etc."),
      },
    },
    ({ a, b, goal }) =>
      userPrompt(
        [
          `Compare A (${a}) vs B (${b})${goal ? ` for ${goal}` : ""}.`,
          "",
          "Collect evidence: previews for both outputs, snapshot_td_graph compact:true for both scopes, get_td_node_errors, and performance if relevant.",
          "Use diff_snapshots/compare_td_nodes for structural or parameter differences.",
          "Conclude with a clear recommendation, tradeoffs, and one concrete tweak to try next.",
        ].join("\n"),
      ),
  );
};

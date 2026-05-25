import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerOptimizePerformance: PromptRegistrar = (server) => {
  server.registerPrompt(
    "optimize_performance",
    {
      title: "Optimize performance",
      description:
        "Analyze a TD network for performance: identify bottlenecks, suggest resolution changes, and recommend cooking optimizations.",
      argsSchema: { root_path: z.string().describe("Root path to optimize, e.g. /project1.") },
    },
    ({ root_path }) =>
      userPrompt(
        [
          `Optimize the TouchDesigner network under ${root_path} for real-time performance.`,
          `1. Inspect cook times: read tdmcp://operators for any heavy operators and use get_td_node_parameters under "${root_path}".`,
          "2. Identify the most expensive nodes and explain why (resolution too high, cooking every frame, large blurs/feedback, CPU SOPs).",
          "3. Recommend concrete fixes: lower TOP resolution, use Null/Select for caching, reduce blur sizes, move CPU work to GPU, limit cook rate, bypass unused branches.",
          "4. Apply the safe changes with update_td_node_parameters and report the expected FPS impact. Do not delete nodes unless asked.",
        ].join("\n"),
      ),
  );
};

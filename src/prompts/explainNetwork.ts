import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerExplainNetwork: PromptRegistrar = (server) => {
  server.registerPrompt(
    "explain_network",
    {
      title: "Explain network",
      description:
        "Generate a human-readable explanation of what a TD network does: data flow, key parameters, and artistic intent.",
      argsSchema: { root_path: z.string().describe("Root path to explain, e.g. /project1.") },
    },
    ({ root_path }) =>
      userPrompt(
        [
          `Explain the TouchDesigner network under ${root_path} for someone learning TouchDesigner.`,
          `1. Call get_td_nodes for "${root_path}" and follow the connections to understand the data flow.`,
          "2. Describe the signal path from input to output in plain language (what each stage does and why).",
          "3. Call out the key parameters an artist would tweak and what visual effect they have.",
          "4. Summarize the artistic intent — what the piece looks like and the technique it uses.",
          "Keep it concise and friendly; avoid dumping raw parameter lists.",
        ].join("\n"),
      ),
  );
};

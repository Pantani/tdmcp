import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerExplainParam: PromptRegistrar = (server) => {
  server.registerPrompt(
    "explain_param",
    {
      title: "Explain parameter",
      description:
        "Explain what one TouchDesigner parameter does using current value, mode, operator docs, and visual context.",
      argsSchema: {
        target: z.string().describe("Parameter written as /node/path.paramName."),
        question: z.string().optional().describe("Optional user question about the parameter."),
      },
    },
    ({ target, question }) =>
      userPrompt(
        [
          `Explain ${target}${question ? ` — ${question}` : ""}.`,
          "",
          "Do not answer from memory alone. Inspect the node with get_td_node_parameters and read_parameter_modes, consult the operator knowledge resource/search_operators for docs, then explain:",
          "1. current value and whether it is constant/expression/bound/exported;",
          "2. what changing it likely does visually or structurally;",
          "3. useful ranges or menu choices;",
          "4. one safe experiment the artist can try.",
        ].join("\n"),
      ),
  );
};

import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerExplainParam: PromptRegistrar = (server) => {
  server.registerPrompt(
    "explain_param",
    {
      title: "Explain parameter",
      description:
        "Plain-language 'what does this knob do, and what happens if I change it?' for any operator parameter — grounded in the 629-operator knowledge base plus the parameter's live value/range, not guessed.",
      argsSchema: {
        node_path: z
          .string()
          .optional()
          .describe("The operator whose parameter to explain (e.g. /project1/feedback1)."),
        param: z
          .string()
          .optional()
          .describe(
            "The parameter name/label to explain (e.g. 'opacity'). Omit to explain the most important knobs on the node.",
          ),
      },
    },
    ({ node_path, param }) =>
      userPrompt(
        [
          `Explain ${param ? `the "${param}" parameter` : "the key parameters"}${node_path ? ` on ${node_path}` : " on a node"} in plain language for an artist — grounded in facts, not guesses.`,
          "",
          "1. Identify the operator's type and ground the answer in the knowledge base: use search_operators / get_module_help (and the tdmcp://operators resource) to get the operator's real documentation. Do NOT invent behavior — if the KB doesn't cover a param, say so.",
          `2. Read the live context: get_td_node_parameters${node_path ? ` on ${node_path}` : ""} for the current value, and read_parameter_modes to see whether it's a constant, an expression, or a bind (that changes what 'change it' means).`,
          "3. Explain in this shape: (a) what it does in one sentence an artist understands; (b) the practical range — what low vs high looks like on screen; (c) what it interacts with (other params/inputs); (d) a concrete 'try this' (a value to set for a named effect).",
          "4. If useful, demonstrate: set the param (update_td_node_parameters / set_parameter_expression) to a couple of values and get_preview each so the explanation is shown, not just told — then restore the original value.",
          "5. Keep it short and concrete. Prefer 'raising period makes the noise blobs bigger and slower' over a datasheet restatement.",
        ].join("\n"),
      ),
  );
};

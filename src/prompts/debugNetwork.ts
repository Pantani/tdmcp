import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerDebugNetwork: PromptRegistrar = (server) => {
  server.registerPrompt(
    "debug_network",
    {
      title: "Debug network",
      description:
        "Systematically debug a TD network: check errors, verify connections, inspect cook times, and suggest fixes.",
      argsSchema: { root_path: z.string().describe("Root path to debug from, e.g. /project1.") },
    },
    ({ root_path }) =>
      userPrompt(
        [
          `Debug the TouchDesigner network under ${root_path}. Work step by step:`,
          `1. Call get_td_node_errors with path "${root_path}" and recursive=true. List every error/warning.`,
          `2. Call get_td_nodes for "${root_path}" to map the children, and get_td_node_parameters on any node that errored.`,
          "3. For each error, explain the likely cause (missing input, bad parameter, unsupported operator, resolution mismatch) and the concrete fix.",
          "4. Apply fixes with update_td_node_parameters or connect_nodes, then re-run get_td_node_errors to confirm.",
          "5. Finish with get_preview on the output TOP to confirm it renders.",
        ].join("\n"),
      ),
  );
};

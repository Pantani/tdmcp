import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerFixReactivity: PromptRegistrar = (server) => {
  server.registerPrompt(
    "fix_reactivity",
    {
      title: "Fix reactivity",
      description:
        "Diagnose and repair a parameter that should react to audio, beat, motion, MIDI, or another CHOP channel.",
      argsSchema: {
        target: z.string().describe("Parameter or node that should be reactive."),
        source_chop: z.string().optional().describe("Expected source CHOP, if known."),
        channel: z.string().optional().describe("Expected channel name, if known."),
      },
    },
    ({ target, source_chop, channel }) =>
      userPrompt(
        [
          `Fix the reactivity for ${target}.`,
          "",
          "Work evidence-first:",
          `1. Inspect the target with get_td_node_parameters and read_parameter_modes.`,
          source_chop
            ? `2. Inspect ${source_chop} and confirm channel ${channel ?? "(specified by the artist)"} exists or will exist after cook.`
            : "2. Find the likely source CHOP with find_td_nodes/get_td_topology; do not guess paths.",
          "3. Check get_td_node_errors on the target and the source chain.",
          "4. If the expression/bind is stale, repair it with bind_to_channel or set_parameter_expression. Preserve existing scale/offset when obvious.",
          "5. Re-check errors and capture a preview when the target affects a TOP.",
          "",
          "Report the broken link, the evidence, the exact expression/binding you restored, and any live tuning still needed.",
        ].join("\n"),
      ),
  );
};

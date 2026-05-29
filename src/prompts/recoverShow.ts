import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerRecoverShow: PromptRegistrar = (server) => {
  server.registerPrompt(
    "recover_show",
    {
      title: "Recover show",
      description:
        "Recover a live project after a bad edit using checkpoints, snapshots, error summaries, and previews.",
      argsSchema: {
        scope: z.string().default("/project1").describe("Project/container scope to recover."),
        symptom: z
          .string()
          .optional()
          .describe("What went wrong, e.g. black output or missing cues."),
      },
    },
    ({ scope, symptom }) =>
      userPrompt(
        [
          `Recover the show under ${scope}${symptom ? `; symptom: ${symptom}` : "."}`,
          "",
          "Use the least destructive path:",
          "1. Snapshot the current state with snapshot_td_graph compact:true.",
          "2. Run summarize_td_errors/get_td_node_errors and capture the current output preview.",
          "3. List available manage_checkpoint checkpoints. Do not restore yet unless the user explicitly confirms.",
          "4. Prefer targeted repairs first: stale references, bad parameters, missing files, paused timeline, or broken DAT code.",
          "5. If restore is confirmed, restore the smallest checkpoint scope, then re-run errors and preview.",
          "",
          "Return a recovery log: current evidence, proposed restore/repair, commands used, and remaining live risks.",
        ].join("\n"),
      ),
  );
};

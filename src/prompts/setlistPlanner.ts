import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerSetlistPlanner: PromptRegistrar = (server) => {
  server.registerPrompt(
    "setlist_planner",
    {
      title: "Setlist planner",
      description:
        "Plan a VJ setlist from tracks/sections before building cues or importing a vault setlist.",
      argsSchema: {
        tracks: z.string().describe("Tracks, sections, BPM notes, or set order."),
        target: z.string().default("/project1").describe("Show container to plan for."),
      },
    },
    ({ tracks, target }) =>
      userPrompt(
        [
          `Plan a setlist for ${target}.`,
          "",
          tracks,
          "",
          "Return a practical plan: sections, BPM/energy arc, likely tdmcp tools per section, cue names, transition lengths, and any assets needed.",
          "If the user wants to build it, use import_setlist/vault only for a real vault note; otherwise create cues and generators directly.",
        ].join("\n"),
      ),
  );
};

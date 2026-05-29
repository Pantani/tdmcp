import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerSetlistPlanner: PromptRegistrar = (server) => {
  server.registerPrompt(
    "setlist_planner",
    {
      title: "Setlist planner",
      description:
        "Turn a DJ tracklist / BPM + energy curve into a scene-per-track plan: which generator, palette, reactivity intensity and cue-morph time per track — then optionally drive import_setlist / manage_cue. Plans a whole night, not one track's sections.",
      argsSchema: {
        tracklist: z
          .string()
          .optional()
          .describe(
            "The set's tracks, ideally with BPM and a vibe/energy note each, e.g. '1. Opener 122bpm warm; 2. Builder 124; 3. Peak banger 128 ...'.",
          ),
        duration: z.string().optional().describe("Total set length / venue context, if known."),
      },
    },
    ({ tracklist, duration }) =>
      userPrompt(
        [
          `Plan a VJ set across the whole tracklist as an energy arc, not track by track in isolation.${tracklist ? `\n\nTracklist:\n${tracklist}` : " (Ask for the tracklist with BPM/energy if not given.)"}${duration ? `\n\nSet length: ${duration}.` : ""}`,
          "",
          "1. Read the arc of the night: where are the warm-up, the builds, the peak(s), the breakdowns, the comedown? Mark energy per track (1–5) and the BPM curve.",
          "2. For each track choose a concrete plan: a primary generator/look (name the tdmcp tool — e.g. create_feedback_tunnel, create_gpu_particle_field, create_kaleidoscope), a palette (tie it to color_story), a reactivity intensity (low for warm-up, high for peak — bind_audio_reactive intensity), and whether it's a new scene or a variation of the previous.",
          "3. Plan the seams: per track-change pick a transition style + morph time (manage_cue quantize + create_transition) — long dissolves for warm-up, hard glitch-cuts on drops. Continuity matters: don't reset the whole look every track.",
          "4. Make it runnable: express the plan as a setlist the tools can build — either drive import_setlist from a setlist note (tracks → scenes) or store one cue per track (manage_cue store) so the operator steps through with create_set_navigator / create_cue_sequencer.",
          "5. Output a compact table: track → BPM → energy → look/tool → palette → reactivity → transition-in. Keep it tight enough to glance at mid-set.",
        ].join("\n"),
      ),
  );
};

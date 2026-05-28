import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerAutoVjDirector: PromptRegistrar = (server) => {
  server.registerPrompt(
    "auto_vj_director",
    {
      title: "Auto VJ director",
      description:
        "Run a hands-free AI VJ: watch the live beat/onset event stream and fire cue recalls, transitions, and control randomization on the song's structure — an AI conductor over the create_autopilot engine, reasoning about builds/drops instead of randomizing mechanically.",
      argsSchema: {
        target_path: z
          .string()
          .optional()
          .describe("The show/visual system to drive (the COMP whose cues/controls you'll fire)."),
        structure: z
          .string()
          .optional()
          .describe(
            "Known song structure or vibe arc, e.g. 'long ambient intro, drop at ~2:00, breakdown, double drop'.",
          ),
      },
    },
    ({ target_path, structure }) =>
      userPrompt(
        [
          `Act as a live VJ director for ${target_path ? target_path : "the current show"}, reacting to the music in real time. Your job is to make musically-intelligent decisions — hold through builds, slam a change on the drop, ease back in breakdowns — not to randomize blindly (that's what create_autopilot already does mechanically).`,
          "",
          "First, prove the loop is fast enough before committing to a tight cadence:",
          "1. Confirm the building blocks exist: cues to recall (manage_cue list), a tempo/beat source (create_tempo_sync with emit_events on, or detect_onsets with its onset event), and an output you can preview. If a beat/onset event stream isn't running, set it up first — your reactions ride those events.",
          "2. LATENCY PROBE (do this before locking your cadence — it is unproven over MCP): subscribe to the event stream (the bridge broadcasts `beat`/`onset` events; `tdmcp watch --filter beat,onset` tails them) and measure how quickly you can observe an event and act on it. If the round-trip is slower than a beat, do NOT try to hit every beat — operate on bars/phrases/sections instead, or pre-arm a cue and let create_autopilot/create_cue_sequencer fire the beat-tight part. State the cadence you chose and why.",
          "",
          "Then conduct:",
          `3. Map the music to moves. ${structure ? `Use the given structure: ${structure}. ` : "Infer structure from the energy you observe (onset density, level, tempo). "}Decide a plan: which cue/look per section, when to transition (create_transition), when to intensify (raise reactivity via bind_audio_reactive / randomize_controls with a small amount), when to hold.`,
          "4. Execute on musical boundaries, not arbitrarily: recall/morph cues quantized to the beat/bar (manage_cue quantize), fire a transition on a drop, nudge controls during a build. Prefer eased morphs over hard cuts except on a deliberate drop.",
          "5. Stay safe and legible: keep create_panic within reach (if the output breaks, recover_show), and after each major move get_preview to confirm the change landed. Narrate your decisions briefly ('holding through the build → cue \"drop\" on the next bar') so the human operator can follow or override.",
          "6. This is a loop: keep watching, keep deciding, until told to stop. Don't over-trigger — restraint reads as musicality; a change every 8–16 bars usually beats a change every beat.",
        ].join("\n"),
      ),
  );
};

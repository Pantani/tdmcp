import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerBeatReactiveDesigner: PromptRegistrar = (server) => {
  server.registerPrompt(
    "beat_reactive_designer",
    {
      title: "Beat-reactive designer",
      description:
        "Make a visual react to music — wire audio features and the beat into a visual system's parameters.",
      argsSchema: {
        target_path: z
          .string()
          .describe("Path of the visual system to make reactive (or describe one to create)."),
        feel: z
          .string()
          .describe(
            "How it should move, e.g. 'kick pumps the zoom, hats sparkle the particles, color flips on the downbeat'.",
          ),
        audio_source: z
          .string()
          .optional()
          .describe("Audio source: device (live mic/line), file, or oscillator (for testing)."),
      },
    },
    ({ target_path, feel, audio_source }) =>
      userPrompt(
        [
          `Make the visual system at ${target_path} react to music. Desired feel: "${feel}".`,
          "",
          "Build the reactive signal chain, then wire it in:",
          `1. Reactive sources. Run extract_audio_features (source: ${audio_source || "device — use oscillator if you're just testing so no mic permission is needed"}) for level/bass/mid/treble, and create_tempo_sync for the beat (ramp/pulse/beat channels + live 'beat' events). Note the features Null path and the tempo Null path from their results.`,
          `2. Inspect the target: get_td_nodes and get_td_node_parameters under "${target_path}" to find the parameters worth driving (scale, zoom, brightness, feedback gain, displacement, hue, particle birth, …).`,
          "3. Wire it with bind_to_channel — this is the actual link. Map low energy to weight and motion, highs to detail/sparkle, and the beat to punctuation. For example:",
          "   - bass → a transform scale or feedback zoom (scale ~0.5–2, offset 1 so it pulses around the base value)",
          "   - treble → a brightness, edge or particle-birth parameter",
          "   - tempo 'ramp' → a continuous sweep (hue rotation, rotation angle)",
          "   - tempo 'pulse' → a momentary hit (flash, scale kick); combine scale/offset so the rest value is sane",
          "   Choose scale/offset so the parameter stays in a sensible range — check each channel's typical magnitude first (audio RMS is often ~0.0–0.3).",
          "4. Verify: get_td_node_errors on the system, get_preview to see it, and run `tdmcp-agent watch` (or note that beat events broadcast) to confirm the beat is firing. Tell the user which parameter reacts to what, and offer to tune the scale/offset mappings.",
        ].join("\n"),
      ),
  );
};

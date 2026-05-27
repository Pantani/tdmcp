import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerAudioToShow: PromptRegistrar = (server) => {
  server.registerPrompt(
    "audio_to_show",
    {
      title: "Audio to show",
      description:
        "Turn a track, genre or mood into a full reactive VJ show — visuals, audio/beat reactivity and section cues.",
      argsSchema: {
        track: z
          .string()
          .describe(
            "The track, genre or mood to build around, e.g. 'driving 128bpm techno', 'lush ambient', 'this DnB tune'.",
          ),
        sections: z
          .string()
          .optional()
          .describe(
            "The arrangement to cover, e.g. 'intro, build, drop, breakdown, outro' (default: intro/build/drop/outro).",
          ),
        audio_source: z
          .string()
          .optional()
          .describe("device (live mic/line), file, or oscillator (for testing without a mic)."),
      },
    },
    ({ track, sections, audio_source }) =>
      userPrompt(
        [
          `Build a complete reactive VJ show for: "${track}".`,
          `Sections to cover: ${sections || "intro, build, drop, outro"}.`,
          "",
          "Plan and assemble the whole show, verifying each step in TD:",
          "1. Visuals: pick looks that fit the energy and genre (e.g. a slow feedback tunnel for the intro, a dense particle field / strobing geometry for the drop). Build each with the matching generator and a palette that suits the mood; keep each look in its own container.",
          `2. Audio analysis: extract_audio_features (source: ${audio_source || "device — oscillator if you're only testing"}) for level/bass/mid/treble, create_tempo_sync for beat ramp/pulse + live beat events, and where useful detect_onsets (hits/transients) and create_spectrum (frequency bands). Note each feature's Null/output path.`,
          "3. Reactivity: bind_to_channel to wire the analysis into the visuals — bass into weight/zoom/scale, treble into detail/sparkle/brightness, the tempo ramp into continuous sweeps (hue, rotation) and the pulse/onsets into punctuation (flashes, scale kicks). Choose scale/offset so each parameter stays in a sane range (audio RMS is often ~0.0–0.3).",
          "4. Cues per section: dial in a look for each section and store it with manage_cue, with morph times that match the music (long glides for builds, snappy cuts on the drop). Sequence them so you can step through the arrangement.",
          "5. Verify and hand off: get_td_node_errors and get_preview as you build, confirm the beat is firing, then give the user a short 'how to run this show' summary — which cue is which section and what reacts to what.",
        ].join("\n"),
      ),
  );
};

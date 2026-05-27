import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerVjSetBuilder: PromptRegistrar = (server) => {
  server.registerPrompt(
    "vj_set_builder",
    {
      title: "VJ set builder",
      description:
        "Assemble a complete reactive audiovisual set — scenes, audio/beat reactivity, cues and a control surface.",
      argsSchema: {
        vibe: z
          .string()
          .describe(
            "The set's mood/genre, e.g. 'dark techno', 'dreamy ambient', 'glitchy footwork'.",
          ),
        scenes: z.string().optional().describe("How many distinct looks to prepare (default 3)."),
        audio_source: z
          .string()
          .optional()
          .describe("device (live), file, or oscillator (testing)."),
      },
    },
    ({ vibe, scenes, audio_source }) =>
      userPrompt(
        [
          `Build a VJ set for: "${vibe}" (${scenes || "3"} scenes).`,
          "",
          "Assemble the whole reactive chain, checking each step in TD:",
          `1. Scenes: create ${scenes || "3"} distinct looks that fit the vibe (e.g. a feedback tunnel, a particle field, a 3D/simulation piece). Build each with the matching generator and a fitting palette; keep them in their own containers.`,
          `2. Reactivity: extract_audio_features (source: ${audio_source || "device — oscillator if only testing"}) and create_tempo_sync. Then bind_to_channel to wire bass/level into each scene's weight/zoom and the beat ramp/pulse into motion or flashes.`,
          "3. Mixing: create_layer_mixer to blend/crossfade between scenes, and apply_post_processing on the mix for a cohesive grade.",
          "4. Cues: dial in a look per scene and store it with manage_cue; set tasteful morph times so you can glide between them.",
          "5. Surface: create_control_surface with a Crossfade fader and a cue button per scene (and optionally create_phone_remote). Expose a macro or two for live energy.",
          "6. Verify as you go (get_td_node_errors, get_preview) and finish with a short 'how to play this set' summary: which knob/button does what.",
        ].join("\n"),
      ),
  );
};

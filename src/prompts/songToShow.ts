import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

/**
 * Deliberately distinct from `audio_to_show` (which assumes the audio already
 * exists): `song_to_show` GENERATES the song first, with ACE-Step, then builds the
 * reactive show around it.
 */
export const registerSongToShow: PromptRegistrar = (server) => {
  server.registerPrompt(
    "song_to_show",
    {
      title: "Song to show",
      description:
        "Generate a song with ACE-Step and build a full reactive VJ show around it — unlike " +
        "audio_to_show, the audio does not exist yet; this prompt creates it first.",
      argsSchema: {
        song: z
          .string()
          .describe(
            "The song to generate and build a show around: tags/genre/mood, e.g. 'driving 128bpm techno, dark, analog'.",
          ),
        lyrics: z
          .string()
          .optional()
          .describe("Optional lyrics with [verse]/[chorus] markers. Omit for an instrumental."),
        duration: z
          .string()
          .optional()
          .describe("Target length in seconds (default: let the model choose)."),
        visual_style: z
          .string()
          .optional()
          .describe("Visual look to build, e.g. particles, feedback, geometry."),
        sections: z
          .string()
          .optional()
          .describe("The arrangement to cue (default: intro, build, drop, outro)."),
      },
    },
    ({ song, lyrics, duration, visual_style, sections }) =>
      userPrompt(
        [
          `Generate a song and build a complete reactive VJ show around it: "${song}".`,
          lyrics ? `Lyrics to sing:\n${lyrics}` : "Instrumental — no lyrics.",
          `Target duration: ${duration || "let the model choose (audio_duration -1)"}.`,
          `Visual style: ${visual_style || "pick one that fits the genre and energy"}.`,
          `Sections to cue: ${sections || "intro, build, drop, outro"}.`,
          "",
          "Work through this, verifying each step in TouchDesigner:",
          "1. Check ACE is available: music generation needs TDMCP_ACE_ENABLED=1 and the ace/ wrapper running. If generate_music comes back with the 'ACE-Step music generation is disabled' error, stop and tell the user exactly how to enable it — do not fake the audio.",
          "2. Generate the bed. For a short instrumental stinger, call generate_music_reactive once (it generates the bed AND builds the reactive network in one shot). For a longer song, call submit_music_job, then poll get_music_job until status is 'done' (cancel_music_job aborts it and frees the GPU), and build the visual from the returned wavPath with create_audio_reactive (audio_source: 'file', audio_file_path: <wavPath>). Generation takes minutes — say so before you start.",
          "3. Bind reactivity with bind_to_channel: bass into scale/weight/zoom, treble into detail/sparkle, the tempo ramp into continuous sweeps (hue, rotation), beats into punctuation. Pick scale/offset so each parameter stays in a sane range (audio RMS is often ~0.0-0.3).",
          "4. Store one cue per section with manage_cue, with morph times that match the music (long glides for builds, snappy cuts on the drop).",
          "5. Verify and hand off: get_td_node_errors and get_preview, then give the user a short 'how to run this show' summary — the generated WAV path, which cue is which section, and what reacts to what.",
        ].join("\n"),
      ),
  );
};

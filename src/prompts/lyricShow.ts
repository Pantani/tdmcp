import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerLyricShow: PromptRegistrar = (server) => {
  server.registerPrompt(
    "lyric_show",
    {
      title: "Lyric show",
      description:
        "Plan kinetic lyric typography synced to beat/onsets and composited over a visual.",
      argsSchema: {
        lyrics: z.string().describe("Lyric lines or text fragments to stage."),
        source_path: z.string().optional().describe("Optional TOP to composite lyrics over."),
      },
    },
    ({ lyrics, source_path }) =>
      userPrompt(
        [
          "Build a lyric-driven visual pass.",
          "",
          `Lyrics:\n${lyrics}`,
          "",
          "Use create_kinetic_text for the text system, create_tempo_sync/detect_onsets for timing, and create_text_overlay or Composite TOPs when layering over a source.",
          source_path
            ? `Composite over ${source_path}.`
            : "If no source is supplied, build a standalone transparent lyric layer.",
          "Verify readability at output resolution, check node errors, and capture a preview.",
        ].join("\n"),
      ),
  );
};

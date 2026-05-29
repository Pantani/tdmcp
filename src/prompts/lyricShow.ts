import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerLyricShow: PromptRegistrar = (server) => {
  server.registerPrompt(
    "lyric_show",
    {
      title: "Lyric show",
      description:
        "Turn a block of lyrics/credits + a vibe into a timed kinetic-text layer — choosing create_kinetic_text mode (flash/pulse/slide), font/color from the palette, and beat-syncing the flashes.",
      argsSchema: {
        lyrics: z
          .string()
          .optional()
          .describe(
            "The lyrics, title cards, or credits to display (one line/phrase per beat-drop).",
          ),
        vibe: z
          .string()
          .optional()
          .describe(
            "The aesthetic, e.g. 'aggressive techno, hard flashes' or 'dreamy, slow slide-ins'.",
          ),
        over: z
          .string()
          .optional()
          .describe("The visual/COMP the text should sit over (so it composites, not replaces)."),
      },
    },
    ({ lyrics, vibe, over }) =>
      userPrompt(
        [
          `Build a typographic layer that tells the words${vibe ? ` with this vibe: ${vibe}` : ""}.${lyrics ? `\n\nText:\n${lyrics}` : " (Ask for the lyrics/credits if not given.)"}${over ? `\n\nComposite it over: ${over}.` : ""}`,
          "",
          "1. Choose the delivery to match the vibe: create_kinetic_text mode — flash (punchy, beat-locked), pulse (breathing), or slide (smooth reveals). Aggressive genres → flash on the beat; ambient → slow slide/fade. Pick font weight, size, and a color drawn from the set's palette (tie to color_story if one exists).",
          "2. For text that should sit ON the visuals, composite it (create_text_overlay over the source, or kinetic-text's own background-transparent path) — don't replace the look. For a full title card, standalone is fine.",
          "3. Time it to the music: drive the flash/reveal from the beat (create_tempo_sync's pulse/beat channel via bind_to_channel, or quantize cue changes to the bar). One phrase per drop usually reads better than a stream of words.",
          "4. Keep it legible: enough contrast against the background, not too many words on screen at once, and safe margins. get_preview to confirm it's readable over the actual visual, not just on black.",
          "5. Report the sequence (phrase → timing → mode) and how to advance it live (cue list / set-navigator) so the operator can fire lines on cue.",
        ].join("\n"),
      ),
  );
};

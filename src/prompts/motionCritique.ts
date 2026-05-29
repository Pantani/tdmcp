import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerMotionCritique: PromptRegistrar = (server) => {
  server.registerPrompt(
    "motion_critique",
    {
      title: "Motion critique",
      description:
        "Critique temporal feel, rhythm, camera/motion reactivity, pacing, and loop smoothness.",
      argsSchema: {
        target: z.string().describe("TOP/COMP to critique."),
        music_context: z.string().optional().describe("Tempo/genre/section context."),
      },
    },
    ({ target, music_context }) =>
      userPrompt(
        [
          `Critique the motion of ${target}${music_context ? ` in context: ${music_context}` : ""}.`,
          "",
          "Inspect topology, preview, errors, and any tempo/audio/motion sources. Look for dead motion, overly linear easing, jitter, bad loop points, phase mismatch, and performance-heavy feedback.",
          "Suggest 1-3 concrete parameter/tool changes (animate_parameter, bind_to_channel, create_tempo_sync, create_motion_reactive, manage_cue quantize) and verify after applying only if the user asks.",
        ].join("\n"),
      ),
  );
};

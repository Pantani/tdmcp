import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerFixReactivity: PromptRegistrar = (server) => {
  server.registerPrompt(
    "fix_reactivity",
    {
      title: "Fix reactivity",
      description:
        "Diagnose 'my visual stopped reacting to the music/camera' — the wired-but-dead signal class (paused timeline, silent source, RMS-0, a scale/offset that flattens the signal) that auto_fix and fix_shader don't cover.",
      argsSchema: {
        target_path: z
          .string()
          .optional()
          .describe(
            "The visual/COMP that should be reacting but isn't (default: ask or inspect the project).",
          ),
        source_chop: z
          .string()
          .optional()
          .describe(
            "The feature CHOP that should carry the driving signal (e.g. an extract_audio_features / create_motion_reactive Null).",
          ),
      },
    },
    ({ target_path, source_chop }) =>
      userPrompt(
        [
          `A visual${target_path ? ` (${target_path})` : ""} is wired to react but nothing is moving. Find the dead link — this is almost never a cook error, so get_td_node_errors will likely be clean. Work down the signal path from source to parameter:`,
          "",
          "1. Is time running? Read the project timeline — `op('/').time.play`. A PAUSED timeline is the #1 cause: every time-dependent chain (audio analysis, motion frame-diff, feedback, LFOs) reads 0 or a frozen value when paused. If it's paused, that's very likely the whole bug — start it (or tell the user to press Play) and re-check before touching anything else.",
          `2. Does the source actually carry energy? Read the feature CHOP${source_chop ? ` (${source_chop})` : " (the extract_audio_features / create_spectrum / create_motion_reactive Null)"} with get_td_nodes (include channel values). If level/bass/mid/treble (or motion) sit at ~0:`,
          "   - audio: the input device may be silent or unselected, or the wrong device is chosen. extract_audio_features offers a synthetic oscillator source — switch to it to prove the chain works without a live mic. Check the Sensitivity knob isn't at 0. Remember Analyze CHOP RMS needs function='rmspower' (plain 'rms' silently averages to ~0).",
          "   - camera/motion: the camera may be unselected or the permission modal unanswered; a still source produces no frame-difference. Verify the source TOP is non-black.",
          "3. Is the binding intact? For each reactive parameter, read it with read_parameter_modes — confirm its mode is EXPRESSION (not reverted to CONSTANT) and the expression still references the live channel (op('…')['…']). A common failure: the parameter was re-set to a constant by a later edit, or the source path in the expression is stale.",
          "4. Is the mapping flattening the signal? Inspect the bind scale/offset. A tiny scale, a huge offset, or an attack/release (Lag) so slow it never moves will read as 'dead'. A signal of 0.02 × scale 1 is invisible — raise the scale or use bind_audio_reactive's intensity. Confirm the parameter's own range isn't clamping the result to a single value.",
          "5. Confirm the fix live: get_preview before and after a beat (or motion), and read the bound parameter's value twice a second apart — it must change. State the root cause (which of the five it was) and the one change that fixed it, so the user recognises it next time.",
        ].join("\n"),
      ),
  );
};

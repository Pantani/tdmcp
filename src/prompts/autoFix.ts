import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerAutoFix: PromptRegistrar = (server) => {
  server.registerPrompt(
    "auto_fix",
    {
      title: "Auto fix",
      description:
        "Detect, diagnose and repair errors across a network in a re-checking loop until it cooks clean.",
      argsSchema: {
        target_path: z
          .string()
          .optional()
          .describe("Scope to a container/path to fix (default: the whole project)."),
      },
    },
    ({ target_path }) =>
      userPrompt(
        [
          `Find and fix the errors${target_path ? ` under ${target_path}` : " across the project"}, then re-check until everything cooks clean.`,
          "",
          "Work as a detect → diagnose → fix → re-check loop:",
          `1. Detect: run get_td_node_errors${target_path ? ` on ${target_path}` : ""} and summarize_td_errors to get the full list grouped by node and message. Read the actual compiler/operator text — don't guess.`,
          "2. Diagnose by cause for each error:",
          "   - GLSL/compile errors → the Text/Pixel DAT feeding the GLSL TOP (missing `out vec4 fragColor;`, `texture2D`, a preamble name collision like F1/F2, no time uniform). For these, the fix_shader prompt's checklist applies.",
          "   - Missing/short inputs → a node expects an input it isn't getting; check wiring (remember TOP→TOP across containers needs a Select/In, not a raw cross-container wire) and connect_nodes.",
          "   - Bad parameter / out-of-range / wrong menu value → set the correct parameter (note some parameters simply don't exist on a given op — e.g. a Level TOP has no `gain`; verify with get_td_node_parameters before setting).",
          "   - Missing file/DAT/CHOP reference → fix the path or recreate the missing operator.",
          "3. Apply the minimal fix — change the offending parameter, re-wire the input, or edit the DAT code. Prefer structured tools (update_td_node_parameters, connect_nodes) over ad-hoc scripts. Don't rebuild things that already work.",
          "4. Re-cook and re-check: re-run get_td_node_errors on what you touched. If new or remaining errors show, loop back to step 2. Stop when the scope is error-free (a couple of passes is normal).",
          "5. Confirm with get_preview and report what was broken, the root cause of each error, and the fix you applied — so the user can recognise the pattern next time.",
        ].join("\n"),
      ),
  );
};

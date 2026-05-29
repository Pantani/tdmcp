import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerRecoverShow: PromptRegistrar = (server) => {
  server.registerPrompt(
    "recover_show",
    {
      title: "Recover show",
      description:
        "Mid-show emergency: the output is frozen, black, or erroring and there is an audience. A fast 'get a picture back NOW' triage loop — optimized for speed over completeness, unlike the thorough auto_fix.",
      argsSchema: {
        output_path: z
          .string()
          .optional()
          .describe(
            "The master output TOP the audience sees (so panic/blackout and preview target the right node).",
          ),
      },
    },
    ({ output_path }) =>
      userPrompt(
        [
          `Live emergency: the show output${output_path ? ` (${output_path})` : ""} is broken and there is an audience. Optimize for getting SOMETHING acceptable back on screen fast — do not aim for a perfect fix. Move in this order and stop as soon as the picture is back:`,
          "",
          "1. Triage in one read: get_preview the master output and run summarize_td_errors on the project. Decide which failure you're in: (a) BLACK/frozen but no errors → a dead source or paused timeline; (b) ERRORING → a specific node is broken; (c) total chaos → too much is wrong to fix piecemeal.",
          "2. Make it safe first if it's ugly, not just dark: if the screen is showing garbage/flashing/an error overlay, trigger a clean blackout immediately (create_panic if no panic control exists yet, or set the existing panic's Blackout on) so the audience sees black instead of a crash — THEN diagnose behind the blackout. A controlled black is better than visible chaos.",
          "3. Fix only the cheapest cause that restores a picture:",
          "   - paused timeline → start it (covers the whole 'frozen' class; see fix_reactivity).",
          "   - one erroring node feeding the output → bypass it (set its Bypass on) or switch the output to a known-good source/cue rather than repairing it now. A recallable cue or a different deck/layer is the fastest route to a live picture.",
          "   - a broken live source (camera/NDI dropped) → switch to a generated fallback look.",
          "4. Restore: once a picture is up, lift the blackout. Recall the last known-good cue/preset if you have one (manage_cue / manage_presets) rather than rebuilding.",
          "5. Confirm with get_preview that the output is live and acceptable. Keep the report to two lines — what was broken and what you switched to — so the operator can keep performing. Do the thorough root-cause repair (auto_fix) AFTER the set, not during it.",
        ].join("\n"),
      ),
  );
};

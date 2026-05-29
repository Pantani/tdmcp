import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerMotionCritique: PromptRegistrar = (server) => {
  server.registerPrompt(
    "motion_critique",
    {
      title: "Motion critique",
      description:
        "Judge a look's MOTION over time, not a single frame — capture a short burst of previews (or read CHOP activity) and assess whether it's static, jittery, or musical. critique_visual looks at one still; the live thesis is movement.",
      argsSchema: {
        target_path: z.string().optional().describe("The output/visual to assess for motion."),
      },
    },
    ({ target_path }) =>
      userPrompt(
        [
          `Critique the MOTION of ${target_path ? target_path : "the visual"} — is it alive and musical, or static/jittery/mechanical? A single frame can't tell you; sample over time.`,
          "",
          "1. First rule out a false negative: check the timeline is playing (op('/').time.play). A paused timeline freezes every time-dependent chain and will look 'static' for the wrong reason — if paused, say so and start it before judging.",
          "2. Capture a short burst: get_preview the target several times spaced ~0.3–0.5s apart (4–6 frames). Confirm the frames actually DIFFER — if they're identical with the timeline running, that itself is the finding (the look isn't animating; trace why with fix_reactivity).",
          "3. Optionally read the driving signals: get_td_nodes on the reactive CHOPs to see if level/beat/motion are actually moving, which tells you whether the stillness is upstream (dead signal) or downstream (signal not mapped to anything visible).",
          "4. Judge on motion axes: liveliness (is anything moving?), variety (does it evolve or loop tightly?), smoothness vs jitter (flickering from raw unsmoothed signal? — suggest bind_to_channel attack/release), and musicality (does the motion relate to the beat or is it arbitrary?).",
          "5. Give concrete fixes: e.g. 'add slow feedback for evolution', 'smooth the bass binding (attack 0.05 / release 0.4) to stop the flicker', 'tie the zoom to the beat'. Report what you observed across the frames, not a generic single-frame critique.",
        ].join("\n"),
      ),
  );
};

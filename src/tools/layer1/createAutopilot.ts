import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createAutopilotSchema = z.object({
  comp_path: z
    .string()
    .default("/project1")
    .describe(
      "COMP the autopilot drives — its numeric custom controls (randomize mode) or its stored cues (cue mode). Usually a generated system container or a control panel.",
    ),
  mode: z
    .enum(["randomize", "cue"])
    .default("randomize")
    .describe(
      "'randomize' nudges the COMP's numeric controls toward new random values each trigger (works on any COMP with controls). 'cue' cycles through the COMP's stored cues (needs cues from manage_cue).",
    ),
  beats: z.coerce
    .number()
    .int()
    .positive()
    .default(4)
    .describe("Fire an action every N beats (4 = once per bar at 4/4)."),
  amount: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "(randomize) How far to move toward random each trigger: 1 = full scramble, low = gentle drift.",
    ),
  parent_path: z.string().default("/project1").describe("Where to create the autopilot engine."),
});
type CreateAutopilotArgs = z.infer<typeof createAutopilotSchema>;

// CHOP Execute callback (runs in TD's normal op context, so it imports td). It fires once per
// beat on the Beat CHOP's cumulative `count` channel; every Nth beat (N = the live Beats knob,
// while Active is on) it either scrambles the target COMP's numeric controls toward random by
// the Amount knob, or recalls the next stored cue. __COMP__ / __MODE__ are filled in on build.
const ENGINE = `import td, random

def onValueChange(channel, sampleIndex, val, prev):
    if channel.name != 'count':
        return
    ap = me.parent()
    act = getattr(ap.par, 'Active', None)
    if act is not None and not act.eval():
        return
    bn = getattr(ap.par, 'Beats', None)
    n = int(bn.eval()) if bn is not None else 4
    if n < 1:
        n = 1
    if int(val) % n != 0:
        return
    target = op('__COMP__')
    if target is None:
        return
    if '__MODE__' == 'cue':
        cues = target.fetch('tdmcp_cues', {})
        names = sorted(cues.keys())
        if not names:
            return
        idx = (ap.fetch('tdmcp_cue_idx', -1) + 1) % len(names)
        ap.store('tdmcp_cue_idx', idx)
        for pn, v in cues[names[idx]].items():
            par = getattr(target.par, pn, None)
            if par is not None and not par.readOnly:
                try:
                    par.val = v
                except Exception:
                    pass
    else:
        an = getattr(ap.par, 'Amount', None)
        amt = float(an.eval()) if an is not None else 0.5
        if not hasattr(target, 'customPars'):
            return
        for par in target.customPars:
            if not getattr(par, 'isNumber', False) or par.readOnly:
                continue
            lo = par.normMin
            hi = par.normMax
            if lo is None or hi is None or hi <= lo:
                continue
            try:
                old = float(par.eval())
            except Exception:
                old = lo
            r = random.uniform(lo, hi)
            new = old * (1 - amt) + r * amt
            if par.style == 'Int':
                new = int(round(new))
            try:
                par.val = new
            except Exception:
                pass
    return
`;

export async function createAutopilotImpl(ctx: ToolContext, args: CreateAutopilotArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "autopilot");

    // A Beat CHOP on the global tempo, with the cumulative `count` channel turned on; the engine
    // watches it so an action fires exactly once per beat.
    const beat = await builder.add("beatCHOP", "beat", { count: 1, beat: 1 });
    const engine = await builder.add("chopexecuteDAT", "engine", {
      chop: beat,
      channel: "count",
      valuechange: 1,
      offtoon: 0,
      active: 1,
    });
    const text = ENGINE.replaceAll("__COMP__", args.comp_path).replaceAll("__MODE__", args.mode);
    await builder.python(`op(${q(engine)}).text = ${q(text)}`);

    // Live knobs the engine reads each beat: pause without deleting, retune the cadence, dial the
    // scramble amount. (No bind_to — they just expose the custom parameters.)
    const controls: ControlSpec[] = [
      { name: "Active", type: "toggle", default: 1, bind_to: [] },
      { name: "Beats", type: "int", min: 1, max: 32, default: args.beats, bind_to: [] },
      { name: "Amount", type: "float", min: 0, max: 1, default: args.amount, bind_to: [] },
    ];

    return finalize(ctx, {
      summary: `Built an autopilot driving ${args.comp_path} in ${args.mode} mode, every ${args.beats} beat(s). Toggle Active to pause; tune Beats/Amount live. ${
        args.mode === "cue"
          ? "Store cues on the target with manage_cue first."
          : "Randomizes the target's numeric controls."
      }`,
      builder,
      outputPath: beat,
      // The output is a CHOP engine, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        target: args.comp_path,
        mode: args.mode,
        beats: args.beats,
        amount: args.amount,
        engine,
      },
    });
  });
}

export const registerCreateAutopilot: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_autopilot",
    {
      title: "Create autopilot",
      description:
        "Build a beat-driven auto-VJ: a Beat CHOP + a CHOP Execute DAT that, every N beats, either randomizes a target COMP's numeric controls (a hands-free drift, set by Amount) or cycles through its stored cues — so a set keeps evolving on its own. Live Active/Beats/Amount knobs let you pause or retune on stage. Reuses the tempo clock, randomize_controls and manage_cue mechanisms. Pair with a generated system (or a control panel) as the target.",
      inputSchema: createAutopilotSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAutopilotImpl(ctx, args),
  );
};

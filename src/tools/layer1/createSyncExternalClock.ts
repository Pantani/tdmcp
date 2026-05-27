import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createSyncExternalClockSchema = z.object({
  bpm: z.coerce
    .number()
    .min(40)
    .max(220)
    .default(120)
    .describe("Starting tempo in BPM (match the DJ's displayed BPM, then fine-tune by tapping)."),
  parent_path: z.string().default("/project1"),
});
type CreateSyncExternalClockArgs = z.infer<typeof createSyncExternalClockSchema>;

// Parameter Execute callback (runs in TD's normal op context, so it imports td). The Bpm knob
// writes the project's global tempo (op('/').time.tempo), which every Beat CHOP — and so every
// beat-synced visual (create_tempo_sync, create_autopilot) — follows. The Tap pulse beat-matches
// by ear: it averages the last few tap intervals into a BPM and feeds the Bpm knob.
const ENGINE = `import td

def onValueChange(par, prev):
    if par.name == 'Bpm':
        try:
            op('/').time.tempo = max(40.0, min(220.0, float(par.eval())))
        except Exception:
            pass
    return

def onPulse(par):
    if par.name != 'Tap':
        return
    ap = par.owner
    now = absTime.seconds
    taps = list(ap.fetch('tdmcp_taps', []))
    if taps and now - taps[-1] > 2.0:
        taps = []
    taps.append(now)
    taps = taps[-4:]
    ap.store('tdmcp_taps', taps)
    if len(taps) >= 2:
        diffs = [taps[i + 1] - taps[i] for i in range(len(taps) - 1)]
        avg = sum(diffs) / len(diffs)
        if avg > 0:
            ap.par.Bpm = round(max(40.0, min(220.0, 60.0 / avg)), 1)
    return
`;

export async function createSyncExternalClockImpl(
  ctx: ToolContext,
  args: CreateSyncExternalClockArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "tempo_clock");

    // A Parameter Execute DAT watches this container's custom knobs and pushes the tempo to the
    // global clock. (Its `op` is set to its own parent so it follows wherever the container lands.)
    const engine = await builder.add("parameterexecuteDAT", "engine");
    await builder.python(
      `_e = op(${q(engine)})\n_e.par.op = _e.parent().path\n_e.par.pars = '*'\n_e.par.custom = True\n_e.par.builtin = False\n_e.par.valuechange = True\n_e.par.onpulse = True\n_e.par.active = True\n_e.text = ${q(ENGINE)}\nop('/').time.tempo = ${args.bpm}`,
    );

    const controls: ControlSpec[] = [
      { name: "Bpm", type: "float", min: 40, max: 220, default: args.bpm, bind_to: [] },
      { name: "Tap", type: "pulse", bind_to: [] },
    ];

    return finalize(ctx, {
      summary: `Built a tempo clock at ${args.bpm} BPM driving the global tempo. Dial the Bpm knob to the DJ's BPM, or hit Tap on the beat to match by ear — every beat-synced visual follows.`,
      builder,
      outputPath: engine,
      // No visual output (it drives the global tempo), so nothing to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        bpm: args.bpm,
        engine,
        drives: "op('/').time.tempo (global)",
      },
    });
  });
}

export const registerCreateSyncExternalClock: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "sync_external_clock",
    {
      title: "Sync external clock (tempo)",
      description:
        "Lock the project tempo to a live source so beat-synced visuals follow the music: a Bpm knob writes the global tempo (op('/').time.tempo), and a Tap pulse beat-matches by ear (averaging your taps into a BPM). Drives every Beat CHOP downstream — create_tempo_sync clocks and create_autopilot all follow. Dedicated MIDI-clock / Ableton-Link sync is a planned follow-up; for now match the DJ by tapping or dialing their BPM.",
      inputSchema: createSyncExternalClockSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSyncExternalClockImpl(ctx, args),
  );
};

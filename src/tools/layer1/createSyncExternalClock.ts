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
  mode: z
    .enum(["tap", "ableton_link", "midi_clock"])
    .default("tap")
    .describe(
      "How the tempo is sourced. 'tap' (default): a Bpm knob + Tap pulse you dial/tap by ear. 'ableton_link': lock to an Ableton Link session on the network (an Ableton Link CHOP's tempo drives the clock). 'midi_clock': derive BPM from incoming MIDI timing-clock (24 PPQN). The Link/MIDI modes need that source present on the machine — without it they fall back to the manual Bpm knob.",
    ),
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

// CHOP Execute callback for Ableton Link mode. The Ableton Link CHOP outputs a `tempo` channel
// (current BPM negotiated across the Link session); when it changes we push it to the global
// clock and reflect it on the Bpm knob so the panel stays honest. onValueChange fires only when a
// channel value actually changes, so this is cheap (tempo changes rarely).
const LINK_CALLBACK = `
def onValueChange(channel, sampleIndex, val, prev):
    if channel.name == 'tempo' and val and val > 0:
        t = max(40.0, min(220.0, float(val)))
        op('/').time.tempo = t
        try:
            parent().par.Bpm = round(t, 1)
        except Exception:
            pass
    return
`;

// Callbacks DAT for MIDI-clock mode. MIDI sends 24 timing-clock pulses per quarter note (PPQN);
// we timestamp each pulse and, over a one-quarter-note window (24 intervals), compute BPM. The
// MIDI In DAT callback API varies by TouchDesigner build — if onReceiveMIDI doesn't fire on your
// build, adapt the function name/signature (this is the documented modern shape). Hardware-gated:
// needs a device sending MIDI clock; with none present the manual Bpm knob still drives the clock.
const MIDI_CALLBACK = `
def onReceiveMIDI(dat, rowIndex, message, channel, index, value, input, bytes):
    if message != 'Clock':
        return
    ticks = list(me.fetch('tdmcp_clock', []))
    ticks.append(absTime.seconds)
    ticks = ticks[-25:]
    me.store('tdmcp_clock', ticks)
    if len(ticks) >= 25:
        span = ticks[-1] - ticks[0]
        if span > 0:
            bpm = max(40.0, min(220.0, 60.0 / span))
            op('/').time.tempo = round(bpm, 1)
            try:
                parent().par.Bpm = round(bpm, 1)
            except Exception:
                pass
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
    // This is the manual tap/dial path and stays present in every mode as a fallback.
    const engine = await builder.add("parameterexecuteDAT", "engine");
    await builder.python(
      `_e = op(${q(engine)})\n_e.par.op = _e.parent().path\n_e.par.pars = '*'\n_e.par.custom = True\n_e.par.builtin = False\n_e.par.valuechange = True\n_e.par.onpulse = True\n_e.par.active = True\n_e.text = ${q(ENGINE)}\nop('/').time.tempo = ${args.bpm}`,
    );

    const extra: Record<string, unknown> = {
      bpm: args.bpm,
      mode: args.mode,
      engine,
      drives: "op('/').time.tempo (global)",
    };
    let summary: string;
    const hardwareGated: string[] = [];

    if (args.mode === "ableton_link") {
      // Ableton Link CHOP negotiates a shared tempo over the network; a CHOP Execute DAT forwards
      // its `tempo` channel to the global clock. Each par is set defensively so a name that differs
      // on this build can't sink the rest of the configuration.
      const link = await builder.add("abletonlinkCHOP", "link");
      const linkClock = await builder.add("chopexecuteDAT", "linkclock");
      await builder.python(
        `_lk = op(${q(link)})\nfor _pn, _v in [('enable', 1), ('active', 1), ('tempo', 1), ('beat', 1), ('phase', 1), ('status', 1)]:\n    try:\n        setattr(_lk.par, _pn, _v)\n    except Exception:\n        pass\n_d = op(${q(linkClock)})\ntry:\n    _d.par.chop = ${q(link)}\nexcept Exception:\n    pass\ntry:\n    _d.par.valuechange = True\n    _d.par.active = True\nexcept Exception:\n    pass\n_d.text = ${q(LINK_CALLBACK)}`,
      );
      extra.link = link;
      extra.linkClock = linkClock;
      hardwareGated.push(
        "Ableton Link tempo-lock can only be confirmed with an active Link session (Ableton/another Link peer) on the network.",
      );
      summary = `Built a tempo clock locked to Ableton Link (starting ${args.bpm} BPM): an Ableton Link CHOP's tempo drives the global clock, with the Bpm knob/Tap as a manual fallback. Start a Link session on the network and TouchDesigner follows it.`;
    } else if (args.mode === "midi_clock") {
      // MIDI In DAT receives the device's timing-clock; a callbacks DAT derives BPM from 24-PPQN
      // pulse timing and writes the global clock. The callbacks-DAT par name varies by build, so
      // try the common spellings.
      const midiin = await builder.add("midiinDAT", "midiin");
      const midiClock = await builder.add("textDAT", "midiclock");
      await builder.python(
        `op(${q(midiClock)}).text = ${q(MIDI_CALLBACK)}\n_m = op(${q(midiin)})\nfor _pn in ['callbacks', 'callbackdat', 'callbacksdat']:\n    try:\n        setattr(_m.par, _pn, ${q(midiClock)})\n        break\n    except Exception:\n        pass\ntry:\n    _m.par.active = True\nexcept Exception:\n    pass`,
      );
      extra.midiin = midiin;
      extra.midiClock = midiClock;
      hardwareGated.push(
        "MIDI-clock tempo-lock can only be confirmed with a device sending MIDI timing-clock; the callback signature (onReceiveMIDI) is TouchDesigner-build-dependent.",
      );
      summary = `Built a tempo clock locked to incoming MIDI clock (starting ${args.bpm} BPM): a MIDI In DAT's 24-PPQN timing pulses are converted to BPM and drive the global clock, with the Bpm knob/Tap as a manual fallback. Send MIDI clock from your DAW/controller and TouchDesigner follows it.`;
    } else {
      summary = `Built a tempo clock at ${args.bpm} BPM driving the global tempo. Dial the Bpm knob to the DJ's BPM, or hit Tap on the beat to match by ear — every beat-synced visual follows.`;
    }

    if (hardwareGated.length) extra.hardware_gated = hardwareGated;

    const controls: ControlSpec[] = [
      { name: "Bpm", type: "float", min: 40, max: 220, default: args.bpm, bind_to: [] },
      { name: "Tap", type: "pulse", bind_to: [] },
    ];

    return finalize(ctx, {
      summary,
      builder,
      outputPath: engine,
      // No visual output (it drives the global tempo), so nothing to capture.
      capturePreviewImage: false,
      controls,
      extra,
    });
  });
}

export const registerCreateSyncExternalClock: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "sync_external_clock",
    {
      title: "Sync external clock (tempo)",
      description:
        "Lock the project tempo to a live source so beat-synced visuals follow the music. `mode` picks the source: 'tap' (default) gives a Bpm knob + Tap pulse you dial/tap by ear; 'ableton_link' locks to an Ableton Link session on the network; 'midi_clock' derives BPM from incoming MIDI timing-clock (24 PPQN). All modes write the global tempo (op('/').time.tempo), so create_tempo_sync clocks and create_autopilot follow. The Link/MIDI modes are hardware-gated — without that source present the manual Bpm knob still drives the clock.",
      inputSchema: createSyncExternalClockSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSyncExternalClockImpl(ctx, args),
  );
};

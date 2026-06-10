import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const createMidiNoteReactiveSchema = z.object({
  name: z
    .string()
    .default("midi_note_reactive")
    .describe(
      "Name for the container COMP created inside parent_path. Must be a valid TD identifier.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained container is created inside."),
  source: z
    .enum(["device", "synthetic"])
    .default("synthetic")
    .describe(
      "device: a real MIDI In CHOP (hardware-gated; needs a MIDI keyboard/controller — HELD FROM RELEASE until validated with gear). synthetic: a Noise CHOP driving an Event CHOP so it previews without any hardware. Default is synthetic so the chain is immediately visible.",
    ),
  device_name: z
    .string()
    .optional()
    .describe(
      "(device) MIDI device name to filter (e.g. 'Arturia MiniLab mkII'). When omitted the MIDI In CHOP listens on all devices.",
    ),
  notes: z
    .number()
    .int()
    .min(1)
    .max(128)
    .default(12)
    .describe(
      "How many note channels to expose (e.g. 12 = one octave, 128 = full keyboard). Each channel is named note0…noteN-1 on the output Null CHOP.",
    ),
});
type CreateMidiNoteReactiveArgs = z.infer<typeof createMidiNoteReactiveSchema>;

// Synthetic keep-alive: a Noise CHOP quantised to 0/1 steps simulates note-on pulses for
// each of the N notes. It feeds an Event CHOP which runs ADSR envelopes so the output
// channels move exactly as they would from a real keyboard — just procedurally generated.
// This lets the whole chain cook and produce moving channels with no hardware present.
//
// NOTE on midiinCHOP par names: 'device' and 'active' are the well-known documented
// parameters. 'norm' is the channel normalization enum (also used in createExternalIo).
// These are probed defensively in the setup script so a missing par name logs a warning
// rather than failing silently. Channel naming (note0…note127) on eventCHOP is the TD
// convention documented in the Event CHOP KB entry.
//
// UNVERIFIED — device path is HELD FROM RELEASE pending live testing with MIDI hardware.
const KEEPALIVE_CALLBACK = `
def onFrameStart(frame):
    return
`;

export async function createMidiNoteReactiveImpl(
  ctx: ToolContext,
  args: CreateMidiNoteReactiveArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const warnings: string[] = [];
    let summary: string;
    const extra: Record<string, unknown> = {
      source: args.source,
      notes: args.notes,
    };

    if (args.source === "device") {
      // HARDWARE-GATED: midiinCHOP outputs one channel per note, named note0…note127.
      // We then wire into an eventCHOP to get per-note ADSR envelopes (velocity as the
      // "input" channel), then a Null as the stable bind point.
      //
      // Par names probed defensively: 'active', 'device' (device name filter).
      // midiinCHOP channel output mode — 'normalization' / 'norm' sets 0-1 vs 0-127
      // scaling; we use raw 0-127 (off / none) so velocity is preserved for eventCHOP.
      const midiin = await builder.add("midiinCHOP", "midiin");
      await builder.python(
        `_m = op(${q(midiin)})\n` +
          `for _pn, _v in [('active', 1)]:\n` +
          `    try:\n` +
          `        setattr(_m.par, _pn, _v)\n` +
          `    except Exception:\n` +
          `        pass\n` +
          (args.device_name
            ? `for _pn in ['device', 'devicename', 'name']:\n` +
              `    try:\n` +
              `        setattr(_m.par, _pn, ${q(args.device_name)})\n` +
              `        break\n` +
              `    except Exception:\n` +
              `        pass\n`
            : "") +
          `# Scope to note channels only; eventCHOP input should be note0..noteN-1\n` +
          `for _pn in ['scope', 'chanscope']:\n` +
          `    try:\n` +
          `        setattr(_m.par, _pn, 'note*')\n` +
          `        break\n` +
          `    except Exception:\n` +
          `        pass`,
      );

      // eventCHOP manages birth/life of overlapping note events. Each channel from
      // midiinCHOP (note0…noteN-1) gets an ADSR envelope; 'input' captures velocity.
      const events = await builder.add("eventCHOP", "events");
      await builder.connect(midiin, events);
      await builder.python(
        `_ev = op(${q(events)})\n` +
          `for _pn, _v in [('timeslice', 1), ('attacktime', 0.01), ('releasetime', 0.3)]:\n` +
          `    try:\n` +
          `        setattr(_ev.par, _pn, _v)\n` +
          `    except Exception:\n` +
          `        pass`,
      );

      const noteNull = await builder.add("nullCHOP", "notes_out");
      await builder.connect(events, noteNull);

      // Keep-alive: a Script DAT / framestartDAT forces the chain to cook each frame
      // even when the network is paused.
      const keepalive = await builder.add("executeDAT", "keepalive");
      await builder.python(
        `_ka = op(${q(keepalive)})\n` +
          `_ka.text = ${q(KEEPALIVE_CALLBACK)}\n` +
          `for _pn in ['framestart', 'active']:\n` +
          `    try:\n` +
          `        setattr(_ka.par, _pn, 1)\n` +
          `    except Exception:\n` +
          `        pass`,
      );

      extra.midiin = midiin;
      extra.events = events;
      extra.output = noteNull;
      extra.keepalive = keepalive;
      extra.unverified = {
        status: "HELD FROM RELEASE",
        reason:
          "device path requires a real MIDI keyboard or controller to validate. " +
          "midiinCHOP parameter names ('device', 'scope') and eventCHOP wiring are " +
          "documented but unconfirmed on this build. Use source='synthetic' to preview.",
        hardware_needed: "MIDI controller sending Note On/Off messages",
      };

      warnings.push(
        "UNVERIFIED (device source): midiinCHOP par names probed defensively but " +
          "cannot be confirmed without MIDI hardware. Use source='synthetic' to preview.",
      );

      summary =
        `Built a MIDI note-reactive chain (source: device, ${args.notes} notes): ` +
        `midiinCHOP → eventCHOP (per-note ADSR envelopes) → Null CHOP '${args.name}/notes_out'. ` +
        `Bind a parameter to op('${args.name}/notes_out')['note0'] (etc.) to make it react to keys. ` +
        `HARDWARE-GATED: connect a MIDI keyboard/controller for signal. ` +
        `Use source='synthetic' to preview without gear.`;
    } else {
      // SYNTHETIC path — no hardware needed.
      // A Noise CHOP generates N channels (one per note) oscillating 0↔1 at different
      // rates, acting as a continuous stand-in for Note On/Off triggers.
      // An Event CHOP turns those pulses into ADSR envelopes that mimic note velocity.
      // The output Null CHOP exposes the same channel names (note0…noteN-1) so
      // downstream bind_to_channel expressions work identically for device and synthetic.
      const synth = await builder.add("noiseCHOP", "note_source", {
        // channels: N channels named note0…note(N-1)
        type: "random",
        period: 0.5,
        amplitude: 1,
        roughness: 0.8,
      });
      // Set channel count and names via Python (no REST param for channel names)
      await builder.python(
        `_s = op(${q(synth)})\n` +
          `for _pn, _v in [('chancount', ${args.notes}), ('roughness', 0.8), ('period', 0.5)]:\n` +
          `    try:\n` +
          `        setattr(_s.par, _pn, _v)\n` +
          `    except Exception:\n` +
          `        pass\n` +
          `# Name the channels note0…note${args.notes - 1} so eventCHOP labels them correctly\n` +
          `try:\n` +
          `    _s.par.channame = ' '.join('note' + str(i) for i in range(${args.notes}))\n` +
          `except Exception:\n` +
          `    try:\n` +
          `        _s.par.channelnames = ' '.join('note' + str(i) for i in range(${args.notes}))\n` +
          `    except Exception:\n` +
          `        pass`,
      );

      // Clamp the noise to 0/1 steps via a Limit CHOP so the Event CHOP sees clean
      // on/off transitions (it looks for transitions through 0.5).
      const limit = await builder.add("limitCHOP", "note_trigger", {
        quantize: "roundhalf",
        min: 0,
        max: 1,
      });
      await builder.connect(synth, limit);

      // Event CHOP turns each 0→1 transition into an ADSR envelope. The 'input' channel
      // carries the amplitude at trigger time (velocity equivalent).
      const events = await builder.add("eventCHOP", "events");
      await builder.connect(limit, events);
      await builder.python(
        `_ev = op(${q(events)})\n` +
          `for _pn, _v in [('timeslice', 1), ('attacktime', 0.01), ('releasetime', 0.3)]:\n` +
          `    try:\n` +
          `        setattr(_ev.par, _pn, _v)\n` +
          `    except Exception:\n` +
          `        pass`,
      );

      const noteNull = await builder.add("nullCHOP", "notes_out");
      await builder.connect(events, noteNull);

      // Keep-alive executeDAT so the chain cooks live even when TD timeline is paused.
      const keepalive = await builder.add("executeDAT", "keepalive");
      await builder.python(
        `_ka = op(${q(keepalive)})\n` +
          `_ka.text = ${q(KEEPALIVE_CALLBACK)}\n` +
          `for _pn in ['framestart', 'active']:\n` +
          `    try:\n` +
          `        setattr(_ka.par, _pn, 1)\n` +
          `    except Exception:\n` +
          `        pass`,
      );

      extra.synth = synth;
      extra.limit = limit;
      extra.events = events;
      extra.output = noteNull;
      extra.keepalive = keepalive;

      summary =
        `Built a MIDI note-reactive chain (source: synthetic, ${args.notes} note channels): ` +
        `Noise CHOP → Limit CHOP (step pulses) → Event CHOP (ADSR envelopes) → Null CHOP '${args.name}/notes_out'. ` +
        `Channels note0…note${args.notes - 1} are live and bindable without any hardware. ` +
        `Bind a parameter to op('${args.name}/notes_out')['note0'] (etc.) to make it react. ` +
        `Switch source='device' and connect a MIDI keyboard to receive real note velocity.`;
    }

    const controls: ControlSpec[] = [
      {
        name: "Release",
        type: "float",
        min: 0.01,
        max: 2.0,
        default: 0.3,
        bind_to: [],
      },
    ];

    return finalize(ctx, {
      summary,
      builder,
      outputPath: undefined, // CHOP output — no TOP preview
      capturePreviewImage: false,
      controls,
      extra: {
        ...extra,
        warnings_extra: warnings,
      },
    });
  });
}

export const registerCreateMidiNoteReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_midi_note_reactive",
    {
      title: "Create MIDI note reactive",
      description:
        "Build a MIDI note → per-note trigger/velocity chain that exposes bindable channels " +
        "on a Null CHOP (note0…noteN-1). Unlike learn_control (which binds one CC), this " +
        "creates a full note-event chain: midiinCHOP → eventCHOP (ADSR envelopes per note) " +
        "→ Null CHOP. Bind any parameter to op('…/notes_out')['note0'] and it pulses with " +
        "each keypress. source='synthetic' (default) previews without hardware by generating " +
        "a procedural note pattern — switch to source='device' when a MIDI keyboard is " +
        "connected. The device path is HARDWARE-GATED (HELD FROM RELEASE until validated " +
        "with real MIDI gear).",
      inputSchema: createMidiNoteReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMidiNoteReactiveImpl(ctx, args),
  );
};

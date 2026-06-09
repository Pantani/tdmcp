import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createPhraseLockedCueEngineSchema = z.object({
  pending_chop_path: z
    .string()
    .describe(
      "Path to a CHOP whose first channel is the 'pending cue' pulse. Every time it rises 0→1 a cue is enqueued; the gated trigger fires it on the next phrase boundary. Wire a Button COMP, OSC In CHOP, MIDI In CHOP, or composeCueList trigger into this channel.",
    ),
  phrase_length_bars: z
    .union([
      z.literal(1),
      z.literal(2),
      z.literal(4),
      z.literal(8),
      z.literal(16),
      z.literal(32),
      z.literal(64),
    ])
    .default(16)
    .describe(
      "Phrase length in bars. 16 is the DJ/VJ standard for builds/drops. Restricted to powers of 2 (1/2/4/8/16/32/64) — the canonical phrase grid; arbitrary values break the modulo lock.",
    ),
  quantize_mode: z
    .enum(["next", "aligned"])
    .default("next")
    .describe(
      "'next' (default): fire on the NEXT bar where (bar % phrase_length == 0), which is the upcoming phrase downbeat. 'aligned': only fire at a phrase downbeat that is also bar 1 of the bar-1-anchored phrase grid (bar % phrase_length == 0 AND bar >= phrase_length) — strict alignment from project start. For most live use, 'next' is what you want.",
    ),
  queue_capacity: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(8)
    .describe(
      "Max queued pending cues. Extra pulses while at capacity are dropped (warning logged in storage).",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live PhraseLength / Active / Flush / QueueDepth controls on the engine container.",
    ),
  name: z.string().default("phrase_lock").describe("Engine container name."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP. Self-contained engine container is created here."),
});

export type CreatePhraseLockedCueEngineArgs = z.infer<typeof createPhraseLockedCueEngineSchema>;

// ---------------------------------------------------------------------------
// Python callbacks (deployed as DAT text at build time)
// ---------------------------------------------------------------------------

/**
 * CHOP Execute callback: off→on edge of `pending_in` enqueues a cue into
 * seq.storage['tdmcp_pl_queue']. __CAP__ and __MODE__ are replaced at build time.
 */
const ENQUEUE_CALLBACK = `import td

def onOffToOn(channel, sampleIndex, val, prev):
    seq = me.parent()
    cap = __CAP__
    try:
        p = getattr(seq.par, 'Queuecapacity', None)
        if p is not None:
            cap = max(1, int(p.eval()))
    except Exception:
        pass
    q = list(seq.fetch('tdmcp_pl_queue', []))
    if len(q) >= cap:
        seq.store('tdmcp_pl_warn', 'queue full — dropping pulse')
        return
    clock_op = op('clock')
    bar_val = float(clock_op['bar'][0]) if clock_op is not None else 0.0
    entry = {'ch': channel.name, 'enq_bar': bar_val}
    # 'next' mode: if already on a phrase boundary when enqueued + queue was empty,
    # arm an immediate fire flag so the gate fires on this same bar.
    phrase = __PHRASE__
    try:
        p2 = getattr(seq.par, 'Phraselength', None)
        if p2 is not None:
            phrase = max(1, int(p2.eval()))
    except Exception:
        pass
    bar_int = int(bar_val)
    if '__MODE__' == 'next' and len(q) == 0 and bar_int > 0 and (bar_int % phrase) == 0:
        seq.store('tdmcp_pl_armed_now', True)
    q.append(entry)
    seq.store('tdmcp_pl_queue', q)
    qd = getattr(seq.par, 'Queuedepth', None)
    if qd is not None:
        try:
            qd.val = len(q)
        except Exception:
            pass
    return
`;

/**
 * CHOP Execute callback: watches `clock` bar channel for value-change.
 * Fires gated trigger for FIFO-queued cues on each phrase boundary.
 * __PHRASE__, __MODE__, __TRIG__ replaced at build time.
 */
const GATE_CALLBACK = `import td

def _phrase_len(seq):
    p = getattr(seq.par, 'Phraselength', None)
    try:
        return max(1, int(p.eval())) if p is not None else __PHRASE__
    except Exception:
        return __PHRASE__

def onValueChange(channel, sampleIndex, val, prev):
    if channel.name != 'bar':
        return
    seq = me.parent()
    act = getattr(seq.par, 'Active', None)
    if act is not None and not act.eval():
        return
    bar = int(val)
    phrase = _phrase_len(seq)
    on_boundary = bar > 0 and (bar % phrase) == 0
    # mode-specific arm check: __ARMED_CHECK__ is True only in 'next' mode
    armed = False
    if __ARMED_CHECK__:
        armed = bool(seq.fetch('tdmcp_pl_armed_now', False))
        if armed:
            seq.store('tdmcp_pl_armed_now', False)
    if not on_boundary and not armed:
        return
    q = list(seq.fetch('tdmcp_pl_queue', []))
    if not q:
        return
    q.pop(0)
    seq.store('tdmcp_pl_queue', q)
    qd = getattr(seq.par, 'Queuedepth', None)
    if qd is not None:
        try:
            qd.val = len(q)
        except Exception:
            pass
    trig = op('__TRIG__')
    if trig is None:
        return
    try:
        trig.par.value0 = 1
    except Exception:
        pass
    run("op('__TRIG__').par.value0 = 0", delayFrames=1)
    return
`;

/**
 * Parameter Execute DAT on the engine container: handles the Flush pulse control to
 * clear the queue, mirroring createSyncExternalClock's ENGINE DAT pattern.
 */
const FLUSH_CALLBACK = `import td

def onPulse(par):
    if par.name != 'Flush':
        return
    seq = par.owner
    seq.store('tdmcp_pl_queue', [])
    seq.store('tdmcp_pl_armed_now', False)
    qd = getattr(seq.par, 'Queuedepth', None)
    if qd is not None:
        try:
            qd.val = 0
        except Exception:
            pass
    return
`;

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createPhraseLockedCueEngineImpl(
  ctx: ToolContext,
  args: CreatePhraseLockedCueEngineArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const containerPath = builder.containerPath;

    // Beat CHOP — local clock keyed to global project tempo.
    // period = phrase_length_bars * 4 beats (each bar = 4 beats).
    const beatPeriod = args.phrase_length_bars * 4;
    const clock = await builder.add("beatCHOP", "clock", {
      period: beatPeriod,
      count: 1,
      beat: 1,
      bar: 1,
      ramp: 0,
      pulse: 0,
      bpm: 0,
    });

    // Select CHOP referencing the caller's pending-cue CHOP (no cross-container wire).
    const pendingIn = await builder.add("selectCHOP", "pending_in", {
      chop: args.pending_chop_path,
    });

    // Constant CHOP for the gated trigger output (0/1).
    const trigger = await builder.add("constantCHOP", "trigger", {
      name0: "trigger",
      value0: 0,
    });

    // Null CHOP — the exposed gated trigger output consumers bind to.
    const out = await builder.add("nullCHOP", "out");
    await builder.connect(trigger, out);

    // CHOP Execute for enqueue (off→on edge of pending_in).
    const enqueue = await builder.add("chopexecuteDAT", "enqueue", {
      chop: pendingIn,
      channel: "*",
      offtoon: 1,
      active: 1,
    });

    // CHOP Execute for gating (value-change of 'bar' channel on clock).
    const gate = await builder.add("chopexecuteDAT", "gate", {
      chop: clock,
      channel: "bar",
      valuechange: 1,
      active: 1,
    });

    // Parameter Execute DAT for Flush pulse.
    const flushDat = await builder.add("parameterexecuteDAT", "flush_exec", {
      active: 1,
    });

    // Deploy callback texts — substitute build-time literals.
    const trigName = "trigger"; // relative name inside the container
    const armedCheck = args.quantize_mode === "next" ? "True" : "False";
    const enqueueText = ENQUEUE_CALLBACK.replace(/__CAP__/g, String(args.queue_capacity))
      .replace(/__PHRASE__/g, String(args.phrase_length_bars))
      .replace(/__MODE__/g, args.quantize_mode);
    const gateText = GATE_CALLBACK.replace(/__PHRASE__/g, String(args.phrase_length_bars))
      .replace(/__ARMED_CHECK__/g, armedCheck)
      .replace(/__TRIG__/g, trigName);

    await builder.python(`op(${q(enqueue)}).text = ${q(enqueueText)}`);
    await builder.python(`op(${q(gate)}).text = ${q(gateText)}`);
    await builder.python(`op(${q(flushDat)}).text = ${q(FLUSH_CALLBACK)}`);

    // Live controls.
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Active",
            type: "toggle",
            default: 1,
            bind_to: [],
          },
          {
            name: "PhraseLength",
            type: "int",
            min: 1,
            max: 64,
            default: args.phrase_length_bars,
            bind_to: [],
          },
          {
            name: "Flush",
            type: "pulse",
            bind_to: [],
          },
          {
            name: "QueueDepth",
            type: "int",
            min: 0,
            max: args.queue_capacity,
            default: 0,
            bind_to: [],
          },
        ]
      : [];

    const result = await finalize(ctx, {
      summary: `Created phrase-locked cue engine '${containerPath}' (${args.phrase_length_bars}-bar phrase, mode=${args.quantize_mode}). Queue any pulse CHOP into 'pending_in'; gated trigger fires on each phrase boundary at '${containerPath}/out'. Controls: Active / PhraseLength / Flush / QueueDepth.`,
      builder,
      outputPath: out,
      capturePreviewImage: false,
      controls,
      extra: {
        comp: containerPath,
        gated_trigger_chop_path: out,
        clock,
        enqueue_dat: enqueue,
        gate_dat: gate,
        pending_in: pendingIn,
        controls: args.expose_controls ? ["Active", "PhraseLength", "Flush", "QueueDepth"] : [],
        phrase_length_bars: args.phrase_length_bars,
        quantize_mode: args.quantize_mode,
        queue_capacity: args.queue_capacity,
      },
    });

    // Surface any fatal from the report if present (bridge returned an error report).
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (text.includes('"fatal"')) {
      try {
        const match = /"fatal"\s*:\s*"([^"]+)"/.exec(text);
        if (match?.[1]) return errorResult(`Phrase-lock engine build failed: ${match[1]}`);
      } catch {
        // ignore parse error — return result as-is
      }
    }

    return result;
  });
}

export const registerCreatePhraseLockedCueEngine: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_phrase_locked_cue_engine",
    {
      title: "Create phrase-locked cue engine",
      description:
        "Build a DJ/VJ phrase-quantized cue-lock engine. Any incoming pulse CHOP (Button, MIDI In, OSC In, composeCueList trigger) is queued FIFO and fired on the next 1/2/4/8/16/32/64-bar phrase boundary derived from the global project tempo. Live controls: Active (on/off gate), PhraseLength (live retune), Flush (clear queue), QueueDepth (display). Mode 'next' fires on the first upcoming boundary; 'aligned' locks to the project-start phrase grid. Pairs with create_tempo_sync upstream and bind_to_channel / manage_cue downstream. Output is a 0/1 trigger Null CHOP at <container>/out.",
      inputSchema: createPhraseLockedCueEngineSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPhraseLockedCueEngineImpl(ctx, args),
  );
};

import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createTempoSyncSchema = z.object({
  period: z.coerce
    .number()
    .positive()
    .default(4)
    .describe("Beats per bar / beat period — how the ramp and bar channels divide the tempo."),
  emit_events: z
    .boolean()
    .default(true)
    .describe(
      "Also broadcast a `beat` event over the bridge WebSocket on every beat, so `tdmcp-agent watch` and the AI can react to beats live.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose a live 'Period' knob to retune the beat division on the fly."),
  parent_path: z.string().default("/project1"),
});
type CreateTempoSyncArgs = z.infer<typeof createTempoSyncSchema>;

// CHOP Execute callback (lives in TD, runs in the normal op context — not the exec
// namespace — so it imports `td` for the operator classes). The integer `beat` channel
// steps 0→1→2→…→0 once per beat, so watching it for value changes fires exactly once per
// beat (whatever the period). On each beat it broadcasts a \`beat\` event through the
// bridge's Web Server DAT (located by type so it works wherever the bridge was installed).
const BEAT_EMITTER = `import td

def _webserver():
    for w in op('/').findChildren(type=td.webserverDAT):
        return w
    return None

def onValueChange(channel, sampleIndex, val, prev):
    if channel.name != 'beat':
        return
    ws = _webserver()
    if ws is None:
        return
    try:
        from mcp import events
        owner = channel.owner
        names = [c.name for c in owner.chans()]
        data = {'beat': int(val)}
        if 'bar' in names:
            data['bar'] = int(owner['bar'][0])
        if 'count' in names:
            data['count'] = int(owner['count'][0])
        if 'bpm' in names:
            data['bpm'] = round(float(owner['bpm'][0]), 2)
        events.broadcast(ws, 'beat', data)
    except Exception:
        pass
    return
`;

export async function createTempoSyncImpl(ctx: ToolContext, args: CreateTempoSyncArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "tempo_sync");

    // A Beat CHOP driven by TouchDesigner's global tempo; the toggles turn on the useful
    // sync channels (a per-beat 0→1 ramp, a pulse spike, integer beat/bar counters, BPM).
    const beat = await builder.add("beatCHOP", "beat", {
      period: args.period,
      ramp: 1,
      pulse: 1,
      count: 1,
      beat: 1,
      bar: 1,
      bpm: 1,
    });
    const tempo = await builder.add("nullCHOP", "tempo");
    await builder.connect(beat, tempo);

    let emitter: string | undefined;
    if (args.emit_events) {
      emitter = await builder.add("chopexecuteDAT", "beat_emitter", {
        chop: tempo,
        channel: "beat",
        valuechange: 1,
        offtoon: 0,
        active: 1,
      });
      await builder.python(`op(${q(emitter)}).text = ${q(BEAT_EMITTER)}`);
    }

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Period",
            type: "float",
            min: 0.25,
            max: 16,
            default: args.period,
            bind_to: [`${beat}.period`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a tempo clock at ${tempo} (channels ramp/pulse/beat/bar/bpm)${args.emit_events ? ", broadcasting `beat` events" : ""}. Bind a parameter to op('${tempo}')['ramp'] for a per-beat sweep, or ['pulse'] for a hit on each beat.`,
      builder,
      outputPath: tempo,
      // The output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        tempo_path: tempo,
        channels: ["ramp", "pulse", "count", "beat", "bar", "bpm"],
        emits_beat_events: args.emit_events,
        emitter,
      },
    });
  });
}

export const registerCreateTempoSync: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_tempo_sync",
    {
      title: "Create tempo sync",
      description:
        "Create a tempo clock (Beat CHOP driven by TouchDesigner's global tempo) exposing beat-synced channels on a Null CHOP: a per-beat 0→1 `ramp`, a `pulse` spike on each beat, integer `beat`/`bar` counters, and `bpm`. Bind any parameter to these to lock visuals to the beat. With emit_events on, it also broadcasts a `beat` event over the bridge WebSocket each beat, so `tdmcp-agent watch` and the AI can see the pulse live. Pair with extract_audio_features for full musical reactivity.",
      inputSchema: createTempoSyncSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTempoSyncImpl(ctx, args),
  );
};

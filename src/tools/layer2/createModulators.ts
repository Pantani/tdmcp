import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/** One modulator (LFO) in the bank. */
const modulatorSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      "Output channel name for this modulator (e.g. 'breathe', 'sweep'). Sanitized to a valid channel name; defaults to mod1, mod2, …",
    ),
  shape: z
    .enum(["sine", "triangle", "saw", "square", "random"])
    .default("sine")
    .describe(
      "Oscillator shape. 'saw' is a rising ramp; 'random' is a sample-&-hold (a new random value held each cycle) built from a Noise CHOP. Every shape sweeps the full depth range.",
    ),
  rate_beats: z.coerce
    .number()
    .positive()
    .default(4)
    .describe(
      "Cycle length in BEATS — how many beats one full cycle takes. 4 = one cycle per bar (slow breathe), 1 = one cycle per beat, 0.5 = twice per beat (eighths). Locked to the tempo source so it tracks BPM.",
    ),
  depth_min: z.coerce.number().default(0).describe("Low end of this modulator's output range."),
  depth_max: z.coerce.number().default(1).describe("High end of this modulator's output range."),
  phase: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Phase offset 0–1 (fraction of a cycle). Use to fan a bank out of step (e.g. 0, 0.25, 0.5, 0.75).",
    ),
});

export const createModulatorsSchema = z.object({
  name: z
    .string()
    .default("modulators")
    .describe("Name of the self-contained modulator-bank container."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP the 'modulators' container is created inside."),
  modulators: z
    .array(modulatorSchema)
    .min(1)
    .max(32)
    .describe(
      "The modulators (LFOs) to build. Each becomes one named output channel on the bank's Null.",
    ),
  tempo_source: z
    .string()
    .optional()
    .describe(
      "Path to an existing tempo Null/Beat CHOP carrying a 'bpm' channel (e.g. the Null from create_tempo_sync, '/project1/tempo_sync/tempo'). Omit to create a fresh Beat CHOP locked to TouchDesigner's global tempo inside the bank.",
    ),
  bpm_channel: z
    .string()
    .default("bpm")
    .describe("Name of the BPM channel on the tempo source to lock rates to."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose a live custom-parameter page on the bank: a master Rate multiplier and a master Depth (amplitude) scale, so you can speed up or flatten the whole bank from one knob during a show.",
    ),
});
type CreateModulatorsArgs = z.infer<typeof createModulatorsSchema>;

/** Friendly shape names → the lfoCHOP `wavetype` menu values. `random` routes to a Noise CHOP. */
const WAVE_MAP: Record<string, string> = {
  sine: "sin",
  triangle: "tri",
  saw: "ramp",
  square: "square",
};

// lfoCHOP / noiseCHOP wave shapes are not uniformly bipolar: sin/tri/square swing
// [-1, 1], but ramp(saw)/random output [0, 1] (verified live, build 2025.32820).
// amp/offset must branch on that, else unipolar shapes only sweep [midpoint, max].
// Mirrors animateParameter.ts BIPOLAR_WAVEFORMS.
const BIPOLAR_SHAPES = new Set(["sine", "triangle", "square"]);

/** One modulator after TS pre-computes wave mapping, bipolarity, cycles-per-beat and channel. */
interface ModulatorSpec {
  channel: string;
  shape: string;
  /** "lfo" for an oscillator, "noise" for a random sample-&-hold. */
  kind: "lfo" | "noise";
  /** lfoCHOP wavetype menu value; absent for noise. */
  wavetype?: string;
  amp: number;
  offset: number;
  phase: number;
  /** cycles per beat = 1 / rate_beats (LFO frequency multiplier). */
  cpb: number;
  /** beats per cycle = rate_beats (noise hold-period multiplier). */
  beats_per_cycle: number;
  rate_beats: number;
  /** Hz/period expression string, evaluated live in TD so it tracks tempo. */
  freq_expr?: string;
  period_expr?: string;
}

interface ModulatorsReport {
  comp: string;
  out_chop: string;
  channels: string[];
  tempo_source: string;
  beat_created: boolean;
  modulators: Array<{ op: string; channel: string; shape: string; rate_beats: number }>;
  time_playing: boolean;
  controls?: string[];
  warnings: string[];
  fatal?: string;
}

/** Sanitize a friendly name into a valid TD channel name (letters/digits/underscore, leading letter). */
function toChannelName(value: string, index: number): string {
  let name = value.replace(/[^a-zA-Z0-9_]/g, "");
  if (!name) name = `mod${index + 1}`;
  if (!/^[a-zA-Z]/.test(name)) name = `m${name}`;
  return name;
}

/** Python `repr`-style single-quoted literal for embedding a path/channel in an expression string. */
function pyStr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// One Python pass: optionally build an internal Beat CHOP on the global tempo, then
// per modulator create an lfoCHOP (or a noiseCHOP for random S&H), set amp/offset/phase
// and bind frequency/period to a tempo expression (so the bank tracks BPM live and stays
// phase-continuous across tempo changes — the lfoCHOP integrates phase internally). All
// outputs merge (names preserved), through an optional master Depth math gain, into a
// `mod_out` Null — the bind target. `ParMode` is not in the bridge's exec globals, so the
// expression-mode enum is derived from a live parameter (`type(par.mode)`).
const MODULATORS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "comp": "", "out_chop": "", "channels": [], "tempo_source": "",
    "beat_created": False, "modulators": [], "time_playing": False,
    "warnings": [],
}
try:
    report["time_playing"] = bool(op('/').time.play)
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent not found: " + _p["parent_path"]
    elif not hasattr(_parent, "create"):
        report["fatal"] = _p["parent_path"] + " cannot contain operators."
    else:
        # Reuse-or-create the named container so it is NEVER auto-renamed on a
        # collision: a bare create() would yield e.g. "modulators1" while the
        # pre-built freq/rate expressions still point at parent_path/name, binding
        # the bank to the wrong/missing tempo control. Clear children so a re-run
        # rebuilds cleanly at deterministic child paths (beat / lfo_* / mod_out).
        _comp = _parent.op(_p["name"])
        if _comp is not None and not hasattr(_comp, "create"):
            raise TypeError("%s exists and is not a container; pass a different name." % _comp.path)
        _comp = _comp or _parent.create(containerCOMP, _p["name"])
        for _old in list(_comp.children):
            _old.destroy()
        report["comp"] = _comp.path

        # Resolve the tempo source: an external Null/Beat CHOP, or a fresh internal Beat CHOP.
        _tempo_path = _p.get("tempo_source")
        if _tempo_path:
            if op(_tempo_path) is None:
                report["warnings"].append("Tempo source not found: %s (rates will read 0 until it exists)." % _tempo_path)
        else:
            _beat = _comp.create(beatCHOP, "beat")
            try:
                _beat.par.bpm = 1
            except Exception:
                pass
            _tempo_path = _beat.path
            report["beat_created"] = True
        report["tempo_source"] = _tempo_path

        _merge = _comp.create(mergeCHOP, "merge")
        _src_ops = []
        for _m in _p["modulators"]:
            try:
                if _m["kind"] == "noise":
                    _o = _comp.create(noiseCHOP, "noise_" + _m["channel"])
                    _o.par.type = "random"
                    try:
                        _o.par.periodunit = "seconds"
                    except Exception:
                        pass
                    _pp = _o.par.period
                    _PM = type(_pp.mode)
                    _pp.expr = _m["period_expr"]
                    _pp.mode = _PM.EXPRESSION
                else:
                    _o = _comp.create(lfoCHOP, "lfo_" + _m["channel"])
                    _o.par.wavetype = _m["wavetype"]
                    _o.par.phase = _m["phase"]
                    _fp = _o.par.frequency
                    _PM = type(_fp.mode)
                    _fp.expr = _m["freq_expr"]
                    _fp.mode = _PM.EXPRESSION
                _o.par.amp = _m["amp"]
                _o.par.offset = _m["offset"]
                _o.par.channelname = _m["channel"]
                _src_ops.append(_o)
                report["modulators"].append({"op": _o.path, "channel": _m["channel"], "shape": _m["shape"], "rate_beats": _m["rate_beats"]})
                report["channels"].append(_m["channel"])
            except Exception:
                report["warnings"].append("Failed to build modulator '%s': %s" % (_m.get("channel", "?"), traceback.format_exc().splitlines()[-1]))

        for _i, _o in enumerate(_src_ops):
            try:
                _merge.inputConnectors[_i].connect(_o)
            except Exception:
                report["warnings"].append("Failed to wire %s into merge." % _o.path)

        _tail = _merge
        _controls = []
        if _p["expose_controls"]:
            _depth = _comp.create(mathCHOP, "depth")
            _depth.inputConnectors[0].connect(_merge)
            _page = _comp.appendCustomPage("Modulators")
            _rate_par = _page.appendFloat("Rate", label="Rate")[0]
            _rate_par.normMin = 0.0; _rate_par.normMax = 4.0
            _rate_par.default = 1.0; _rate_par.val = 1.0
            _depth_par = _page.appendFloat("Depth", label="Depth")[0]
            _depth_par.normMin = 0.0; _depth_par.normMax = 2.0
            _depth_par.default = 1.0; _depth_par.val = 1.0
            # Master Depth scales the whole bank's amplitude via the Math CHOP gain.
            try:
                _gp = _depth.par.gain
                _PM = type(_gp.mode)
                _gp.expr = "op(%s).par.Depth" % repr(_comp.path)
                _gp.mode = _PM.EXPRESSION
            except Exception:
                report["warnings"].append("Could not bind master Depth to the Math CHOP gain.")
            _tail = _depth
            _controls = ["Rate", "Depth"]
            report["controls"] = _controls

        _out = _comp.create(nullCHOP, "mod_out")
        _out.inputConnectors[0].connect(_tail)
        report["out_chop"] = _out.path

        # Warn on any duplicate channel names that survived TS de-duplication (defensive).
        _seen = {}
        for _c in report["channels"]:
            _seen[_c] = _seen.get(_c, 0) + 1
        for _c, _n in _seen.items():
            if _n > 1:
                report["warnings"].append("Duplicate channel name '%s' (x%d) — Merge keeps only one." % (_c, _n))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildModulatorsScript(payload: object): string {
  return buildPayloadScript(MODULATORS_SCRIPT, payload);
}

/**
 * Pure: turn the user's modulators into TS-resolved specs — wave mapping, the
 * bipolarity-aware amp/offset, cycles-per-beat, de-duplicated channel names, and the
 * tempo-locked frequency/period expression strings. Exported for the unit test.
 */
export function buildModulatorSpecs(
  args: CreateModulatorsArgs,
  tempoOp: string,
): { specs: ModulatorSpec[]; dupeWarnings: string[] } {
  const dupeWarnings: string[] = [];
  const usedNames = new Set<string>();
  const masterRate = args.expose_controls
    ? ` * op(${pyStr(`${args.parent_path}/${args.name}`)}).par.Rate`
    : "";
  // Clamp the divisor: Rate=0 is a valid "freeze" for LFOs (freq * 0), but it would
  // divide-by-zero in the noise/random PERIOD expression. max(.., 1e-6) makes the
  // hold period huge (effectively frozen) instead of raising a cook error.
  const masterRateDiv = args.expose_controls
    ? ` / max(op(${pyStr(`${args.parent_path}/${args.name}`)}).par.Rate, 1e-6)`
    : "";
  const specs: ModulatorSpec[] = args.modulators.map((m, i) => {
    // Resolve and de-duplicate the channel name (suffix _2, _3, … on collision) so two
    // modulators given the same name both survive the Merge instead of one clobbering the other.
    const base = toChannelName(m.name ?? `mod${i + 1}`, i);
    let channel = base;
    if (usedNames.has(channel)) {
      // Check the FINAL name against every name already used (not just the base),
      // so a user-supplied suffix (e.g. "foo_2") can't collide with an auto one
      // and get silently dropped by the Merge.
      let n = 2;
      while (usedNames.has(`${base}_${n}`)) n++;
      channel = `${base}_${n}`;
      dupeWarnings.push(
        `Duplicate channel name '${base}' renamed to '${channel}' so both modulators survive the Merge.`,
      );
    }
    usedNames.add(channel);

    const span = m.depth_max - m.depth_min;
    const bipolar = BIPOLAR_SHAPES.has(m.shape);
    const amp = bipolar ? span / 2 : span;
    const offset = bipolar ? (m.depth_max + m.depth_min) / 2 : m.depth_min;
    const cpb = 1 / m.rate_beats;
    const beatsPerCycle = m.rate_beats;
    const isNoise = m.shape === "random";

    const tempoRef = `op(${pyStr(tempoOp)})[${pyStr(args.bpm_channel)}]`;
    return {
      channel,
      shape: m.shape,
      kind: isNoise ? "noise" : "lfo",
      wavetype: isNoise ? undefined : WAVE_MAP[m.shape],
      amp,
      offset,
      phase: m.phase,
      cpb,
      beats_per_cycle: beatsPerCycle,
      rate_beats: m.rate_beats,
      freq_expr: isNoise ? undefined : `${tempoRef} / 60.0 * ${cpb}${masterRate}`,
      period_expr: isNoise
        ? args.expose_controls
          ? `(60.0 / ${tempoRef} * ${beatsPerCycle})${masterRateDiv}`
          : `60.0 / ${tempoRef} * ${beatsPerCycle}`
        : undefined,
    };
  });
  return { specs, dupeWarnings };
}

export async function createModulatorsImpl(ctx: ToolContext, args: CreateModulatorsArgs) {
  // Tempo op used for the expression strings: the external source, or the bank's own Beat CHOP.
  const tempoOp = args.tempo_source ?? `${args.parent_path}/${args.name}/beat`;
  const { specs, dupeWarnings } = buildModulatorSpecs(args, tempoOp);
  return guardTd(
    async () => {
      const script = buildModulatorsScript({
        name: args.name,
        parent_path: args.parent_path,
        tempo_source: args.tempo_source ?? null,
        bpm_channel: args.bpm_channel,
        expose_controls: args.expose_controls,
        modulators: specs,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ModulatorsReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build modulators: ${report.fatal}`, report);
      }
      const warnings = [...dupeWarnings, ...report.warnings];
      const tempoLabel = report.beat_created ? "TD global tempo" : report.tempo_source;
      let summary = `Built a bank of ${report.channels.length} BPM-synced modulator(s) at ${report.out_chop} (channels: ${report.channels.join(", ")}), locked to ${tempoLabel}. Bind with bind_to_channel(source_chop="${report.out_chop}", channel="${report.channels[0] ?? "mod1"}").`;
      if (report.controls?.length) {
        summary += ` Master controls exposed: ${report.controls.join(", ")}.`;
      }
      if (!report.time_playing) {
        summary +=
          " ⚠ The timeline is paused — modulators are frozen until you press Play (they're timeline-driven).";
      }
      if (warnings.length) {
        summary += ` ${warnings.length} warning(s).`;
      }
      return jsonResult(summary, { ...report, warnings });
    },
  );
}

export const registerCreateModulators: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_modulators",
    {
      title: "Create modulators",
      description:
        "Build a bank of N BPM-synced LFOs in one self-contained container — each an oscillator (sine/triangle/saw/square or a random sample-&-hold) with its own rate-in-beats, output range and phase offset. Every rate locks to a tempo source (a create_tempo_sync Null, or TouchDesigner's global tempo) by expression, so the whole bank speeds up/slows down with the music and stays phase-continuous across tempo changes. All outputs land on one Null CHOP (mod_out) with one named channel per modulator, ready for bind_to_channel — the 'everything breathes' lever. Note: modulators are timeline-driven, so they only move while the timeline is playing. Re-running with an existing container name rebuilds it in place (clearing that container's children), so this tool is marked destructive and hidden from the safe profile.",
      inputSchema: createModulatorsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => createModulatorsImpl(ctx, args),
  );
};

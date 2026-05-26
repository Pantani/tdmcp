import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/** Friendly waveform names → the lfoCHOP `wavetype` menu values. */
const WAVE_MAP = {
  sine: "sin",
  triangle: "tri",
  ramp: "ramp",
  square: "square",
  pulse: "pulse",
  random: "normal",
} as const;

export const animateParameterSchema = z.object({
  targets: z
    .array(z.string())
    .min(1)
    .describe(
      "Parameters to animate, each written as 'nodePath.parName' (e.g. '/project1/sys/blur1.size'). Each is switched to expression mode so it tracks the oscillator live.",
    ),
  waveform: z
    .enum(["sine", "triangle", "ramp", "square", "pulse", "random"])
    .default("sine")
    .describe("Oscillator shape. Every waveform sweeps the full min–max range."),
  min: z.coerce.number().default(0).describe("Low end of the value sweep."),
  max: z.coerce.number().default(1).describe("High end of the value sweep."),
  period_seconds: z.coerce
    .number()
    .positive()
    .default(4)
    .describe("Seconds for one full cycle (lower = faster)."),
  container_path: z
    .string()
    .optional()
    .describe("Where to create the LFO CHOP; defaults to the first target's parent network."),
  name: z.string().default("lfo_anim").describe("Name for the LFO CHOP."),
});
type AnimateParameterArgs = z.infer<typeof animateParameterSchema>;

interface AnimateReport {
  lfo?: string;
  container?: string;
  channel?: string;
  frequency?: number;
  targets_bound: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass creates the lfoCHOP and binds each target parameter to its channel
// value by expression. `ParMode` is not in the bridge's exec globals, so the
// expression-mode enum is derived from a live parameter (`type(par.mode)`).
const ANIMATE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"targets_bound": [], "warnings": []}
try:
    _targets = _p["targets"]
    _first = _targets[0]; _dot0 = _first.rfind(".")
    if _dot0 <= 0:
        report["fatal"] = "Invalid target '%s' (expected 'nodePath.parName')." % _first
    else:
        _np0 = _first[:_dot0]; _firstnode = op(_np0)
        if _firstnode is None:
            report["fatal"] = "Target node not found: %s" % _np0
        else:
            _cont = _p.get("container") or _firstnode.parent().path
            _parent = op(_cont)
            if _parent is None:
                report["fatal"] = "Container not found: %s" % _cont
            else:
                _lfo = _parent.create(lfoCHOP, _p["name"])
                _lfo.par.wavetype = _p["wavetype"]
                _lfo.par.frequency = _p["frequency"]
                _lfo.par.amp = _p["amp"]
                _lfo.par.offset = _p["offset"]
                _ch = _lfo.par.channelname.eval() or "chan1"
                report["lfo"] = _lfo.path; report["container"] = _cont
                report["channel"] = _ch; report["frequency"] = _p["frequency"]
                for _t in _targets:
                    try:
                        _dot = _t.rfind(".")
                        if _dot <= 0:
                            report["warnings"].append("Invalid target '%s' (expected 'nodePath.parName')." % _t); continue
                        _npth = _t[:_dot]; _pn = _t[_dot + 1:]; _tn = op(_npth)
                        if _tn is None:
                            report["warnings"].append("Target node not found: %s" % _npth); continue
                        _tp = getattr(_tn.par, _pn, None)
                        if _tp is None:
                            report["warnings"].append("Target parameter not found: %s.%s" % (_npth, _pn)); continue
                        _PM = type(_tp.mode)
                        _tp.expr = "op(%s)[%s]" % (repr(_lfo.path), repr(_ch))
                        _tp.mode = _PM.EXPRESSION
                        report["targets_bound"].append(_npth + "." + _pn)
                    except Exception:
                        report["warnings"].append("Failed to bind '%s': %s" % (_t, traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildAnimateScript(payload: object): string {
  return buildPayloadScript(ANIMATE_SCRIPT, payload);
}

// lfoCHOP wave shapes are not uniformly bipolar: sin/tri/square swing [-1, 1],
// but ramp/pulse/random(normal) output [0, 1] (verified live, build 2025.32820).
// amp/offset must branch on that, else unipolar waves only sweep [midpoint, max].
const BIPOLAR_WAVEFORMS = new Set(["sine", "triangle", "square"]);

export async function animateParameterImpl(ctx: ToolContext, args: AnimateParameterArgs) {
  const span = args.max - args.min;
  const bipolar = BIPOLAR_WAVEFORMS.has(args.waveform);
  const amp = bipolar ? span / 2 : span;
  const offset = bipolar ? (args.max + args.min) / 2 : args.min;
  const frequency = 1 / args.period_seconds;
  return guardTd(
    async () => {
      const script = buildAnimateScript({
        targets: args.targets,
        name: args.name,
        wavetype: WAVE_MAP[args.waveform],
        frequency,
        amp,
        offset,
        container: args.container_path ?? null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<AnimateReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return jsonResult(`Could not set up animation: ${report.fatal}`, report);
      }
      const summary = `Animating ${report.targets_bound.length} parameter(s) with a ${args.waveform} LFO (period ${args.period_seconds}s, range ${args.min}–${args.max}) at ${report.lfo}${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerAnimateParameter: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "animate_parameter",
    {
      title: "Animate parameter",
      description:
        "Drive one or more node parameters over time with an LFO (sine/triangle/ramp/square/pulse/random). Creates an LFO CHOP and binds each target so it oscillates between min and max with the given period — movement without manual keyframing.",
      inputSchema: animateParameterSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => animateParameterImpl(ctx, args),
  );
};

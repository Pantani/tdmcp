import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const learnControlSchema = z.object({
  mode: z
    .enum(["snapshot", "bind"])
    .describe(
      "snapshot: record the current value of every channel of source_chop. bind: re-read source_chop, find the channel that moved the most since the snapshot, and bind target to it. Call snapshot first (controls at rest), wiggle one hardware control, then call bind.",
    ),
  source_chop: z
    .string()
    .describe(
      "Absolute path of the input CHOP carrying the hardware controls (e.g. a midiin/oscin CHOP or a Null fed by one).",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "Parameter to drive, written as 'nodePath.parName' (e.g. '/project1/sys/transform1.scale'). Required for mode:'bind'; switched to expression mode so it tracks the matched channel live.",
    ),
  scale: z.coerce
    .number()
    .default(1)
    .describe("Multiply the matched channel value (mapping gain)."),
  offset: z.coerce.number().default(0).describe("Add to the scaled value (mapping offset)."),
  min_delta: z.coerce
    .number()
    .optional()
    .describe(
      "mode:'bind' minimum NORMALIZED movement (default 0.05). The winning channel's delta is normalized by max(|old|, |new|, epsilon) — a unit-free relative change — so a 0–127 MIDI CC and a 0–1 OSC float compare fairly. If the top channel moved less than this, nothing is bound and you're told to wiggle the control harder. Raise it to reject controller jitter; lower it for very small/slow knobs.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "COMP whose storage persists the snapshot between the snapshot and bind calls (defaults to /project1).",
    ),
});
type LearnControlArgs = z.infer<typeof learnControlSchema>;

interface LearnReport {
  mode: string;
  source_chop: string;
  // snapshot
  channels?: string[];
  channel_count?: number;
  // bind
  matched_channel?: string;
  matched_delta?: number; // raw |new - old| of the winning channel (for display)
  matched_norm?: number; // normalized delta the pick was actually made on
  min_delta?: number; // the normalized threshold that was applied
  bound?: string;
  expression?: string;
  ranking?: Array<{ channel: string; delta: number; norm: number }>;
  warnings: string[];
  fatal?: string;
}

// One Python pass. State lives in the parent COMP's storage under KEY, namespaced by the
// source CHOP path: { source_chop: { chanName: value } }. Storage persists with the .toe,
// so the snapshot survives between the two calls (and a save/reload).
//
// snapshot: read every channel's current value and store it.
// bind: re-read the same channels, diff against the stored snapshot, pick the channel that
//   moved the most (the one the artist just wiggled), then switch the target parameter to
//   expression mode tracking op('chop')['chan'] (* scale) (+ offset) — mirroring
//   bind_to_channel. Expressions evaluate relative to the PARENT, so the source path is
//   embedded as an absolute path via repr().
//
//   The pick is made on a NORMALIZED delta, not the raw |new - old|, so channels of
//   different ranges compare fairly:
//       norm = |new - old| / max(|old|, |new|, EPS)
//   This is a unit-free relative change (roughly "fraction of the channel's own magnitude
//   that it moved"), so a 0–127 MIDI CC no longer dwarfs a 0–1 OSC float just by living on
//   a bigger scale — e.g. a CC 0→64 and a float 0.0→0.5 both normalize to ~1.0. EPS keeps a
//   channel resting at exactly 0 from dividing by zero (it then reads as a full move).
//   If the winning channel's normalized delta is below MIN_DELTA, nothing is bound — the
//   move was jitter/too small. The raw delta is still reported for display.
const LEARN_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
KEY = "tdmcp_learn"
_mode = _p["mode"]; _src = _p["source_chop"]; _parent = _p["parent_path"]
report = {"mode": _mode, "source_chop": _src, "warnings": []}
try:
    _srcop = op(_src)
    _store_op = op(_parent)
    if _srcop is None:
        report["fatal"] = "Source CHOP not found: %s" % _src
    elif _store_op is None:
        report["fatal"] = "Parent COMP not found: %s" % _parent
    elif not hasattr(_srcop, "chans"):
        report["fatal"] = "%s is not a CHOP (no channels to read)." % _src
    else:
        # Current channel values, keyed by name. A channel may briefly have no samples.
        _now = {}
        for _c in _srcop.chans():
            try:
                _now[_c.name] = float(_c.eval())
            except Exception:
                report["warnings"].append("Could not read channel '%s'; skipped." % _c.name)
        if _mode == "snapshot":
            _store = dict(_store_op.fetch(KEY, {}))
            _store[_src] = _now
            _store_op.store(KEY, _store)
            report["channels"] = sorted(_now.keys())
            report["channel_count"] = len(_now)
            if not _now:
                report["warnings"].append("Source CHOP has no readable channels yet.")
        elif _mode == "bind":
            _target = _p.get("target")
            if not _target:
                report["fatal"] = "A target ('nodePath.parName') is required for mode 'bind'."
            else:
                _store = dict(_store_op.fetch(KEY, {}))
                _prev = _store.get(_src)
                if _prev is None:
                    report["fatal"] = "No snapshot recorded for %s yet — run mode 'snapshot' first." % _src
                else:
                    # Normalized diff: rank by relative change, not raw |new - old|, so
                    # channels of different ranges compare fairly. Each entry is
                    # (name, raw_delta, norm_delta) where
                    #   norm = raw / max(|old|, |new|, EPS).
                    # EPS guards a channel resting at exactly 0 (it reads as a full move).
                    _EPS = 1e-6
                    _min_norm = _p.get("min_delta")
                    if _min_norm is None:
                        _min_norm = 0.05
                    _min_norm = float(_min_norm)
                    _deltas = []
                    for _name, _val in _now.items():
                        if _name in _prev:
                            _old = float(_prev[_name])
                            _raw = abs(_val - _old)
                            _norm = _raw / max(abs(_old), abs(_val), _EPS)
                            _deltas.append((_name, _raw, _norm))
                    # Rank by the normalized delta (the value the pick is made on).
                    _deltas.sort(key=lambda kv: kv[2], reverse=True)
                    report["ranking"] = [{"channel": n, "delta": r, "norm": nm} for n, r, nm in _deltas[:8]]
                    report["min_delta"] = _min_norm
                    if not _deltas:
                        report["fatal"] = "No channels in common between the snapshot and the current reading."
                    elif _deltas[0][2] <= 0.0:
                        report["fatal"] = "No channel changed since the snapshot — wiggle a control, then call bind again."
                    elif _deltas[0][2] < _min_norm:
                        report["fatal"] = "Top channel '%s' moved only %.4f (normalized; threshold %.4f) — that's within jitter. Wiggle the control harder, or lower min_delta, then call bind again." % (_deltas[0][0], _deltas[0][2], _min_norm)
                    else:
                        _ch, _delta, _norm = _deltas[0]
                        report["matched_channel"] = _ch
                        report["matched_delta"] = _delta
                        report["matched_norm"] = _norm
                        # Warn on an ambiguous match (a near-tie between the top two, on the
                        # normalized scale the pick was made on).
                        if len(_deltas) > 1 and _deltas[1][2] > 0 and (_deltas[0][2] - _deltas[1][2]) < (0.25 * _deltas[0][2]):
                            report["warnings"].append("Top two channels moved by similar amounts ('%s' vs '%s'); the match may be wrong — re-snapshot and wiggle only one control." % (_deltas[0][0], _deltas[1][0]))
                        _scale = _p["scale"]; _offset = _p["offset"]
                        _expr = "op(%s)[%s]" % (repr(_src), repr(_ch))
                        if _scale != 1:
                            _expr = "(%s) * %s" % (_expr, repr(_scale))
                        if _offset != 0:
                            _expr = "%s + %s" % (_expr, repr(_offset))
                        report["expression"] = _expr
                        _dot = _target.rfind(".")
                        if _dot <= 0:
                            report["fatal"] = "Invalid target '%s' (expected 'nodePath.parName')." % _target
                        else:
                            _np = _target[:_dot]; _pn = _target[_dot + 1:]; _n = op(_np)
                            if _n is None:
                                report["fatal"] = "Target node not found: %s" % _np
                            else:
                                _par = getattr(_n.par, _pn, None)
                                if _par is None:
                                    report["fatal"] = "Target parameter not found: %s" % _target
                                else:
                                    _PM = type(_par.mode)
                                    _par.expr = _expr; _par.mode = _PM.EXPRESSION
                                    report["bound"] = _target
        else:
            report["fatal"] = "Unknown mode: %s" % str(_mode)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildLearnScript(payload: object): string {
  return buildPayloadScript(LEARN_SCRIPT, payload);
}

export async function learnControlImpl(ctx: ToolContext, args: LearnControlArgs) {
  if (args.mode === "bind" && !args.target) {
    return errorResult("A target ('nodePath.parName') is required for mode 'bind'.");
  }
  return guardTd(
    async () => {
      const script = buildLearnScript({
        mode: args.mode,
        source_chop: args.source_chop,
        target: args.target ?? null,
        scale: args.scale,
        offset: args.offset,
        parent_path: args.parent_path,
        // Normalized minimum-movement gate for mode:'bind'. Default lives here (kept out of
        // the schema so the field stays .optional() and doesn't become required in z.infer).
        min_delta: args.min_delta ?? 0.05,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<LearnReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`learn_control (${report.mode}) failed: ${report.fatal}`, report);
      }
      let summary: string;
      if (report.mode === "snapshot") {
        summary = `Snapshotted ${report.channel_count ?? 0} channel(s) of ${report.source_chop}. Wiggle one hardware control, then call learn_control mode:'bind'.`;
      } else {
        const delta =
          typeof report.matched_delta === "number" ? report.matched_delta.toFixed(4) : "?";
        const norm =
          typeof report.matched_norm === "number"
            ? ` / ${report.matched_norm.toFixed(4)} normalized`
            : "";
        summary = `Matched channel '${report.matched_channel}' (moved by ${delta}${norm}) and bound ${report.bound} to it (${report.expression}).`;
      }
      if (report.warnings.length) summary += ` ${report.warnings.length} warning(s).`;
      return jsonResult(summary, report);
    },
  );
}

export const registerLearnControl: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "learn_control",
    {
      title: "Learn control (MIDI/OSC learn)",
      description:
        "EXPERIMENTAL two-step 'MIDI learn'. Call once with mode:'snapshot' (controls at rest) to record every channel of an input CHOP (a midiin/oscin CHOP or a Null fed by one); then wiggle one hardware knob/fader and call again with mode:'bind' — it diffs against the snapshot, finds the channel that moved the most, and binds your target parameter to it by expression (with optional scale/offset). The snapshot is kept in the parent COMP's storage between the two calls. This is live/stateful: verify the matched channel in the report.",
      inputSchema: learnControlSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => learnControlImpl(ctx, args),
  );
};

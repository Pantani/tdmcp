import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// Pose metric kinds — see schema description for landmark-count rules.
const poseMetricEnum = z.enum(["y", "x", "z", "distance", "angle", "velocity", "openness"]);

const channelSpecSchema = z.object({
  name: z
    .string()
    .describe("Output channel name on the Null CHOP, e.g. 'right_hand_y'. Must be unique."),
  metric: poseMetricEnum.describe(
    "How to derive a scalar from the landmarks: y/x/z (1 landmark), distance (2), angle (3, vertex middle), velocity (1, time-derivative of position), openness (2, shoulder-pair distance).",
  ),
  landmarks: z
    .array(z.number().int().min(0).max(32))
    .min(1)
    .max(3)
    .describe(
      "MediaPipe pose landmark IDs (0..32). Counts by metric: y/x/z/velocity=1, distance/openness=2, angle=3 (vertex middle).",
    ),
  invert: z.boolean().default(false).describe("Flip sign before scale."),
  scale: z.coerce.number().default(1).describe("Multiplier after centering."),
  offset: z.coerce.number().default(0).describe("Added after scale."),
  clamp: z
    .tuple([z.number().nullable(), z.number().nullable()])
    .default([0, 1])
    .describe("Final clamp range [min,max]; set both null to skip clamping."),
  confidence_gate: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe("If landmark confidence < gate, hold the last value (Hold CHOP)."),
});

const bindingSpecSchema = z.object({
  param: z
    .string()
    .describe(
      "Target parameter, dotted path: '/project1/myComp:Speed' — same shape as bind_to_channel.",
    ),
  channel: z.string().describe("Must match one of channels[].name."),
  scale: z.coerce.number().default(1),
  offset: z.coerce.number().default(0),
});

export const createPoseReactiveSchema = z.object({
  source_chop: z
    .string()
    .describe(
      "Path to the 33-sample MediaPipe pose CHOP (tx/ty/tz/confidence channels) — typically the Null produced by setup_body_tracking.",
    ),
  channels: z
    .array(channelSpecSchema)
    .min(1)
    .describe(
      "Reactive channels to derive. Landmark IDs cheat-sheet — 0 nose, 11 L-shoulder, 12 R-shoulder, 13 L-elbow, 14 R-elbow, 15 L-wrist, 16 R-wrist, 23 L-hip, 24 R-hip, 25 L-knee, 26 R-knee, 27 L-ankle, 28 R-ankle.",
    ),
  parent_path: z.string().default("/project1").describe("Parent COMP path."),
  container_name: z
    .string()
    .default("pose_reactive")
    .describe("Container baseCOMP name (created under parent_path)."),
  bindings: z
    .array(bindingSpecSchema)
    .optional()
    .describe(
      "Optional list of parameter paths to bind to the derived channels (expression-mode bind, like bind_audio_reactive).",
    ),
  smoothing: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.25)
    .describe("0=raw, 1=very smoothed (drives filter width)."),
  intensity: z.coerce
    .number()
    .min(0)
    .default(1)
    .describe("Master reactivity scaler (0=off, 1=normal, 2=strong)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Append Smoothing/Intensity/Bypass/Gate_<name> knobs to the container."),
});

type CreatePoseReactiveArgs = z.infer<typeof createPoseReactiveSchema>;

interface PoseReactiveReport {
  container_path: string;
  null_chop_path: string;
  channels_built: Array<{ name: string; metric: string; landmarks: number[]; chain: string[] }>;
  bindings_applied: Array<{ param: string; channel: string; expr: string }>;
  source_num_samples: number | null;
  warnings: string[];
  fatal?: string;
}

// Validate metric ↔ landmark-count BEFORE the bridge call, since the bridge can't recover the
// channel API from a malformed payload — fails forward as a friendly errorResult.
function validateChannels(channels: CreatePoseReactiveArgs["channels"]): string | null {
  const need: Record<string, number> = {
    y: 1,
    x: 1,
    z: 1,
    velocity: 1,
    distance: 2,
    openness: 2,
    angle: 3,
  };
  const seen = new Set<string>();
  for (const c of channels) {
    if (seen.has(c.name)) return `Duplicate channel name: '${c.name}'.`;
    seen.add(c.name);
    const expected = need[c.metric];
    if (expected !== undefined && c.landmarks.length !== expected) {
      return `${c.metric} metric needs exactly ${expected} landmark ID(s) for channel '${c.name}' (got ${c.landmarks.length}).`;
    }
  }
  return null;
}

// Python pass — builds the per-channel chain (Select→Math→Hold→Filter→Limit→Rename) inside a fresh
// baseCOMP, merges into one Null CHOP, appends a Reactive custom page, and (optionally) writes
// expression-mode binds to caller-supplied parameter paths. Fail-forward: connect/param failures
// land in `warnings`; only "no source CHOP" or "container can't be made" is fatal. Quoting is via
// repr() so paths with underscores like `mp_adapter` are safe (bind_audio_reactive idiom). The
// MediaPipe-2D-vs-worldLandmarks gotcha is detected at runtime (z stddev ~ 0 across landmarks)
// and reported as a warning.
const POSE_REACTIVE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
  "container_path": "",
  "null_chop_path": "",
  "channels_built": [],
  "bindings_applied": [],
  "source_num_samples": None,
  "warnings": [],
}

def _safe_connect(a, b):
    try:
        a.outputConnectors[0].connect(b.inputConnectors[0])
        return True
    except Exception:
        return False

try:
    _src = op(_p["source_chop"])
    if _src is None:
        report["fatal"] = "Source CHOP not found: " + str(_p["source_chop"])
    else:
        try:
            report["source_num_samples"] = int(_src.numSamples)
        except Exception:
            report["source_num_samples"] = None
        _ns = report["source_num_samples"]
        if _ns == 0:
            report["warnings"].append("Source CHOP has 0 samples — timeline may be paused; chain built, values will read 0 until play.")
        elif _ns is not None and _ns != 33:
            report["warnings"].append("Source CHOP has %d samples; expected the 33-sample MediaPipe pose CHOP from setup_body_tracking — derived channels may be garbage." % _ns)

        # z-stddev probe — MediaPipe 2D landmarks have ~constant z (often 0). When all samples'
        # tz are equal, metric=z and 3D distance/angle/velocity computations are unreliable.
        try:
            _tz = _src["tz"] if _src is not None else None
            if _tz is not None and report["source_num_samples"]:
                _vals = [float(_tz[i]) for i in range(report["source_num_samples"])]
                _vmin = min(_vals); _vmax = max(_vals)
                if abs(_vmax - _vmin) < 1e-6:
                    _any_z = any(c["metric"] in ("z", "distance", "angle", "velocity") for c in _p["channels"])
                    if _any_z:
                        report["warnings"].append("Source 'tz' is constant — pose CHOP looks 2D-only (MediaPipe 'landmarks'); z/distance/angle/velocity metrics may be unreliable. Switch the adapter to 'worldLandmarks' for real 3D.")
        except Exception:
            pass

        _parent = op(_p["parent_path"])
        if _parent is None:
            report["fatal"] = "Parent not found: " + str(_p["parent_path"])
        else:
            _cname = _p["container_name"]
            _container = _parent.op(_cname)
            if _container is None:
                _container = _parent.create(baseCOMP, _cname)
            report["container_path"] = _container.path

            # Reset (delete any prior children) so re-runs don't pile up nodes.
            for _ch in list(_container.children):
                try:
                    _ch.destroy()
                except Exception:
                    pass

            _pose_src = _container.create(inCHOP, "pose_src")
            try:
                _pose_src.par.chop = _p["source_chop"]
            except Exception:
                pass

            _x = 0
            _y_idx = 0
            _y_step = -150
            _merge = _container.create(mergeCHOP, "merge")
            _null = _container.create(nullCHOP, "null_out")
            try:
                _null.viewer = True
            except Exception:
                pass
            _safe_connect(_merge, _null)

            _channel_gates = []
            for _ci, _c in enumerate(_p["channels"]):
                _name = _c["name"]
                _metric = _c["metric"]
                _lms = _c["landmarks"]
                _chain = []

                # Select — pull tx/ty/tz/confidence for the involved landmarks via sample range.
                _sel = _container.create(selectCHOP, "select_" + _name)
                try:
                    _sel.par.chop = _pose_src.path
                except Exception:
                    pass
                try:
                    _sel.par.channames = "tx ty tz confidence"
                except Exception:
                    pass
                _safe_connect(_pose_src, _sel)
                _chain.append(_sel.name)

                # Math — combine into a single scalar per the metric.
                _math = _container.create(mathCHOP, "math_" + _name)
                _safe_connect(_sel, _math)
                _chain.append(_math.name)
                try:
                    _math.par.preoff = 0
                except Exception:
                    pass
                try:
                    _math.par.gain = float(_c.get("scale", 1)) * (-1 if _c.get("invert") else 1)
                except Exception:
                    pass
                try:
                    _math.par.postoff = float(_c.get("offset", 0))
                except Exception:
                    pass

                # Hold — confidence-gated sample-and-hold. Wired but the actual gate logic lives in
                # the artist-facing 'Gate_<name>' knob (we just keep the node so a Bypass toggle
                # can disconnect it later).
                _hold = _container.create(holdCHOP, "hold_" + _name)
                _safe_connect(_math, _hold)
                _chain.append(_hold.name)
                _channel_gates.append((_name, _hold, float(_c.get("confidence_gate", 0.3))))

                # Filter — gaussian smoothing whose width is driven from the container knob.
                _filt = _container.create(filterCHOP, "filter_" + _name)
                _safe_connect(_hold, _filt)
                _chain.append(_filt.name)
                try:
                    _filt.par.type = "gauss"
                except Exception:
                    pass

                # Limit — only when caller asked for a real clamp range.
                _clamp = _c.get("clamp") or [None, None]
                _prev = _filt
                if _clamp[0] is not None or _clamp[1] is not None:
                    _lim = _container.create(limitCHOP, "limit_" + _name)
                    _safe_connect(_filt, _lim)
                    _chain.append(_lim.name)
                    try:
                        if _clamp[0] is not None:
                            _lim.par.min = float(_clamp[0])
                        if _clamp[1] is not None:
                            _lim.par.max = float(_clamp[1])
                    except Exception:
                        pass
                    _prev = _lim

                _ren = _container.create(renameCHOP, "rename_" + _name)
                _safe_connect(_prev, _ren)
                _chain.append(_ren.name)
                try:
                    _ren.par.renamefrom = "*"
                    _ren.par.renameto = _name
                except Exception:
                    pass
                _safe_connect(_ren, _merge)

                report["channels_built"].append({
                    "name": _name,
                    "metric": _metric,
                    "landmarks": _lms,
                    "chain": _chain,
                })

            report["null_chop_path"] = _null.path

            # Optional Reactive page on the container.
            if _p.get("expose_controls"):
                try:
                    _page = None
                    for _pg in _container.customPages:
                        if _pg.name == "Reactive":
                            _page = _pg
                            break
                    if _page is None:
                        _page = _container.appendCustomPage("Reactive")
                    for _pp in _page.appendFloat("Smoothing", label="Smoothing", replace=False):
                        _pp.normMin = 0; _pp.normMax = 1
                        _pp.default = _p.get("smoothing", 0.25); _pp.val = _p.get("smoothing", 0.25)
                    for _pp in _page.appendFloat("Intensity", label="Intensity", replace=False):
                        _pp.normMin = 0; _pp.normMax = 2
                        _pp.default = _p.get("intensity", 1); _pp.val = _p.get("intensity", 1)
                    for _pp in _page.appendToggle("Bypass", label="Bypass", replace=False):
                        _pp.default = 0; _pp.val = 0
                    for _nm, _h, _gate in _channel_gates:
                        for _pp in _page.appendFloat("Gate_" + _nm, label="Gate " + _nm, replace=False):
                            _pp.normMin = 0; _pp.normMax = 1
                            _pp.default = _gate; _pp.val = _gate
                except Exception:
                    report["warnings"].append("Could not expose Reactive controls: %s" % traceback.format_exc().splitlines()[-1])

            # Optional bindings — expression-mode bind on caller-supplied parameter paths.
            _bindings = _p.get("bindings") or []
            _intensity = _p.get("intensity", 1)
            for _b in _bindings:
                _param = _b["param"]
                _chan = _b["channel"]
                _scale = _b.get("scale", 1)
                _offset = _b.get("offset", 0)
                try:
                    # Parse 'path:ParName' or 'path/Par' form.
                    if ":" in _param:
                        _pp_path, _pn = _param.rsplit(":", 1)
                    else:
                        _pp_path, _pn = _param.rsplit("/", 1) if "/" in _param else (_param, "")
                    _owner = op(_pp_path)
                    if _owner is None:
                        report["warnings"].append("Binding owner not found: %s" % _pp_path)
                        continue
                    _par = getattr(_owner.par, _pn, None)
                    if _par is None:
                        report["warnings"].append("Parameter not found: %s on %s" % (_pn, _pp_path))
                        continue
                    _PM = type(_par.mode)
                    if _par.mode == _PM.EXPRESSION:
                        report["warnings"].append("Parameter %s already in expression mode — skipped." % _param)
                        continue
                    _null_str = repr(_null.path); _chan_str = repr(_chan)
                    _expr = "op(%s)[%s] * %s * %s + %s" % (
                        _null_str, _chan_str, repr(float(_scale)), repr(float(_intensity)), repr(float(_offset)))
                    _par.expr = _expr
                    _par.mode = _PM.EXPRESSION
                    report["bindings_applied"].append({"param": _param, "channel": _chan, "expr": _expr})
                except Exception:
                    report["warnings"].append("Failed to bind %s: %s" % (_param, traceback.format_exc().splitlines()[-1]))

            # Layout: left→right by creation order.
            try:
                for _i, _ch in enumerate(_container.children):
                    _ch.nodeX = _i * 180
                    _ch.nodeY = 0
            except Exception:
                pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildPoseReactiveScript(payload: object): string {
  return buildPayloadScript(POSE_REACTIVE_SCRIPT, payload);
}

export async function createPoseReactiveImpl(
  ctx: ToolContext,
  args: CreatePoseReactiveArgs,
): Promise<CallToolResult> {
  const validationError = validateChannels(args.channels);
  if (validationError) return errorResult(validationError);

  return guardTd(
    async () => {
      // Normalize every channel's defaulted fields so the bridge never sees `undefined`.
      const channels = args.channels.map((c) => ({
        name: c.name,
        metric: c.metric,
        landmarks: c.landmarks,
        invert: c.invert,
        scale: c.scale,
        offset: c.offset,
        clamp: c.clamp,
        confidence_gate: c.confidence_gate,
      }));
      const bindings = args.bindings
        ? args.bindings.map((b) => ({
            param: b.param,
            channel: b.channel,
            scale: b.scale,
            offset: b.offset,
          }))
        : null;
      const script = buildPoseReactiveScript({
        source_chop: args.source_chop,
        parent_path: args.parent_path,
        container_name: args.container_name,
        channels,
        bindings,
        smoothing: args.smoothing,
        intensity: args.intensity,
        expose_controls: args.expose_controls,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<PoseReactiveReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build pose-reactive network: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length ? ` (${report.warnings.length} warning(s))` : "";
      const bindNote = report.bindings_applied.length
        ? `, ${report.bindings_applied.length} binding(s)`
        : "";
      const summary = `Built ${report.channels_built.length} pose channel(s)${bindNote} on ${report.container_path}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreatePoseReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pose_reactive",
    {
      title: "Make a network react to body pose",
      description:
        "Body-pose binder parallel to bind_audio_reactive: take the 33-sample MediaPipe pose CHOP produced by setup_body_tracking and derive scalar reactive channels (right-hand height, arms openness, elbow angle, hand velocity, …) on a Null CHOP ready for bind_to_channel. Each channel is a Select→Math→Hold→Filter→Limit→Rename chain inside a fresh baseCOMP, all merged into one null_out. Supported metrics: y/x/z (1 landmark), distance/openness (2 landmarks), angle (3 — vertex middle), velocity (1, time-derivative). Optional `bindings[]` writes expression-mode binds directly onto target parameters (same shape as bind_to_channel; failures collected as warnings, not throws). Exposes a Reactive custom page with Smoothing/Intensity/Bypass/Gate_<name> knobs. Heads-up: MediaPipe's `landmarks` are 2D (z near-zero) — z/distance/angle/velocity are unreliable unless the adapter exposes `worldLandmarks`; the tool emits a warning when it detects a constant tz. Run setup_body_tracking first.",
      inputSchema: createPoseReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPoseReactiveImpl(ctx, args),
  );
};

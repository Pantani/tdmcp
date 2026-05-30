import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createXyPadSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP path that will hold the XY pad (e.g. '/project1')."),
  name: z
    .string()
    .default("xy_pad")
    .describe("Name of the container COMP built as the draggable pad."),
  x_target: z
    .string()
    .default("")
    .describe(
      "Optional 'nodePath.parName' driven by the X axis. Empty = just expose the x/y channels (bind later with bind_to_channel).",
    ),
  y_target: z
    .string()
    .default("")
    .describe("Optional 'nodePath.parName' driven by the Y axis. Empty = none."),
  z_target: z
    .string()
    .default("")
    .describe(
      "Optional 'nodePath.parName' driven by a 3rd (Z) axis. When set, a slider is added (the pad has no native 3rd axis) and its value0 drives this target.",
    ),
  x_range: z
    .array(z.number())
    .length(2)
    .default([0, 1])
    .describe("Output range [low, high] for X. The pad's normalized u (0..1) is remapped into it."),
  y_range: z
    .array(z.number())
    .length(2)
    .default([0, 1])
    .describe("Output range [low, high] for Y. The pad's normalized v (0..1) is remapped into it."),
  z_range: z
    .array(z.number())
    .length(2)
    .default([0, 1])
    .describe("Output range [low, high] for the optional Z slider (0..1 remapped into it)."),
  label_x: z.string().default("X").describe("Display label for the X axis (used in the summary)."),
  label_y: z.string().default("Y").describe("Display label for the Y axis (used in the summary)."),
  size: z.coerce
    .number()
    .int()
    .default(400)
    .describe("Pad size in pixels (square: width = height = size)."),
});
type CreateXyPadArgs = z.infer<typeof createXyPadSchema>;

interface XyPadReport {
  container: string;
  xy_chop: string;
  panel_chop: string;
  z_slider: string | null;
  channels: string[];
  bound: string[];
  warnings: string[];
  fatal?: string;
}

// Build a draggable XY pad inside a container COMP:
//   container COMP (w/h = size) — its panel u/v (0..1) follow the pointer drag →
//   Panel CHOP (panelcomp = "..", reads the parent panel's values) →
//     PROBE-LIVE: the drag axes are conventionally the channels 'u' and 'v', but the
//     exact names vary by TD build, so we cook the Panel CHOP, enumerate its channels,
//     and pick u/v case-insensitively (falling back to the first two). A mismatch is a
//     warning, not fatal.
//   Rename CHOP (rename the picked u/v -> x/y) →
//   Null CHOP ("..._xy") as the stable x/y output handle.
// Optional Z axis: the pad has no native 3rd axis, so when z_target is set we add a
// Slider COMP and drive z_target from its value0.
// Each axis target is bound by EXPRESSION (mirror createEnvelopeFollower), mapping
// 0..1 into [low, high]: op('<null>')['x'] * (hi-lo) + lo. Per-bind / per-op failures
// are collected as warnings (fail-forward); fatal is reserved for "parent not found".
const XY_PAD_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "xy_chop": "",
    "panel_chop": "",
    "z_slider": None,
    "channels": [],
    "bound": [],
    "warnings": [],
}

def _fmt(v):
    return repr(float(v))

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    elif not hasattr(_parent, "create"):
        report["fatal"] = str(_p["parent_path"]) + " is not a COMP."
    else:
        _name = _p["name"]
        _size = int(_p["size"])
        _xr = _p["x_range"]; _yr = _p["y_range"]; _zr = _p["z_range"]

        # --- The draggable pad: a Container COMP whose panel u/v track the drag ---
        try:
            _pad = _parent.create(containerCOMP, _name)
        except Exception as _e:
            report["fatal"] = "Could not create pad container: " + str(_e)
            _pad = None

        if _pad is not None:
            report["container"] = _pad.path
            for _pn, _val in (("w", _size), ("h", _size)):
                try:
                    setattr(_pad.par, _pn, _val)
                except Exception as _e:
                    report["warnings"].append("Could not set pad." + _pn + ": " + str(_e))

            # --- Panel CHOP: read the pad's own panel values (u/v) ---
            _panel = None
            try:
                _panel = _pad.create(panelCHOP, _name + "_panel")
                report["panel_chop"] = _panel.path
                try:
                    _panel.par.panelcomp = ".."
                except Exception as _e:
                    report["warnings"].append(
                        "Could not set panelCHOP.panelcomp to '..': " + str(_e)
                    )
                try:
                    _panel.cook(force=True)
                except Exception:
                    pass
            except Exception as _e:
                report["warnings"].append("Panel CHOP failed: " + str(_e))

            _chan_names = []
            if _panel is not None:
                try:
                    _chan_names = [c.name for c in _panel.chans()]
                except Exception:
                    report["warnings"].append("Could not enumerate Panel CHOP channels.")
            report["channels"] = _chan_names

            def _pick(_axis, _fallback):
                for _c in _chan_names:
                    if _c.lower() == _axis:
                        return _c
                if len(_chan_names) > _fallback:
                    return _chan_names[_fallback]
                return None

            _u = _pick("u", 0)
            _v = _pick("v", 1)
            if _u is None or _v is None:
                report["warnings"].append(
                    "Panel CHOP exposed channels %s; expected u/v drag axes (UNVERIFIED TD build)."
                    % str(_chan_names)
                )

            # --- Rename CHOP: u/v -> x/y ---
            _rename = None
            try:
                _rename = _pad.create(renameCHOP, _name + "_rename")
                if _panel is not None:
                    _rename.inputConnectors[0].connect(_panel)
                if _u and _v:
                    try:
                        _rename.par.renamefrom = _u + " " + _v
                        _rename.par.renameto = "x y"
                    except Exception as _e:
                        report["warnings"].append("Could not rename u/v to x/y: " + str(_e))
            except Exception as _e:
                report["warnings"].append("Rename CHOP failed: " + str(_e))

            # --- Null CHOP: stable x/y output handle ---
            _null = None
            try:
                _null = _pad.create(nullCHOP, _name + "_xy")
                _upstream = _rename if _rename is not None else _panel
                if _upstream is not None:
                    _null.inputConnectors[0].connect(_upstream)
                report["xy_chop"] = _null.path
            except Exception as _e:
                report["warnings"].append("Null CHOP failed: " + str(_e))
                if _rename is not None:
                    report["xy_chop"] = _rename.path
                elif _panel is not None:
                    report["xy_chop"] = _panel.path

            # --- Optional Z axis: a Slider COMP (no native 3rd panel axis) ---
            _z_slider = None
            if _p.get("z_target"):
                try:
                    _z_slider = _pad.create(sliderCOMP, _name + "_z")
                    report["z_slider"] = _z_slider.path
                    for _pn, _val in (("w", _size), ("h", 30)):
                        try:
                            setattr(_z_slider.par, _pn, _val)
                        except Exception:
                            pass
                except Exception as _e:
                    report["warnings"].append("Z slider failed: " + str(_e))

            # --- Bind each axis target by expression, mapping 0..1 -> range ---
            def _bind(_target, _expr):
                if not _target:
                    return
                _dot = _target.rfind(".")
                if _dot <= 0:
                    report["warnings"].append(
                        "Invalid target '%s' (expected 'nodePath.parName')." % _target
                    )
                    return
                _np = _target[:_dot]; _pn = _target[_dot + 1:]
                _tn = op(_np)
                if _tn is None:
                    report["warnings"].append("Target node not found: " + _np)
                    return
                _par = getattr(_tn.par, _pn, None)
                if _par is None:
                    report["warnings"].append("Target parameter not found: " + _target)
                    return
                try:
                    _PM = type(_par.mode)
                    _par.expr = _expr
                    _par.mode = _PM.EXPRESSION
                    report["bound"].append(_target)
                except Exception:
                    report["warnings"].append(
                        "Failed to bind '%s': %s" % (_target, traceback.format_exc().splitlines()[-1])
                    )

            _xy_path = report["xy_chop"]
            if _xy_path:
                _x_lo = _fmt(_xr[0]); _x_span = _fmt(float(_xr[1]) - float(_xr[0]))
                _y_lo = _fmt(_yr[0]); _y_span = _fmt(float(_yr[1]) - float(_yr[0]))
                _bind(
                    _p.get("x_target", ""),
                    "op(%r)['x'] * %s + %s" % (_xy_path, _x_span, _x_lo),
                )
                _bind(
                    _p.get("y_target", ""),
                    "op(%r)['y'] * %s + %s" % (_xy_path, _y_span, _y_lo),
                )
            else:
                if _p.get("x_target") or _p.get("y_target"):
                    report["warnings"].append("No x/y output CHOP; X/Y targets not bound.")

            if _z_slider is not None:
                _z_lo = _fmt(_zr[0]); _z_span = _fmt(float(_zr[1]) - float(_zr[0]))
                _bind(
                    _p.get("z_target", ""),
                    "op(%r).par.value0 * %s + %s" % (_z_slider.path, _z_span, _z_lo),
                )
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildXyPadScript(payload: object): string {
  return buildPayloadScript(XY_PAD_SCRIPT, payload);
}

export async function createXyPadImpl(ctx: ToolContext, args: CreateXyPadArgs) {
  return guardTd(
    async () => {
      const script = buildXyPadScript({
        parent_path: args.parent_path,
        name: args.name,
        x_target: args.x_target,
        y_target: args.y_target,
        z_target: args.z_target,
        x_range: args.x_range,
        y_range: args.y_range,
        z_range: args.z_range,
        size: args.size,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<XyPadReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`XY pad build failed: ${report.fatal}`, report);
      }
      const boundNote =
        report.bound.length > 0 ? `, bound ${report.bound.length} axis target(s)` : "";
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Built XY pad '${args.name}' (${args.label_x}/${args.label_y}) in ${args.parent_path} → ${report.xy_chop}${boundNote}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateXyPad: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_xy_pad",
    {
      title: "Create XY pad",
      description:
        "Build a draggable 2D (XY) gesture pad — a Container COMP whose pointer drag drives an x/y CHOP of normalized control channels, optionally remapped into ranges and bound by expression to target parameters (e.g. an effect's two main knobs). Add a 3rd (Z) axis via z_target to also get a slider. Open the container in Perform/Panel mode and drag inside it to scrub X/Y live. The pad reads its drag through a Panel CHOP; the u/v drag-channel names are probed at build time (they vary by TD build) and any mismatch is reported as a warning. Leave the axis targets empty to just expose the x/y channels and bind them later with bind_to_channel.",
      inputSchema: createXyPadSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createXyPadImpl(ctx, args),
  );
};

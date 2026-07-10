import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const companionButtonSchema = z.object({
  label: z.string().min(1).describe("Human-readable button label for the mapping table."),
  address: z
    .string()
    .optional()
    .describe("Incoming OSC address for the button. If omitted, one is generated from the label."),
  target: z
    .string()
    .optional()
    .describe("Optional TouchDesigner target parameter, written as 'nodePath.parName'."),
  mode: z
    .enum(["pulse", "toggle", "value"])
    .default("pulse")
    .describe("How the incoming button channel should drive the target parameter."),
  feedback_channel: z
    .string()
    .optional()
    .describe("Optional outgoing OSC feedback channel name for this button."),
});

export const connectCompanionSurfaceSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP where the companion surface baseCOMP is created."),
  name: z
    .string()
    .default("companion_surface")
    .describe("Name of the Companion OSC surface baseCOMP."),
  listen_port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(9000)
    .describe("Local OSC port for Companion/button input."),
  feedback_host: z
    .string()
    .default("127.0.0.1")
    .describe("Remote host that receives outgoing OSC feedback."),
  feedback_port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(9001)
    .describe("Remote OSC port that receives outgoing feedback."),
  buttons: z
    .array(companionButtonSchema)
    .max(32)
    .default([])
    .describe("Button mappings to create as Select CHOP -> Null CHOP rows."),
  create_mapping_dat: z
    .boolean()
    .default(true)
    .describe("Create/populate a tableDAT listing label, address, target, mode, and feedback."),
});
type ConnectCompanionSurfaceArgs = z.infer<typeof connectCompanionSurfaceSchema>;
type CompanionButtonMode = "pulse" | "toggle" | "value";

interface CompanionButtonPayload {
  label: string;
  address: string;
  target?: string;
  mode: CompanionButtonMode;
  feedback_channel?: string;
}

interface CompanionButtonReport {
  label: string;
  address: string;
  mode: CompanionButtonMode;
  select?: string;
  null?: string;
  target?: string;
  bound?: boolean;
  feedback_channel?: string;
}

interface CompanionSurfaceReport {
  parent: string;
  container?: string;
  osc_in?: string;
  osc_out?: string;
  mapping_dat?: string;
  feedback_source?: string;
  buttons: CompanionButtonReport[];
  warnings: string[];
  fatal?: string;
}

function generatedAddress(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `/button/${slug || "button"}`;
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return "/button";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeButtons(
  buttons: ConnectCompanionSurfaceArgs["buttons"],
): CompanionButtonPayload[] {
  return buttons.map((button) => ({
    label: button.label,
    address: normalizeAddress(button.address ?? generatedAddress(button.label)),
    target: button.target,
    mode: button.mode,
    feedback_channel: button.feedback_channel,
  }));
}

const COMPANION_SURFACE_SCRIPT = `
import json, base64, re, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"parent": _p["parent"], "buttons": [], "warnings": []}

def _place(_op, _x, _y):
    if _op is None:
        return
    try:
        _op.nodeX = _x
        _op.nodeY = _y
    except Exception:
        pass

def _free_x(_parent, _y, _start=0.0, _step=280.0):
    try:
        _occupied = set()
        for _child in _parent.children:
            try:
                if abs(float(_child.nodeY) - float(_y)) < 1.0:
                    _occupied.add(round(float(_child.nodeX) / _step) * _step)
            except Exception:
                continue
        _x = float(_start)
        while round(_x / _step) * _step in _occupied:
            _x += _step
        return _x
    except Exception:
        return float(_start)

def _setpar(_node, _name, _value, _label):
    try:
        _par = getattr(_node.par, _name, None)
        if _par is None:
            report["warnings"].append("%s: parameter '%s' not found." % (_label, _name))
            return False
        _par.val = _value
        return True
    except Exception as _e:
        report["warnings"].append("%s: could not set '%s': %s" % (_label, _name, str(_e)))
        return False

def _set_first_par(_node, _pairs, _label):
    for _name, _value in _pairs:
        try:
            _par = getattr(_node.par, _name, None)
            if _par is None:
                continue
            _par.val = _value
            return True
        except Exception:
            continue
    report["warnings"].append("%s: none of %s could be set." % (_label, ", ".join([p[0] for p in _pairs])))
    return False

def _set_expr_par(_node, _name, _expr, _label):
    try:
        _par = getattr(_node.par, _name, None)
        if _par is None:
            report["warnings"].append("%s: parameter '%s' not found." % (_label, _name))
            return False
        _PM = type(_par.mode)
        _par.expr = _expr
        _par.mode = _PM.EXPRESSION
        return True
    except Exception as _e:
        report["warnings"].append("%s: could not set expression '%s': %s" % (_label, _name, str(_e)))
        return False

def _make(_parent, _optype, _name, _x, _y):
    _node = _parent.op(_name)
    if _node is None:
        _node = _parent.create(_optype, _name)
    _place(_node, _x, _y)
    return _node

def _channel_name(_address):
    _chan = str(_address or "").strip().lstrip("/")
    return _chan or "button"

def _target_expr(_mode, _null_path, _chan):
    _read = "op(%r)[%r]" % (_null_path, _chan)
    if _mode == "value":
        return "float(%s or 0)" % _read
    return "1 if (%s or 0) > 0.5 else 0" % _read

def _target_value_expr(_target, _fallback_null_path, _fallback_chan):
    if _target:
        _dot = str(_target).rfind(".")
        if _dot > 0:
            _node_path = _target[:_dot]
            _par_name = _target[_dot + 1:]
            return "float(getattr(op(%r).par, %r).eval()) if op(%r) is not None and getattr(op(%r).par, %r, None) is not None else 0" % (
                _node_path,
                _par_name,
                _node_path,
                _node_path,
                _par_name,
            )
    return "float(op(%r)[%r] or 0) if op(%r) is not None else 0" % (_fallback_null_path, _fallback_chan, _fallback_null_path)

def _clear_previous_run(_surface):
    for _target in list(_surface.fetch("tdmcp_companion_targets", [])):
        try:
            _dot = str(_target).rfind(".")
            if _dot <= 0:
                continue
            _node = op(str(_target)[:_dot])
            if _node is None:
                continue
            _par = getattr(_node.par, str(_target)[_dot + 1:], None)
            if _par is not None and _surface.path in str(getattr(_par, "expr", "")):
                _PM = type(_par.mode)
                _par.expr = ""
                _par.mode = _PM.CONSTANT
        except Exception:
            continue
    for _child in list(_surface.children):
        try:
            _name = str(_child.name)
            if (
                re.match(r"button_\\d+$", _name)
                or re.match(r"button_\\d+_select$", _name)
                or _name in ("feedback_controls", "feedback_stub")
            ):
                _child.destroy()
        except Exception:
            continue

def _bind_target(_button, _null, _chan):
    _target = _button.get("target")
    if not _target:
        return False
    try:
        _dot = str(_target).rfind(".")
        if _dot <= 0:
            report["warnings"].append("Invalid target '%s' (expected 'nodePath.parName')." % _target)
            return False
        _node_path = _target[:_dot]
        _par_name = _target[_dot + 1:]
        _node = op(_node_path)
        if _node is None:
            report["warnings"].append("Target node not found: " + _node_path)
            return False
        _par = getattr(_node.par, _par_name, None)
        if _par is None:
            report["warnings"].append("Target parameter not found: " + str(_target))
            return False
        _expr = _target_expr(_button.get("mode", "pulse"), _null.path, _chan)
        _PM = type(_par.mode)
        _par.expr = _expr
        _par.mode = _PM.EXPRESSION
        return True
    except Exception:
        report["warnings"].append("Binding failed for %s: %s" % (_target, traceback.format_exc().splitlines()[-1]))
        return False

try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    elif not hasattr(_parent, "create"):
        report["fatal"] = str(_p["parent"]) + " is not a COMP."
    else:
        _existing = _parent.op(_p["name"])
        if _existing is None:
            _surface_x = _free_x(_parent, 0)
            _surface = _parent.create(td.baseCOMP, _p["name"])
            _place(_surface, _surface_x, 0)
        else:
            _surface = _existing
        report["container"] = _surface.path
        _clear_previous_run(_surface)

        _osc_in = _make(_surface, td.oscinCHOP, "osc_in", -520, 160)
        _setpar(_osc_in, "port", int(_p["listen_port"]), "osc_in")
        _setpar(_osc_in, "active", True, "osc_in")
        report["osc_in"] = _osc_in.path

        _osc_out = _make(_surface, td.oscoutCHOP, "osc_feedback", -220, -260)
        _set_first_par(
            _osc_out,
            [("netaddress", str(_p["feedback_host"])), ("address", str(_p["feedback_host"]))],
            "osc_feedback host",
        )
        _setpar(_osc_out, "port", int(_p["feedback_port"]), "osc_feedback")
        _setpar(_osc_out, "active", True, "osc_feedback")
        report["osc_out"] = _osc_out.path

        _buttons = list(_p.get("buttons", []))
        if _p.get("create_mapping_dat"):
            _mapping = _make(_surface, td.tableDAT, "button_mappings", -520, -80)
            try:
                _mapping.clear()
                _mapping.appendRow(["label", "address", "target", "mode", "feedback"])
                for _button in _buttons:
                    _mapping.appendRow([
                        str(_button.get("label", "")),
                        str(_button.get("address", "")),
                        str(_button.get("target") or ""),
                        str(_button.get("mode", "pulse")),
                        str(_button.get("feedback_channel") or ""),
                    ])
                report["mapping_dat"] = _mapping.path
            except Exception:
                report["warnings"].append("Could not populate button_mappings table.")

        _feedback_channels = []
        _bound_targets = []
        for _i, _button in enumerate(_buttons):
            _row_y = 160 - (_i * 120)
            _label = str(_button.get("label", "button_%02d" % (_i + 1)))
            _address = str(_button.get("address", ""))
            _mode = str(_button.get("mode", "pulse"))
            _chan = _channel_name(_address)
            _select = _make(_surface, td.selectCHOP, "button_%02d_select" % (_i + 1), -220, _row_y)
            _null = _make(_surface, td.nullCHOP, "button_%02d" % (_i + 1), 40, _row_y)
            _setpar(_select, "chop", _osc_in.path, "button_%02d_select" % (_i + 1))
            _setpar(_select, "channames", _chan, "button_%02d_select" % (_i + 1))
            try:
                _null.inputConnectors[0].connect(_select)
            except Exception:
                report["warnings"].append("Could not wire button_%02d_select to button_%02d." % (_i + 1, _i + 1))
            _bound = _bind_target(_button, _null, _chan)
            if _bound and _button.get("target"):
                _bound_targets.append(str(_button.get("target")))
            _feedback = _button.get("feedback_channel")
            if _feedback:
                _feedback_channels.append((_channel_name(_feedback), _button.get("target"), _null.path, _chan))
            report["buttons"].append({
                "label": _label,
                "address": _address,
                "mode": _mode,
                "select": _select.path,
                "null": _null.path,
                "target": _button.get("target"),
                "bound": bool(_bound),
                "feedback_channel": _feedback,
            })

        if _feedback_channels:
            _feedback_src = _make(_surface, td.constantCHOP, "feedback_controls", -520, -260)
            for _i, (_chan, _target, _null_path, _button_chan) in enumerate(_feedback_channels):
                _setpar(_feedback_src, "name%d" % _i, _chan, "feedback_controls")
                _set_expr_par(
                    _feedback_src,
                    "value%d" % _i,
                    _target_value_expr(_target, _null_path, _button_chan),
                    "feedback_controls",
                )
            try:
                _osc_out.inputConnectors[0].connect(_feedback_src)
                report["feedback_source"] = _feedback_src.path
            except Exception:
                report["warnings"].append("Could not wire feedback_controls to osc_feedback.")
        else:
            _feedback_src = _make(_surface, td.constantCHOP, "feedback_stub", -520, -260)
            _setpar(_feedback_src, "name0", "tdmcp/status", "feedback_stub")
            _setpar(_feedback_src, "value0", 0.0, "feedback_stub")
            try:
                _osc_out.inputConnectors[0].connect(_feedback_src)
                report["feedback_source"] = _feedback_src.path
            except Exception:
                report["warnings"].append("Could not wire feedback_stub to osc_feedback.")
        _surface.store("tdmcp_companion_targets", _bound_targets)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = report
print(json.dumps(report))
`;

function buildCompanionSurfaceScript(payload: object): string {
  return buildPayloadScript(COMPANION_SURFACE_SCRIPT, payload);
}

export async function connectCompanionSurfaceImpl(
  ctx: ToolContext,
  args: ConnectCompanionSurfaceArgs,
) {
  return guardTd(
    async () => {
      const buttons = normalizeButtons(args.buttons);
      const script = buildCompanionSurfaceScript({
        parent: args.parent_path,
        name: args.name,
        listen_port: args.listen_port,
        feedback_host: args.feedback_host,
        feedback_port: args.feedback_port,
        buttons,
        create_mapping_dat: args.create_mapping_dat,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<CompanionSurfaceReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build companion surface: ${report.fatal}`, report);
      }
      const summary = `Built companion surface ${report.container} with ${report.buttons.length} button(s), listening on OSC ${args.listen_port} and sending feedback to ${args.feedback_host}:${args.feedback_port}${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerConnectCompanionSurface: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_companion_surface",
    {
      title: "Connect Companion OSC surface",
      description:
        "Build an OSC Companion-style button surface inside TouchDesigner: an OSC In CHOP listens for button addresses, each button gets a Select CHOP and Null CHOP row, optional target parameters are expression-bound, and an OSC Out CHOP is configured for feedback. A mapping table records label/address/target/mode/feedback for later editing.",
      inputSchema: connectCompanionSurfaceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectCompanionSurfaceImpl(ctx, args),
  );
};

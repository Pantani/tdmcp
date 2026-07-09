import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const connectTouchengineNotchSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the bridge scaffold."),
  name: z.string().default("touchengine_notch").describe("Generated baseCOMP name."),
  mode: z
    .enum(["touchengine", "notch_top", "ndi_fallback", "syphon_spout_fallback"])
    .default("touchengine"),
  tox_or_block_path: z
    .string()
    .optional()
    .describe("TouchEngine tox/block path or Notch block path."),
  input_top_path: z.string().optional().describe("Optional TOP to feed into the engine/fallback."),
  output_name: z.string().default("notch_out").describe("Stable output Null TOP name."),
  control_channels: z.array(z.string()).default([]).describe("Named control channels to scaffold."),
  active: z.boolean().default(false).describe("Start engine/fallback active where supported."),
});

type ConnectTouchengineNotchArgs = z.infer<typeof connectTouchengineNotchSchema>;

export interface ConnectTouchengineNotchReport {
  container_path?: string;
  mode?: ConnectTouchengineNotchArgs["mode"];
  host_op?: string;
  output_top?: string;
  controls_in?: string;
  status_dat?: string;
  setup_dat?: string;
  warnings: string[];
  fatal?: string;
}

const TOUCHENGINE_NOTCH_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"mode": _p.get("mode"), "warnings": []}

def _warn(message):
    report["warnings"].append(str(message))

def _place(node, x, y):
    if node is None:
        return
    try:
        node.nodeX = float(x)
        node.nodeY = float(y)
    except Exception:
        pass

def _free_x(parent, y, start=0.0, step=280.0, exclude=None):
    try:
        occupied = set()
        for child in parent.children:
            if exclude is not None and getattr(child, "path", None) == getattr(exclude, "path", None):
                continue
            try:
                if abs(float(child.nodeY) - float(y)) < 1.0:
                    occupied.add(round(float(child.nodeX) / step) * step)
            except Exception:
                continue
        x = float(start)
        while round(x / step) * step in occupied:
            x += step
        return x
    except Exception:
        return float(start)

def _or_create(parent, name, optype):
    existing = parent.op(name)
    if existing is not None:
        return existing
    return parent.create(optype, name)

def _optype(name, fallback):
    found = globals().get(name)
    if found is None:
        _warn("%s is not available; using placeholder %s." % (name, getattr(fallback, "__name__", str(fallback))))
        return fallback
    return found

def _setpar(node, par_name, value, warn=True):
    if node is None or value is None:
        return False
    try:
        par = getattr(node.par, par_name, None)
    except Exception:
        par = None
    if par is None:
        if warn:
            _warn("No parameter '%s' on %s" % (par_name, getattr(node, "path", node)))
        return False
    try:
        par.val = value
        return True
    except Exception as exc:
        if warn:
            _warn("Could not set %s on %s: %s" % (par_name, getattr(node, "path", node), exc))
        return False

def _connect(src, dst, input_index=0):
    try:
        dst.inputConnectors[input_index].connect(src)
        return True
    except Exception as exc:
        _warn("Could not connect %s -> %s: %s" % (getattr(src, "name", src), getattr(dst, "name", dst), exc))
        return False

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        comp = parent.op(_p["name"])
        if comp is None:
            comp = parent.create(baseCOMP, _p["name"])
        _place(comp, _free_x(parent, -180, exclude=comp), -180)
        report["container_path"] = comp.path

        input_select = None
        if _p.get("input_top_path"):
            input_select = _or_create(comp, "input_select", selectTOP)
            _place(input_select, 0, 0)
            _setpar(input_select, "top", _p.get("input_top_path"))

        mode = _p.get("mode", "touchengine")
        if mode == "touchengine":
            host = _or_create(comp, "touchengine_host", _optype("engineCOMP", constantTOP))
            _warn("TouchEngine mode requires installed TouchEngine runtime/licensing and live project validation.")
        elif mode == "notch_top":
            host = _or_create(comp, "notch_host", _optype("notchTOP", constantTOP))
            _warn("Notch TOP mode requires Notch Builder/Block runtime and licensing validated live.")
        elif mode == "ndi_fallback":
            host = _or_create(comp, "ndi_fallback", ndiinTOP)
            _warn("Using NDI fallback instead of direct TouchEngine/Notch host.")
        else:
            host = _or_create(comp, "syphon_spout_fallback", syphonspoutinTOP)
            _warn("Using Syphon/Spout fallback instead of direct TouchEngine/Notch host.")
        _place(host, 280, 0)
        report["host_op"] = host.path
        if input_select is not None:
            _connect(input_select, host)
        _setpar(host, "active", 1 if _p.get("active") else 0, warn=False)

        controls = _or_create(comp, "controls_in", constantCHOP)
        _place(controls, 0, -220)
        for idx, channel in enumerate(_p.get("control_channels") or []):
            _setpar(controls, "name%d" % idx, channel, warn=False)
            _setpar(controls, "value%d" % idx, 0.0, warn=False)
        report["controls_in"] = controls.path

        out = _or_create(comp, _p.get("output_name") or "notch_out", nullTOP)
        _place(out, 560, 0)
        _connect(host, out)
        report["output_top"] = out.path

        status = _or_create(comp, "status", tableDAT)
        _place(status, 280, -220)
        status.clear()
        status.appendRow(["field", "value"])
        status.appendRow(["mode", str(mode)])
        status.appendRow(["tox_or_block_path", str(_p.get("tox_or_block_path") or "")])
        status.appendRow(["active", str(bool(_p.get("active")))])
        report["status_dat"] = status.path

        notes = _or_create(comp, "setup_notes", textDAT)
        _place(notes, 560, -220)
        notes.text = (
            "TouchEngine/Notch bridge scaffold. Direct engine modes are paid/runtime-gated. "
            "Validate TouchEngine/Notch installation, licensing, block path, GPU compatibility, "
            "and parameter mappings live before relying on this output."
        )
        report["setup_dat"] = notes.path
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = report
print(json.dumps(report))
`;

export function buildTouchengineNotchScript(payload: object): string {
  return buildPayloadScript(TOUCHENGINE_NOTCH_SCRIPT, payload);
}

export async function connectTouchengineNotchImpl(
  ctx: ToolContext,
  args: ConnectTouchengineNotchArgs,
) {
  const script = buildTouchengineNotchScript({
    parent_path: args.parent_path,
    name: args.name,
    mode: args.mode,
    tox_or_block_path: args.tox_or_block_path ?? null,
    input_top_path: args.input_top_path ?? null,
    output_name: args.output_name,
    control_channels: args.control_channels,
    active: args.active,
  });

  return guardTd(
    async () =>
      parsePythonReport<ConnectTouchengineNotchReport>(
        (await ctx.client.executePythonScript(script, true)).stdout,
      ),
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not connect TouchEngine/Notch scaffold: ${report.fatal}`, report);
      }
      return jsonResult(
        `Created TouchEngine/Notch scaffold ${report.container_path}; mode ${report.mode}; output ${report.output_top} (${report.warnings.length} warning(s)).`,
        report,
      );
    },
  );
}

export const registerConnectTouchengineNotch: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_touchengine_notch",
    {
      title: "Connect TouchEngine Notch",
      description:
        "Create a TouchEngine/Notch bridge scaffold with stable output TOP, control channels, NDI/Syphon fallback modes, and explicit licensing/runtime warnings.",
      inputSchema: connectTouchengineNotchSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectTouchengineNotchImpl(ctx, args),
  );
};

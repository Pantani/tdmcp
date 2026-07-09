import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const touchoscControlSchema = z.object({
  label: z.string().min(1).describe("Control label shown in the manifest and mapping table."),
  address: z.string().optional().describe("OSC address. If omitted, generated from label."),
  type: z.enum(["fader", "xy", "toggle", "push", "rotary"]).default("fader"),
  target: z.string().optional().describe("Optional target as nodePath.parName."),
  min: z.number().optional(),
  max: z.number().optional(),
  default: z.number().optional(),
});

export const createTouchoscLayoutSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the TouchOSC surface."),
  name: z.string().default("touchosc_layout").describe("Generated baseCOMP name."),
  receive_port: z.coerce.number().int().min(1).max(65535).default(8000),
  send_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(9000),
  page_name: z.string().default("tdmcp"),
  controls: z
    .array(touchoscControlSchema)
    .max(64)
    .default([])
    .describe("TouchOSC-style controls to expose as OSC mapping rows."),
  create_manifest_dat: z.boolean().default(true),
});

type CreateTouchoscLayoutArgs = z.infer<typeof createTouchoscLayoutSchema>;

interface TouchoscControlPayload {
  label: string;
  address: string;
  type: "fader" | "xy" | "toggle" | "push" | "rotary";
  target?: string;
  min?: number;
  max?: number;
  default?: number;
}

export interface TouchoscLayoutReport {
  container?: string;
  osc_in?: string;
  osc_out?: string;
  manifest_dat?: string;
  control_map?: string;
  controls: Array<{ label: string; address: string; type: string; select?: string; null?: string }>;
  warnings: string[];
  fatal?: string;
}

function generatedAddress(label: string): string {
  const slug =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "control";
  return `/tdmcp/${slug}`;
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return "/tdmcp/control";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeControls(
  controls: CreateTouchoscLayoutArgs["controls"],
): TouchoscControlPayload[] {
  return controls.map((control) => ({
    ...control,
    address: normalizeAddress(control.address ?? generatedAddress(control.label)),
  }));
}

const TOUCHOSC_LAYOUT_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"controls": [], "warnings": []}

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

def _channel(address):
    return str(address or "").strip().lstrip("/") or "control"

def _prime_osc_out(comp, osc_out):
    stub = _or_create(comp, "feedback_stub", constantCHOP)
    _place(stub, -280, -220)
    _setpar(stub, "name0", "tdmcp/status", warn=False)
    _setpar(stub, "value0", 0.0, warn=False)
    _connect(stub, osc_out)
    return stub

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        comp = parent.op(_p["name"])
        if comp is None:
            comp = parent.create(baseCOMP, _p["name"])
        _place(comp, _free_x(parent, -180, exclude=comp), -180)
        report["container"] = comp.path

        osc_in = _or_create(comp, "osc_in", oscinCHOP)
        _place(osc_in, 0, 160)
        _setpar(osc_in, "port", int(_p["receive_port"]))
        _setpar(osc_in, "active", 1, warn=False)
        report["osc_in"] = osc_in.path

        osc_out = _or_create(comp, "osc_out", oscoutCHOP)
        _place(osc_out, 0, -220)
        _setpar(osc_out, "port", int(_p["send_port"]))
        _setpar(osc_out, "netaddress", _p["send_host"], warn=False)
        _setpar(osc_out, "active", 1, warn=False)
        _prime_osc_out(comp, osc_out)
        report["osc_out"] = osc_out.path

        controls = list(_p.get("controls", []))
        control_map = _or_create(comp, "control_map", tableDAT)
        _place(control_map, 0, -40)
        control_map.clear()
        control_map.appendRow(["label", "address", "type", "target", "min", "max", "default"])
        report["control_map"] = control_map.path

        if _p.get("create_manifest_dat"):
            manifest = _or_create(comp, "touchosc_manifest", textDAT)
            _place(manifest, 300, -220)
            manifest.text = json.dumps({
                "format": "tdmcp-touchosc-manifest",
                "note": "This is not a .tosc document. Recreate these controls in TouchOSC and use the OSC addresses below.",
                "page": _p.get("page_name"),
                "receive_port": _p.get("receive_port"),
                "send_host": _p.get("send_host"),
                "send_port": _p.get("send_port"),
                "controls": controls,
            }, indent=2)
            report["manifest_dat"] = manifest.path
            _warn("Generated a JSON manifest only; TouchOSC .tosc document generation is intentionally not claimed.")

        for idx, control in enumerate(controls):
            y = 160 - (idx * 110)
            channel = _channel(control.get("address"))
            sel = _or_create(comp, "control_%02d_select" % (idx + 1), selectCHOP)
            _place(sel, 300, y)
            _setpar(sel, "chop", osc_in.path)
            _setpar(sel, "channames", channel)
            nul = _or_create(comp, "control_%02d" % (idx + 1), nullCHOP)
            _place(nul, 560, y)
            _connect(sel, nul)
            control_map.appendRow([
                str(control.get("label", "")),
                str(control.get("address", "")),
                str(control.get("type", "fader")),
                str(control.get("target") or ""),
                str(control.get("min") if control.get("min") is not None else ""),
                str(control.get("max") if control.get("max") is not None else ""),
                str(control.get("default") if control.get("default") is not None else ""),
            ])
            if control.get("target"):
                _warn("Target binding for %s is recorded in control_map; validate parameter expressions live." % control.get("target"))
            report["controls"].append({
                "label": control.get("label"),
                "address": control.get("address"),
                "type": control.get("type"),
                "select": sel.path,
                "null": nul.path,
            })
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = report
print(json.dumps(report))
`;

export function buildTouchoscLayoutScript(payload: object): string {
  return buildPayloadScript(TOUCHOSC_LAYOUT_SCRIPT, payload);
}

export async function createTouchoscLayoutImpl(ctx: ToolContext, args: CreateTouchoscLayoutArgs) {
  const script = buildTouchoscLayoutScript({
    parent_path: args.parent_path,
    name: args.name,
    receive_port: args.receive_port,
    send_host: args.send_host,
    send_port: args.send_port,
    page_name: args.page_name,
    controls: normalizeControls(args.controls),
    create_manifest_dat: args.create_manifest_dat,
  });

  return guardTd(
    async () =>
      parsePythonReport<TouchoscLayoutReport>(
        (await ctx.client.executePythonScript(script, true)).stdout,
      ),
    (report) => {
      if (report.fatal)
        return errorResult(`Could not create TouchOSC layout: ${report.fatal}`, report);
      return jsonResult(
        `Created TouchOSC layout ${report.container} with ${report.controls.length} control(s), receive port ${args.receive_port}, send ${args.send_host}:${args.send_port}.`,
        report,
      );
    },
  );
}

export const registerCreateTouchoscLayout: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_touchosc_layout",
    {
      title: "Create TouchOSC layout",
      description:
        "Create a TouchOSC-oriented OSC mapping surface and JSON manifest DAT. This intentionally does not claim to generate TouchOSC .tosc documents.",
      inputSchema: createTouchoscLayoutSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTouchoscLayoutImpl(ctx, args),
  );
};

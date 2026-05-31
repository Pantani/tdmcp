import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const MappingSchema = z.object({
  control: z
    .string()
    .min(1)
    .describe(
      "Device-side address. For OSC use the OSC path (e.g. '/track/1/fader'); for MIDI use 'cc:<num>:<chan>' (e.g. 'cc:7:1' = CC#7, channel 1).",
    ),
  param: z
    .string()
    .min(1)
    .describe(
      "TouchDesigner parameter to bind, written as an absolute path (e.g. '/project1/wave1/amplitude') or 'opPath.parName'.",
    ),
  epsilon: z.coerce
    .number()
    .min(0)
    .default(0.001)
    .describe("Minimum |new - last_out| before an outgoing send is emitted. Scaled by Globaleps."),
  direction: z
    .enum(["in", "out", "both"])
    .default("both")
    .describe("'in' = device → param only; 'out' = param → device only; 'both' = bidirectional."),
  min: z.coerce.number().default(0).describe("Low end of the value range."),
  max: z.coerce.number().default(1).describe("High end of the value range."),
});

export const createTwoWaySurfaceSchema = z.object({
  name: z.string().default("two_way_surface").describe("Container name."),
  parent: z.string().default("/").describe("Parent COMP path."),
  protocol: z
    .enum(["osc", "midi"])
    .default("osc")
    .describe("Transport: 'osc' uses OSC In/Out CHOPs; 'midi' uses MIDI In/Out CHOPs."),
  host: z
    .string()
    .default("127.0.0.1")
    .describe("OSC remote host (device IP) for outgoing messages. Ignored for MIDI."),
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(9000)
    .describe("OSC remote port for outgoing messages. Ignored for MIDI."),
  listenPort: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(9001)
    .describe("OSC local port for incoming messages. Ignored for MIDI."),
  midiDevice: z.string().optional().describe("MIDI device name (required when protocol='midi')."),
  mappings: z.array(MappingSchema).min(1).describe("Per-control routing + guard config."),
  rateLimitHz: z.coerce
    .number()
    .min(1)
    .max(240)
    .default(60)
    .describe("Outgoing send-rate cap (Hz). Outbound channels are throttled below this rate."),
});
export type CreateTwoWaySurfaceArgs = z.infer<typeof createTwoWaySurfaceSchema>;

interface TwoWaySurfaceReport {
  container?: string;
  inNullPath?: string;
  guardPath?: string;
  outChopPath?: string;
  mappingCount: number;
  warnings: string[];
  fatal?: string;
}

// Script CHOP onCook body — guards outgoing values against epsilon delta, rate limit, and
// device echo (last_in equality). Stored on the Script CHOP's text DAT.
export const TWO_WAY_GUARD_BODY = `# tdmcp two_way_surface guard
def onCook(scriptOp):
    import time
    scriptOp.clear()
    surf = scriptOp.parent()
    try:
        if surf.par.Bypass.eval():
            return
    except Exception:
        pass
    try:
        global_eps = float(surf.par.Globaleps.eval())
    except Exception:
        global_eps = 1.0
    try:
        rate_hz = float(surf.par.Ratehz.eval())
    except Exception:
        rate_hz = 60.0
    min_dt = 1.0 / max(1.0, rate_hz)
    last_out = scriptOp.fetch('last_out', {})
    last_in = scriptOp.fetch('last_in', {})
    last_send_t = scriptOp.fetch('last_send_t', {})
    now = time.time()
    mappings = scriptOp.fetch('mappings', [])
    for m in mappings:
        if m.get('direction') == 'in':
            continue
        addr = m.get('control')
        path = m.get('param')
        eps = float(m.get('epsilon', 0.001)) * global_eps
        try:
            dot = path.rfind('.')
            tn = op(path[:dot]) if dot > 0 else None
            pr = getattr(tn.par, path[dot + 1:], None) if tn is not None else None
            if pr is None:
                continue
            new = float(pr.eval())
        except Exception:
            continue
        prev_out = last_out.get(addr)
        if prev_out is not None and abs(new - prev_out) < eps:
            continue
        last_in_v = last_in.get(addr)
        if last_in_v is not None and abs(new - last_in_v) < eps:
            continue
        ts = last_send_t.get(addr, 0.0)
        if now - ts < min_dt:
            continue
        ch = scriptOp.appendChan(addr)
        ch[0] = new
        last_out[addr] = new
        last_send_t[addr] = now
    scriptOp.store('last_out', last_out)
    scriptOp.store('last_send_t', last_send_t)
    return
`;

// CHOP Execute DAT on the IN Null — every incoming sample updates last_in[addr] so the guard
// recognises the device's own echo and refuses to re-send it.
export const TWO_WAY_IN_CB = `# tdmcp two_way_surface in-cache
def onValueChange(channel, sampleIndex, val, prev):
    surf = me.parent()
    guard = surf.op('guard')
    if guard is None:
        return
    last_in = guard.fetch('last_in', {})
    last_in[channel.name] = float(val)
    guard.store('last_in', last_in)
    return
`;

const TWO_WAY_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"mappingCount": len(_p.get("mappings", [])), "warnings": []}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    elif not hasattr(_parent, "create"):
        report["fatal"] = str(_p["parent"]) + " is not a COMP."
    else:
        _c = _parent.op(_p["name"]) or _parent.create(td.baseCOMP, _p["name"])
        report["container"] = _c.path
        _protocol = _p["protocol"]
        # IN op
        if _protocol == "osc":
            _in = _c.op("in_chop") or _c.create(td.oscinCHOP, "in_chop")
            try:
                _in.par.port = int(_p["listenPort"])
                _in.par.active = True
            except Exception:
                report["warnings"].append("Could not configure OSC In port.")
        else:
            _in = _c.op("in_chop") or _c.create(td.midiinCHOP, "in_chop")
            try:
                if _p.get("midiDevice"):
                    for _pn in ["device", "id"]:
                        try:
                            setattr(_in.par, _pn, _p["midiDevice"])
                            break
                        except Exception:
                            pass
                _in.par.active = True
            except Exception:
                report["warnings"].append("Could not configure MIDI In.")
        _innull = _c.op("in_null") or _c.create(td.nullCHOP, "in_null")
        try:
            _innull.inputConnectors[0].connect(_in)
        except Exception:
            report["warnings"].append("Could not wire IN → in_null.")
        report["inNullPath"] = _innull.path
        # Mapping table
        _tbl = _c.op("mappings") or _c.create(td.tableDAT, "mappings")
        try:
            _tbl.clear()
            _tbl.appendRow(["index", "control", "param", "epsilon", "direction", "min", "max"])
            for _i, _m in enumerate(_p.get("mappings", [])):
                _tbl.appendRow([
                    str(_i),
                    str(_m.get("control", "")),
                    str(_m.get("param", "")),
                    str(_m.get("epsilon", 0.001)),
                    str(_m.get("direction", "both")),
                    str(_m.get("min", 0)),
                    str(_m.get("max", 1)),
                ])
        except Exception:
            report["warnings"].append("Could not populate mapping table.")
        # Bind params for direction in {in, both}
        for _m in _p.get("mappings", []):
            if _m.get("direction") == "out":
                continue
            _path = str(_m.get("param", ""))
            _dot = _path.rfind(".")
            try:
                if _dot > 0:
                    _np = _path[:_dot]; _prn = _path[_dot + 1:]
                else:
                    _np = _path; _prn = None
                _tn = op(_np)
                if _tn is None:
                    report["warnings"].append("Bind target node not found: " + _np); continue
                _tp = getattr(_tn.par, _prn, None) if _prn else None
                if _tp is None:
                    report["warnings"].append("Bind target parameter not found: " + _path); continue
                _chan = str(_m.get("control", ""))
                _expr = "op(%r)[%r] or 0" % (_innull.path, _chan)
                _PM = type(_tp.mode); _tp.expr = _expr; _tp.mode = _PM.EXPRESSION
            except Exception:
                report["warnings"].append("Bind failed for " + _path + ": " + traceback.format_exc().splitlines()[-1])
        # Guard Script CHOP
        _guard = _c.op("guard") or _c.create(td.scriptCHOP, "guard")
        _gtxt = _c.op("guard_body") or _c.create(td.textDAT, "guard_body")
        _gtxt.text = _p["guard_body"]
        try:
            _guard.par.callbacks = _gtxt
        except Exception:
            try:
                _guard.par.dat = _gtxt
            except Exception:
                report["warnings"].append("Could not bind guard script DAT.")
        try:
            _guard.inputConnectors[0].connect(_innull)
        except Exception:
            pass
        _guard.store("mappings", _p.get("mappings", []))
        _guard.store("last_out", {})
        _guard.store("last_in", {})
        _guard.store("last_send_t", {})
        report["guardPath"] = _guard.path
        # IN-watch CHOP Execute DAT (keeps last_in fresh)
        _inwatch = _c.op("in_watch") or _c.create(td.chopexecuteDAT, "in_watch")
        _inwatch.text = _p["in_cb"]
        try:
            _inwatch.par.chop = _innull
            _inwatch.par.valuechange = True
            _inwatch.par.active = True
        except Exception:
            report["warnings"].append("Could not wire in_watch CHOP Execute.")
        # OUT op
        if _protocol == "osc":
            _out = _c.op("out_chop") or _c.create(td.oscoutCHOP, "out_chop")
            try:
                for _pn, _v in [("netaddress", str(_p["host"])), ("address", str(_p["host"])), ("port", int(_p["port"]))]:
                    try:
                        setattr(_out.par, _pn, _v)
                    except Exception:
                        pass
                _out.par.active = True
            except Exception:
                report["warnings"].append("Could not configure OSC Out.")
        else:
            _out = _c.op("out_chop") or _c.create(td.midioutCHOP, "out_chop")
            try:
                if _p.get("midiDevice"):
                    for _pn in ["device", "id"]:
                        try:
                            setattr(_out.par, _pn, _p["midiDevice"])
                            break
                        except Exception:
                            pass
                _out.par.active = True
            except Exception:
                report["warnings"].append("Could not configure MIDI Out.")
        try:
            _out.inputConnectors[0].connect(_guard)
        except Exception:
            report["warnings"].append("Could not wire guard → OUT.")
        report["outChopPath"] = _out.path
        # Custom pars
        try:
            _page = None
            for _pg in _c.customPages:
                if _pg.name == "Surface":
                    _page = _pg; break
            if _page is None:
                _page = _c.appendCustomPage("Surface")
            _existing = {p.name for p in _c.customPars}
            if "Bypass" not in _existing:
                _page.appendToggle("Bypass")
            if "Globaleps" not in _existing:
                _gp = _page.appendFloat("Globaleps")
                _gp[0].default = 1.0; _gp[0].val = 1.0
            if "Ratehz" not in _existing:
                _rp = _page.appendInt("Ratehz")
                _rp[0].default = int(_p["rateLimitHz"]); _rp[0].val = int(_p["rateLimitHz"])
            if "Reseccache" not in _existing:
                _page.appendPulse("Reseccache")
        except Exception:
            report["warnings"].append("Could not append custom pars.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildTwoWaySurfaceScript(payload: object): string {
  return buildPayloadScript(TWO_WAY_SCRIPT, payload);
}

export async function createTwoWaySurfaceImpl(ctx: ToolContext, args: CreateTwoWaySurfaceArgs) {
  if (args.protocol === "midi" && !args.midiDevice) {
    return errorResult(
      "midiDevice is required when protocol='midi'. Pass the MIDI device name (as it appears in TouchDesigner's MIDI Device Mapper).",
    );
  }
  return guardTd(
    async () => {
      const script = buildTwoWaySurfaceScript({
        name: args.name,
        parent: args.parent,
        protocol: args.protocol,
        host: args.host,
        port: args.port,
        listenPort: args.listenPort,
        midiDevice: args.midiDevice,
        mappings: args.mappings,
        rateLimitHz: args.rateLimitHz,
        guard_body: TWO_WAY_GUARD_BODY,
        in_cb: TWO_WAY_IN_CB,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<TwoWaySurfaceReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build two-way surface: ${report.fatal}`, report);
      }
      const summary = `Built two-way ${args.protocol.toUpperCase()} surface ${report.container} with ${report.mappingCount} mapping(s)${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateTwoWaySurface: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_two_way_surface",
    {
      title: "Create two-way control surface (OSC/MIDI with feedback guard)",
      description:
        "Build a bidirectional OSC or MIDI control surface that drives TouchDesigner params from a controller AND echoes outgoing changes back to it (motor faders, RGB pads), with an oscillation guard so the device's own echo doesn't ping-pong. Each mapping pairs a device address with a TD parameter; a Script CHOP gates outbound sends by epsilon delta, rate limit, and a last_in cache. Exposes Bypass, Globaleps, Ratehz, Reseccache custom pars on the container.",
      inputSchema: createTwoWaySurfaceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTwoWaySurfaceImpl(ctx, args),
  );
};

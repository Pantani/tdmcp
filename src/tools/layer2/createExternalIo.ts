import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const bindSchema = z.object({
  channel: z
    .string()
    .describe(
      "Channel name produced by the input (e.g. an OSC address tail 'fader1', or a MIDI channel name).",
    ),
  target: z.string().describe("Parameter to drive, written as 'nodePath.parName'."),
});

export const createExternalIoSchema = z.object({
  kind: z
    .enum(["osc_in", "midi_in", "dmx_out", "ndi_in", "syphon_spout_in"])
    .describe(
      "What to bridge: OSC input, MIDI input, DMX/Art-Net output (lighting), or NDI / Syphon-Spout video input. (Video/NDI/Syphon *outputs* live in setup_output.)",
    ),
  parent_path: z.string().default("/project1").describe("COMP to create the I/O operator in."),
  name: z.string().optional(),
  port: z.coerce
    .number()
    .int()
    .optional()
    .describe("(osc_in) UDP port to listen on. Defaults to 7000."),
  normalize: z
    .enum(["off", "0to1", "-1to1", "onoff"])
    .default("0to1")
    .describe("(midi_in) How to scale incoming MIDI values."),
  bind_to: z
    .array(bindSchema)
    .optional()
    .describe(
      "(osc_in/midi_in) Map incoming channels to parameters. Each binding tolerates a channel that hasn't arrived yet (falls back to 0 instead of erroring).",
    ),
  source_path: z
    .string()
    .optional()
    .describe("(dmx_out) CHOP whose channel values are sent out as DMX."),
  interface: z
    .enum(["artnet", "sacn", "enttecusbpro", "enttecusbpromk2", "serial", "kinet"])
    .default("artnet")
    .describe("(dmx_out) DMX transport."),
  universe: z.coerce.number().int().default(1).describe("(dmx_out) DMX universe."),
  net_address: z.string().optional().describe("(dmx_out) Target IP address for Art-Net / sACN."),
  source_name: z
    .string()
    .optional()
    .describe("(ndi_in/syphon_spout_in) Name of the NDI source or Spout sender to receive."),
});
type CreateExternalIoArgs = z.infer<typeof createExternalIoSchema>;

interface IoReport {
  kind: string;
  node?: string;
  type?: string;
  source?: string;
  bound?: Array<{ channel: string; target: string }>;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass creates and configures the right operator per kind. Control-surface
// inputs (OSC/MIDI) bind channels to parameters with a guard so a channel that hasn't
// arrived yet evaluates to 0 instead of leaving the target in an error state. The
// expression-mode enum is derived from a live parameter (`ParMode` is not in scope here).
const IO_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"kind": _p["kind"], "warnings": []}
_TYPEMAP = {"osc_in": oscinCHOP, "midi_in": midiinCHOP, "dmx_out": dmxoutCHOP, "ndi_in": ndiinTOP, "syphon_spout_in": syphonspoutinTOP}
try:
    _kind = _p["kind"]; _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _name = _p.get("name")
        _node = _parent.create(_TYPEMAP[_kind], _name) if _name else _parent.create(_TYPEMAP[_kind])
        report["node"] = _node.path; report["type"] = _node.type
        def _setpar(parname, val):
            if val is None:
                return
            pr = getattr(_node.par, parname, None)
            if pr is None:
                report["warnings"].append("No parameter '%s' on %s" % (parname, _node.type)); return
            try:
                pr.val = val
            except Exception:
                report["warnings"].append("Could not set parameter '%s'" % parname)
        if _kind == "osc_in":
            _setpar("port", _p.get("port"))
        elif _kind == "midi_in":
            _setpar("norm", _p.get("normalize"))
        elif _kind == "dmx_out":
            _setpar("interface", _p.get("interface")); _setpar("universe", _p.get("universe")); _setpar("netaddress", _p.get("net_address"))
            _src = _p.get("source")
            if _src:
                _s = op(_src)
                if _s is None:
                    report["warnings"].append("Source CHOP not found: " + _src)
                else:
                    try:
                        _node.inputConnectors[0].connect(_s); report["source"] = _s.path
                    except Exception:
                        report["warnings"].append("Could not connect source " + _src)
        elif _kind == "ndi_in":
            _setpar("name", _p.get("source_name"))
        elif _kind == "syphon_spout_in":
            _setpar("sendername", _p.get("source_name"))
        _bound = []
        if _kind in ("osc_in", "midi_in"):
            for _b in (_p.get("bind_to") or []):
                try:
                    _ch = _b["channel"]; _t = _b["target"]; _dot = _t.rfind(".")
                    if _dot <= 0:
                        report["warnings"].append("Invalid bind target '%s' (expected 'nodePath.parName')." % _t); continue
                    _np = _t[:_dot]; _pn = _t[_dot + 1:]; _tn = op(_np)
                    if _tn is None:
                        report["warnings"].append("Bind target node not found: " + _np); continue
                    _tp = getattr(_tn.par, _pn, None)
                    if _tp is None:
                        report["warnings"].append("Bind target parameter not found: %s.%s" % (_np, _pn)); continue
                    _expr = "op(%r)[%r] if %r in [c.name for c in op(%r).chans()] else 0" % (_node.path, _ch, _ch, _node.path)
                    _PM = type(_tp.mode); _tp.expr = _expr; _tp.mode = _PM.EXPRESSION
                    _bound.append({"channel": _ch, "target": _np + "." + _pn})
                except Exception:
                    report["warnings"].append("Bind failed: " + traceback.format_exc().splitlines()[-1])
        report["bound"] = _bound
        report["errors"] = [str(e) for e in _node.errors()][:3]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildIoScript(payload: object): string {
  return buildPayloadScript(IO_SCRIPT, payload);
}

export async function createExternalIoImpl(ctx: ToolContext, args: CreateExternalIoArgs) {
  return guardTd(
    async () => {
      const script = buildIoScript({
        kind: args.kind,
        parent: args.parent_path,
        name: args.name ?? null,
        port: args.kind === "osc_in" ? (args.port ?? 7000) : null,
        normalize: args.normalize,
        bind_to: args.bind_to ?? null,
        source: args.source_path ?? null,
        interface: args.interface,
        universe: args.universe,
        net_address: args.net_address ?? null,
        source_name: args.source_name ?? null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<IoReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return jsonResult(`Could not create ${report.kind}: ${report.fatal}`, report);
      }
      const bound = report.bound?.length ? `, ${report.bound.length} binding(s)` : "";
      const errs = report.errors?.length ? `, ${report.errors.length} node error(s)` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      return jsonResult(
        `Created ${report.kind} (${report.type}) at ${report.node}${bound}${errs}${warns}.`,
        report,
      );
    },
  );
}

export const registerCreateExternalIo: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_external_io",
    {
      title: "Create external I/O",
      description:
        "Bridge TouchDesigner to the outside world: OSC input or MIDI input (a control surface — bind incoming channels straight to parameters), DMX/Art-Net output for lighting, or NDI / Syphon-Spout video input. Validate live where possible, but real signal needs the hardware/sender present.",
      inputSchema: createExternalIoSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createExternalIoImpl(ctx, args),
  );
};

import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// OSC-out preset maps for popular real-time targets. Each preset fixes the OSC address
// prefix (the oscoutCHOP prepends '/'+channelName; we name channels so the full address
// matches the target app's convention) and a default set of named controls.
export const OSC_PRESETS = {
  synesthesia: {
    prefix: "syn",
    port: 6448,
    // Synesthesia's OSC "media" controls are addressed as /syn/<name>. These are common
    // scene-reactive controls artists map audio/UI to.
    controls: ["Bass", "Mid", "High", "Level", "Hue", "Speed", "Zoom", "Amount"],
    note: "Synesthesia listens on /syn/<control>; enable OSC in Synesthesia > Settings and match the port (default 6448).",
  },
  unreal: {
    prefix: "unreal",
    port: 8000,
    // Unreal's OSC plugin routes /unreal/<name> to bound blueprint float params.
    controls: ["Param1", "Param2", "Param3", "Param4", "Intensity", "Speed", "Color", "Scale"],
    note: "Unreal's OSC plugin binds /unreal/<control> to blueprint float params; set the receive port to match (default 8000).",
  },
} as const satisfies Record<
  string,
  { prefix: string; port: number; controls: readonly string[]; note: string }
>;

export type OscPreset = keyof typeof OSC_PRESETS;

export const createSynesthesiaUnrealOscSchema = z.object({
  name: z.string().default("osc_send").describe("Base name for the container COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to create the OSC-out chain in (default '/project1')."),
  preset: z
    .enum(["synesthesia", "unreal"])
    .default("synesthesia")
    .describe(
      "Named OSC-out preset — sets the address prefix, default port, and default control names for Synesthesia or Unreal Engine.",
    ),
  host: z
    .string()
    .default("127.0.0.1")
    .describe(
      "Destination IP the OSC messages are sent to (the machine running Synesthesia / Unreal).",
    ),
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .nullable()
    .default(null)
    .describe(
      "UDP port to send OSC to. Null uses the preset's default (Synesthesia 6448, Unreal 8000).",
    ),
  controls: z
    .array(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Control name must be a valid OSC address tail"),
    )
    .nullable()
    .default(null)
    .describe(
      "Override the preset's control names. Each becomes an OSC address '/<prefix>/<name>' and a channel on the source Constant CHOP you drive/bind.",
    ),
  prefix: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, "Prefix must be alphanumeric")
    .nullable()
    .default(null)
    .describe(
      "Override the preset's OSC address prefix (the part before the control name). Null uses the preset default (syn / unreal).",
    ),
  active: z
    .boolean()
    .default(false)
    .describe(
      "Start sending immediately. Defaults off so you can confirm the destination host/port first.",
    ),
});

export type CreateSynesthesiaUnrealOscArgs = z.infer<typeof createSynesthesiaUnrealOscSchema>;

interface OscReport {
  container: string;
  source: string;
  osc_out: string;
  preset: string;
  prefix: string;
  host: string;
  port: number;
  addresses: string[];
  controls: string[];
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass. Builds a Constant CHOP with one channel per named control (channel name =
// '<prefix>/<control>' so the oscoutCHOP emits the exact OSC address the target app expects),
// wired into an oscoutCHOP configured for the preset host/port. Fail-forward.
const OSC_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"container": "", "source": "", "osc_out": "", "preset": _p["preset"], "prefix": _p["prefix"], "host": _p["host"], "port": int(_p["port"]), "addresses": [], "controls": list(_p["controls"]), "errors": [], "warnings": []}

def _try(label, fn):
    try:
        return fn()
    except Exception as _e:
        report["warnings"].append(label + ": " + str(_e))
        return None

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _c = _parent.create(baseCOMP, _p["name"])
        report["container"] = _c.path
        _prefix = _p["prefix"]
        _controls = list(_p["controls"])

        # Source Constant CHOP: one named channel per control. Channel name carries the
        # address tail so oscoutCHOP sends '/<prefix>/<control>'.
        _src = _try("source", lambda: _c.create(constantCHOP, "controls"))
        if _src is not None:
            for _i, _ctl in enumerate(_controls):
                _chan = "%s/%s" % (_prefix, _ctl)
                _try("name%d" % _i, lambda i=_i, ch=_chan, n=_src: setattr(n.par, "name%d" % i, ch))
                _try("value%d" % _i, lambda i=_i, n=_src: setattr(n.par, "value%d" % i, 0.0))
                report["addresses"].append("/" + _chan)
            report["source"] = _src.path

        _osc = _try("osc out", lambda: _c.create(oscoutCHOP, "osc"))
        if _osc is not None:
            _try("osc netaddress", lambda: setattr(_osc.par, "netaddress", _p["host"]))
            _try("osc port", lambda: setattr(_osc.par, "port", int(_p["port"])))
            # The oscoutCHOP emits each channel at OSC address '/<channelName>', so naming the
            # source channels '<prefix>/<control>' already yields '/<prefix>/<control>'.
            if _src is not None:
                _try("osc connect", lambda: _osc.inputConnectors[0].connect(_src))
            _try("osc active", lambda: setattr(_osc.par, "active", 1 if _p.get("active") else 0))
            report["osc_out"] = _osc.path
            try:
                report["errors"] = [str(e) for e in _osc.errors()][:3]
            except Exception:
                pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSynesthesiaUnrealOscScript(payload: object): string {
  return buildPayloadScript(OSC_SCRIPT, payload);
}

export async function createSynesthesiaUnrealOscImpl(
  ctx: ToolContext,
  args: CreateSynesthesiaUnrealOscArgs,
) {
  const preset = OSC_PRESETS[args.preset];
  const prefix = args.prefix ?? preset.prefix;
  const port = args.port ?? preset.port;
  const controls = args.controls?.length ? args.controls : [...preset.controls];
  return guardTd(
    async () => {
      const script = buildSynesthesiaUnrealOscScript({
        parent_path: args.parent_path,
        name: args.name,
        preset: args.preset,
        prefix,
        host: args.host,
        port,
        controls,
        active: args.active,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<OscReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`OSC preset build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const activeNote = args.active ? "sending now" : "inactive (flip Active/active to send)";
      const summary = `Built a ${report.preset} OSC-out preset → ${report.host}:${report.port} (${activeNote}), ${report.controls.length} controls at ${report.addresses.slice(0, 3).join(", ")}${report.addresses.length > 3 ? " …" : ""}${warnNote}. ${preset.note} Drive channels on op('${report.source}') (e.g. bind audio to '${prefix}/${controls[0] ?? "Bass"}').`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateSynesthesiaUnrealOsc: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_synesthesia_unreal_osc",
    {
      title: "Create Synesthesia / Unreal OSC preset send",
      description:
        "Build a named OSC-out preset map for driving Synesthesia or Unreal Engine from TouchDesigner. Picks a preset ('synesthesia' → prefix '/syn', port 6448; 'unreal' → prefix '/unreal', port 8000), builds a Constant CHOP with one named channel per control (channel name = '<prefix>/<control>' so an oscoutCHOP emits the exact address the target app expects), and wires it into an oscoutCHOP aimed at host:port. Override the control names, prefix, host, or port as needed. This is the preset layer on top of create_external_io osc_out — it fills in the address templates and default control set so the send 'just works' with the target app. Bind audio/analysis to the source channels (e.g. op('controls')['syn/Bass']) to make the receiving app react.",
      inputSchema: createSynesthesiaUnrealOscSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSynesthesiaUnrealOscImpl(ctx, args),
  );
};

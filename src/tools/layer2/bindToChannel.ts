import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const bindToChannelSchema = z.object({
  targets: z
    .array(z.string())
    .min(1)
    .describe(
      "Parameters to drive, each written as 'nodePath.parName' (e.g. '/project1/sys/transform1.scale'). Each is switched to expression mode so it tracks the channel live.",
    ),
  source_chop: z
    .string()
    .describe("Path of the CHOP that carries the driving channel (e.g. an audio_features Null)."),
  channel: z
    .string()
    .describe("Channel name to read from the source CHOP (e.g. 'bass', 'level', 'ramp', 'pulse')."),
  scale: z.coerce.number().default(1).describe("Multiply the channel value (mapping gain)."),
  offset: z.coerce.number().default(0).describe("Add to the scaled value (mapping offset)."),
});
type BindToChannelArgs = z.infer<typeof bindToChannelSchema>;

interface BindReport {
  bound: string[];
  expression?: string;
  channel_present?: boolean;
  warnings: string[];
  fatal?: string;
}

// One Python pass: build the expression op('chop')['chan'] (* scale) (+ offset) and switch
// each target parameter to expression mode tracking it. ParMode isn't in the exec globals,
// so the expression-mode enum is derived from a live parameter (type(par.mode)), mirroring
// animate_parameter.
const BIND_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"bound": [], "warnings": []}
try:
    _src = _p["source_chop"]; _ch = _p["channel"]
    _scale = _p["scale"]; _offset = _p["offset"]
    _srcop = op(_src)
    if _srcop is None:
        report["fatal"] = "Source CHOP not found: %s" % _src
    else:
        try:
            report["channel_present"] = _ch in [c.name for c in _srcop.chans()]
        except Exception:
            report["channel_present"] = None
        if report.get("channel_present") is False:
            report["warnings"].append("Channel '%s' not present on %s yet; binding anyway (it will track once it exists)." % (_ch, _src))
        _expr = "op(%s)[%s]" % (repr(_src), repr(_ch))
        if _scale != 1:
            _expr = "(%s) * %s" % (_expr, repr(_scale))
        if _offset != 0:
            _expr = "%s + %s" % (_expr, repr(_offset))
        report["expression"] = _expr
        for _t in _p["targets"]:
            try:
                _dot = _t.rfind(".")
                if _dot <= 0:
                    report["warnings"].append("Invalid target '%s' (expected 'nodePath.parName')." % _t); continue
                _np = _t[:_dot]; _pn = _t[_dot + 1:]; _n = op(_np)
                if _n is None:
                    report["warnings"].append("Target node not found: %s" % _np); continue
                _par = getattr(_n.par, _pn, None)
                if _par is None:
                    report["warnings"].append("Target parameter not found: %s" % _t); continue
                _PM = type(_par.mode)
                _par.expr = _expr; _par.mode = _PM.EXPRESSION
                report["bound"].append(_t)
            except Exception:
                report["warnings"].append("Failed to bind '%s': %s" % (_t, traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildBindScript(payload: object): string {
  return buildPayloadScript(BIND_SCRIPT, payload);
}

export async function bindToChannelImpl(ctx: ToolContext, args: BindToChannelArgs) {
  return guardTd(
    async () => {
      const script = buildBindScript({
        targets: args.targets,
        source_chop: args.source_chop,
        channel: args.channel,
        scale: args.scale,
        offset: args.offset,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<BindReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not bind to channel: ${report.fatal}`, report);
      }
      const summary = `Bound ${report.bound.length} parameter(s) to ${args.source_chop}['${args.channel}'] (${report.expression})${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerBindToChannel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "bind_to_channel",
    {
      title: "Bind parameter to channel",
      description:
        "Drive one or more node parameters from a CHOP channel by expression — the link that makes a visual react. Point it at an audio_features channel (bass/mid/treble/level) or a tempo_sync channel (ramp/pulse/beat) with a scale and offset, and each target parameter tracks that signal live. This is how you wire extract_audio_features / create_tempo_sync into a visual system.",
      inputSchema: bindToChannelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => bindToChannelImpl(ctx, args),
  );
};

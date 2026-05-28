import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createDataSourceSchema = z.object({
  kind: z
    .enum(["json", "csv", "osc", "serial"])
    .default("json")
    .describe(
      "Where the data comes from: 'json' or 'csv' poll a URL with a Web Client DAT (or, with no url, cook from a static sample so it works offline), 'osc' listens for OSC messages on a UDP port, 'serial' reads a serial device. json/csv always cook; osc/serial only carry values once a sender/device is present.",
    ),
  parent_path: z.string().default("/project1").describe("COMP to build the data source inside."),
  name: z.string().optional().describe("Base name for the created sub-network."),
  url: z
    .string()
    .optional()
    .describe(
      "(json/csv) Endpoint the Web Client DAT fetches. When omitted the network still cooks from a static sample so other tools have channels to bind to.",
    ),
  port: z.coerce
    .number()
    .int()
    .optional()
    .describe("(osc) UDP port to listen on. Defaults to 7000."),
  device: z
    .string()
    .optional()
    .describe("(serial) Serial port, e.g. 'COM3' on Windows or '/dev/tty.usbserial' on macOS."),
  baud: z.coerce.number().int().default(9600).describe("(serial) Baud rate."),
  fields: z
    .array(z.string())
    .default(["value"])
    .describe(
      "Numeric keys to extract. Each becomes a channel on the output Null CHOP (named for the key) so create_data_visualization / bind_to_channel can bind to it, and a column in the offline sample table.",
    ),
  poll_seconds: z.coerce
    .number()
    .positive()
    .default(1)
    .describe("(json/csv) How often the Web Client DAT re-fetches the URL."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Surface live 'Active' and 'Poll' controls on the source operator."),
});
type CreateDataSourceArgs = z.infer<typeof createDataSourceSchema>;

interface DataSourceReport {
  kind: string;
  container?: string;
  source?: string;
  source_type?: string;
  null_chop?: string;
  null_dat?: string;
  channels?: string[];
  fields?: string[];
  controls?: string[];
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass builds a self-contained data-source sub-network per kind. For
// json/csv it seeds a static sample table (one column per field) so the output
// Null CHOP always carries the named channels offline, and wires a Web Client DAT
// alongside for live fetching (whose callback can overwrite the sample). For osc/
// serial it creates the matching In operator pair. Everything degrades to a
// warning instead of throwing: a partial network still returns a useful report.
const DATA_SOURCE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"kind": _p["kind"], "warnings": []}
try:
    _kind = _p["kind"]; _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _base = _p.get("name") or ("data_source_" + _kind)
        _c = _parent.create(baseCOMP, _base)
        report["container"] = _c.path
        _fields = [str(f) for f in (_p.get("fields") or ["value"])] or ["value"]
        def _setpar(node, parname, val):
            if val is None:
                return
            pr = getattr(node.par, parname, None)
            if pr is None:
                report["warnings"].append("No parameter '%s' on %s" % (parname, node.type)); return
            try:
                pr.val = val
            except Exception:
                report["warnings"].append("Could not set parameter '%s' on %s" % (parname, node.type))
        def _connect(src, dst):
            try:
                dst.inputConnectors[0].connect(src); return True
            except Exception:
                report["warnings"].append("Could not connect %s -> %s" % (src.name, dst.name)); return False
        def _expose_active(node, parname):
            # Real Active toggle on the container, expression-bound to the source operator's enable
            # parameter (so it actually pauses/resumes the source rather than just being a label).
            try:
                _pg = None
                for _existing in _c.customPages:
                    if _existing.name == "Controls":
                        _pg = _existing; break
                if _pg is None:
                    _pg = _c.appendCustomPage("Controls")
                _ap = _pg.appendToggle("Active")[0]
                _ap.default = True; _ap.val = True
                _tp = getattr(node.par, parname, None)
                if _tp is not None:
                    _tp.expr = "op(%r).par.Active" % _c.path
                    _tp.mode = type(_tp.mode).EXPRESSION
                return ["Active"]
            except Exception:
                report["warnings"].append("Could not create the Active control.")
                return []
        _controls = []
        _null_chop = None
        _raw_dat = None
        if _kind in ("json", "csv"):
            _src = _c.create(webclientDAT, "src")
            report["source"] = _src.path; report["source_type"] = _src.type
            _setpar(_src, "url", _p.get("url"))
            _setpar(_src, "active", 1 if _p.get("url") else 0)
            _setpar(_src, "reqmethod", "get")
            # The Web Client DAT has no polling-interval parameter (verified live): it only fetches
            # on its 'active' toggle or a 'request' pulse. To make poll_seconds control fetch
            # cadence, an Execute DAT re-pulses src.par.request whenever absTime passes the next
            # interval. The interval comes from the Poll custom par when exposed (so the knob retunes
            # the rate live), else the static poll_seconds. Only re-fetches when there is a URL.
            _poll = float(_p.get("poll_seconds") or 1) or 1
            _refresh = _c.create(executeDAT, "refresh")
            _interval_expr = ("op(%r).par.Poll" % _c.path) if _p.get("expose_controls") else repr(_poll)
            _rtext = (
                "def onFrameStart(frame):\\n"
                "\\tsrc = parent().op('src')\\n"
                "\\tif src is None or not src.par.url.eval():\\n"
                "\\t\\treturn\\n"
                "\\tiv = max(0.05, float(%s))\\n"
                "\\tnxt = parent().fetch('tdmcp_poll_next', 0.0)\\n"
                "\\tif absTime.seconds >= nxt:\\n"
                "\\t\\tparent().store('tdmcp_poll_next', absTime.seconds + iv)\\n"
                "\\t\\tsrc.par.request.pulse()\\n"
                "\\treturn\\n"
            ) % _interval_expr
            _refresh.text = _rtext
            if hasattr(_refresh.par, "framestart"):
                _refresh.par.framestart = True
            _refresh.par.active = 1 if _p.get("url") else 0
            _raw_dat = _c.create(nullDAT, "raw"); _connect(_src, _raw_dat)
            # Static sample: header row of field names + two numeric sample rows so
            # the Null CHOP carries the named channels even before any fetch.
            _sample = _c.create(tableDAT, "sample")
            _sample.clear()
            _sample.appendRow(_fields)
            _sample.appendRow([("%.3f" % (0.5 + 0.4 * (i % 3 - 1))) for i in range(len(_fields))])
            _sample.appendRow([("%.3f" % (0.5 - 0.3 * (i % 2))) for i in range(len(_fields))])
            _datto = _c.create(dattoCHOP, "datto")
            _setpar(_datto, "firstrow", "names")
            _setpar(_datto, "firstcolumn", "values")
            _setpar(_datto, "output", "chanpercol")
            _connect(_sample, _datto)
            _null_chop = _c.create(nullCHOP, "out"); _connect(_datto, _null_chop)
            if _p.get("expose_controls"):
                # Real controls (not just a label list): Active drives the Web Client DAT's enable,
                # Poll sets the fetch interval the refresh Execute DAT reads above.
                _pg = _c.appendCustomPage("Controls")
                _ap = _pg.appendToggle("Active")[0]
                _ap.default = bool(_p.get("url")); _ap.val = bool(_p.get("url"))
                try:
                    _src.par.active.expr = "op(%r).par.Active" % _c.path
                    _src.par.active.mode = type(_src.par.active.mode).EXPRESSION
                except Exception:
                    report["warnings"].append("Could not bind Active to the Web Client DAT.")
                _pp = _pg.appendFloat("Poll")[0]
                _pp.normMin = 0.05; _pp.min = 0.05; _pp.clampMin = True
                _pp.normMax = 60; _pp.default = _poll; _pp.val = _poll
                _controls = ["Active", "Poll"]
        elif _kind == "osc":
            _src = _c.create(oscinDAT, "src")
            report["source"] = _src.path; report["source_type"] = _src.type
            _setpar(_src, "port", _p.get("port"))
            _raw_dat = _c.create(nullDAT, "raw"); _connect(_src, _raw_dat)
            _osc_chop = _c.create(oscinCHOP, "osc_chop")
            _setpar(_osc_chop, "port", _p.get("port"))
            _null_chop = _c.create(nullCHOP, "out"); _connect(_osc_chop, _null_chop)
            if _p.get("expose_controls"):
                _controls = _expose_active(_src, "active")
        elif _kind == "serial":
            _src = _c.create(serialDAT, "src")
            report["source"] = _src.path; report["source_type"] = _src.type
            _setpar(_src, "port", _p.get("device"))
            _setpar(_src, "baudrate", _p.get("baud"))
            _raw_dat = _c.create(nullDAT, "raw"); _connect(_src, _raw_dat)
            _datto = _c.create(dattoCHOP, "datto")
            _setpar(_datto, "firstrow", "values")
            _setpar(_datto, "firstcolumn", "values")
            _setpar(_datto, "output", "chanpercol")
            _connect(_src, _datto)
            _null_chop = _c.create(nullCHOP, "out"); _connect(_datto, _null_chop)
            if _p.get("expose_controls"):
                _controls = _expose_active(_src, "active")
        if _raw_dat is not None:
            report["null_dat"] = _raw_dat.path
        if _null_chop is not None:
            report["null_chop"] = _null_chop.path
            report["channels"] = [c.name for c in _null_chop.chans()]
        report["fields"] = _fields
        report["controls"] = _controls
        report["errors"] = [str(e) for e in _c.errors()][:3]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildDataSourceScript(payload: object): string {
  return buildPayloadScript(DATA_SOURCE_SCRIPT, payload);
}

export async function createDataSourceImpl(ctx: ToolContext, args: CreateDataSourceArgs) {
  return guardTd(
    async () => {
      const script = buildDataSourceScript({
        kind: args.kind,
        parent: args.parent_path,
        name: args.name ?? null,
        url: args.kind === "json" || args.kind === "csv" ? (args.url ?? null) : null,
        port: args.kind === "osc" ? (args.port ?? 7000) : null,
        device: args.kind === "serial" ? (args.device ?? null) : null,
        baud: args.kind === "serial" ? args.baud : null,
        fields: args.fields,
        poll_seconds: args.poll_seconds,
        expose_controls: args.expose_controls,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<DataSourceReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create ${report.kind} data source: ${report.fatal}`, report);
      }
      const chans = report.channels?.length ?? 0;
      const errs = report.errors?.length ? `, ${report.errors.length} node error(s)` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      const where = report.null_chop ? ` Bind to the Null CHOP at ${report.null_chop}.` : "";
      return jsonResult(
        `Created a ${report.kind} data source at ${report.container} with ${chans} channel(s)${errs}${warns}.${where}`,
        report,
      );
    },
  );
}

export const registerCreateDataSource: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_data_source",
    {
      title: "Create data source",
      description:
        "Ingest live external data onto a binding-ready channel/table — the input counterpart to create_data_visualization and bind_to_channel. 'json'/'csv' poll a URL with a Web Client DAT (and cook from a static sample of `fields` when no url is given, so it works offline); 'osc' listens on a UDP port; 'serial' reads a device. Numeric `fields` become channels on an output Null CHOP (named for each key) so other tools can bind to them; the raw text is exposed on a Null DAT. Live OSC/serial values only appear when a sender/device is present.",
      inputSchema: createDataSourceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDataSourceImpl(ctx, args),
  );
};

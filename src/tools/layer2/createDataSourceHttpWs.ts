import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const selectorSchema = z.object({
  name: z.string().min(1),
  path: z.string().startsWith("$"),
});

export const createDataSourceHttpWsSchema = z
  .object({
    mode: z.enum(["http_poll", "websocket"]).default("http_poll").describe("Transport."),
    parent_path: z.string().default("/project1").describe("COMP to build inside."),
    name: z
      .string()
      .optional()
      .describe("Base name for the created baseCOMP; defaults to data_src_<mode>."),
    url: z
      .string()
      .describe(
        "Endpoint URL. http(s):// for http_poll; ws:// or wss:// for websocket. " +
          "Note: webclientDAT runs inside TD (no browser CORS). " +
          "wss:// with self-signed certs may silently fail (statusCode 0). " +
          "JSONPath selector support: $.name, $.key.sub, $.arr[0].field — no wildcards or filters.",
      ),
    method: z
      .enum(["get", "post", "put", "patch", "delete"])
      .default("get")
      .describe("HTTP method. http_poll only; ignored for websocket."),
    headers: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Request headers (http_poll) or connect headers (websocket; best-effort, param may vary by TD build).",
      ),
    body: z
      .string()
      .optional()
      .describe("Request body. http_poll only; caller pre-serializes JSON."),
    selectors: z
      .array(selectorSchema)
      .min(1)
      .describe(
        "JSONPath-lite selectors. Each name becomes a Null CHOP channel and must be unique. " +
          "path must start with $. Supported: $.key, $.key.sub, $.arr[0], $.arr[0].key. " +
          "Non-numeric or missing values fall back to 0 with a warning.",
      ),
    poll_seconds: z
      .number()
      .positive()
      .default(1.0)
      .describe("Polling interval in seconds. http_poll only; drives the timerCHOP cycle."),
    reconnect_seconds: z
      .number()
      .positive()
      .default(2.0)
      .describe("Seconds between reconnect attempts. websocket only."),
    expose_controls: z
      .boolean()
      .default(true)
      .describe("Surface live Active, Poll/Reconnect, and per-selector LastValue readouts."),
    static_sample: z
      .record(z.string(), z.number())
      .optional()
      .describe("Seed values keyed by selector name. Missing names default to 0.5."),
  })
  .refine(
    (data) => {
      const names = data.selectors.map((s) => s.name);
      return names.length === new Set(names).size;
    },
    { message: "Selector names must be unique.", path: ["selectors"] },
  );

type CreateDataSourceHttpWsArgs = z.infer<typeof createDataSourceHttpWsSchema>;

interface DataSourceHttpWsReport {
  mode: string;
  container?: string;
  source?: string;
  source_type?: string;
  null_chop?: string;
  null_dat?: string;
  channels?: string[];
  selectors?: Array<{ name: string; path: string }>;
  endpoint?: string;
  reconnect_seconds?: number;
  controls?: string[];
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

const DATA_SOURCE_HTTP_WS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"mode": _p["mode"], "warnings": []}
try:
    _mode = _p["mode"]; _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _base = _p.get("name") or ("data_src_" + _mode)
        _c = _parent.create(baseCOMP, _base)
        report["container"] = _c.path
        report["endpoint"] = _p["url"]
        _selectors = _p.get("selectors") or []
        _sel_names = [s[0] for s in _selectors]
        _sel_paths = [s[1] for s in _selectors]
        # Single shared sanitizer used by BOTH the appendFloat call and the
        # report's controls list — keep alphanumerics (digits included), lowercase,
        # then prefix "Last". TD custom-param rule: starts uppercase, rest is
        # lowercase letters/digits.
        def _to_custom_par_name(s):
            _safe = ''.join(ch for ch in s if ch.isalnum()).lower() or 'x'
            return "Last" + _safe
        _static = _p.get("static_sample") or {}
        def _setpar(node, parname, val):
            if val is None:
                return
            pr = getattr(node.par, parname, None)
            if pr is None:
                report["warnings"].append("No parameter '%s' on %s" % (parname, node.type))
                return
            try:
                pr.val = val
            except Exception:
                report["warnings"].append("Could not set parameter '%s' on %s" % (parname, node.type))
        def _connect(src, dst):
            try:
                dst.inputConnectors[0].connect(src)
                return True
            except Exception:
                report["warnings"].append("Could not connect %s -> %s" % (src.name, dst.name))
                return False
        # Build sample table TRANSPOSED: one row per selector, col0 = name, col1 = value.
        # Combined with datto firstcolumn='names'+output='chanperrow', this yields a
        # CHOP with one channel per selector named by the selector. (Header-row layout
        # only emits the last column in 'chanpercol' mode, which is why we transpose.)
        _sample = _c.create(tableDAT, "sample")
        _sample.clear()
        for _n in _sel_names:
            _sample.appendRow([_n, str(_static.get(_n, 0.5))])
        # DAT-to-CHOP reads from the 'dat' parameter, not input connector.
        # Menu params on dattoCHOP take string menu names, NOT integer indices.
        _datto = _c.create(dattoCHOP, "datto")
        _setpar(_datto, "firstrow", "values")
        _setpar(_datto, "firstcolumn", "names")
        _setpar(_datto, "output", "chanperrow")
        _setpar(_datto, "dat", _sample.name)
        _null_chop = _c.create(nullCHOP, "out")
        _connect(_datto, _null_chop)
        report["null_chop"] = _null_chop.path
        # JSONPath-lite parser embedded in parse textDAT
        # Supports: $.key, $.key.sub, $.arr[N], $.arr[N].key — no wildcards or filters.
        _parser_code = (
            "import json, re\\n"
            "def _jsonpath(obj, path):\\n"
            "    tokens = re.findall(r'(?<=\\.)(\\w+)|\\[(\\d+)\\]|\\[\\'(.*?)\\'\\]|\\[\\"(.*?)\\"\\]', path)\\n"
            "    cur = obj\\n"
            "    for t in tokens:\\n"
            "        key_dot, idx_num, key_sq, key_dq = t\\n"
            "        if idx_num:\\n"
            "            if not isinstance(cur, list):\\n"
            "                return None\\n"
            "            i = int(idx_num)\\n"
            "            if i >= len(cur):\\n"
            "                return None\\n"
            "            cur = cur[i]\\n"
            "        else:\\n"
            "            k = key_dot or key_sq or key_dq\\n"
            "            if not isinstance(cur, dict):\\n"
            "                return None\\n"
            "            cur = cur.get(k)\\n"
            "            if cur is None:\\n"
            "                return None\\n"
            "    return cur\\n"
            "def _parse_and_update(data_str, sel_names, sel_paths, sample, container):\\n"
            "    if not data_str:\\n"
            "        return\\n"
            "    if isinstance(data_str, (bytes, bytearray)):\\n"
            "        data_str = data_str.decode('utf-8', 'replace')\\n"
            "    try:\\n"
            "        obj = json.loads(data_str)\\n"
            "    except Exception:\\n"
            "        container.store('tdmcp_parse_error', 'Non-JSON frame: ' + str(data_str)[:200])\\n"
            "        return\\n"
            "    vals = []\\n"
            "    for name, path in zip(sel_names, sel_paths):\\n"
            "        raw = _jsonpath(obj, path)\\n"
            "        try:\\n"
            "            vals.append(float(raw) if raw is not None else 0.0)\\n"
            "        except (TypeError, ValueError):\\n"
            "            vals.append(0.0)\\n"
            "    if sample is None:\\n"
            "        return\\n"
            "    sample.clear()\\n"
            "    for n, v in zip(sel_names, vals):\\n"
            "        sample.appendRow([n, '%%.6f' %% v])\\n"
        )
        _sel_names_lit = repr(_sel_names)
        _sel_paths_lit = repr(_sel_paths)
        _cb = _c.create(textDAT, "parse")
        _raw_dat = _c.create(nullDAT, "raw")
        report["null_dat"] = _raw_dat.path
        if _mode == "http_poll":
            _src = _c.create(webclientDAT, "src")
            report["source"] = _src.path
            report["source_type"] = _src.type
            _setpar(_src, "url", _p["url"])
            _method_map = {"get": 0, "post": 1, "put": 2, "patch": 3, "delete": 4}
            _setpar(_src, "reqmethod", _method_map.get(str(_p.get("method", "get")).lower(), 0))
            _setpar(_src, "active", 1)
            # Headers: set via par.headers if available, else warn
            _headers = _p.get("headers") or {}
            if _headers:
                _hp = getattr(_src.par, "headers", None)
                if _hp is not None:
                    try:
                        _hp.val = json.dumps(_headers)
                    except Exception:
                        report["warnings"].append("Could not set webclientDAT headers; set manually.")
                else:
                    report["warnings"].append("webclientDAT has no 'headers' par in this TD build; set manually.")
            # Body (for POST/PUT/PATCH)
            _body = _p.get("body")
            if _body:
                _setpar(_src, "body", _body)
            _connect(_src, _raw_dat)
            # timer CHOP drives polling cadence
            _poll = float(_p.get("poll_seconds") or 1.0)
            _clock = _c.create(timerCHOP, "clock")
            _setpar(_clock, "length", _poll)
            _setpar(_clock, "cycle", 1)
            _setpar(_clock, "play", 1)
            if hasattr(_clock.par, "outfraction"):
                _clock.par.outfraction = 1
            # chopExecute DAT listens for cycle end and pulses src.par.request
            _chop_exec = _c.create(chopexecuteDAT, "clock_cb")
            _chop_exec_text = (
                "def onOffToOn(channel, sampleIndex, val, prev):\\n"
                "    src = parent().op('src')\\n"
                "    if src is not None:\\n"
                "        src.par.request.pulse()\\n"
            )
            _chop_exec.text = _chop_exec_text
            _setpar(_chop_exec, "chop", _clock.name)
            # cycle trigger: chopExecute fires on the 'timer_fraction' or 'done' channel offtoon
            # Use 'offtoon' on the 'done' channel to catch cycle completion
            if hasattr(_chop_exec.par, "offtoon"):
                _chop_exec.par.offtoon = 1
            # parse callbacks for webclientDAT
            _cb_text = (
                _parser_code +
                "def onResponse(webClientDAT, statusCode, headerDict, data):\\n"
                "    c = webClientDAT.parent()\\n"
                "    sample = c.op('sample')\\n"
                "    _parse_and_update(data, %s, %s, sample, c)\\n"
            ) % (_sel_names_lit, _sel_paths_lit)
            _cb.text = _cb_text
            _setpar(_src, "callbacks", _cb.name)
            _controls = []
            if _p.get("expose_controls"):
                _pg = _c.appendCustomPage("Controls")
                _ap = _pg.appendToggle("Active")[0]
                _ap.default = True; _ap.val = True
                try:
                    _src.par.active.expr = "op(%r).par.Active" % _c.path
                    _src.par.active.mode = type(_src.par.active.mode).EXPRESSION
                except Exception:
                    report["warnings"].append("Could not bind Active to webclientDAT.")
                _pp = _pg.appendFloat("Poll")[0]
                _pp.min = 0.05; _pp.clampMin = True
                _pp.max = 60; _pp.normMax = 60
                _pp.default = _poll; _pp.val = _poll
                try:
                    _clock.par.length.expr = "op(%r).par.Poll" % _c.path
                    _clock.par.length.mode = type(_clock.par.length.mode).EXPRESSION
                except Exception:
                    report["warnings"].append("Could not bind Poll to timerCHOP.")
                for s in _sel_names:
                    # Shared sanitizer keeps digits (e.g. "cam1" -> "Lastcam1")
                    # so two selectors differing only in trailing digits stay distinct.
                    _parname = _to_custom_par_name(s)
                    try:
                        _lp = _pg.appendFloat(_parname)[0]
                    except Exception as _e:
                        report["warnings"].append("Could not create LastValue par for %s: %s" % (s, _e))
                        continue
                    try:
                        _lp.expr = "op(%r).op('out')[%r].eval()" % (_c.path, s)
                        _lp.mode = type(_lp.mode).EXPRESSION
                    except Exception as _e:
                        report["warnings"].append("Could not bind LastValue expr for %s: %s" % (s, _e))
                    try:
                        _lp.readOnly = True
                    except Exception:
                        pass
                _controls = ["Active", "Poll"] + [_to_custom_par_name(s) for s in _sel_names]
            report["controls"] = _controls
        else:
            # websocket mode
            _src = _c.create(websocketDAT, "src")
            report["source"] = _src.path
            report["source_type"] = _src.type
            _setpar(_src, "url", _p["url"])
            _setpar(_src, "active", 1)
            _setpar(_src, "autoreconnect", 1)
            _reconnect = float(_p.get("reconnect_seconds") or 2.0)
            _setpar(_src, "reconnectinterval", _reconnect)
            report["reconnect_seconds"] = _reconnect
            _connect(_src, _raw_dat)
            _cb_text = (
                _parser_code +
                "def onReceiveText(websocketDAT, rowIndex, message):\\n"
                "    c = websocketDAT.parent()\\n"
                "    sample = c.op('sample')\\n"
                "    _parse_and_update(message, %s, %s, sample, c)\\n"
                "def onConnect(websocketDAT):\\n"
                "    websocketDAT.parent().store('tdmcp_ws_status', 'connected')\\n"
                "def onDisconnect(websocketDAT):\\n"
                "    websocketDAT.parent().store('tdmcp_ws_status', 'disconnected')\\n"
            ) % (_sel_names_lit, _sel_paths_lit)
            _cb.text = _cb_text
            _setpar(_src, "callbacks", _cb.name)
            _controls = []
            if _p.get("expose_controls"):
                _pg = _c.appendCustomPage("Controls")
                _ap = _pg.appendToggle("Active")[0]
                _ap.default = True; _ap.val = True
                try:
                    _src.par.active.expr = "op(%r).par.Active" % _c.path
                    _src.par.active.mode = type(_src.par.active.mode).EXPRESSION
                except Exception:
                    report["warnings"].append("Could not bind Active to websocketDAT.")
                _rp = _pg.appendFloat("Reconnect")[0]
                _rp.min = 0.1; _rp.clampMin = True
                _rp.max = 60; _rp.normMax = 60
                _rp.default = _reconnect; _rp.val = _reconnect
                try:
                    _src.par.reconnectinterval.expr = "op(%r).par.Reconnect" % _c.path
                    _src.par.reconnectinterval.mode = type(_src.par.reconnectinterval.mode).EXPRESSION
                except Exception:
                    report["warnings"].append("Could not bind Reconnect to websocketDAT.")
                for s in _sel_names:
                    # Shared sanitizer keeps digits (e.g. "cam1" -> "Lastcam1")
                    # so two selectors differing only in trailing digits stay distinct.
                    _parname = _to_custom_par_name(s)
                    try:
                        _lp = _pg.appendFloat(_parname)[0]
                    except Exception as _e:
                        report["warnings"].append("Could not create LastValue par for %s: %s" % (s, _e))
                        continue
                    try:
                        _lp.expr = "op(%r).op('out')[%r].eval()" % (_c.path, s)
                        _lp.mode = type(_lp.mode).EXPRESSION
                    except Exception as _e:
                        report["warnings"].append("Could not bind LastValue expr for %s: %s" % (s, _e))
                    try:
                        _lp.readOnly = True
                    except Exception:
                        pass
                _controls = ["Active", "Reconnect"] + [_to_custom_par_name(s) for s in _sel_names]
            report["controls"] = _controls
        report["selectors"] = [{"name": n, "path": p} for n, p in zip(_sel_names, _sel_paths)]
        report["channels"] = [c.name for c in _null_chop.chans()]
        report["errors"] = [str(e) for e in _c.errors()][:3]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildDataSourceHttpWsScript(payload: object): string {
  return buildPayloadScript(DATA_SOURCE_HTTP_WS_SCRIPT, payload);
}

export async function createDataSourceHttpWsImpl(
  ctx: ToolContext,
  args: CreateDataSourceHttpWsArgs,
) {
  return guardTd(
    async () => {
      const selectorPairs = args.selectors.map((s) => [s.name, s.path]);
      const payload = {
        mode: args.mode,
        parent: args.parent_path,
        name: args.name ?? null,
        url: args.url,
        method: args.method,
        headers: args.headers,
        body: args.body ?? null,
        selectors: selectorPairs,
        poll_seconds: args.poll_seconds,
        reconnect_seconds: args.reconnect_seconds,
        expose_controls: args.expose_controls,
        static_sample: args.static_sample ?? null,
      };
      const script = buildDataSourceHttpWsScript(payload);
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<DataSourceHttpWsReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create ${report.mode} data source: ${report.fatal}`, report);
      }
      const chans = report.channels?.length ?? 0;
      const errs = report.errors?.length ? `, ${report.errors.length} node error(s)` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      const where = report.null_chop ? ` Bind to the Null CHOP at ${report.null_chop}.` : "";
      return jsonResult(
        `Created a ${report.mode} data source at ${report.container} with ${chans} channel(s)${errs}${warns}.${where}`,
        report,
      );
    },
  );
}

export const registerCreateDataSourceHttpWs: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_data_source_http_ws",
    {
      title: "Create HTTP/WebSocket data source",
      description:
        "Advanced live-data ingest for HTTP polling and WebSocket streams — the richer-transport sibling of create_data_source. " +
        "http_poll: webclientDAT driven by a timerCHOP so polling cadence is a real CHOP signal you can retune/sync; supports custom HTTP method, headers, and body. " +
        "websocket: websocketDAT with auto-reconnect, persistent connection. " +
        "Both: JSONPath-lite selectors ($.key, $.key.sub, $.arr[0].field — no wildcards/filters) map response fields to named channels on an output Null CHOP ready for bind_to_channel. Raw body exposed on a Null DAT. " +
        "Use create_data_source for simple one-knob JSON/CSV polling; use this tool when you need real POST/headers, fine-cadence timer sync, or a WebSocket stream.",
      inputSchema: createDataSourceHttpWsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (rawArgs) => {
      const parsed = createDataSourceHttpWsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return errorResult(`Invalid create_data_source_http_ws arguments: ${parsed.error.message}`);
      }
      return createDataSourceHttpWsImpl(ctx, parsed.data);
    },
  );
};

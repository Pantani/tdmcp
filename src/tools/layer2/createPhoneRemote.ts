import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createPhoneRemoteSchema = z.object({
  comp_path: z
    .string()
    .default("/project1")
    .describe("Control COMP whose numeric custom parameters the phone page exposes."),
  port: z.coerce
    .number()
    .int()
    .positive()
    .max(65535)
    .default(9981)
    .describe("TCP port for the remote web server (keep it distinct from the bridge's 9980)."),
});
type CreatePhoneRemoteArgs = z.infer<typeof createPhoneRemoteSchema>;

interface RemoteReport {
  comp: string;
  server?: string;
  port?: number;
  url?: string;
  controls?: string[];
  warnings: string[];
  fatal?: string;
}

// Web Server DAT callbacks (run in TD). GET / serves a mobile page of range sliders, one per
// numeric custom parameter of the COMP the server lives in; each slider POSTs /set?param=&value=
// back, which writes the parameter. No build step on the client — the artist just opens the URL.
const REMOTE_CALLBACKS = `from urllib.parse import urlparse, parse_qs

def _build_html(comp):
    rows = ""
    for p in comp.customPars:
        if not getattr(p, "isNumber", False) or p.readOnly:
            continue
        lo = p.normMin if p.normMin is not None else 0
        hi = p.normMax if p.normMax is not None else 1
        try:
            v = float(p.eval())
        except Exception:
            v = lo
        rows += ('<div class="r"><label>' + p.name + '</label>'
                 '<input type="range" data-p="' + p.name + '" min="' + str(lo) + '" max="' + str(hi)
                 + '" step="any" value="' + str(v) + '"></div>')
    head = ('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">'
            '<title>tdmcp remote</title><style>'
            'body{background:#0d0d10;color:#eee;font-family:-apple-system,system-ui,sans-serif;margin:0;padding:18px}'
            '.r{margin:22px 0}label{display:block;margin-bottom:10px;font-size:15px;opacity:.85}'
            'input[type=range]{width:100%;height:42px;accent-color:#6cf}h1{font-size:17px;opacity:.6;font-weight:600}'
            '</style></head><body><h1>' + comp.name + ' — tdmcp remote</h1>')
    script = ('<script>document.querySelectorAll("input[type=range]").forEach(function(el){'
              'el.addEventListener("input",function(){'
              'fetch("/set?param="+encodeURIComponent(el.dataset.p)+"&value="+el.value)})})</script>')
    return head + rows + script + "</body></html>"

def onHTTPRequest(webServerDAT, request, response):
    comp = webServerDAT.parent()
    parsed = urlparse(request.get("uri", "/"))
    # /set is served on any method (GET keeps the client trivial and avoids POST quirks).
    if parsed.path.rstrip("/") == "/set":
        # TouchDesigner's WebServer DAT surfaces the query as a dict under request['pars'],
        # not in the uri, so read that first and fall back to parsing the uri query.
        pars = request.get("pars")
        pars = pars if isinstance(pars, dict) else {}
        name = pars.get("param", "")
        val = pars.get("value", "")
        if not name:
            q = parse_qs(parsed.query)
            name = (q.get("param") or [""])[0]
            val = (q.get("value") or [""])[0]
        par = getattr(comp.par, name, None)
        if par is not None and not par.readOnly:
            try:
                par.val = float(val)
            except Exception:
                pass
        response["statusCode"] = 200
        response["content-type"] = "text/plain"
        response["data"] = "ok"
        return response
    response["statusCode"] = 200
    response["content-type"] = "text/html"
    response["data"] = _build_html(comp)
    return response

def onWebSocketOpen(webServerDAT, client, uri): return
def onWebSocketReceiveText(webServerDAT, client, data): return
def onWebSocketReceiveBinary(webServerDAT, client, data): return
def onWebSocketReceivePing(webServerDAT, client, data):
    webServerDAT.webSocketSendPong(client, data=data)
def onWebSocketReceivePong(webServerDAT, client, data): return
def onServerStart(webServerDAT): return
def onServerStop(webServerDAT): return
`;

const REMOTE_SCRIPT = `
import json, base64, traceback, socket
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "warnings": []}
_c = op(_p["comp"])
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "create") or not hasattr(_c, "customPars"):
        report["fatal"] = _p["comp"] + " is not a COMP."
    else:
        _cb = _c.op("remote_callbacks") or _c.create(td.textDAT, "remote_callbacks")
        _cb.text = _p["callbacks"]
        _server = _c.op("remote_server") or _c.create(td.webserverDAT, "remote_server")
        _server.par.port = _p["port"]
        _server.par.callbacks = _cb
        _server.par.active = True
        report["server"] = _server.path; report["port"] = _p["port"]
        report["controls"] = [p.name for p in _c.customPars if getattr(p, "isNumber", False) and not p.readOnly]
        try:
            _ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            _ip = "<this-machine-ip>"
        report["url"] = "http://%s:%s/" % (_ip, _p["port"])
        _server.cook(force=True)
        _err = _server.errors(recurse=False) or ""
        if _err:
            report["warnings"].append("Web Server DAT: " + _err[:160])
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildRemoteScript(payload: object): string {
  return buildPayloadScript(REMOTE_SCRIPT, payload);
}

export async function createPhoneRemoteImpl(ctx: ToolContext, args: CreatePhoneRemoteArgs) {
  return guardTd(
    async () => {
      const script = buildRemoteScript({
        comp: args.comp_path,
        port: args.port,
        callbacks: REMOTE_CALLBACKS,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<RemoteReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not start phone remote: ${report.fatal}`, report);
      }
      const summary = `Phone remote serving ${report.controls?.length ?? 0} control(s) at ${report.url} (open it on a phone on the same network)${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreatePhoneRemote: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_phone_remote",
    {
      title: "Create phone remote",
      description:
        "Serve a mobile-friendly web panel from a Web Server DAT so you can control a COMP's numeric custom parameters from a phone — just open the URL, no app to install. Each parameter becomes a touch slider that writes back live. SECURITY: like the bridge, this listens on all interfaces and accepts writes with no auth, so use it only on a trusted network. Pair with create_control_panel (the params to expose) and manage_cue (snapshot looks you dial in from the phone).",
      inputSchema: createPhoneRemoteSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPhoneRemoteImpl(ctx, args),
  );
};

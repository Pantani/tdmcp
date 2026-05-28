import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const faderSpecSchema = z.object({
  label: z.string().describe("Fader label shown on the page."),
  par_path: z
    .string()
    .describe(
      "Absolute parameter path the fader drives, e.g. '/project1/level1/brightness1' or '/project1/comp1/Intensity'. Written live as a float.",
    ),
});
export type FaderSpec = z.infer<typeof faderSpecSchema>;

export const createStageDashboardSchema = z.object({
  target: z
    .string()
    .default("/project1")
    .describe(
      "Control COMP the dashboard is built inside. It holds the cues (manage_cue) and the Blackout/Freeze toggles (create_panic); cue buttons fire that COMP's cues and the panic button toggles its safety pars.",
    ),
  port: z.coerce
    .number()
    .int()
    .positive()
    .max(65535)
    .default(9990)
    .describe(
      "TCP port for the dashboard web server (keep it distinct from the bridge's 9980 and phone_remote's 9981).",
    ),
  cues: z
    .array(z.string())
    .default([])
    .describe(
      "Cue names (stored with manage_cue) to expose as launch buttons, in order. Each becomes a button that instantly recalls its cue on the target COMP. Empty omits the cue grid.",
    ),
  faders: z
    .array(faderSpecSchema)
    .default([])
    .describe(
      "Master faders, each a { label, par_path } that becomes a slider writing the parameter live. Empty omits the fader bank.",
    ),
  audio_features: z
    .string()
    .optional()
    .describe(
      "Optional audio-features Null CHOP path for the readout strip's VU bar (first channel). When omitted the readout still renders (beat from the timeline, VU flat).",
    ),
  name: z
    .string()
    .default("stage_dashboard")
    .describe("Name of the Web Server DAT (and its callbacks DAT) built inside the target COMP."),
});
type CreateStageDashboardArgs = z.infer<typeof createStageDashboardSchema>;

interface DashboardReport {
  comp: string;
  server?: string;
  callbacks?: string;
  port?: number;
  url?: string;
  cues?: string[];
  faders?: FaderSpec[];
  audio_features?: string | null;
  warnings: string[];
  fatal?: string;
}

/** Config baked into the callbacks DAT as a JSON literal, so the running server needs no exec. */
interface DashboardConfig {
  comp: string;
  cues: string[];
  faders: FaderSpec[];
  audio: string | null;
  title: string;
}

// Web Server DAT callbacks (run in TD). One onHTTPRequest routes every widget by a `do` field:
// cue → recall a stored cue (the manage_cue instant-recall path), fader → write a parameter,
// panic → toggle Blackout/Freeze on the target COMP, and GET /state → live {beat, vu} JSON the
// readout strip polls. GET / serves the single responsive page combining all four. Config
// (cues/faders/audio path) is baked in as __DASH_CFG__ so no per-request exec is needed.
const DASHBOARD_CALLBACKS = `import json
from urllib.parse import urlparse, parse_qs
import td

CFG = json.loads('''__DASH_CFG__''')

def _panic_par(comp, which):
    name = "Blackout" if which == "blackout" else "Freeze"
    par = getattr(comp.par, name, None)
    if par is None:
        pg = None
        for _pg in comp.customPages:
            if _pg.name == "Panic":
                pg = _pg
                break
        if pg is None:
            pg = comp.appendCustomPage("Panic")
        par = pg.appendToggle(name, label=name)[0]
    return par

def _recall_cue(comp, cue):
    store = comp.fetch("tdmcp_cues", {})
    vals = store.get(cue)
    if not vals:
        return
    for k, v in vals.items():
        pr = getattr(comp.par, k, None)
        if pr is not None and not pr.readOnly:
            try:
                pr.val = v
            except Exception:
                pass

def _set_par(path, value):
    if "/" not in path:
        return
    node_path, _, par_name = path.rpartition("/")
    node = op(node_path)
    if node is None:
        return
    pr = getattr(node.par, par_name, None)
    if pr is not None and not pr.readOnly:
        try:
            pr.val = float(value)
        except Exception:
            pass

def _state():
    beat = 0.0
    try:
        _t = op("/").time
        _b = getattr(_t, "beat", None)
        if _b is not None:
            beat = float(_b)
        else:
            _tempo = float(getattr(_t, "tempo", 0.0) or 0.0)
            _secs = float(getattr(_t, "seconds", 0.0) or 0.0)
            beat = (_secs * _tempo / 60.0) if _tempo > 0 else 0.0
    except Exception:
        beat = 0.0
    vu = 0.0
    apath = CFG.get("audio")
    if apath:
        try:
            chop = op(apath)
            if chop is not None and len(chop.chans) > 0:
                ch = chop.chans[0]
                n = ch.numSamples
                vu = float(ch[n - 1] if n > 0 else ch.eval())
        except Exception:
            vu = 0.0
    return {"beat": beat, "vu": vu}

def _button(label, do, extra=""):
    return ('<button class="btn" onclick="hit(\\'?do=' + do + extra
            + '\\')">' + label + '</button>')

def _build_html(comp):
    cues = "".join(_button(c, "cue", "&name=" + c) for c in CFG.get("cues", []))
    faders = ""
    for f in CFG.get("faders", []):
        faders += ('<div class="r"><label>' + f["label"] + '</label>'
                   '<input type="range" min="0" max="1" step="any" value="0" '
                   'oninput="hit(\\'?do=fader&path=' + f["par_path"]
                   + '&value=\\'+this.value)"></div>')
    head = ('<!doctype html><html><head><meta name="viewport" '
            'content="width=device-width,initial-scale=1,maximum-scale=1">'
            '<title>tdmcp stage</title><style>'
            'body{background:#0b0b0e;color:#eee;font-family:-apple-system,system-ui,sans-serif;margin:0;padding:16px}'
            'h1{font-size:15px;opacity:.55;font-weight:600;margin:0 0 12px}'
            'h2{font-size:12px;letter-spacing:.08em;opacity:.45;margin:22px 0 10px;text-transform:uppercase}'
            '.grid{display:flex;flex-wrap:wrap;gap:10px}'
            '.btn{flex:1 1 90px;min-height:64px;border:0;border-radius:12px;background:#1c1c24;color:#eee;font-size:15px}'
            '.btn:active{background:#2a6cf6}'
            '.r{margin:18px 0}label{display:block;margin-bottom:8px;font-size:14px;opacity:.85}'
            'input[type=range]{width:100%;height:40px;accent-color:#6cf}'
            '.readout{display:flex;align-items:center;gap:14px;background:#141419;border-radius:12px;padding:12px}'
            '#beat{width:18px;height:18px;border-radius:50%;background:#333;transition:background .05s}'
            '#beat.on{background:#2a6cf6}'
            '#vuwrap{flex:1;height:16px;background:#222;border-radius:8px;overflow:hidden}'
            '#vu{height:100%;width:0;background:linear-gradient(90deg,#2a6cf6,#6cf)}'
            '.panic{display:flex;gap:10px;margin-top:24px}'
            '.kill{flex:2;min-height:72px;border:0;border-radius:12px;background:#7a1020;color:#fff;font-size:16px;font-weight:700}'
            '.freeze{flex:1;min-height:72px;border:0;border-radius:12px;background:#1c1c24;color:#eee;font-size:15px}'
            '</style></head><body><h1>' + CFG.get("title", comp.name) + ' — tdmcp stage</h1>')
    readout = ('<div class="readout"><div id="beat"></div>'
               '<div id="vuwrap"><div id="vu"></div></div></div>')
    cue_sec = ('<h2>Cues</h2><div class="grid">' + cues + '</div>') if cues else ""
    fader_sec = ('<h2>Faders</h2>' + faders) if faders else ""
    panic = ('<div class="panic">'
             + '<button class="kill" onclick="hit(\\'?do=panic&mode=blackout&value=1\\')">PANIC — BLACKOUT</button>'
             + '<button class="freeze" onclick="hit(\\'?do=panic&mode=freeze&value=1\\')">FREEZE</button>'
             + '</div>')
    script = ('<script>'
              'function hit(q){fetch(q)}'
              'function poll(){fetch("/state").then(function(r){return r.json()}).then(function(s){'
              'var b=document.getElementById("beat");'
              'if(b)b.className=((s.beat%1)<0.25)?"on":"";'
              'var v=document.getElementById("vu");'
              'if(v)v.style.width=Math.max(0,Math.min(1,s.vu))*100+"%"})}'
              'setInterval(poll,250);poll();'
              '</script>')
    return head + readout + cue_sec + fader_sec + panic + script + "</body></html>"

def onHTTPRequest(webServerDAT, request, response):
    comp = webServerDAT.parent()
    parsed = urlparse(request.get("uri", "/"))
    path = parsed.path.rstrip("/")
    pars = request.get("pars")
    pars = pars if isinstance(pars, dict) else {}
    if not pars:
        q = parse_qs(parsed.query)
        pars = {k: (v[0] if v else "") for k, v in q.items()}
    if path == "/state":
        response["statusCode"] = 200
        response["content-type"] = "application/json"
        response["data"] = json.dumps(_state())
        return response
    do = pars.get("do", "")
    if do:
        if do == "cue":
            _recall_cue(comp, pars.get("name", ""))
        elif do == "fader":
            _set_par(pars.get("path", ""), pars.get("value", "0"))
        elif do == "panic":
            par = _panic_par(comp, pars.get("mode", "blackout"))
            try:
                par.val = bool(int(pars.get("value", "1")))
            except Exception:
                par.val = True
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

const DASHBOARD_SCRIPT = `
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
        _cfg = json.dumps(_p["config"])
        _callbacks = _p["callbacks"].replace("__DASH_CFG__", _cfg)
        _cb = _c.op(_p["name"] + "_callbacks") or _c.create(td.textDAT, _p["name"] + "_callbacks")
        _cb.text = _callbacks
        _server = _c.op(_p["name"]) or _c.create(td.webserverDAT, _p["name"])
        _server.par.port = _p["port"]
        _server.par.callbacks = _cb
        _server.par.active = True
        report["server"] = _server.path
        report["callbacks"] = _cb.path
        report["port"] = _p["port"]
        report["cues"] = _p["config"]["cues"]
        report["faders"] = _p["config"]["faders"]
        report["audio_features"] = _p["config"]["audio"]
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

export function buildDashboardScript(payload: object): string {
  return buildPayloadScript(DASHBOARD_SCRIPT, payload);
}

export async function createStageDashboardImpl(ctx: ToolContext, args: CreateStageDashboardArgs) {
  const config: DashboardConfig = {
    comp: args.target,
    cues: args.cues,
    faders: args.faders,
    audio: args.audio_features ?? null,
    title: args.target,
  };
  return guardTd(
    async () => {
      const script = buildDashboardScript({
        comp: args.target,
        name: args.name,
        port: args.port,
        config,
        callbacks: DASHBOARD_CALLBACKS,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<DashboardReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not start stage dashboard: ${report.fatal}`, report);
      }
      const summary = `Stage dashboard serving ${report.cues?.length ?? 0} cue button(s) + ${
        report.faders?.length ?? 0
      } fader(s) + panic at ${report.url} (open it on a phone or laptop on the same network)${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateStageDashboard: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_stage_dashboard",
    {
      title: "Create stage dashboard",
      description:
        "Serve one unified live-performance cockpit from a Web Server DAT — a single responsive web page (phone + laptop) that combines a grid of cue-launch buttons (recall named cues from manage_cue on the target COMP), master faders bound to chosen parameters, a big PANIC button (toggles the target COMP's Blackout/Freeze safety pars, the create_panic mechanism), and a live readout strip (a beat indicator plus a VU bar reading an audio-features Null CHOP). Open the URL — no app to install — and the page POSTs every control change back to the server, which applies it. SECURITY: like the bridge and create_phone_remote, this listens on all interfaces and accepts writes with NO auth, so use it only on a trusted network. Store cues with manage_cue, expose params with create_control_panel, and run create_panic first so the Blackout/Freeze toggles exist.",
      inputSchema: createStageDashboardSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createStageDashboardImpl(ctx, args),
  );
};

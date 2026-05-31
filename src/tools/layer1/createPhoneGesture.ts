import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createPhoneGestureSchema = z.object({
  name: z.string().default("phone_gesture").describe("Child operator base name inside parent."),
  parent: z
    .string()
    .default("/project1")
    .describe("COMP that will host the Web Server DAT + Script CHOP."),
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(9982)
    .describe(
      "TCP port for the gesture web server (distinct from bridge:9980 and phone_remote:9981).",
    ),
  enableImu: z
    .boolean()
    .default(true)
    .describe(
      "Enable tilt_*, gyro_*, shake channels (iOS Safari requires HTTPS + permission tap).",
    ),
  enableMultitouch: z.boolean().default(true).describe("Enable touch0..3_x/y/active channels."),
  shakeThreshold: z.coerce
    .number()
    .min(0.5)
    .max(50)
    .default(15)
    .describe("Acceleration magnitude (m/s^2) above which `shake` fires."),
});
type CreatePhoneGestureArgs = z.infer<typeof createPhoneGestureSchema>;

interface GestureReport {
  parent: string;
  server?: string;
  out?: string;
  port?: number;
  url?: string;
  warnings: string[];
  fatal?: string;
}

// Served HTML page + WebSocket client. Streams DeviceOrientation/DeviceMotion + TouchEvent at ~30 Hz.
// iOS Safari requires HTTPS for DeviceMotionEvent.requestPermission; on plain LAN HTTP it silently
// no-ops and the page falls back to touch-only. Android/desktop Chrome auto-grants.
const HTML_TEMPLATE = `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>tdmcp gesture</title>
<style>
body{background:#0d0d10;color:#eee;font-family:-apple-system,system-ui,sans-serif;margin:0;padding:14px;overscroll-behavior:none;touch-action:none}
h1{font-size:15px;opacity:.6;font-weight:600;margin:0 0 6px}
.s{font-size:12px;opacity:.7;margin-bottom:10px}
button{background:#6cf;color:#000;border:0;padding:14px 18px;border-radius:8px;font-size:15px;width:100%;margin:8px 0}
.row{font-family:ui-monospace,Menlo,monospace;font-size:12px;opacity:.85;margin:3px 0}
.pad{position:fixed;left:0;right:0;bottom:0;top:160px;background:#15151a;border-top:1px solid #222}
.dot{position:absolute;width:48px;height:48px;border-radius:50%;margin:-24px 0 0 -24px;pointer-events:none;opacity:.8}
</style></head><body>
<h1>tdmcp gesture — __PARENT_NAME__</h1>
<div class="s" id="st">ws: connecting</div>
<button id="perm" style="display:none">Enable motion sensors</button>
<div class="row" id="r1">tilt  x  0.0  y  0.0  z  0.0</div>
<div class="row" id="r2">gyro  x  0.0  y  0.0  z  0.0</div>
<div class="row" id="r3">shake 0.00</div>
<div class="pad" id="pad"></div>
<script>
var IMU_ENABLED = __IMU_ENABLED__;
var TOUCH_ENABLED = __TOUCH_ENABLED__;
var SHAKE_THRESHOLD = __SHAKE_THRESHOLD__;
var ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/');
var st = document.getElementById('st');
var permBtn = document.getElementById('perm');
var pad = document.getElementById('pad');
var lastSend = 0, hz = 0, hzCount = 0, hzT = performance.now();
var state = {tilt:[0,0,0], gyro:[0,0,0], shake:0, touches:[]};
ws.onopen = function(){ st.textContent = 'ws: connected'; };
ws.onclose = function(){ st.textContent = 'ws: disconnected'; };
ws.onerror = function(){ st.textContent = 'ws: error'; };

function attachIMU(){
  window.addEventListener('deviceorientation', function(e){
    state.tilt = [e.beta||0, e.gamma||0, e.alpha||0];
    permBtn.style.display = 'none';
  });
  window.addEventListener('devicemotion', function(e){
    var rr = e.rotationRate || {};
    state.gyro = [rr.beta||0, rr.gamma||0, rr.alpha||0];
    var a = e.acceleration || {x:0,y:0,z:0};
    var mag = Math.sqrt((a.x||0)*(a.x||0)+(a.y||0)*(a.y||0)+(a.z||0)*(a.z||0));
    if (mag > SHAKE_THRESHOLD) state.shake = 1.0;
    else state.shake = Math.max(0, state.shake - 0.06);
  });
}
function requestIMU(){
  if (!IMU_ENABLED) return;
  var needs = (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function');
  if (needs) {
    permBtn.style.display = 'block';
    permBtn.onclick = async function(){
      try {
        var r = await DeviceMotionEvent.requestPermission();
        if (r === 'granted') {
          if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            try { await DeviceOrientationEvent.requestPermission(); } catch(e){}
          }
          attachIMU();
          permBtn.style.display = 'none';
        }
      } catch(e){ st.textContent = 'ws: motion denied'; }
    };
  } else {
    attachIMU();
  }
}
requestIMU();

if (TOUCH_ENABLED) {
  var dots = {};
  function updTouches(ev){
    ev.preventDefault();
    var ts = [];
    for (var i=0; i<Math.min(ev.touches.length,4); i++){
      var t = ev.touches[i];
      ts.push({id:i, x:t.clientX/window.innerWidth, y:t.clientY/window.innerHeight});
    }
    state.touches = ts;
    var seen = {};
    for (var j=0; j<ts.length; j++){
      var id = ts[j].id; seen[id]=1;
      var d = dots[id];
      if (!d){ d = document.createElement('div'); d.className='dot';
        d.style.background = ['#6cf','#fc6','#c6f','#6fc'][id%4]; pad.appendChild(d); dots[id]=d; }
      d.style.left = ts[j].x*window.innerWidth + 'px';
      d.style.top  = ts[j].y*window.innerHeight + 'px';
    }
    for (var k in dots){ if(!seen[k]){ pad.removeChild(dots[k]); delete dots[k]; } }
  }
  pad.addEventListener('touchstart', updTouches, {passive:false});
  pad.addEventListener('touchmove',  updTouches, {passive:false});
  pad.addEventListener('touchend',   updTouches, {passive:false});
  pad.addEventListener('touchcancel',updTouches, {passive:false});
}

function tick(){
  var now = performance.now();
  if (now - lastSend >= 33 && ws.readyState === 1) {
    lastSend = now;
    try { ws.send(JSON.stringify({t:now|0, tilt:state.tilt, gyro:state.gyro, shake:state.shake, touches:state.touches})); } catch(e){}
    hzCount++;
    if (now - hzT > 1000){ hz = hzCount; hzCount = 0; hzT = now;
      st.textContent = 'ws: connected • ' + hz + ' Hz'; }
    document.getElementById('r1').textContent = 'tilt  x ' + state.tilt[0].toFixed(1) + '  y ' + state.tilt[1].toFixed(1) + '  z ' + state.tilt[2].toFixed(1);
    document.getElementById('r2').textContent = 'gyro  x ' + state.gyro[0].toFixed(1) + '  y ' + state.gyro[1].toFixed(1) + '  z ' + state.gyro[2].toFixed(1);
    document.getElementById('r3').textContent = 'shake ' + state.shake.toFixed(2);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
</script></body></html>`;

const CALLBACKS_TEMPLATE = `# Web Server DAT callbacks for tdmcp create_phone_gesture.
HTML_PAGE = """__HTML__"""

def _state_dat(webServerDAT):
    return webServerDAT.parent().op("__STATE_NAME__")

def onHTTPRequest(webServerDAT, request, response):
    response["statusCode"] = 200
    response["content-type"] = "text/html"
    response["data"] = HTML_PAGE
    return response

def onWebSocketOpen(webServerDAT, client, uri):
    s = webServerDAT.fetch("clients", None)
    if not isinstance(s, set):
        s = set()
    s.add(str(client))
    webServerDAT.store("clients", s)

def onWebSocketClose(webServerDAT, client):
    s = webServerDAT.fetch("clients", None)
    if isinstance(s, set):
        s.discard(str(client))
        webServerDAT.store("clients", s)

def onWebSocketReceiveText(webServerDAT, client, data):
    d = _state_dat(webServerDAT)
    if d is not None:
        try:
            d.text = data
        except Exception:
            pass

def onWebSocketReceiveBinary(webServerDAT, client, data): return
def onWebSocketReceivePing(webServerDAT, client, data):
    webServerDAT.webSocketSendPong(client, data=data)
def onWebSocketReceivePong(webServerDAT, client, data): return
def onServerStart(webServerDAT): return
def onServerStop(webServerDAT): return
`;

const SCRIPT_CHOP_CALLBACK = `# Script CHOP callback for tdmcp create_phone_gesture.
# Reads the most recent JSON frame from the state textDAT and emits channels.
import json

def _zero(scriptOp):
    names = ["tilt_x","tilt_y","tilt_z","gyro_x","gyro_y","gyro_z","shake"]
    for i in range(4):
        names += ["touch%d_x" % i, "touch%d_y" % i, "touch%d_active" % i]
    names += ["clients"]
    for n in names:
        c = scriptOp.appendChan(n)
        c[0] = 0.0
    scriptOp.numSamples = 1

def onCook(scriptOp):
    scriptOp.clear()
    _zero(scriptOp)
    state_dat = scriptOp.parent().op("__STATE_NAME__")
    server_dat = scriptOp.parent().op("__SERVER_NAME__")
    if state_dat is None:
        return
    txt = state_dat.text or ""
    if txt.strip():
        try:
            d = json.loads(txt)
            t = d.get("tilt") or [0,0,0]
            g = d.get("gyro") or [0,0,0]
            scriptOp["tilt_x"][0] = float(t[0] if len(t)>0 else 0)
            scriptOp["tilt_y"][0] = float(t[1] if len(t)>1 else 0)
            scriptOp["tilt_z"][0] = float(t[2] if len(t)>2 else 0)
            scriptOp["gyro_x"][0] = float(g[0] if len(g)>0 else 0)
            scriptOp["gyro_y"][0] = float(g[1] if len(g)>1 else 0)
            scriptOp["gyro_z"][0] = float(g[2] if len(g)>2 else 0)
            scriptOp["shake"][0] = float(d.get("shake") or 0)
            touches = d.get("touches") or []
            for i in range(min(len(touches), 4)):
                tt = touches[i] or {}
                scriptOp["touch%d_x" % i][0] = float(tt.get("x") or 0)
                scriptOp["touch%d_y" % i][0] = float(tt.get("y") or 0)
                scriptOp["touch%d_active" % i][0] = 1.0
        except Exception:
            pass
    if server_dat is not None:
        s = server_dat.fetch("clients", None)
        if isinstance(s, set):
            scriptOp["clients"][0] = float(len(s))
    return
`;

const BUILD_SCRIPT = `
import json, base64, traceback, socket
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"parent": _p["parent"], "warnings": []}
_c = op(_p["parent"])
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["parent"]
    elif not hasattr(_c, "create"):
        report["fatal"] = _p["parent"] + " is not a COMP."
    else:
        name = _p["name"]
        cb_name      = name + "_callbacks"
        state_name   = name + "_state"
        server_name  = name + "_server"
        script_name  = name + "_script"
        scriptcb_n   = name + "_script_cb"
        out_name     = name + "_out"
        url_name     = name + "_url"

        cb       = _c.op(cb_name)      or _c.create(td.textDAT, cb_name)
        state    = _c.op(state_name)   or _c.create(td.textDAT, state_name)
        server   = _c.op(server_name)  or _c.create(td.webserverDAT, server_name)
        scriptcb = _c.op(scriptcb_n)   or _c.create(td.textDAT, scriptcb_n)
        scrop    = _c.op(script_name)  or _c.create(td.scriptCHOP, script_name)
        outop    = _c.op(out_name)     or _c.create(td.nullCHOP, out_name)
        urlop    = _c.op(url_name)     or _c.create(td.textDAT, url_name)

        cb.text = _p["callbacks"]
        scriptcb.text = _p["script_callback"]
        state.text = ""

        try:
            scrop.par.callbacks = scriptcb
        except Exception as _e:
            report["warnings"].append("Script CHOP callbacks param: " + str(_e)[:160])
        try:
            scrop.cook(force=True)
        except Exception:
            pass

        try:
            outop.inputConnectors[0].connect(scrop)
        except Exception as _e:
            report["warnings"].append("Could not wire script->null: " + str(_e)[:160])

        try:
            server.par.port = _p["port"]
            server.par.callbacks = cb
            server.par.active = True
        except Exception as _e:
            report["warnings"].append("Web Server DAT params: " + str(_e)[:160])

        try:
            _ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            _ip = "<this-machine-ip>"
        url = "http://%s:%s/" % (_ip, _p["port"])
        urlop.text = url

        try:
            server.cook(force=True)
        except Exception:
            pass

        report["server"] = server.path
        report["out"] = outop.path
        report["port"] = _p["port"]
        report["url"] = url

        try:
            _err = server.errors(recurse=False) or ""
            if _err:
                report["warnings"].append("Web Server DAT: " + _err[:160])
        except Exception:
            pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildPhoneGestureScript(payload: {
  parent: string;
  name: string;
  port: number;
  enableImu: boolean;
  enableMultitouch: boolean;
  shakeThreshold: number;
}): string {
  const stateName = `${payload.name}_state`;
  const serverName = `${payload.name}_server`;
  const html = HTML_TEMPLATE.replaceAll("__PARENT_NAME__", payload.parent)
    .replaceAll("__IMU_ENABLED__", payload.enableImu ? "true" : "false")
    .replaceAll("__TOUCH_ENABLED__", payload.enableMultitouch ? "true" : "false")
    .replaceAll("__SHAKE_THRESHOLD__", String(payload.shakeThreshold));
  // Escape triple-quotes in the HTML so the Python triple-quoted string stays valid.
  const safeHtml = html.replaceAll('"""', '\\"\\"\\"');
  const callbacks = CALLBACKS_TEMPLATE.replaceAll("__HTML__", safeHtml).replaceAll(
    "__STATE_NAME__",
    stateName,
  );
  const scriptCallback = SCRIPT_CHOP_CALLBACK.replaceAll("__STATE_NAME__", stateName).replaceAll(
    "__SERVER_NAME__",
    serverName,
  );
  return buildPayloadScript(BUILD_SCRIPT, {
    parent: payload.parent,
    name: payload.name,
    port: payload.port,
    callbacks,
    script_callback: scriptCallback,
  });
}

export async function createPhoneGestureImpl(ctx: ToolContext, args: CreatePhoneGestureArgs) {
  return guardTd(
    async () => {
      const script = buildPhoneGestureScript({
        parent: args.parent,
        name: args.name,
        port: args.port,
        enableImu: args.enableImu,
        enableMultitouch: args.enableMultitouch,
        shakeThreshold: args.shakeThreshold,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<GestureReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build phone gesture: ${report.fatal}`, report);
      }
      const summary = `Phone gesture '${args.name}' streaming on ${report.url} → ${report.out}${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreatePhoneGesture: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_phone_gesture",
    {
      title: "Create phone gesture",
      description:
        "Stream a phone's IMU (tilt + gyro + shake) and multitouch into TouchDesigner as CHOP channels you can bind to anything. Builds a Web Server DAT page the phone opens (any browser, no app) and a Null CHOP exposing tilt_x/y/z, gyro_x/y/z, shake, touch0..3_x/y/active, clients. Composable with create_phone_remote on the same COMP (different port). SECURITY: listens on all interfaces with no auth — trusted networks only. iOS Safari needs HTTPS for motion permission; falls back to touch-only on plain HTTP.",
      inputSchema: createPhoneGestureSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPhoneGestureImpl(ctx, args),
  );
};

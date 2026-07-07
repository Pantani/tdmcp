import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const connectDaydreamCloudSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to create the bridge sub-network in."),
  name: z.string().optional().describe("Container name; defaults to daydream_cloud1."),
  source_top_path: z.string().describe("TOP whose frames are POSTed to Daydream."),
  server_url: z
    .string()
    .default("https://api.daydream.live/v1/stream")
    .describe("Daydream inference endpoint. Override for self-hosted or staging."),
  model_id: z.string().default("streamdiffusion-v1").describe("Daydream model slug."),
  prompt: z.string().default("").describe("Text prompt sent in the request body."),
  strength: z.number().min(0).max(1).default(0.7).describe("Diffusion strength."),
  seed: z.number().int().optional().describe("Optional seed."),
  fps: z
    .number()
    .min(1)
    .max(30)
    .default(8)
    .describe("Outbound POST cadence; clamped 1–30 (cloud rate-limit guard)."),
  output_mode: z
    .enum(["syphon", "spout", "ndi"])
    .default("syphon")
    .describe("Receiver TOP to instantiate for the relay output."),
  output_source_name: z
    .string()
    .default("daydream_out")
    .describe("NDI source / Syphon-Spout sender name to subscribe to."),
  active: z
    .boolean()
    .default(false)
    .describe("Start polling immediately (default off so artist can confirm API key is set)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Add custom-page sliders (Prompt, Strength, FPS, Active)."),
});

type ConnectDaydreamCloudArgs = z.infer<typeof connectDaydreamCloudSchema>;

interface DaydreamCloudReport {
  container?: string;
  output_top?: string;
  receiver_kind?: string;
  server_url?: string;
  model_id?: string;
  warnings: string[];
  fatal?: string | string[];
  errors?: string[];
}

const DAYDREAM_CLOUD_SCRIPT = `
import os, json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": [], "kind": "daydream_cloud"}
try:
    _key = os.environ.get("DAYDREAM_API_KEY")
    if not _key:
        report["fatal"] = "DAYDREAM_API_KEY not set in TouchDesigner process environment"
    else:
        _parent = op(_p["parent"])
        if _parent is None:
            report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
        else:
            _src_top = op(_p["source_top_path"])
            if _src_top is None:
                report["warnings"].append("Source TOP not found: " + str(_p["source_top_path"]))
            _base = _p.get("name") or "daydream_cloud1"
            _comp = _parent.create(baseCOMP, _base)
            def _place(node, col, row):
                if node is not None:
                    node.nodeX = col * 220
                    node.nodeY = -(row * 140)
            _place(_comp, 0, 0)

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
                    report["warnings"].append(
                        "Could not set parameter '%s' on %s" % (parname, node.type)
                    )

            def _connect(src, dst):
                try:
                    dst.inputConnectors[0].connect(src)
                    return True
                except Exception:
                    report["warnings"].append(
                        "Could not connect %s -> %s" % (src.name, dst.name)
                    )
                    return False

            # build_request textDAT: encodes source frame + config as JSON body
            _build_req = _comp.create(textDAT, "build_request")
            _place(_build_req, 0, 0)
            _fps_clamped = max(1.0, min(30.0, float(_p.get("fps", 8))))
            _build_req_code = (
                "import json, base64\\n"
                "def onCook(dat):\\n"
                "    src = op(%r)\\n"
                "    if src is None:\\n"
                "        dat.text = '{}'\\n"
                "        return\\n"
                "    try:\\n"
                "        raw = src.saveByteArray('png')\\n"
                "        frame_b64 = base64.b64encode(bytes(raw)).decode('utf-8')\\n"
                "    except Exception:\\n"
                "        frame_b64 = ''\\n"
                "    c = dat.parent()\\n"
                "    pr = c.par.Prompt.val if hasattr(c.par, 'Prompt') else %r\\n"
                "    st = c.par.Strength.val if hasattr(c.par, 'Strength') else %r\\n"
                "    body = {'image': frame_b64, 'model_id': %r, 'prompt': pr,"
                " 'strength': st}\\n"
                "    if %r is not None:\\n"
                "        body['seed'] = %r\\n"
                "    dat.text = json.dumps(body)\\n"
            ) % (
                _p["source_top_path"],
                _p.get("prompt", ""),
                _p.get("strength", 0.7),
                _p.get("model_id", "streamdiffusion-v1"),
                _p.get("seed"),
                _p.get("seed"),
            )
            _build_req.text = _build_req_code

            # webclientDAT
            _web = _comp.create(webclientDAT, "src")
            _place(_web, 1, 0)
            _setpar(_web, "url", _p["server_url"])
            _setpar(_web, "reqmethod", 1)  # POST
            _setpar(_web, "active", 1 if _p.get("active") else 0)
            # headers include Authorization — _key NEVER written to report
            _headers = {
                "Authorization": "Bearer " + _key,
                "Content-Type": "application/json",
            }
            _hp = getattr(_web.par, "headers", None)
            if _hp is not None:
                try:
                    _hp.val = json.dumps(_headers)
                except Exception:
                    report["warnings"].append("Could not set webclientDAT headers; set manually.")
            else:
                report["warnings"].append(
                    "webclientDAT has no 'headers' par in this TD build; set manually."
                )
            # body DAT reference
            _setpar(_web, "callbacks", _build_req.name)

            # response_log DAT
            _resp_log = _comp.create(textDAT, "response_log")
            _place(_resp_log, 2, 1)
            _resp_code = (
                "def onResponse(webClientDAT, statusCode, headerDict, data):\\n"
                "    webClientDAT.parent().op('response_log').text = "
                "'status: ' + str(statusCode)\\n"
            )
            _resp_log.text = ""
            _setpar(_web, "callbacks", _build_req.name)

            # timerCHOP drives cadence
            _clock = _comp.create(timerCHOP, "clock")
            _place(_clock, 0, 1)
            _setpar(_clock, "length", 1.0 / _fps_clamped)
            _setpar(_clock, "cycle", 1)
            _setpar(_clock, "play", 1 if _p.get("active") else 0)

            # chopexecuteDAT fires on cycle → pulses src.par.request
            _cb = _comp.create(chopexecuteDAT, "clock_cb")
            _place(_cb, 1, 1)
            _cb_code = (
                "def onOffToOn(channel, sampleIndex, val, prev):\\n"
                "    src = parent().op('src')\\n"
                "    if src is not None:\\n"
                "        src.par.request.pulse()\\n"
            )
            _cb.text = _cb_code
            _setpar(_cb, "chop", _clock.name)
            if hasattr(_cb.par, "offtoon"):
                _cb.par.offtoon = 1

            # receiver TOP based on output_mode
            _mode = _p.get("output_mode", "syphon")
            _src_name = _p.get("output_source_name", "daydream_out")
            if _mode == "ndi":
                _recv = _comp.create(ndiinTOP, "receiver")
                _place(_recv, 2, 0)
                _setpar(_recv, "sourcename", _src_name)
            else:
                # syphon or spout both use syphonspoutinTOP
                _recv = _comp.create(syphonspoutinTOP, "receiver")
                _place(_recv, 2, 0)
                _setpar(_recv, "sendername", _src_name)

            # nullTOP exposes output
            _null = _comp.create(nullTOP, "out")
            _place(_null, 3, 0)
            _connect(_recv, _null)

            # custom controls page
            if _p.get("expose_controls"):
                _pg = _comp.appendCustomPage("Daydream")
                _ap = _pg.appendToggle("Active")[0]
                _ap.default = bool(_p.get("active"))
                _ap.val = bool(_p.get("active"))
                _pp = _pg.appendStr("Prompt")[0]
                _pp.default = _p.get("prompt", "")
                _pp.val = _p.get("prompt", "")
                _sp = _pg.appendFloat("Strength")[0]
                _sp.min = 0.0; _sp.max = 1.0
                _sp.clampMin = True; _sp.clampMax = True
                _sp.default = float(_p.get("strength", 0.7))
                _sp.val = float(_p.get("strength", 0.7))
                _fp = _pg.appendFloat("Fps")[0]
                _fp.min = 1.0; _fp.max = 30.0
                _fp.clampMin = True; _fp.clampMax = True
                _fp.default = _fps_clamped; _fp.val = _fps_clamped
                # bind Active to webclientDAT and timerCHOP
                try:
                    _web.par.active.expr = "op(%r).par.Active" % _comp.path
                    _web.par.active.mode = type(_web.par.active.mode).EXPRESSION
                except Exception:
                    report["warnings"].append("Could not bind Active to webclientDAT.")
                try:
                    _clock.par.play.expr = "op(%r).par.Active" % _comp.path
                    _clock.par.play.mode = type(_clock.par.play.mode).EXPRESSION
                except Exception:
                    report["warnings"].append("Could not bind Active to timerCHOP.play.")
                try:
                    _clock.par.length.expr = "1.0 / max(1.0, min(30.0, op(%r).par.Fps))" % _comp.path
                    _clock.par.length.mode = type(_clock.par.length.mode).EXPRESSION
                except Exception:
                    report["warnings"].append("Could not bind Fps to timerCHOP.length.")

            report["container"] = _comp.path
            report["output_top"] = _null.path
            report["receiver_kind"] = _mode
            report["server_url"] = _p["server_url"]
            report["model_id"] = _p["model_id"]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
result = json.dumps(report)
print(result)
`;

export async function connectDaydreamCloudImpl(
  ctx: ToolContext,
  args: ConnectDaydreamCloudArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  const payload = {
    parent: args.parent_path,
    name: args.name,
    source_top_path: args.source_top_path,
    server_url: args.server_url,
    model_id: args.model_id,
    prompt: args.prompt,
    strength: args.strength,
    seed: args.seed ?? null,
    fps: Math.max(1, Math.min(30, args.fps)),
    output_mode: args.output_mode,
    output_source_name: args.output_source_name,
    active: args.active,
    expose_controls: args.expose_controls,
  };

  const script = buildPayloadScript(DAYDREAM_CLOUD_SCRIPT, payload);

  return guardTd(
    () => ctx.client.executePythonScript(script),
    (res) => {
      const raw = parsePythonReport<DaydreamCloudReport>(
        (res as unknown as { stdout?: string }).stdout,
      );
      if (raw.fatal) {
        const msg = Array.isArray(raw.fatal) ? raw.fatal.join("\n") : String(raw.fatal);
        // Never include auth headers in the error message
        return errorResult(msg);
      }
      return jsonResult("Daydream Cloud bridge created.", {
        container: raw.container,
        output_top: raw.output_top,
        receiver_kind: raw.receiver_kind,
        server_url: raw.server_url,
        model_id: raw.model_id,
        warnings: raw.warnings,
      });
    },
  );
}

export const registerConnectDaydreamCloud: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "connect_daydream_cloud",
    {
      title: "Connect Daydream Cloud",
      description:
        "Create a Daydream cloud-hosted StreamDiffusion bridge in TD. " +
        "A webclientDAT POSTs the encoded source TOP frame to Daydream's REST endpoint; " +
        "the diffused result is pulled back via a Syphon/Spout/NDI receiver and exposed " +
        "as a null TOP. API key is read from DAYDREAM_API_KEY in the TD process environment — " +
        "never inlined. Live probe SKIPPED (requires Daydream account + outbound HTTPS).",
      inputSchema: connectDaydreamCloudSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectDaydreamCloudImpl(ctx, args),
  );

import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const connectObsRecorderSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP that will receive the OBS recorder control scaffold."),
  name: z.string().default("obs_recorder").describe("Container name for the OBS scaffold."),
  obs_url: z
    .string()
    .default("ws://127.0.0.1:4455")
    .describe("OBS obs-websocket URL. OBS 28+ includes obs-websocket by default."),
  password: z
    .string()
    .optional()
    .describe("Optional OBS websocket password. Never echoed in returned reports."),
  scene_name: z.string().optional().describe("Optional OBS scene name for scene switch requests."),
  source_top_path: z
    .string()
    .optional()
    .describe("Optional TD TOP to publish to OBS through NDI or Syphon/Spout."),
  output_mode: z
    .enum(["ndi", "syphon_spout", "none"])
    .default("ndi")
    .describe("How to expose source_top_path for OBS capture."),
  recording_profile: z
    .enum(["rehearsal", "stream", "archive"])
    .default("rehearsal")
    .describe("Operator-facing recording profile label stored in the scaffold status."),
  active: z
    .boolean()
    .default(false)
    .describe("Start websocket/sender operators active immediately. Defaults off for setup."),
});

type ConnectObsRecorderArgs = z.infer<typeof connectObsRecorderSchema>;

interface ConnectObsRecorderPayload {
  parent: string;
  name: string;
  obs_url: string;
  password?: string;
  scene_name: string | null;
  source_top_path: string | null;
  output_mode: "ndi" | "syphon_spout" | "none";
  recording_profile: "rehearsal" | "stream" | "archive";
  active: boolean;
}

export interface ConnectObsRecorderReport {
  kind?: "obs_recorder";
  container_path?: string;
  websocket_dat?: string;
  callbacks_dat?: string;
  request_dats?: string[];
  status_dat?: string;
  setup_dat?: string;
  sender_top?: string;
  sender_kind?: "ndi" | "syphon_spout" | "none";
  obs_url?: string;
  scene_name?: string | null;
  output_mode?: "ndi" | "syphon_spout" | "none";
  recording_profile?: "rehearsal" | "stream" | "archive";
  active?: boolean;
  auth_status?: "none" | "password redacted";
  warnings?: string[];
  errors?: string[];
  fatal?: string;
}

const OBS_RECORDER_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "kind": "obs_recorder",
    "warnings": [],
    "request_dats": [],
    "obs_url": _p.get("obs_url"),
    "scene_name": _p.get("scene_name"),
    "output_mode": _p.get("output_mode"),
    "recording_profile": _p.get("recording_profile"),
    "active": bool(_p.get("active")),
    "auth_status": "password redacted" if _p.get("password") else "none",
}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _name = _p.get("name") or "obs_recorder"
        _comp = _parent.op(_name)
        if _comp is None:
            _comp = _parent.create(baseCOMP, _name)

        def _place(node, col, row):
            if node is not None:
                node.nodeX = col * 220
                node.nodeY = -(row * 140)

        def _place_abs(node, x, y):
            if node is not None:
                node.nodeX = float(x)
                node.nodeY = float(y)

        def _free_x(parent, y, start=0.0, step=280.0, exclude=None):
            try:
                occupied = set()
                for child in parent.children:
                    if exclude is not None and getattr(child, "path", None) == getattr(exclude, "path", None):
                        continue
                    try:
                        if abs(float(child.nodeY) - float(y)) < 1.0:
                            occupied.add(round(float(child.nodeX) / step) * step)
                    except Exception:
                        continue
                x = float(start)
                while round(x / step) * step in occupied:
                    x += step
                return x
            except Exception:
                return float(start)

        _place_abs(_comp, _free_x(_parent, -180, exclude=_comp), -180)
        report["container_path"] = _comp.path

        def _optype(name):
            return globals().get(name)

        def _ensure(optype_name, node_name, col, row):
            _existing = _comp.op(node_name)
            if _existing is not None:
                _place(_existing, col, row)
                return _existing
            _kind = _optype(optype_name)
            if _kind is None:
                report["warnings"].append("%s not available in this TouchDesigner build." % optype_name)
                return None
            try:
                _created = _comp.create(_kind, node_name)
                _place(_created, col, row)
                return _created
            except Exception as _e:
                report["warnings"].append("Could not create %s %s: %s" % (optype_name, node_name, str(_e)))
                return None

        def _setpar_first(node, names, val, label):
            if node is None or val is None:
                return False
            for _par_name in names:
                _par = getattr(node.par, _par_name, None)
                if _par is None:
                    continue
                try:
                    _par.val = val
                    return True
                except Exception as _e:
                    report["warnings"].append("Could not set %s on %s: %s" % (label, node.name, str(_e)))
                    return False
            report["warnings"].append("No %s parameter found on %s." % (label, node.name))
            return False

        def _connect(src, dst, label):
            if src is None or dst is None:
                return False
            try:
                dst.inputConnectors[0].connect(src)
                return True
            except Exception as _e:
                report["warnings"].append("Could not connect %s: %s" % (label, str(_e)))
                return False

        _ws = _ensure("websocketDAT", "obs_ws", 0, 0)
        if _ws is not None:
            report["websocket_dat"] = _ws.path
            _setpar_first(_ws, ["url"], _p.get("obs_url"), "OBS websocket URL")
            _setpar_first(_ws, ["active"], 1 if _p.get("active") else 0, "active")
            _setpar_first(_ws, ["autoreconnect", "reconnect"], 1, "auto-reconnect")

        _callbacks = _ensure("textDAT", "obs_ws_callbacks", 0, 1)
        if _callbacks is not None:
            report["callbacks_dat"] = _callbacks.path
            _callbacks.text = (
                "import json\\n"
                "def onConnect(websocketDAT):\\n"
                "    websocketDAT.parent().store('obs_status', 'connected')\\n"
                "def onDisconnect(websocketDAT):\\n"
                "    websocketDAT.parent().store('obs_status', 'disconnected')\\n"
                "def onReceiveText(websocketDAT, rowIndex, message):\\n"
                "    websocketDAT.parent().store('obs_last_message', message)\\n"
            )
            _setpar_first(_ws, ["callbacks"], _callbacks.name, "callbacks DAT")

        def _request_payload(request_type, request_data=None):
            return {
                "op": 6,
                "d": {
                    "requestType": request_type,
                    "requestId": "tdmcp_" + request_type,
                    "requestData": request_data or {},
                },
            }

        _scene = _p.get("scene_name") or "Scene"
        _requests = [
            ("req_start_record", "StartRecord", None),
            ("req_stop_record", "StopRecord", None),
            ("req_set_scene", "SetCurrentProgramScene", {"sceneName": _scene}),
            ("req_start_stream", "StartStream", None),
            ("req_stop_stream", "StopStream", None),
        ]
        for _idx, (_dat_name, _request_type, _request_data) in enumerate(_requests):
            _dat = _ensure("textDAT", _dat_name, 1 + (_idx % 3), _idx // 3)
            if _dat is None:
                continue
            _dat.text = json.dumps(_request_payload(_request_type, _request_data), indent=2)
            report["request_dats"].append(_dat.path)

        _status = _ensure("tableDAT", "status", 0, 2)
        if _status is not None:
            report["status_dat"] = _status.path
            _status.clear()
            _status.appendRow(["field", "value"])
            _status.appendRow(["obs_url", str(_p.get("obs_url") or "")])
            _status.appendRow(["scene_name", str(_p.get("scene_name") or "")])
            _status.appendRow(["output_mode", str(_p.get("output_mode") or "none")])
            _status.appendRow(["recording_profile", str(_p.get("recording_profile") or "rehearsal")])
            _status.appendRow(["active", str(bool(_p.get("active")))])
            _status.appendRow(["auth", "password redacted" if _p.get("password") else "none"])
            _status.appendRow(["connection", "obs-websocket v5 request templates ready"])

        _setup = _ensure("textDAT", "setup", 1, 2)
        if _setup is not None:
            report["setup_dat"] = _setup.path
            _setup.text = (
                "OBS Recorder Scaffold\\n"
                "OBS 28+ includes obs-websocket by default. Confirm the websocket server is enabled "
                "on port 4455, then connect obs_ws and send one of the req_* DAT payloads.\\n"
                "If authentication is enabled, configure the websocket callback/auth flow in TD; "
                "this scaffold never stores or displays the password.\\n"
                "Record requests: StartRecord / StopRecord. Stream requests: StartStream / StopStream.\\n"
            )

        _source = _p.get("source_top_path")
        _mode = _p.get("output_mode") or "none"
        if _mode != "none":
            if not _source:
                report["warnings"].append("output_mode=%s but source_top_path was not provided." % _mode)
            else:
                _select = _ensure("selectTOP", "source_select", 0, 3)
                if _select is not None:
                    _setpar_first(_select, ["top"], _source, "source TOP")
                if _mode == "ndi":
                    _sender = _ensure("ndioutTOP", "ndi_out", 1, 3)
                    if _sender is not None:
                        _connect(_select, _sender, "source_select -> ndi_out")
                        _setpar_first(_sender, ["name", "sourcename"], _comp.name, "NDI source name")
                        _setpar_first(_sender, ["active"], 1 if _p.get("active") else 0, "active")
                        report["sender_top"] = _sender.path
                        report["sender_kind"] = "ndi"
                elif _mode == "syphon_spout":
                    _sender = _ensure("syphonspoutoutTOP", "syphon_spout_out", 1, 3)
                    if _sender is not None:
                        _connect(_select, _sender, "source_select -> syphon_spout_out")
                        _setpar_first(_sender, ["sendername", "name"], _comp.name, "Syphon/Spout sender name")
                        _setpar_first(_sender, ["active"], 1 if _p.get("active") else 0, "active")
                        report["sender_top"] = _sender.path
                        report["sender_kind"] = "syphon_spout"
        else:
            report["sender_kind"] = "none"

        _nodes = [_comp, _ws, _callbacks, _status, _setup]
        _errors = []
        for _n in _nodes:
            if _n is None:
                continue
            try:
                _err = _n.errors()
                if _err:
                    _errors.append(str(_err))
            except Exception:
                pass
        report["errors"] = _errors[:3]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
result = json.dumps(report)
print(result)
`;

function redactedText(value: string | undefined, secret: string | undefined): string | undefined {
  if (!value || !secret) return value;
  return value.replaceAll(secret, "[redacted]");
}

function redactedReport(
  report: ConnectObsRecorderReport,
  secret: string | undefined,
): ConnectObsRecorderReport {
  if (!secret) return report;
  return {
    ...report,
    fatal: redactedText(report.fatal, secret),
    warnings: report.warnings?.map((warning) => redactedText(warning, secret) ?? warning),
    errors: report.errors?.map((error) => redactedText(error, secret) ?? error),
  };
}

function buildObsRecorderPayload(args: ConnectObsRecorderArgs): ConnectObsRecorderPayload {
  const payload: ConnectObsRecorderPayload = {
    parent: args.parent_path,
    name: args.name,
    obs_url: args.obs_url,
    scene_name: args.scene_name ?? null,
    source_top_path: args.source_top_path ?? null,
    output_mode: args.output_mode,
    recording_profile: args.recording_profile,
    active: args.active,
  };
  if (args.password !== undefined) {
    payload.password = args.password;
  }
  return payload;
}

export async function connectObsRecorderImpl(ctx: ToolContext, args: ConnectObsRecorderArgs) {
  const script = buildPayloadScript(OBS_RECORDER_SCRIPT, buildObsRecorderPayload(args));

  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ConnectObsRecorderReport>(exec.stdout);
    },
    (rawReport) => {
      const report = redactedReport(rawReport, args.password);
      if (report.fatal) {
        return errorResult(`connect_obs_recorder failed: ${report.fatal}`, report);
      }
      const warnCount = report.warnings?.length ?? 0;
      const errCount = report.errors?.length ?? 0;
      const warnPart = warnCount ? `, ${warnCount} warning(s)` : "";
      const errPart = errCount ? `, ${errCount} node error(s)` : "";
      return jsonResult(
        `Created OBS recorder scaffold at ${report.container_path}. OBS: ${report.obs_url}; output: ${report.output_mode}; profile: ${report.recording_profile}${warnPart}${errPart}.`,
        report,
      );
    },
  );
}

export const registerConnectObsRecorder: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_obs_recorder",
    {
      title: "Connect OBS Recorder",
      description:
        "Create a TouchDesigner-side OBS control scaffold with obs-websocket v5 request templates, status/setup DATs, and optional NDI or Syphon/Spout TOP publishing for OBS capture. The optional OBS password is passed only to the bridge payload and is redacted from all returned reports.",
      inputSchema: connectObsRecorderSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectObsRecorderImpl(ctx, args),
  );
};

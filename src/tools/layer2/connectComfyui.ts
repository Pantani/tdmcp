import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { dropExternalTox } from "../util/dropExternalTox.js";

// ---------------------------------------------------------------------------
// connect_comfyui — bridge TD to a running ComfyUI server.
// Two strategies, tried in order when mode="auto":
//   1. tox_drop — drop TDComfyUI / ComfyUI-TD .tox (community integration).
//   2. webclient — stock-only skeleton: webclientDAT + timerCHOP + receiver TOP.
// ---------------------------------------------------------------------------

export const connectComfyuiSchema = z.object({
  mode: z
    .enum(["auto", "tox_drop", "webclient"])
    .default("auto")
    .describe(
      "'auto' tries tox_drop first then falls back to webclient. Force one explicitly when you know which is installed.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP that will receive the ComfyUI container."),
  name: z.string().optional().describe("Container name; defaults to 'comfyui'."),

  // tox_drop mode
  tox_path: z
    .string()
    .optional()
    .describe(
      "Explicit .tox path. When omitted, candidates are probed in order: olegchomp/TDComfyUI, JiSenHua/ComfyUI-TD.",
    ),

  // webclient mode
  server_url: z
    .string()
    .default("http://127.0.0.1:8188")
    .describe("ComfyUI server base URL — host:port of `python main.py --listen`."),
  workflow_json_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to a ComfyUI workflow JSON exported from the web UI (Save (API Format)). Required for webclient mode.",
    ),
  source_top_path: z
    .string()
    .optional()
    .describe(
      "(webclient) TOP whose current frame is sent as the workflow input image via Syphon/Spout re-broadcast.",
    ),
  output_top_name: z
    .string()
    .default("out")
    .describe("Name of the Null TOP exposed inside the container as the downstream output."),

  // FM-01 output routing
  output_mode: z
    .enum(["spout", "syphon", "ndi", "file_watch"])
    .default(process.platform === "win32" ? "spout" : "syphon")
    .describe(
      "How the generated frame is pulled back into TD. 'file_watch' reloads ComfyUI's output folder via a movieFileInTOP.",
    ),
  output_source_name: z
    .string()
    .default("ComfyUI")
    .describe(
      "Spout sender / Syphon server / NDI source name to receive on. Must match the ComfyUI side.",
    ),
  watch_folder: z
    .string()
    .optional()
    .describe(
      "(output_mode=file_watch) Folder ComfyUI writes outputs to. The movieFileInTOP cycles the newest file.",
    ),

  poll_interval_seconds: z.coerce
    .number()
    .default(0.5)
    .describe("(webclient) How often to poll /history for completion."),
  active: z
    .boolean()
    .default(false)
    .describe(
      "Start polling / streaming immediately. Default off so the artist can sanity-check first.",
    ),
});

type ConnectComfyuiArgs = z.infer<typeof connectComfyuiSchema>;

export interface ConnectComfyuiReport {
  mode_used: "tox_drop" | "webclient";
  container_path: string;
  out_path: string;
  tox_path?: string;
  server_url?: string;
  workflow_json_path?: string;
  validated_pars?: string[];
  missing_pars?: string[];
  warnings: string[];
  errors?: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// tox candidate paths (probed in order on the TS side via dropExternalTox).
// UNVERIFIED — community-project install dirs; tox_path arg is the override.
// Only absolute paths — project-relative paths bypass the TS-side precheck and
// can cause TD to hang when dispatching executePythonScript under load.
// ---------------------------------------------------------------------------
function toxCandidates(explicit?: string): string[] {
  if (explicit) return [explicit];
  const home = os.homedir();
  if (process.platform === "win32") {
    return [
      path.join(home, "Documents", "Derivative", "Palette", "TDComfyUI", "TDComfyUI.tox"),
      path.join(home, "Documents", "Derivative", "Palette", "ComfyUI-TD", "ComfyUI-TD.tox"),
    ];
  }
  return [
    "/Library/Application Support/Derivative/TouchDesigner099/Components/TDComfyUI/TDComfyUI.tox",
    "/Library/Application Support/Derivative/TouchDesigner099/Components/ComfyUI-TD/ComfyUI-TD.tox",
    path.join(home, "Documents", "Derivative", "COMP", "TDComfyUI", "TDComfyUI.tox"),
    path.join(home, "Documents", "Derivative", "COMP", "ComfyUI-TD", "ComfyUI-TD.tox"),
  ];
}

// ---------------------------------------------------------------------------
// Python script — runs after TS resolves the mode. For tox_drop it only sets
// custom pars on the already-loaded COMP; for webclient it builds the full
// stock skeleton and exposes custom pars on the container.
// ---------------------------------------------------------------------------
const COMFYUI_SCRIPT = `
import json, base64, traceback, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": [], "errors": []}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
        print(json.dumps(report)); raise SystemExit
    _name = _p.get("name") or "comfyui"
    _container = _parent.op(_name)
    if _container is None:
        _container = _parent.create(baseCOMP, _name)
    def _place(node, col, row):
        if node is not None:
            node.nodeX = col * 220
            node.nodeY = -(row * 140)
    _place(_container, 0, 0)
    report["container_path"] = _container.path
    _mode = _p["mode_resolved"]

    def _ensure_out(receiver_op=None):
        _out = _container.op(_p.get("output_top_name", "out"))
        if _out is None:
            _out = _container.create(nullTOP, _p.get("output_top_name", "out"))
        _place(_out, 3, 0)
        if receiver_op is not None:
            try:
                _out.inputConnectors[0].connect(receiver_op)
            except Exception as _e:
                report["warnings"].append("Could not connect out to receiver: " + str(_e))
        return _out

    if _mode == "tox_drop":
        _loaded_path = _p.get("loaded_container_path")
        _loaded = op(_loaded_path) if _loaded_path else None
        if _loaded is None:
            report["fatal"] = "tox_drop: loaded container not found at " + str(_loaded_path)
            print(json.dumps(report)); raise SystemExit
        _validated = []
        _missing = []
        _spellings = [
            ("Serverurl", "server_url"), ("Server", "server_url"),
            ("Workflowpath", "workflow_json_path"), ("Workflow", "workflow_json_path"),
            ("Sourcetop", "source_top_path"), ("Input", "source_top_path"),
            ("Active", "active"), ("Run", "active"),
        ]
        _already_set = set()
        for _par_name, _key in _spellings:
            if _key in _already_set:
                continue
            _val = _p.get(_key)
            _pr = getattr(_loaded.par, _par_name, None)
            if _pr is not None and _val is not None:
                try:
                    _pr.val = _val
                    _validated.append(_par_name)
                    _already_set.add(_key)
                except Exception as _e:
                    report["warnings"].append("Could not set par %s: %s" % (_par_name, str(_e)))
            elif _pr is None:
                _missing.append(_par_name)
        report["validated_pars"] = _validated
        report["missing_pars"] = _missing
        report["tox_path"] = _loaded_path
        _out = _ensure_out(_loaded)
        report["out_path"] = _out.path
        report["mode_used"] = "tox_drop"

    elif _mode == "webclient":
        _wf = _p.get("workflow_json_path")
        if not _wf:
            report["fatal"] = "workflow_json_path required for webclient mode"
            print(json.dumps(report)); raise SystemExit
        if not os.path.exists(_wf):
            report["fatal"] = "workflow JSON not found: " + _wf
            print(json.dumps(report)); raise SystemExit
        # --- textDAT "workflow" loads the JSON from disk ---
        _wf_dat = _container.op("workflow")
        if _wf_dat is None:
            _wf_dat = _container.create(textDAT, "workflow")
        _place(_wf_dat, 0, 0)
        try:
            _wf_dat.par.file.val = _wf
            _wf_dat.par.syncfile.val = True
        except Exception as _e:
            report["warnings"].append("Could not configure workflow DAT: " + str(_e))
        # --- webclientDAT "submit" ---
        _submit = _container.op("submit")
        if _submit is None:
            _submit = _container.create(webclientDAT, "submit")
        _place(_submit, 1, 0)
        _srv = _p.get("server_url", "http://127.0.0.1:8188")
        try:
            _submit.par.url.val = _srv.rstrip("/") + "/prompt"
        except Exception as _e:
            report["warnings"].append("Could not set submit url: " + str(_e))
        # --- timerCHOP "poll" ---
        _poll = _container.op("poll")
        if _poll is None:
            _poll = _container.create(timerCHOP, "poll")
        _place(_poll, 1, 1)
        try:
            _poll.par.period.val = float(_p.get("poll_interval_seconds", 0.5))
            _poll.par.active.val = bool(_p.get("active", False))
        except Exception as _e:
            report["warnings"].append("Could not configure poll timer: " + str(_e))
        # --- webclientDAT "history" ---
        _hist = _container.op("history")
        if _hist is None:
            _hist = _container.create(webclientDAT, "history")
        _place(_hist, 2, 1)
        try:
            _hist.par.url.val = _srv.rstrip("/") + "/history"
        except Exception as _e:
            report["warnings"].append("Could not set history url: " + str(_e))
        # --- source frame re-broadcast (src_in + tx_in) ---
        _src_path = _p.get("source_top_path")
        if _src_path:
            _src_op = op(_src_path)
            _src_in = _container.op("src_in")
            if _src_in is None:
                _src_in = _container.create(nullTOP, "src_in")
            _place(_src_in, 0, 2)
            if _src_op is not None:
                try:
                    _src_in.inputConnectors[0].connect(_src_op)
                except Exception as _e:
                    report["warnings"].append("Could not connect src_in: " + str(_e))
            else:
                report["warnings"].append("source_top_path not found: " + _src_path)
            _tx_in = _container.op("tx_in")
            if _tx_in is None:
                _tx_in = _container.create(syphonspoutoutTOP, "tx_in")
            _place(_tx_in, 1, 2)
            try:
                _tx_in.inputConnectors[0].connect(_src_in)
            except Exception as _e:
                report["warnings"].append("Could not connect tx_in: " + str(_e))
        # --- receiver TOP per output_mode ---
        _omode = _p.get("output_mode", "syphon")
        _oname = _p.get("output_source_name", "ComfyUI")
        _receiver = None
        if _omode == "file_watch":
            _receiver = _container.op("receiver")
            if _receiver is None:
                _receiver = _container.create(movieFileInTOP, "receiver")
            _place(_receiver, 2, 0)
            _wfolder = _p.get("watch_folder")
            if _wfolder:
                try:
                    _receiver.par.file.val = _wfolder
                except Exception as _e:
                    report["warnings"].append("Could not set watch_folder: " + str(_e))
            else:
                report["warnings"].append("output_mode=file_watch but watch_folder not set")
        elif _omode == "ndi":
            _receiver = _container.op("receiver")
            if _receiver is None:
                _receiver = _container.create(ndiinTOP, "receiver")
            _place(_receiver, 2, 0)
            try:
                _receiver.par.name.val = _oname
            except Exception as _e:
                report["warnings"].append("Could not set NDI source name: " + str(_e))
        else:
            # spout or syphon — both use syphonspoutinTOP
            _receiver = _container.op("receiver")
            if _receiver is None:
                _receiver = _container.create(syphonspoutinTOP, "receiver")
            _place(_receiver, 2, 0)
            try:
                _receiver.par.sendername.val = _oname
            except Exception as _e:
                report["warnings"].append("Could not set receiver sender name: " + str(_e))
        # --- expose custom pars on container ---
        try:
            _pg = _container.appendCustomPage("ComfyUI")
            _pg.appendStr("Serverurl", label="Server URL")[0].val = _srv
            _pg.appendFile("Workflowpath", label="Workflow Path")[0].val = _wf
            _pg.appendToggle("Active", label="Active")[0].val = bool(_p.get("active", False))
            _pg.appendFloat("Poll", label="Poll Interval")[0].val = float(_p.get("poll_interval_seconds", 0.5))
            _pg.appendStr("Output_sender", label="Output Sender")[0].val = _oname
        except Exception as _e:
            report["warnings"].append("Could not expose custom pars: " + str(_e))
        _out = _ensure_out(_receiver)
        report["out_path"] = _out.path
        report["server_url"] = _srv
        report["workflow_json_path"] = _wf
        report["mode_used"] = "webclient"
    else:
        report["fatal"] = "Unknown mode_resolved: " + str(_mode)
        print(json.dumps(report)); raise SystemExit

    report["errors"] = [str(e) for e in _container.errors()][:3]
except SystemExit:
    pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

// ---------------------------------------------------------------------------
// Expected custom pars probed on the loaded TDComfyUI / ComfyUI-TD container.
// All are optional — missing pars are surfaced as warnings rather than errors.
// ---------------------------------------------------------------------------
const TOX_EXPECTED_PARS = [
  "Serverurl",
  "Server",
  "Workflowpath",
  "Workflow",
  "Sourcetop",
  "Input",
  "Active",
  "Run",
] as const;

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------
export async function connectComfyuiImpl(ctx: ToolContext, args: ConnectComfyuiArgs) {
  const containerName = args.name ?? "comfyui";

  // Validate before touching the bridge.
  if (args.mode === "webclient" && !args.workflow_json_path) {
    return errorResult(
      "webclient mode requires workflow_json_path (export as 'Save (API Format)' from the ComfyUI web UI).",
    );
  }

  // --- tox_drop probe (runs outside guardTd so we can return early on forced failure) ---
  let modeResolved: "tox_drop" | "webclient" = "webclient";
  let loadedContainerPath: string | undefined;

  if (args.mode === "auto" || args.mode === "tox_drop") {
    const candidates = toxCandidates(args.tox_path);
    const drop = await dropExternalTox(ctx, {
      parent_path: args.parent_path,
      candidate_paths: candidates,
      expected_custom_pars: Array.from(TOX_EXPECTED_PARS),
      on_missing: "warn",
    });
    if ("ok" in drop) {
      modeResolved = "tox_drop";
      loadedContainerPath = drop.ok.container_path;
    } else if (args.mode === "tox_drop") {
      // Forced tox_drop and it failed — surface the helper's error directly.
      return drop.error;
    }
    // auto + drop failed → continue to webclient
  }

  // webclient auto-fallback also needs workflow_json_path.
  if (modeResolved === "webclient" && !args.workflow_json_path) {
    return errorResult(
      "Both ComfyUI strategies failed: tox candidates not found AND webclient mode requires workflow_json_path.",
    );
  }

  // --- main bridge script ---
  const script = buildPayloadScript(COMFYUI_SCRIPT, {
    mode_resolved: modeResolved,
    parent: args.parent_path,
    name: containerName,
    loaded_container_path: loadedContainerPath ?? null,
    server_url: args.server_url,
    workflow_json_path: args.workflow_json_path ?? null,
    source_top_path: args.source_top_path ?? null,
    output_top_name: args.output_top_name,
    output_mode: args.output_mode,
    output_source_name: args.output_source_name,
    watch_folder: args.watch_folder ?? null,
    poll_interval_seconds: args.poll_interval_seconds,
    active: args.active,
  });

  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ConnectComfyuiReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`connect_comfyui failed: ${report.fatal}`, report);
      }
      const warnCount = report.warnings.length;
      const errCount = report.errors?.length ?? 0;
      const warnPart = warnCount ? `, ${warnCount} warning(s)` : "";
      const errPart = errCount ? `, ${errCount} node error(s)` : "";
      return jsonResult(
        `Connected ComfyUI via ${report.mode_used} at ${report.container_path}. Output: ${report.out_path}${warnPart}${errPart}.`,
        report,
      );
    },
  );
}

export const registerConnectComfyui: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_comfyui",
    {
      title: "Connect ComfyUI",
      description:
        "Bridge a running ComfyUI server: drops the TDComfyUI .tox if installed, otherwise builds a stock webclientDAT skeleton. The container exposes a Null TOP at <container>/out as the downstream output.",
      inputSchema: connectComfyuiSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectComfyuiImpl(ctx, args),
  );
};

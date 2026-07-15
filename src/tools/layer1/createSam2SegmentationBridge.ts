import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createSam2SegmentationBridgeSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP that will receive the SAM2/FastSAM bridge container."),
  name: z
    .string()
    .default("sam2_segmentation_bridge")
    .describe("Container name for the bridge under parent_path."),
  input_top_path: z
    .string()
    .optional()
    .describe(
      "Optional source TOP path. When provided it is pulled into the container via a Select TOP.",
    ),
  bridge_mode: z
    .enum(["comfyui", "websocket", "ndi_mask", "syphon_spout_mask", "file_watch"])
    .default("comfyui")
    .describe("External mask transport used by the SAM2/FastSAM service."),
  server_url: z
    .string()
    .default("http://127.0.0.1:8188")
    .describe("External SAM2/FastSAM service URL or WebSocket endpoint."),
  mask_source_name: z
    .string()
    .optional()
    .describe("NDI/Syphon/Spout sender name that publishes the segmentation mask."),
  watch_folder: z
    .string()
    .optional()
    .describe("Folder used by file_watch mode for externally rendered mask images."),
  prompt_mode: z
    .enum(["auto", "point", "box", "text"])
    .default("auto")
    .describe("Prompt style expected by the external SAM2/FastSAM service."),
  active: z
    .boolean()
    .default(false)
    .describe("Start request/polling endpoints active. Default is off for artist validation."),
});

type CreateSam2SegmentationBridgeArgs = z.infer<typeof createSam2SegmentationBridgeSchema>;

export interface Sam2SegmentationBridgeReport {
  container_path?: string;
  bridge_mode?: CreateSam2SegmentationBridgeArgs["bridge_mode"];
  prompt_mode?: CreateSam2SegmentationBridgeArgs["prompt_mode"];
  server_url?: string;
  input_top_path?: string | null;
  mask_source_name?: string | null;
  watch_folder?: string | null;
  active?: boolean;
  output_paths?: {
    mask_out: string;
    matte_out: string;
    preview_out: string;
  };
  nodes?: Record<string, string>;
  warnings: string[];
  errors?: string[];
  fatal?: string;
}

const SAM2_SEGMENTATION_BRIDGE_SCRIPT = `
import json, base64, traceback
from urllib.parse import urlparse

_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": [], "errors": [], "nodes": {}}

def _warn(message):
    report["warnings"].append(str(message))

def _place(node, col, row):
    if node is None:
        return
    try:
        node.nodeX = col * 240
        node.nodeY = -(row * 150)
    except Exception:
        pass

def _place_abs(node, x, y):
    if node is None:
        return
    try:
        node.nodeX = float(x)
        node.nodeY = float(y)
    except Exception:
        pass

def _free_x(parent, y, start=0.0, step=280.0):
    try:
        occupied = set()
        for child in parent.children:
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

def _or_create(parent, name, op_type):
    existing = parent.op(name)
    if existing is not None:
        return existing
    return parent.create(op_type, name)

def _setpar(node, par_name, value, warn=True):
    if node is None or value is None:
        return False
    try:
        par = getattr(node.par, par_name, None)
    except Exception:
        par = None
    if par is None:
        if warn:
            _warn("No parameter '%s' on %s" % (par_name, getattr(node, "path", node)))
        return False
    try:
        par.val = value
        return True
    except Exception as exc:
        if warn:
            _warn("Could not set %s on %s: %s" % (par_name, getattr(node, "path", node), exc))
        return False

def _setpar_any(node, names, value):
    for name in names:
        if _setpar(node, name, value, warn=False):
            return True
    _warn(
        "Could not find any of parameters %s on %s"
        % (", ".join(names), getattr(node, "path", node))
    )
    return False

def _connect(src, dst, input_index=0):
    if src is None or dst is None:
        return False
    try:
        dst.inputConnectors[input_index].connect(src)
        return True
    except Exception as exc:
        _warn("Could not connect %s -> %s: %s" % (src.name, dst.name, exc))
        return False

def _record(key, node):
    if node is not None:
        report["nodes"][key] = node.path

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        name = _p.get("name") or "sam2_segmentation_bridge"
        comp = parent.op(name)
        if comp is None:
            comp = parent.create(baseCOMP, name)
        _place_abs(comp, _free_x(parent, -180), -180)
        report["container_path"] = comp.path
        _record("container", comp)

        report["bridge_mode"] = _p.get("bridge_mode", "comfyui")
        report["prompt_mode"] = _p.get("prompt_mode", "auto")
        report["server_url"] = _p.get("server_url")
        report["input_top_path"] = _p.get("input_top_path")
        report["mask_source_name"] = _p.get("mask_source_name")
        report["watch_folder"] = _p.get("watch_folder")
        report["active"] = bool(_p.get("active", False))

        source_path = _p.get("input_top_path")
        if source_path:
            source = _or_create(comp, "source_in", selectTOP)
            _setpar(source, "top", source_path)
        else:
            source = _or_create(comp, "source_in", noiseTOP)
            _setpar(source, "monochrome", 0, warn=False)
        _place(source, 0, 0)
        _record("source_in", source)

        hint = _or_create(comp, "sam2_notes", textDAT)
        _place(hint, 0, 3)
        hint.text = (
            "tdmcp SAM2/FastSAM bridge\\n"
            "No segmentation model is bundled in TouchDesigner. Run and validate an external "
            "SAM2/FastSAM or ComfyUI service, then route its mask back via the selected bridge "
            "mode. Outputs: mask_out, matte_out, preview_out. Prompt mode: "
            + str(_p.get("prompt_mode", "auto"))
        )
        _record("notes", hint)

        mode = _p.get("bridge_mode", "comfyui")
        source_name = _p.get("mask_source_name") or "sam2_mask"
        receiver = None

        if mode == "ndi_mask":
            receiver = _or_create(comp, "mask_receiver", ndiinTOP)
            _setpar_any(receiver, ("sourcename", "name"), source_name)
        elif mode == "syphon_spout_mask":
            receiver = _or_create(comp, "mask_receiver", syphonspoutinTOP)
            _setpar_any(receiver, ("sendername", "servername", "name"), source_name)
        elif mode == "file_watch":
            receiver = _or_create(comp, "mask_receiver", moviefileinTOP)
            watch_folder = _p.get("watch_folder")
            if watch_folder:
                _setpar(receiver, "file", watch_folder)
            else:
                _warn("file_watch mode selected but watch_folder was not provided.")
        elif mode == "websocket":
            ws = _or_create(comp, "mask_ws", websocketDAT)
            _place(ws, 1, 1)
            _record("mask_ws", ws)
            parsed = urlparse(_p.get("server_url") or "ws://127.0.0.1:8765")
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or (443 if parsed.scheme == "wss" else 80)
            _setpar(ws, "netaddress", host)
            _setpar(ws, "port", int(port))
            _setpar(ws, "active", 1 if _p.get("active") else 0, warn=False)
            status = _or_create(comp, "ws_status", textDAT)
            _place(status, 2, 1)
            status.text = "websocket mask bridge placeholder: parse external mask messages here"
            _record("ws_status", status)
            receiver = _or_create(comp, "mask_receiver", constantTOP)
            _setpar(receiver, "color1r", 1.0, warn=False)
            _setpar(receiver, "color1g", 1.0, warn=False)
            _setpar(receiver, "color1b", 1.0, warn=False)
            _warn("websocket mode creates status plumbing only; decode incoming mask frames in TD.")
        elif mode == "comfyui":
            request_template = _or_create(comp, "request_template", textDAT)
            _place(request_template, 1, 1)
            request_template.text = json.dumps(
                {
                    "service": "external_sam2_or_fastsam",
                    "server_url": _p.get("server_url"),
                    "prompt_mode": _p.get("prompt_mode", "auto"),
                    "input_top_path": _p.get("input_top_path"),
                    "expected_return": "Mask should be published back to mask_receiver.",
                },
                indent=2,
            )
            _record("request_template", request_template)
            web = _or_create(comp, "sam2_request", webclientDAT)
            _place(web, 2, 1)
            server_url = (_p.get("server_url") or "http://127.0.0.1:8188").rstrip("/")
            _setpar(web, "url", server_url + "/prompt")
            _setpar(web, "reqmethod", 1, warn=False)
            _setpar(web, "active", 1 if _p.get("active") else 0, warn=False)
            _record("sam2_request", web)
            receiver = _or_create(comp, "mask_receiver", constantTOP)
            _setpar(receiver, "color1r", 1.0, warn=False)
            _setpar(receiver, "color1g", 1.0, warn=False)
            _setpar(receiver, "color1b", 1.0, warn=False)
            _warn("comfyui mode creates a request template and placeholder receiver; validate the external workflow live.")
        else:
            report["fatal"] = "Unknown bridge_mode: " + str(mode)

        if not report.get("fatal"):
            _place(receiver, 1, 0)
            _record("mask_receiver", receiver)

            mask_out = _or_create(comp, "mask_out", nullTOP)
            _place(mask_out, 2, 0)
            _connect(receiver, mask_out)
            _record("mask_out", mask_out)

            matte_comp = _or_create(comp, "matte_comp", compositeTOP)
            _place(matte_comp, 3, 0)
            _setpar(matte_comp, "operand", 7, warn=False)
            _connect(source, matte_comp, 0)
            _connect(mask_out, matte_comp, 1)
            _record("matte_comp", matte_comp)

            matte_out = _or_create(comp, "matte_out", nullTOP)
            _place(matte_out, 4, 0)
            _connect(matte_comp, matte_out)
            _record("matte_out", matte_out)

            preview_comp = _or_create(comp, "preview_comp", compositeTOP)
            _place(preview_comp, 3, 1)
            _connect(source, preview_comp, 0)
            _connect(mask_out, preview_comp, 1)
            _record("preview_comp", preview_comp)

            preview_out = _or_create(comp, "preview_out", nullTOP)
            _place(preview_out, 4, 1)
            _connect(preview_comp, preview_out)
            _record("preview_out", preview_out)

            report["output_paths"] = {
                "mask_out": mask_out.path,
                "matte_out": matte_out.path,
                "preview_out": preview_out.path,
            }

            _warn(
                "Live segmentation requires a separately installed and validated SAM2/FastSAM service; this tool only builds the TouchDesigner bridge surface."
            )

            try:
                errors = comp.errors()
                if isinstance(errors, str):
                    report["errors"] = [line.strip() for line in errors.splitlines() if line.strip()][:5]
                else:
                    report["errors"] = [str(err) for err in errors][:5]
            except Exception:
                pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = json.dumps(report)
print(result)
`;

export function buildSam2SegmentationBridgeScript(payload: object): string {
  return buildPayloadScript(SAM2_SEGMENTATION_BRIDGE_SCRIPT, payload);
}

export async function createSam2SegmentationBridgeImpl(
  ctx: ToolContext,
  args: CreateSam2SegmentationBridgeArgs,
) {
  const containerName = args.name ?? "sam2_segmentation_bridge";
  const script = buildSam2SegmentationBridgeScript({
    parent_path: args.parent_path,
    name: containerName,
    input_top_path: args.input_top_path ?? null,
    bridge_mode: args.bridge_mode,
    server_url: args.server_url,
    mask_source_name: args.mask_source_name ?? null,
    watch_folder: args.watch_folder ?? null,
    prompt_mode: args.prompt_mode,
    active: args.active,
  });

  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<Sam2SegmentationBridgeReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`SAM2 segmentation bridge failed: ${report.fatal}`, report);
      }

      const outputs = report.output_paths;
      const outputSummary = outputs
        ? `${outputs.mask_out}, ${outputs.matte_out}, ${outputs.preview_out}`
        : `${args.parent_path}/${containerName}/mask_out, ${args.parent_path}/${containerName}/matte_out, ${args.parent_path}/${containerName}/preview_out`;
      const warningCount = report.warnings.length;
      const warningNote = warningCount > 0 ? ` ${warningCount} warning(s).` : "";
      return jsonResult(
        `SAM2/FastSAM segmentation bridge created in ${report.container_path ?? `${args.parent_path}/${containerName}`}. Outputs: ${outputSummary}.${warningNote}`,
        report,
      );
    },
  );
}

export const registerCreateSam2SegmentationBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_sam2_segmentation_bridge",
    {
      title: "Create SAM2 segmentation bridge",
      description:
        "Build a TouchDesigner bridge surface for an external SAM2/FastSAM segmentation service. " +
        "Creates source input, mask receiver, mask_out, matte_out, preview_out, and clear notes that no model is bundled.",
      inputSchema: createSam2SegmentationBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSam2SegmentationBridgeImpl(ctx, args),
  );
};

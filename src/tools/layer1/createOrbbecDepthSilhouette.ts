import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createOrbbecDepthSilhouetteSchema = z
  .object({
    parent_path: z.string().default("/project1").describe("Parent COMP for the Orbbec silhouette."),
    name: z.string().default("orbbec_depth_silhouette").describe("Generated baseCOMP name."),
    source: z
      .enum(["orbbec_top", "kinect_azure_orbbec", "file", "synthetic"])
      .default("synthetic")
      .describe("Depth source path. Synthetic is the offline-safe default."),
    source_top_path: z
      .string()
      .optional()
      .describe("Existing TOP path to select instead of creating a device/file source."),
    movie_file: z.string().optional().describe("Movie/depth file for source=file."),
    near_threshold: z.coerce.number().min(0).max(1).default(0.2).describe("Near depth cutoff."),
    far_threshold: z.coerce.number().min(0).max(1).default(0.8).describe("Far depth cutoff."),
    smooth: z.coerce.number().min(0).default(1.5).describe("Blur size for mask smoothing."),
    invert: z.boolean().default(false).describe("Invert the silhouette mask."),
    active: z.boolean().default(false).describe("Start device/file source active where supported."),
  })
  .refine((data) => data.near_threshold <= data.far_threshold, {
    path: ["far_threshold"],
    message: "far_threshold must be greater than or equal to near_threshold.",
  });

type CreateOrbbecDepthSilhouetteArgs = z.infer<typeof createOrbbecDepthSilhouetteSchema>;

export interface OrbbecDepthSilhouetteReport {
  container_path?: string;
  source?: CreateOrbbecDepthSilhouetteArgs["source"];
  depth_source?: string;
  depth_preview?: string;
  silhouette_out?: string;
  sensor_status?: string;
  setup_dat?: string;
  warnings: string[];
  fatal?: string;
}

const ORBBEC_DEPTH_SILHOUETTE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"source": _p.get("source"), "warnings": []}

def _warn(message):
    report["warnings"].append(str(message))

def _place(node, x, y):
    if node is None:
        return
    try:
        node.nodeX = float(x)
        node.nodeY = float(y)
    except Exception:
        pass

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

def _or_create(parent, name, optype):
    existing = parent.op(name)
    if existing is not None:
        return existing
    return parent.create(optype, name)

def _optype(name, fallback):
    found = globals().get(name)
    if found is None:
        _warn("%s is not available in this TouchDesigner build; using %s placeholder." % (name, fallback.__name__ if hasattr(fallback, "__name__") else fallback))
        return fallback
    return found

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

def _connect(src, dst, input_index=0):
    try:
        dst.inputConnectors[input_index].connect(src)
        return True
    except Exception as exc:
        _warn("Could not connect %s -> %s: %s" % (getattr(src, "name", src), getattr(dst, "name", dst), exc))
        return False

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        comp = parent.op(_p["name"])
        if comp is None:
            comp = parent.create(baseCOMP, _p["name"])
        _place(comp, _free_x(parent, -180, exclude=comp), -180)
        report["container_path"] = comp.path

        mode = _p.get("source", "synthetic")
        if _p.get("source_top_path"):
            source = _or_create(comp, "depth_source", selectTOP)
            _setpar(source, "top", _p.get("source_top_path"))
        elif mode == "orbbec_top":
            source = _or_create(comp, "depth_source", _optype("orbbecTOP", noiseTOP))
            _warn("Orbbec TOP source requires live Orbbec SDK/device validation.")
        elif mode == "kinect_azure_orbbec":
            source = _or_create(comp, "depth_source", _optype("kinectazureTOP", noiseTOP))
            _warn("Kinect Azure Orbbec mode requires a compatible Orbbec camera and Kinect Azure operator settings validated live.")
        elif mode == "file":
            source = _or_create(comp, "depth_source", moviefileinTOP)
            _setpar(source, "file", _p.get("movie_file"))
            _setpar(source, "play", 1 if _p.get("active") else 0, warn=False)
        else:
            source = _or_create(comp, "depth_source", noiseTOP)
            _setpar(source, "monochrome", 1, warn=False)
            _setpar(source, "period", 3, warn=False)
        _place(source, 0, 0)
        report["depth_source"] = source.path

        level = _or_create(comp, "depth_range", levelTOP)
        _place(level, 240, 0)
        _setpar(level, "blacklevel", float(_p.get("near_threshold", 0.2)), warn=False)
        _setpar(level, "whitelevel", float(_p.get("far_threshold", 0.8)), warn=False)
        _connect(source, level)

        blur = _or_create(comp, "smooth", blurTOP)
        _place(blur, 480, 0)
        _setpar(blur, "size", float(_p.get("smooth", 1.5)), warn=False)
        _connect(level, blur)

        mask = _or_create(comp, "silhouette_mask", thresholdTOP)
        _place(mask, 720, 0)
        _setpar(mask, "threshold", 0.5, warn=False)
        _connect(blur, mask)

        invert = _or_create(comp, "invert", levelTOP)
        _place(invert, 960, 0)
        _setpar(invert, "invert", 1 if _p.get("invert") else 0, warn=False)
        _connect(mask, invert)

        out = _or_create(comp, "silhouette_out", nullTOP)
        _place(out, 1200, 0)
        _connect(invert, out)
        report["silhouette_out"] = out.path

        preview = _or_create(comp, "depth_preview", nullTOP)
        _place(preview, 240, -180)
        _connect(source, preview)
        report["depth_preview"] = preview.path

        status = _or_create(comp, "sensor_status", tableDAT)
        _place(status, 0, -360)
        status.clear()
        status.appendRow(["field", "value"])
        status.appendRow(["source", str(mode)])
        status.appendRow(["near_threshold", str(_p.get("near_threshold"))])
        status.appendRow(["far_threshold", str(_p.get("far_threshold"))])
        status.appendRow(["active", str(bool(_p.get("active")))])
        report["sensor_status"] = status.path

        notes = _or_create(comp, "setup_notes", textDAT)
        _place(notes, 260, -360)
        notes.text = "Orbbec depth silhouette scaffold. Validate Orbbec SDK, camera firmware, depth units, and TouchDesigner operator parameters live before installation use."
        report["setup_dat"] = notes.path
        _warn("Live Orbbec/Kinect Azure hardware path is unverified by this offline build.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = report
print(json.dumps(report))
`;

export function buildOrbbecDepthSilhouetteScript(payload: object): string {
  return buildPayloadScript(ORBBEC_DEPTH_SILHOUETTE_SCRIPT, payload);
}

export async function createOrbbecDepthSilhouetteImpl(
  ctx: ToolContext,
  args: CreateOrbbecDepthSilhouetteArgs,
) {
  const script = buildOrbbecDepthSilhouetteScript({
    parent_path: args.parent_path,
    name: args.name,
    source: args.source,
    source_top_path: args.source_top_path ?? null,
    movie_file: args.movie_file ?? null,
    near_threshold: args.near_threshold,
    far_threshold: args.far_threshold,
    smooth: args.smooth,
    invert: args.invert,
    active: args.active,
  });

  return guardTd(
    async () =>
      parsePythonReport<OrbbecDepthSilhouetteReport>(
        (await ctx.client.executePythonScript(script, true)).stdout,
      ),
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create Orbbec depth silhouette: ${report.fatal}`, report);
      }
      return jsonResult(
        `Created Orbbec depth silhouette ${report.container_path}; output ${report.silhouette_out}; preview ${report.depth_preview} (${report.warnings.length} warning(s)).`,
        report,
      );
    },
  );
}

export const registerCreateOrbbecDepthSilhouette: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_orbbec_depth_silhouette",
    {
      title: "Create Orbbec depth silhouette",
      description:
        "Create an Orbbec/Kinect-compatible depth silhouette scaffold with synthetic/file fallbacks, stable silhouette_out and depth_preview TOPs, and explicit hardware/SDK validation warnings.",
      inputSchema: createOrbbecDepthSilhouetteSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createOrbbecDepthSilhouetteImpl(ctx, args),
  );
};

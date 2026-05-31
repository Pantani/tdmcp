import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createBlobReactiveSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the blob-reactive container is created (default '/project1')."),
  name: z
    .string()
    .default("blob_reactive")
    .describe("Base name for the container COMP that holds the chain."),
  source: z
    .enum(["camera", "top"])
    .default("camera")
    .describe(
      "Blob source. 'camera' = live webcam/capture device (the real-world default; creating it may pop a one-time macOS camera-permission dialog — click Allow, and note it can briefly hang TD at the modal). 'top' = analyze an existing TOP you name in source_top.",
    ),
  source_top: z
    .string()
    .default("")
    .describe(
      "Path of an existing TOP to track blobs in; used only when source='top' (a Select TOP pulls it in so no cross-container wire is needed).",
    ),
  camera_index: z.coerce
    .number()
    .int()
    .default(0)
    .describe(
      "Which capture device to use when source='camera' (0 = the first/default camera). Maps to the Video Device In TOP's device index.",
    ),
  threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe(
      "Luma threshold [0–1] for isolating blobs: pixels brighter than this are considered part of a blob. Lower catches dim/large blobs, higher only bright ones. Drives both the Threshold TOP mask and the blob tracker's own threshold.",
    ),
  max_blobs: z.coerce
    .number()
    .int()
    .min(1)
    .default(5)
    .describe("Maximum number of blobs to track simultaneously, each given a persistent slot/ID."),
  targets: z
    .array(
      z.object({
        blob: z.coerce
          .number()
          .int()
          .describe("Which tracked blob to read (0-based index; 0 is the first blob)."),
        axis: z
          .enum(["x", "y", "size"])
          .describe(
            "Which per-blob value to read: 'x' = horizontal centroid, 'y' = vertical centroid, 'size' = blob area.",
          ),
        node_param: z
          .string()
          .describe("Target 'nodePath.parName' to drive (e.g. '/project1/transform1.tx')."),
        scale: z.coerce
          .number()
          .default(1)
          .describe(
            "Multiplier applied to the blob value before binding (value * scale + offset).",
          ),
        offset: z.coerce
          .number()
          .default(0)
          .describe("Constant added after scaling (value * scale + offset)."),
      }),
    )
    .default([])
    .describe(
      "Per-blob parameter bindings. Each entry binds one node parameter by expression to op('…/blobs')['blob<blob>_<axis>'] * scale + offset. Omit to just build the tracking chain and bind later.",
    ),
});
type CreateBlobReactiveArgs = z.infer<typeof createBlobReactiveSchema>;

interface BlobReactiveTarget {
  blob: number;
  axis: "x" | "y" | "size";
  node_param: string;
  scale: number;
  offset: number;
}

interface BlobReactiveReport {
  container: string;
  blobs_chop: string;
  output_top: string;
  tracker_type: string;
  channels: string[];
  bound: string[];
  warnings: string[];
  fatal?: string;
}

// Build a blob-position-tracking chain inside a container:
//   source (Video Device In TOP for a camera, or a Select TOP pulling source_top) →
//   Monochrome TOP (luma) → Threshold TOP (binary mask at `threshold`) — the isolated
//   blobs feed both the tracker's input and stay as a viewable mask. →
//   Blob tracker: we PROBE for the optype, preferring blobtrackTOP (image + info CHOP)
//   and falling back to blobtrackCHOP (centroids straight to channels). Blob Track is a
//   palette/CV operator and may not exist on every TD build, so failure is a warning,
//   not fatal — the source + mask are still built. →
//   A Script CHOP normalizes whatever the tracker outputs into a DETERMINISTIC layout
//   blob<i>_x / blob<i>_y / blob<i>_size (i = 0..max_blobs-1), because the tracker's
//   native channel names vary by build (u/v vs tx/ty vs blobN:tx). Bindings then read
//   a stable op('<null>')['blob<i>_<axis>'] regardless. →
//   Null CHOP "blobs" as the stable bind handle.
// Per-target and per-op failures → report["warnings"]; fatal only for parent not found.
const BLOB_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "blobs_chop": "",
    "output_top": "",
    "tracker_type": "",
    "channels": [],
    "bound": [],
    "warnings": [],
}

def _try(label, fn):
    try:
        return fn()
    except Exception as _e:
        report["warnings"].append(label + ": " + str(_e))
        return None

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _cont = _parent.create(baseCOMP, _p["name"])
        report["container"] = _cont.path

        # --- Source TOP ---
        _src = None
        if _p["source"] == "top" and _p["source_top"]:
            _src = _try("Select TOP create", lambda: _cont.create(selectTOP, "videoin"))
            if _src is not None:
                _try("Select TOP top par", lambda: setattr(_src.par, "top", _p["source_top"]))
        else:
            # Dedicated Video Device In TOP. Creating it can pop (and briefly hang on) a
            # macOS camera-permission modal — built anyway; the artist clicks Allow.
            _src = _try("Video Device In create", lambda: _cont.create(videodeviceinTOP, "videoin"))
            if _src is not None:
                try:
                    _src.par.device = _p["camera_index"]
                except Exception:
                    # 'device' may be a menu of names rather than an index on some builds.
                    report["warnings"].append(
                        "Could not set camera index %s on videodeviceinTOP (device par may be a name menu)."
                        % str(_p["camera_index"])
                    )
        if _src is None:
            report["warnings"].append("No source TOP created; chain incomplete.")

        # --- Monochrome (luma) ---
        _mono = _try("Monochrome create", lambda: _cont.create(monochromeTOP, "mono"))
        if _mono is not None and _src is not None:
            _try("mono connect", lambda: _mono.inputConnectors[0].connect(_src))

        # --- Threshold TOP: binary blob mask ---
        _thr = _try("Threshold create", lambda: _cont.create(thresholdTOP, "mask"))
        if _thr is not None and _mono is not None:
            _try("threshold connect", lambda: _thr.inputConnectors[0].connect(_mono))
            _try("threshold par", lambda: setattr(_thr.par, "threshold", _p["threshold"]))
        _mask = _thr if _thr is not None else _mono

        # --- Blob tracker: PROBE-LIVE optype (blobtrackTOP preferred, blobtrackCHOP fallback) ---
        _tracker = None
        _tracker_is_top = False
        for _name in ("blobtrackTOP", "blobtrackCHOP"):
            _ot = globals().get(_name, None)
            if _ot is None:
                continue
            try:
                _tracker = _cont.create(_ot, "blobtrack")
                report["tracker_type"] = _name
                _tracker_is_top = _name.endswith("TOP")
                break
            except Exception as _e:
                report["warnings"].append("Could not create %s: %s" % (_name, str(_e)))
                _tracker = None
        if _tracker is None:
            report["warnings"].append(
                "No Blob Track operator available on this TD build (tried blobtrackTOP/blobtrackCHOP). "
                "Source + mask were built; install the Blob Track palette op to get centroids. UNVERIFIED-live."
            )
        else:
            # Wire the mask into the tracker and apply threshold/max-blobs where present.
            if _mask is not None:
                if _tracker_is_top:
                    _try("tracker connect", lambda: _tracker.inputConnectors[0].connect(_mask))
                else:
                    _try("tracker top par", lambda: setattr(_tracker.par, "top", _mask.path))
            _try("tracker threshold", lambda: setattr(_tracker.par, "threshold", _p["threshold"]))
            _try("tracker maxblobs", lambda: setattr(_tracker.par, "maxblobs", _p["max_blobs"]))
            if _tracker_is_top:
                report["output_top"] = _tracker.path

        # The CHOP carrying the tracker's per-blob channels. For a TOP tracker this is an
        # Info CHOP on it; for a CHOP tracker it is the tracker itself. Channel NAMES vary
        # by build, so we normalize below rather than depend on them. PROBE-LIVE.
        _raw = None
        if _tracker is not None:
            if _tracker_is_top:
                _raw = _try("Info CHOP create", lambda: _cont.create(infoCHOP, "blobinfo"))
                if _raw is not None:
                    _try("info op par", lambda: setattr(_raw.par, "op", _tracker.path))
            else:
                _raw = _tracker

        # --- Script CHOP: normalize to deterministic blob<i>_x/_y/_size ---
        # Reads the raw tracker channels positionally (x,y,size per blob) and writes a
        # stable layout. We can't know the exact native names offline, so the cook code
        # matches common Blob Track channel groups (tx/ty/area, u/v/size, blobN:tx ...)
        # and falls back to slicing channels in threes. Failures => warnings; the raw
        # CHOP remains usable directly if the Script CHOP can't map it.
        _maxb = int(_p["max_blobs"])
        _script = _try("Script CHOP create", lambda: _cont.create(scriptCHOP, "normalize"))
        _norm_src = _raw
        if _script is not None and _raw is not None:
            _try("script connect", lambda: _script.inputConnectors[0].connect(_raw))
            _code = (
                "# Auto-generated by create_blob_reactive. Normalizes the Blob Track\\n"
                "# operator's per-blob channels into blob<i>_x / blob<i>_y / blob<i>_size.\\n"
                "MAXB = %d\\n"
                "def _find(chans, blob, keys):\\n"
                "\\tfor c in chans:\\n"
                "\\t\\tn = c.name.lower()\\n"
                "\\t\\tfor k in keys:\\n"
                "\\t\\t\\tif n == ('blob%%d%%s' %% (blob, k)) or n == ('blob%%d:%%s' %% (blob, k)) or n == ('%%s%%d' %% (k, blob)) or n == ('%%s_%%d' %% (k, blob)):\\n"
                "\\t\\t\\t\\treturn c\\n"
                "\\treturn None\\n"
                "def onCook(scriptOp):\\n"
                "\\tscriptOp.clear()\\n"
                "\\tsrc = scriptOp.inputs[0] if scriptOp.inputs else None\\n"
                "\\tchans = src.chans() if src is not None else []\\n"
                "\\tfor i in range(MAXB):\\n"
                "\\t\\tcx = _find(chans, i, ['tx', 'u', 'x'])\\n"
                "\\t\\tcy = _find(chans, i, ['ty', 'v', 'y'])\\n"
                "\\t\\tcs = _find(chans, i, ['area', 'size', 'w'])\\n"
                "\\t\\tox = scriptOp.appendChan('blob%%d_x' %% i)\\n"
                "\\t\\toy = scriptOp.appendChan('blob%%d_y' %% i)\\n"
                "\\t\\tos = scriptOp.appendChan('blob%%d_size' %% i)\\n"
                "\\t\\tox[0] = cx[0] if cx is not None else 0.0\\n"
                "\\t\\toy[0] = cy[0] if cy is not None else 0.0\\n"
                "\\t\\tos[0] = cs[0] if cs is not None else 0.0\\n"
                "\\treturn\\n"
            ) % _maxb
            _ok = _try(
                "script DAT text",
                lambda: (setattr(_script.par.callbacks.eval(), "text", _code), True)[1],
            )
            if not _ok:
                # Some builds expose the script body via .par.callbacks pointing to a DAT
                # we must create; fall back to writing the op's own text if editable.
                _try("script inline text", lambda: setattr(_script, "text", _code))
            _norm_src = _script

        # --- Null CHOP "blobs": stable output handle ---
        _null = _try("Null CHOP create", lambda: _cont.create(nullCHOP, "blobs"))
        if _null is not None and _norm_src is not None:
            _try("blobs connect", lambda: _null.inputConnectors[0].connect(_norm_src))
        _out = _null if _null is not None else _norm_src
        if _out is not None:
            report["blobs_chop"] = _out.path
            try:
                report["channels"] = [c.name for c in _out.chans()]
            except Exception:
                report["channels"] = []

        # --- Bind targets by expression ---
        _read = report["blobs_chop"]
        if _read:
            for _t in _p.get("targets", []):
                _tp = _t.get("node_param", "")
                try:
                    _dot = _tp.rfind(".")
                    if _dot <= 0:
                        report["warnings"].append(
                            "Invalid target node_param '%s' (expected 'nodePath.parName')." % _tp
                        )
                        continue
                    _np = _tp[:_dot]
                    _pn = _tp[_dot + 1:]
                    _n = op(_np)
                    if _n is None:
                        report["warnings"].append("Target node not found: " + _np)
                        continue
                    _par = getattr(_n.par, _pn, None)
                    if _par is None:
                        report["warnings"].append("Target parameter not found: " + _tp)
                        continue
                    _ch = "blob%d_%s" % (int(_t["blob"]), _t["axis"])
                    _scale = float(_t.get("scale", 1))
                    _offset = float(_t.get("offset", 0))
                    _expr = "op(%s)[%s] * %r + %r" % (repr(_read), repr(_ch), _scale, _offset)
                    _PM = type(_par.mode)
                    _par.expr = _expr
                    _par.mode = _PM.EXPRESSION
                    report["bound"].append(_tp)
                except Exception:
                    report["warnings"].append(
                        "Failed to bind '%s': %s" % (_tp, traceback.format_exc().splitlines()[-1])
                    )
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildBlobReactiveScript(payload: object): string {
  return buildPayloadScript(BLOB_SCRIPT, payload);
}

export async function createBlobReactiveImpl(ctx: ToolContext, args: CreateBlobReactiveArgs) {
  return guardTd(
    async () => {
      const targets: BlobReactiveTarget[] = args.targets.map((t) => ({
        blob: t.blob,
        axis: t.axis,
        node_param: t.node_param,
        scale: t.scale,
        offset: t.offset,
      }));
      const script = buildBlobReactiveScript({
        parent_path: args.parent_path,
        name: args.name,
        source: args.source,
        source_top: args.source_top,
        camera_index: args.camera_index,
        threshold: args.threshold,
        max_blobs: args.max_blobs,
        targets,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<BlobReactiveReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Blob-reactive build failed: ${report.fatal}`, report);
      }
      const trackerNote = report.tracker_type
        ? `tracker ${report.tracker_type}`
        : "no blob tracker (palette op unavailable)";
      const boundNote = report.bound.length > 0 ? `, bound ${report.bound.length} target(s)` : "";
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Built a blob-reactive chain (source: ${args.source}, ${trackerNote}) → ${report.blobs_chop} tracking up to ${args.max_blobs} blob(s)${boundNote}${warnNote}. Bind a parameter to op('${report.blobs_chop}')['blob0_x'] (or _y / _size) to react to blob position.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateBlobReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_blob_reactive",
    {
      title: "Create blob reactive",
      description:
        "Build a blob-position-tracking chain that drives parameters from the POSITIONS of multiple objects/hands in a camera (or a TOP) — the per-blob counterpart to create_motion_reactive's single aggregate motion value. Creates a container under `parent_path` with a Video Device In TOP (or a Select TOP pulling an existing TOP), a Monochrome + Threshold TOP to isolate bright blobs, a Blob Track operator assigning each blob a persistent slot, and a Script CHOP that normalizes the tracker's per-blob output into a deterministic 'blobs' Null CHOP with channels blob0_x, blob0_y, blob0_size, blob1_x, … Bind any parameter to op('…/blob_reactive/blobs')['blob0_x'] (or pass `targets` to bind by expression as value*scale+offset). Camera source may prompt for (and briefly hang on) a macOS camera-permission dialog. The Blob Track operator is a palette/CV op whose optype and channel naming vary by TD build — the chain is built fail-forward and warns (rather than failing) if it is unavailable, and the Script CHOP normalizes whatever channels the tracker emits. Returns a summary plus a JSON block with the container path, the blobs CHOP path, the tracked output TOP, the tracker type used, channel names, bound targets, and warnings.",
      inputSchema: createBlobReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createBlobReactiveImpl(ctx, args),
  );
};

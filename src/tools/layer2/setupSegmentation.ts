import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { createPackagePaths } from "../../packages/paths.js";
import { readPackageState } from "../../packages/state.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

function legacyEngineToxPath(): string {
  return join(
    homedir(),
    "tdmcp-packages",
    "mediapipe-touchdesigner",
    "release",
    "toxes",
    "MediaPipe.tox",
  );
}

/** Finds the engine .tox staged by `tdmcp install mediapipe-touchdesigner`. */
export function defaultEngineToxPath(): string {
  const paths = createPackagePaths();
  const record = readPackageState(paths).packages.find(
    (pkg) => pkg.id === "mediapipe-touchdesigner",
  );
  const artifact =
    record?.artifacts.find(
      (item) => basename(item.absolutePath).toLowerCase() === "mediapipe.tox",
    ) ?? record?.artifacts.find((item) => item.kind === "tox");
  if (artifact) return artifact.absolutePath;
  return legacyEngineToxPath();
}

export const setupSegmentationSchema = z.object({
  tox_path: z
    .string()
    .optional()
    .describe(
      "Path to the MediaPipe ENGINE .tox (MediaPipe.tox). Defaults to the package staged by `tdmcp install mediapipe-touchdesigner`, falling back to the legacy ~/tdmcp-packages path.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "COMP to load the engine into. Reuses the existing engine if MediaPipe already exists.",
    ),
  model: z
    .enum(["general", "landscape"])
    .default("general")
    .describe(
      "Selfie-segmentation model variant. 'general' works at any orientation; 'landscape' is tuned for wide-angle scenes.",
    ),
  smooth: z
    .boolean()
    .default(true)
    .describe("Enable the engine's mask temporal smoothing parameter if present."),
  publish_prekeyed: z
    .boolean()
    .default(true)
    .describe(
      "Also build a person_rgba Null TOP (camera × mask) so you can drop 'person on transparent' straight into a comp.",
    ),
  invert_mask: z
    .boolean()
    .default(false)
    .describe(
      "Output 1 − mask (useful for background-only effects). Applied via a Level TOP on the mask branch.",
    ),
  feather_px: z
    .number()
    .int()
    .min(0)
    .max(32)
    .default(2)
    .describe("Soft-edge blur radius on the mask before publishing (Blur TOP). 0 = hard mask."),
  name: z
    .string()
    .optional()
    .describe("Adapter COMP name under parent_path. Defaults to 'mp_segmentation'."),
});
type SetupSegmentationArgs = z.infer<typeof setupSegmentationSchema>;

interface SegmentationReport {
  engine?: string;
  mask_top?: string;
  person_rgba_top?: string | null;
  model?: string;
  warnings: string[];
  errors?: string[];
  error?: "tox_missing" | "parent_missing" | "mask_not_found";
  fatal?: string;
}

// One Python pass: load/reuse the MediaPipe engine, flip on selfie-segmentation pars,
// locate the mask output TOP inside the engine, build the adapter COMP with sel_mask,
// inv (levelTOP), blur (blurTOP), mask (nullTOP), and optionally the pre-keyed branch.
const SEGMENTATION_SCRIPT = `
import json, base64, traceback, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": [], "errors": []}

def _setpar(node, par_name, value):
    try:
        p = getattr(node.par, par_name, None)
        if p is not None:
            p.val = value
        else:
            report["warnings"].append("Unknown par " + par_name + " on " + node.path)
    except Exception as e:
        report["warnings"].append("Could not set " + par_name + ": " + str(e))

def _or_create(parent, op_name, op_type):
    existing = parent.op(op_name)
    if existing is not None:
        return existing
    return parent.create(op_type, op_name)

try:
    TOX = _p["tox_path"]
    PARENT = _p["parent"]
    ADAPTER_NAME = _p["adapter_name"]
    MODEL = _p["model"]
    SMOOTH = _p["smooth"]
    INVERT = _p["invert_mask"]
    FEATHER = int(_p["feather_px"])
    DO_PREKEYED = _p["publish_prekeyed"]

    root = op(PARENT)
    if root is None:
        report["error"] = "parent_missing"
    elif not os.path.exists(TOX):
        report["error"] = "tox_missing"
    else:
        # Load or reuse the engine
        eng = root.op("MediaPipe") or root.loadTox(TOX)
        try:
            eng.name = "MediaPipe"
        except Exception:
            pass
        root.time.play = True

        # Enable selfie segmentation pars (names are UNVERIFIED — probe live)
        _setpar(eng, "Selfiesegmentation", 1)
        _setpar(eng, "Selfiesegmodel", 0 if MODEL == "general" else 1)
        for smooth_par in ("Selfisegsmoothing", "Selfisegsmooth", "Segsmoothing"):
            p = getattr(eng.par, smooth_par, None)
            if p is not None:
                p.val = 1 if SMOOTH else 0
                break

        # Locate the mask output TOP inside the engine. The torinmb engine has
        # used several names over time (selfieseg_mask, seg_mask, mask,
        # segmentation_results, segmentation_mask). Probe a priority list, then
        # fall back to a regex scan so a future rename doesn't break the build.
        import re as _re
        _MASK_CANDIDATES = (
            "segmentation_results", "segmentation_mask", "selfieseg_mask",
            "seg_mask", "mask", "segmentation",
        )
        mask_src = None
        for _n in _MASK_CANDIDATES:
            _t = eng.op(_n)
            if _t is not None:
                mask_src = _t
                break
        if mask_src is None:
            _rx = _re.compile(r"(segmentation|seg.*mask|self.*mask)", _re.IGNORECASE)
            for t in eng.findChildren(type=TOP, maxDepth=3):
                if _rx.search(t.name):
                    mask_src = t
                    break
        if mask_src is None:
            report["error"] = "mask_not_found"
        else:
            # Locate camera RGBA TOP (best-effort)
            cam_src = (
                eng.op("cam")
                or eng.op("camera")
                or eng.op("webcam")
                or eng.op("videoin")
            )
            if cam_src is None:
                for t in eng.findChildren(type=TOP, maxDepth=3):
                    if any(n in t.name.lower() for n in ("cam", "video", "webcam")):
                        cam_src = t
                        break
            if cam_src is None:
                report["warnings"].append(
                    "Camera TOP not found inside MediaPipe engine; skipping pre-keyed branch."
                )
                DO_PREKEYED = False

            # Build/reuse adapter COMP
            adapter = _or_create(root, ADAPTER_NAME, baseCOMP)

            # sel_mask: selectTOP pulling mask from inside MediaPipe
            sel_mask = _or_create(adapter, "sel_mask", selectTOP)
            _setpar(sel_mask, "top", mask_src.path)

            # inv: levelTOP for optional inversion
            inv = _or_create(adapter, "inv", levelTOP)
            _setpar(inv, "invert", 1 if INVERT else 0)

            # blur: blurTOP for feathering (bypassed when feather_px == 0)
            blur = _or_create(adapter, "blur", blurTOP)
            _setpar(blur, "size", FEATHER)
            try:
                blur.bypass = (FEATHER == 0)
            except Exception:
                pass

            # Wire: sel_mask -> inv -> blur
            try:
                inv.inputConnectors[0].connect(sel_mask)
                blur.inputConnectors[0].connect(inv)
            except Exception as e:
                report["warnings"].append("Wire sel_mask->inv->blur: " + str(e))

            # mask: nullTOP publishing the alpha mask
            mask_out = _or_create(adapter, "mask", nullTOP)
            try:
                mask_out.inputConnectors[0].connect(blur)
            except Exception as e:
                report["warnings"].append("Wire blur->mask: " + str(e))

            report["engine"] = eng.path
            report["mask_top"] = mask_out.path
            report["model"] = MODEL
            report["person_rgba_top"] = None

            # Pre-keyed branch (camera x mask)
            if DO_PREKEYED and cam_src is not None:
                sel_cam = _or_create(adapter, "sel_cam", selectTOP)
                _setpar(sel_cam, "top", cam_src.path)

                comp_rgba = _or_create(adapter, "comp_rgba", compositeTOP)
                _setpar(comp_rgba, "operand", 7)  # 7 = multiply in compositeTOP menu

                try:
                    comp_rgba.inputConnectors[0].connect(sel_cam)
                    comp_rgba.inputConnectors[1].connect(mask_out)
                except Exception as e:
                    report["warnings"].append("Wire comp_rgba inputs: " + str(e))

                person_rgba = _or_create(adapter, "person_rgba", nullTOP)
                try:
                    person_rgba.inputConnectors[0].connect(comp_rgba)
                except Exception as e:
                    report["warnings"].append("Wire comp_rgba->person_rgba: " + str(e))

                report["person_rgba_top"] = person_rgba.path

            # Collect node errors
            try:
                report["errors"] = [str(e) for e in mask_out.errors()][:3]
            except Exception:
                pass

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSegmentationScript(payload: object): string {
  return buildPayloadScript(SEGMENTATION_SCRIPT, payload);
}

export async function setupSegmentationImpl(ctx: ToolContext, args: SetupSegmentationArgs) {
  const toxPath = args.tox_path ?? defaultEngineToxPath();
  const adapterName = args.name ?? "mp_segmentation";

  return guardTd(
    async () => {
      const script = buildSegmentationScript({
        tox_path: toxPath,
        parent: args.parent_path,
        adapter_name: adapterName,
        model: args.model,
        smooth: args.smooth,
        publish_prekeyed: args.publish_prekeyed,
        invert_mask: args.invert_mask,
        feather_px: args.feather_px,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SegmentationReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Segmentation setup failed: ${report.fatal}`, report);
      }
      if (report.error === "tox_missing") {
        return errorResult(
          `MediaPipe engine not found at ${toxPath}. Install it first: run 'tdmcp install mediapipe-touchdesigner' in a terminal, or pass tox_path to an existing MediaPipe.tox.`,
          report,
        );
      }
      if (report.error === "parent_missing") {
        return errorResult(`Parent COMP not found: ${args.parent_path}.`, report);
      }
      if (report.error === "mask_not_found") {
        return errorResult(
          "Selfie segmentation mask output TOP not found inside the MediaPipe engine. Open the MediaPipe component, enable Selfie Segmentation, then re-run.",
          report,
        );
      }
      const maskTop = report.mask_top ?? `${args.parent_path}/${adapterName}/mask`;
      const preKeyedLine = report.person_rgba_top
        ? ` Pre-keyed RGBA at ${report.person_rgba_top}.`
        : "";
      const warnLine = report.warnings.length
        ? ` ${report.warnings.length} warning(s): ${report.warnings[0]}.`
        : "";
      const summary =
        `Selfie segmentation set up. Engine: ${report.engine}. Alpha mask at ${maskTop}.${preKeyedLine}${warnLine} ` +
        `⚠ Grant camera permission if macOS asks, and keep the TD timeline PLAYING.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerSetupSegmentation: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "setup_segmentation",
    {
      title: "Set up selfie segmentation",
      description:
        "One-shot selfie segmentation via the MediaPipe TouchDesigner engine (install with `tdmcp install mediapipe-touchdesigner`). Loads the engine, enables Selfie Segmentation, and builds an adapter COMP with a clean alpha-mask Null TOP (optionally inverted and/or feathered) plus an optional pre-keyed RGBA Null TOP (person on transparent). Wire the mask into create_keyer, create_depth_silhouette, or any matte-consuming tool. The engine reuses an existing MediaPipe op if already loaded (idempotent). Keep the TD timeline PLAYING so the embedded browser captures the webcam; click Allow if macOS prompts for camera permission.",
      inputSchema: setupSegmentationSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupSegmentationImpl(ctx, args),
  );
};

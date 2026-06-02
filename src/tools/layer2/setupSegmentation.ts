import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { createPackagePaths } from "../../packages/paths.js";
import { readPackageState } from "../../packages/state.js";
import { friendlyTdError } from "../../td-client/types.js";
import { parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

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
function defaultEngineToxPath(): string {
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
      "Path to the MediaPipe ENGINE .tox (MediaPipe.tox). Defaults to the package staged by `tdmcp install mediapipe-touchdesigner`, falling back to ~/tdmcp-packages. The same engine is shared with setup_body_tracking / setup_hand_tracking / setup_face_tracking.",
    ),
  parent_path: z.string().default("/project1").describe("COMP to load the engine into."),
  model: z
    .enum(["general", "landscape"])
    .default("general")
    .describe(
      "Selfie-segmentation model variant. 'general' = square model; 'landscape' = wide model. Unknown engine pars degrade to a warning.",
    ),
  smooth: z
    .boolean()
    .default(true)
    .describe("Enable the engine's mask temporal smoothing par if present."),
  publish_prekeyed: z
    .boolean()
    .default(true)
    .describe(
      "Also build a person_rgba Null TOP = camera × mask (alpha = mask), so 'person on transparent' can be dropped straight into a comp.",
    ),
  invert_mask: z
    .boolean()
    .default(false)
    .describe("Output (1 - mask) for background-only effects. Applied via a Level TOP."),
  feather_px: z
    .number()
    .int()
    .min(0)
    .max(32)
    .default(2)
    .describe(
      "Soft-edge blur radius on the mask before publishing. 0 = hard mask (Blur bypassed).",
    ),
  name: z.string().default("mp_segmentation").describe("Adapter COMP name under parent_path."),
});
type SetupSegmentationArgs = z.infer<typeof setupSegmentationSchema>;

interface SegmentationReport {
  error?: "tox_missing" | "parent_missing" | "mask_not_found";
  engine?: string;
  mask_top?: string;
  person_rgba_top?: string | null;
  model?: string;
  warnings?: string[];
  errors?: string[];
}

/**
 * Python (runs in TD): load the MediaPipe ENGINE tox (reused if already loaded), start the
 * timeline, defensively flip on selfie-segmentation pars, locate the mask + camera TOPs by
 * known names then by heuristic, and build an adapter baseCOMP that publishes a clean Null
 * mask TOP (optionally also a pre-keyed RGBA Null TOP = camera × mask).
 */
function loadAndBuildScript(
  toxPath: string,
  parentPath: string,
  model: string,
  smooth: boolean,
  publishPrekeyed: boolean,
  invertMask: boolean,
  featherPx: number,
  name: string,
): string {
  return [
    "import json, os",
    `TOX = ${q(toxPath)}`,
    `PARENT = ${q(parentPath)}`,
    `NAME = ${q(name)}`,
    `MODEL = ${q(model)}`,
    `SMOOTH = ${smooth ? "True" : "False"}`,
    `PREKEY = ${publishPrekeyed ? "True" : "False"}`,
    `INVERT = ${invertMask ? "True" : "False"}`,
    `FEATHER = ${featherPx}`,
    "report = {'warnings': [], 'errors': []}",
    "root = op(PARENT)",
    "if not os.path.exists(TOX):",
    "    report['error'] = 'tox_missing'",
    "elif root is None:",
    "    report['error'] = 'parent_missing'",
    "else:",
    "    eng = root.op('MediaPipe') or root.loadTox(TOX)",
    "    try:",
    "        eng.name = 'MediaPipe'",
    "    except Exception:",
    "        pass",
    "    root.time.play = True",
    // Defensive par toggle helper
    "    def _setpar(node, names, value):",
    "        for n in names:",
    "            p = getattr(node.par, n, None)",
    "            if p is not None:",
    "                try:",
    "                    p.val = value",
    "                    return True",
    "                except Exception:",
    "                    pass",
    "        report['warnings'].append('par_not_found:' + '|'.join(names))",
    "        return False",
    "    _setpar(eng, ['Selfiesegmentation','Selfieseg','Segmentation'], True)",
    "    _setpar(eng, ['Selfiesegmodel','Selfiesegmentationmodel','Segmodel'], MODEL)",
    "    _setpar(eng, ['Selfisegsmoothing','Selfisegsmooth','Selfiesegsmoothing','Segsmooth'], SMOOTH)",
    // Locate mask TOP — known names first, then heuristic
    "    mask_src = eng.op('selfieseg_mask') or eng.op('seg_mask') or eng.op('mask')",
    "    if mask_src is None:",
    "        for t in eng.findChildren(type=TOP, maxDepth=3):",
    "            nm = t.name.lower()",
    "            if 'seg' in nm or 'mask' in nm:",
    "                mask_src = t",
    "                break",
    "    if mask_src is None:",
    "        report['error'] = 'mask_not_found'",
    "        report['engine'] = eng.path",
    "    else:",
    // Locate camera RGBA TOP (best-effort)
    "        cam_src = eng.op('cam') or eng.op('camera') or eng.op('webcam') or eng.op('videoin')",
    "        if cam_src is None:",
    "            for t in eng.findChildren(type=TOP, maxDepth=3):",
    "                nm = t.name.lower()",
    "                if 'cam' in nm or 'webcam' in nm or 'videoin' in nm:",
    "                    cam_src = t",
    "                    break",
    "        if cam_src is None and PREKEY:",
    "            report['warnings'].append('camera_top_not_found_skipping_prekeyed')",
    // Build adapter
    "        adapter = root.op(NAME) or root.create(baseCOMP, NAME)",
    "        try:",
    "            adapter.name = NAME",
    "        except Exception:",
    "            pass",
    "        sel_mask = adapter.op('sel_mask') or adapter.create(selectTOP, 'sel_mask')",
    "        try:",
    "            sel_mask.par.top = mask_src.path",
    "        except Exception:",
    "            report['warnings'].append('sel_mask_top_par_failed')",
    "        inv = adapter.op('inv') or adapter.create(levelTOP, 'inv')",
    "        try:",
    "            inv.par.invert = 1.0 if INVERT else 0.0",
    "        except Exception:",
    "            report['warnings'].append('inv_par_failed')",
    "        inv.inputConnectors[0].connect(sel_mask)",
    "        blur = adapter.op('blur') or adapter.create(blurTOP, 'blur')",
    "        try:",
    "            blur.par.size = float(FEATHER)",
    "            blur.bypass = (FEATHER == 0)",
    "        except Exception:",
    "            report['warnings'].append('blur_par_failed')",
    "        blur.inputConnectors[0].connect(inv)",
    "        mask = adapter.op('mask') or adapter.create(nullTOP, 'mask')",
    "        mask.inputConnectors[0].connect(blur)",
    "        person_rgba_path = None",
    "        if PREKEY and cam_src is not None:",
    "            sel_cam = adapter.op('sel_cam') or adapter.create(selectTOP, 'sel_cam')",
    "            try:",
    "                sel_cam.par.top = cam_src.path",
    "            except Exception:",
    "                report['warnings'].append('sel_cam_top_par_failed')",
    "            comp = adapter.op('comp_rgba') or adapter.create(compositeTOP, 'comp_rgba')",
    "            try:",
    "                comp.par.operand = 'multiply'",
    "            except Exception:",
    "                report['warnings'].append('comp_operand_failed')",
    "            comp.inputConnectors[0].connect(sel_cam)",
    "            comp.inputConnectors[1].connect(mask)",
    "            person_rgba = adapter.op('person_rgba') or adapter.create(nullTOP, 'person_rgba')",
    "            person_rgba.inputConnectors[0].connect(comp)",
    "            person_rgba_path = person_rgba.path",
    "        report['engine'] = eng.path",
    "        report['mask_top'] = mask.path",
    "        report['person_rgba_top'] = person_rgba_path",
    "        report['model'] = MODEL",
    "        try:",
    "            report['errors'] = [str(e) for e in mask.errors()[:3]] if hasattr(mask, 'errors') else []",
    "        except Exception:",
    "            report['errors'] = []",
    "print(json.dumps(report))",
  ].join("\n");
}

export async function setupSegmentationImpl(ctx: ToolContext, args: SetupSegmentationArgs) {
  const toxPath = args.tox_path ?? defaultEngineToxPath();

  let report: SegmentationReport;
  try {
    const exec = await ctx.client.executePythonScript(
      loadAndBuildScript(
        toxPath,
        args.parent_path,
        args.model,
        args.smooth,
        args.publish_prekeyed,
        args.invert_mask,
        args.feather_px,
        args.name,
      ),
      true,
    );
    report = parsePythonReport<SegmentationReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "tox_missing") {
    return errorResult(
      `MediaPipe engine not found at ${toxPath}. Install it first by running 'tdmcp install mediapipe-touchdesigner' in a terminal, or pass tox_path to an existing MediaPipe.tox. Legacy installs are also checked at ${legacyEngineToxPath()}.`,
    );
  }
  if (report.error === "parent_missing") {
    return errorResult(`Parent COMP not found: ${args.parent_path}.`);
  }
  if (report.error === "mask_not_found") {
    return errorResult(
      `Loaded engine (${report.engine ?? "?"}) but couldn't find the selfie-segmentation mask TOP. Open the MediaPipe component, enable Selfie Segmentation, then re-run.`,
    );
  }

  const maskPath = report.mask_top ?? `${args.parent_path}/${args.name}/mask`;
  const prekeyed = report.person_rgba_top ?? null;
  const prekeyedLine = prekeyed
    ? `Pre-keyed RGBA (person on transparent) at ${prekeyed}.`
    : args.publish_prekeyed
      ? "Pre-keyed branch skipped (camera TOP not located inside the engine)."
      : "Pre-keyed branch disabled.";

  const summary = {
    engine_loaded: report.engine,
    mask_top: maskPath,
    person_rgba_top: prekeyed,
    model: report.model ?? args.model,
    warnings: report.warnings ?? [],
    errors: report.errors ?? [],
  };

  return jsonResult(
    `Selfie segmentation is set up. Engine → ${report.engine}; alpha mask Null TOP at ${maskPath}. ${prekeyedLine} Keep the TD timeline PLAYING and grant camera permission if macOS asks. Wire mask into create_keyer / create_depth_silhouette or any matte-consuming tool.`,
    summary,
  );
}

export const registerSetupSegmentation: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "setup_segmentation",
    {
      title: "Set up selfie segmentation",
      description:
        "One-shot MediaPipe selfie-segmentation from a webcam: loads the MediaPipe ENGINE (install with `tdmcp install mediapipe-touchdesigner`), starts the timeline, enables Selfie Segmentation, and publishes a clean alpha-mask Null TOP under an adapter COMP — plus an optional pre-keyed RGBA Null TOP (camera × mask) for 'person on transparent'. Re-runs reuse the existing MediaPipe engine. macOS may show a camera-permission prompt on first load — click Allow.",
      inputSchema: setupSegmentationSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupSegmentationImpl(ctx, args),
  );
};

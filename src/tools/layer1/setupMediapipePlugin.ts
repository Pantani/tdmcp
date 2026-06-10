import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { precheckToxCandidates } from "../util/toxCandidatePrecheck.js";
import {
  defaultEngineToxPath,
  engineToxCandidatePaths,
  legacyEngineToxPath,
} from "./mediapipePluginPaths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const setupMediapipePluginSchema = z
  .object({
    tox_path: z
      .string()
      .optional()
      .describe(
        "Override path to the torinmb mediapipe-touchdesigner ENGINE .tox (MediaPipe.tox — the full tracker with webcam capture, NOT the bare pose_tracking.tox or hand_tracking.tox processors). Defaults to the package staged by `tdmcp install mediapipe-touchdesigner`.",
      ),
    parent_path: z.string().default("/project1").describe("Existing COMP to load the engine into."),
    enable_face: z
      .boolean()
      .default(false)
      .describe("Enable the Face detection pipeline inside the engine."),
    enable_hand: z
      .boolean()
      .default(true)
      .describe("Enable the Hand tracking pipeline inside the engine."),
    enable_body: z
      .boolean()
      .default(true)
      .describe("Enable the Body/Pose tracking pipeline inside the engine."),
    enable_segmentation: z
      .boolean()
      .default(false)
      .describe(
        "Enable the Segmentation pipeline (outputs a matte TOP; heavier GPU cost than the landmark pipelines).",
      ),
    source_video_path: z
      .string()
      .optional()
      .describe(
        "Optional path to a video file to use as input instead of the live webcam. The engine's Camera/Source/Videofile/File par is probed in that order and the first match is set.",
      ),
    container_name: z
      .string()
      .default("MediaPipe")
      .describe(
        "Inner baseCOMP name. Matches the default used by setup_body_tracking / setup_hand_tracking so re-running is idempotent (the engine is reused, not duplicated).",
      ),
  })
  .refine((v) => v.enable_face || v.enable_hand || v.enable_body || v.enable_segmentation, {
    message:
      "At least one pipeline must be enabled (enable_face, enable_hand, enable_body, or enable_segmentation).",
  });

type SetupMediapipePluginArgs = z.infer<typeof setupMediapipePluginSchema>;

// ---------------------------------------------------------------------------
// Report type
// ---------------------------------------------------------------------------

interface MediapipePluginReport {
  error?: "tox_missing" | "parent_missing";
  container_path?: string;
  dropped_tox_path?: string;
  exports?: {
    face_chop: string | null;
    hand_chop: string | null;
    body_chop: string | null;
    segmentation_top: string | null;
  };
  enabled?: {
    face: boolean;
    hand: boolean;
    body: boolean;
    segmentation: boolean;
  };
  video_source?: {
    par: string;
    value: string;
  };
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Bridge script
// ---------------------------------------------------------------------------

const BRIDGE_TEMPLATE = `
import json, os, base64
_b64 = "__PAYLOAD_B64__"
_p = json.loads(base64.b64decode(_b64).decode())

TOX = _p["tox_path"]
PARENT = _p["parent_path"]
CONTAINER = _p["container_name"]
ENABLE_FACE = bool(_p["enable_face"])
ENABLE_HAND = bool(_p["enable_hand"])
ENABLE_BODY = bool(_p["enable_body"])
ENABLE_SEG = bool(_p["enable_segmentation"])
SRC_VIDEO = _p.get("source_video_path") or None
CANDIDATES = _p["candidate_paths"]

report = {"warnings": []}

# Resolve tox
if not os.path.exists(TOX):
    found = None
    for c in CANDIDATES:
        if os.path.exists(c):
            found = c
            break
    if found is None:
        report["error"] = "tox_missing"
        print(json.dumps(report))
        result = report
    else:
        TOX = found

if "error" not in report:
    root = op(PARENT)
    if root is None:
        report["error"] = "parent_missing"
        print(json.dumps(report))
        result = report
    else:
        eng = root.op(CONTAINER)
        if eng is None:
            eng = root.loadTox(TOX)
            try:
                eng.name = CONTAINER
            except Exception:
                pass

        # Toggle modality pars (defensive — warn on miss)
        for par_name, flag in [("Face", ENABLE_FACE), ("Hand", ENABLE_HAND), ("Body", ENABLE_BODY), ("Segmentation", ENABLE_SEG)]:
            p = eng.par[par_name] if hasattr(eng, "par") else None
            if p is not None:
                try:
                    p.val = bool(flag)
                except Exception as e:
                    report["warnings"].append(f"{par_name} par set failed: {e}")
            else:
                report["warnings"].append(f"{par_name} par missing on engine")

        # Optional video source par — probe order matches torinmb release history
        vs_par = None
        vs_label = "live webcam"
        if SRC_VIDEO is not None:
            for pn in ["Camera", "Source", "Videofile", "File"]:
                p = eng.par[pn] if hasattr(eng, "par") else None
                if p is not None:
                    try:
                        p.val = SRC_VIDEO
                        vs_par = pn
                        vs_label = SRC_VIDEO
                        break
                    except Exception:
                        pass
            if vs_par is None:
                report["warnings"].append("source_video_path: no matching par found (Camera/Source/Videofile/File all missing)")
        else:
            # Report which par exists even if no override
            for pn in ["Camera", "Source", "Videofile", "File"]:
                p = eng.par[pn] if hasattr(eng, "par") else None
                if p is not None:
                    vs_par = pn
                    break

        report["video_source"] = {"par": vs_par or "unknown", "value": vs_label}

        # Keep the timeline playing (engine's embedded browser only runs while playing)
        try:
            root.time.play = True
        except Exception:
            pass

        # Discover output operators (search engine's immediate children + 1 level down)
        def find_op(name):
            d = eng.op(name)
            if d is not None:
                return d.path
            for child in eng.children:
                sub = child.op(name) if hasattr(child, "op") else None
                if sub is not None:
                    return sub.path
            return None

        face_path = find_op("face") if ENABLE_FACE else None
        hand_path = find_op("hand") if ENABLE_HAND else None
        body_path = find_op("pose") if ENABLE_BODY else None
        seg_path = find_op("segmentation") if ENABLE_SEG else None

        report["container_path"] = eng.path
        report["dropped_tox_path"] = TOX
        report["exports"] = {
            "face_chop": face_path,
            "hand_chop": hand_path,
            "body_chop": body_path,
            "segmentation_top": seg_path,
        }
        report["enabled"] = {
            "face": ENABLE_FACE,
            "hand": ENABLE_HAND,
            "body": ENABLE_BODY,
            "segmentation": ENABLE_SEG,
        }
        print(json.dumps(report))
        result = report
`.trimStart();

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function setupMediapipePluginImpl(
  ctx: ToolContext,
  args: SetupMediapipePluginArgs,
): Promise<ReturnType<typeof errorResult>> {
  const toxPath = args.tox_path ?? defaultEngineToxPath();

  // Round-2 Wave-4 fix: short-circuit BEFORE the bridge call when every
  // candidate is absolute and none exist on disk. Avoids TD-hang under load.
  const allCandidates = [toxPath, ...engineToxCandidatePaths()];
  const precheck = precheckToxCandidates(allCandidates);
  if (precheck.allAbsoluteAndMissing) {
    return errorResult(
      `MediaPipe engine not found at ${toxPath} (also checked: ${engineToxCandidatePaths().join(", ")}). ` +
        "Install it first: `tdmcp install mediapipe-touchdesigner` (free, MIT-licensed GPU MediaPipe tracker by torinmb), " +
        `or pass tox_path pointing to an existing MediaPipe.tox. Legacy installs are also checked at ${legacyEngineToxPath()}.`,
    );
  }

  const script = buildPayloadScript(BRIDGE_TEMPLATE, {
    tox_path: toxPath,
    parent_path: args.parent_path,
    container_name: args.container_name,
    enable_face: args.enable_face,
    enable_hand: args.enable_hand,
    enable_body: args.enable_body,
    enable_segmentation: args.enable_segmentation,
    source_video_path: args.source_video_path ?? null,
    candidate_paths: engineToxCandidatePaths(),
  });

  let report: MediapipePluginReport;
  try {
    const exec = await ctx.client.executePythonScript(script, true);
    report = parsePythonReport<MediapipePluginReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "tox_missing") {
    return errorResult(
      `MediaPipe engine not found at ${toxPath} (also checked: ${engineToxCandidatePaths().join(", ")}). ` +
        `Install it first: \`tdmcp install mediapipe-touchdesigner\` (free, MIT-licensed GPU MediaPipe tracker by torinmb), ` +
        `or pass tox_path pointing to an existing MediaPipe.tox. Legacy installs are also checked at ${legacyEngineToxPath()}.`,
    );
  }
  if (report.error === "parent_missing") {
    return errorResult(`Parent COMP not found: ${args.parent_path}.`);
  }

  const warnings = report.warnings ?? [];
  const exports = report.exports ?? {
    face_chop: null,
    hand_chop: null,
    body_chop: null,
    segmentation_top: null,
  };

  const modalities = [
    args.enable_face && "face",
    args.enable_hand && "hand",
    args.enable_body && "body",
    args.enable_segmentation && "segmentation",
  ]
    .filter(Boolean)
    .join(", ");

  const NOTE =
    "NOTE: face_chop/hand_chop/body_chop output paths are DATs (JSON landmark streams), not CHOPs. " +
    "Wire them through a Script CHOP adapter to get numeric landmark data.";

  const summary =
    `MediaPipe engine loaded at ${report.container_path ?? `${args.parent_path}/${args.container_name}`}. ` +
    `Enabled pipelines: ${modalities}. ` +
    `Keep the TD timeline PLAYING — the plugin captures via an embedded browser that only runs while playing. ` +
    (warnings.length > 0 ? `Warnings: ${warnings.join("; ")}. ` : "") +
    NOTE;

  return jsonResult(summary, {
    container_path: report.container_path,
    dropped_tox_path: report.dropped_tox_path,
    exports,
    enabled: report.enabled,
    video_source: report.video_source,
    warnings,
  });
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerSetupMediapipePlugin: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "setup_mediapipe_plugin",
    {
      title: "Set up MediaPipe plugin (multi-modal)",
      description:
        "Drop the torinmb mediapipe-touchdesigner ENGINE in one shot and enable any combination of face, hand, body, and segmentation pipelines. " +
        "Use this instead of running setup_face_tracking + setup_hand_tracking + setup_body_tracking + setup_segmentation separately — those tools each re-load the engine, resulting in multiple competing MediaPipe COMPs fighting for the webcam. " +
        "This tool loads the engine ONCE and toggles its Face/Hand/Body/Segmentation pars. " +
        "IMPORTANT: there is NO stock TouchDesigner MediaPipe; all five mediapipe tools (this one + the four setup_*_tracking tools) rely on the free torinmb plugin — install it first with `tdmcp install mediapipe-touchdesigner`. " +
        "Output paths for face/hand/body are DATs (JSON landmark streams from the plugin), not CHOPs — use a Script CHOP adapter to convert to numeric channels. " +
        "The engine requires the TD timeline to be PLAYING (uses an embedded browser for webcam capture).",
      inputSchema: setupMediapipePluginSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupMediapipePluginImpl(ctx, args),
  );
};

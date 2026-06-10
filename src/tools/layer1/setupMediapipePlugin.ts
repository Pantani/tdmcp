import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { dropExternalTox } from "../util/dropExternalTox.js";
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
// Expected modality pars on the engine (validated by dropExternalTox).
// Camera/Source/Videofile/File are NOT in this list — the video-source par
// is probed in priority order in the configure pass below.
// ---------------------------------------------------------------------------

const EXPECTED_PARS = ["Face", "Hand", "Body", "Segmentation"] as const;

// ---------------------------------------------------------------------------
// Configure-pass report (runs AFTER dropExternalTox)
// ---------------------------------------------------------------------------

interface ConfigureReport {
  error?: "engine_missing";
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
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Configure pass — runs AFTER the helper has loaded the engine baseCOMP.
// Toggles modality flags, sets optional video source par, locates exports.
// ---------------------------------------------------------------------------

const CONFIGURE_TEMPLATE = `
import json, os, base64
_b64 = "__PAYLOAD_B64__"
_p = json.loads(base64.b64decode(_b64).decode())

CONTAINER_PATH = _p["container_path"]
ENABLE_FACE = bool(_p["enable_face"])
ENABLE_HAND = bool(_p["enable_hand"])
ENABLE_BODY = bool(_p["enable_body"])
ENABLE_SEG  = bool(_p["enable_segmentation"])
SRC_VIDEO   = _p.get("source_video_path") or None

report = {"warnings": []}

eng = op(CONTAINER_PATH)
if eng is None:
    report["error"] = "engine_missing"
    print(json.dumps(report)); raise SystemExit

# Toggle modality pars (defensive — warn on miss)
for par_name, flag in [("Face", ENABLE_FACE), ("Hand", ENABLE_HAND), ("Body", ENABLE_BODY), ("Segmentation", ENABLE_SEG)]:
    p = getattr(eng.par, par_name, None)
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
        p = getattr(eng.par, pn, None)
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
    for pn in ["Camera", "Source", "Videofile", "File"]:
        p = getattr(eng.par, pn, None)
        if p is not None:
            vs_par = pn
            break

report["video_source"] = {"par": vs_par or "unknown", "value": vs_label}

# Keep the timeline playing (engine's embedded browser only runs while playing)
try:
    project.time.play = True
except Exception:
    try:
        op("/").time.play = True
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
seg_path  = find_op("segmentation") if ENABLE_SEG else None

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
result = json.dumps(report)
print(result)
`.trimStart();

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function setupMediapipePluginImpl(
  ctx: ToolContext,
  args: SetupMediapipePluginArgs,
): Promise<ReturnType<typeof errorResult>> {
  const toxPath = args.tox_path ?? defaultEngineToxPath();
  const candidates = [toxPath, ...engineToxCandidatePaths()];

  // Phase 1 — drop the engine TOX into the parent COMP. dropExternalTox
  // runs its own precheck and short-circuits when every candidate is
  // absolute-and-missing on disk, so we don't repeat that here.
  const dropResult = await dropExternalTox(ctx, {
    parent_path: args.parent_path,
    container_name: args.container_name,
    candidate_paths: candidates,
    expected_custom_pars: Array.from(EXPECTED_PARS),
    on_missing: "warn",
  });

  if ("error" in dropResult) {
    // Enrich the error with the standard install hint.
    const original = dropResult.error.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    return errorResult(
      `${original} Install it first: \`tdmcp install mediapipe-touchdesigner\` ` +
        "(free, MIT-licensed GPU MediaPipe tracker by torinmb), or pass tox_path pointing to an existing MediaPipe.tox. " +
        `Legacy installs are also checked at ${legacyEngineToxPath()}.`,
    );
  }

  const {
    container_path: containerPath,
    found_path: droppedToxPath,
    warnings: dropWarn,
  } = dropResult.ok;

  // Phase 2 — configure the loaded engine.
  const script = buildPayloadScript(CONFIGURE_TEMPLATE, {
    container_path: containerPath,
    enable_face: args.enable_face,
    enable_hand: args.enable_hand,
    enable_body: args.enable_body,
    enable_segmentation: args.enable_segmentation,
    source_video_path: args.source_video_path ?? null,
  });

  let report: ConfigureReport;
  try {
    const exec = await ctx.client.executePythonScript(script, true);
    report = parsePythonReport<ConfigureReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "engine_missing") {
    return errorResult(
      `MediaPipe engine container disappeared at ${containerPath} between load and configure (unexpected — re-run).`,
    );
  }

  const warnings = [...dropWarn, ...(report.warnings ?? [])];
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
    `MediaPipe engine loaded at ${containerPath}. ` +
    `Enabled pipelines: ${modalities}. ` +
    `Keep the TD timeline PLAYING — the plugin captures via an embedded browser that only runs while playing. ` +
    (warnings.length > 0 ? `Warnings: ${warnings.join("; ")}. ` : "") +
    NOTE;

  return jsonResult(summary, {
    container_path: containerPath,
    dropped_tox_path: droppedToxPath,
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

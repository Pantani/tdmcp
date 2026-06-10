import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { dropExternalTox } from "../util/dropExternalTox.js";
import { precheckToxCandidates } from "../util/toxCandidatePrecheck.js";

export const createDepthFromTwoDSchema = z.object({
  source_top_path: z
    .string()
    .min(1)
    .describe(
      "Absolute TD path of the 2D source TOP (movieFileInTOP / videoDeviceInTOP / NDI-in / any cooked TOP). Required.",
    ),
  tox_path: z
    .string()
    .optional()
    .describe(
      "Override path to TDDepthAnything.tox. When omitted, candidates are tried in order. Set this when the TOX lives outside ~/Documents/Derivative.",
    ),
  output_resolution: z
    .enum(["256", "384", "512", "768", "1024"])
    .default("512")
    .describe(
      "Square inference resolution. Lower = faster, higher = sharper depth edges. Default 512 matches Depth Anything v2 sweet spot on a 30-series GPU.",
    ),
  model_variant: z
    .enum(["small", "base", "large"])
    .default("small")
    .describe(
      "Depth Anything v2 model size. small = ~25 ms/frame on RTX 3070, large = ~80 ms but cleaner edges. The TOX must have the matching .engine/.onnx weight on disk.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network for the depth_from_2d baseCOMP."),
});

type CreateDepthFromTwoDArgs = z.infer<typeof createDepthFromTwoDSchema>;

const EXPECTED_PARS = ["Inputtop", "Outputresolution", "Modelvariant"] as const;

interface ConfigureReport {
  error?: "container_missing" | "tox_missing";
  depth_out_path?: string;
  validated_pars?: string[];
  missing_pars?: string[];
  warnings?: string[];
}

/**
 * Expands `~` in a path using Node's `homedir()`.
 * `dropExternalTox`'s Python payload only resolves relative paths against `project.folder`;
 * absolute `~/...` candidates must be fully expanded client-side before being sent to TD.
 */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Returns the ordered candidate absolute paths for TDDepthAnything.tox.
 */
function buildCandidatePaths(override: string | undefined): string[] {
  const base = [
    join(homedir(), "Documents", "Derivative", "COMP", "TDDepthAnything.tox"),
    join(homedir(), "Documents", "Derivative", "Palette", "TDDepthAnything", "TDDepthAnything.tox"),
    join(homedir(), "Documents", "touchdesigner", "TDDepthAnything", "TDDepthAnything.tox"),
    join(homedir(), "Documents", "TDDepthAnything", "TDDepthAnything.tox"),
  ];
  if (override) {
    const expanded = expandHome(override);
    return [expanded, ...base.filter((p) => p !== expanded)];
  }
  return base;
}

/**
 * Configure pass — runs AFTER dropExternalTox has loaded TDDepthAnything into a
 * baseCOMP that wraps it. Creates the src_in inTOP, wires source, configures the
 * tox pars (Inputtop / Outputresolution / Modelvariant — UNVERIFIED par names),
 * creates depth_out nullTOP, installs a frame cooker, and returns the depth_out path.
 *
 * The dropExternalTox helper drops TDDepthAnything inside a fresh container named
 * `depth_from_2d`. The container's `container_path` is what we receive; we work
 * with `op(container_path).parent` for the wrapper and `op(container_path)` for
 * the inner tox (the helper made the tox the baseCOMP we got back).
 */
const CONFIGURE_TEMPLATE = `
import json, base64
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))

TOX_PATH          = _p["tox_container_path"]
WRAPPER_PATH      = _p["wrapper_container_path"]
SOURCE_TOP_PATH   = _p["source_top_path"]
OUTPUT_RESOLUTION = _p["output_resolution"]
MODEL_VARIANT     = _p["model_variant"]

report = {"warnings": []}

tox_op = op(TOX_PATH)
if tox_op is None:
    report["error"] = "tox_missing"
    print(json.dumps(report)); raise SystemExit

container = op(WRAPPER_PATH)
if container is None:
    report["error"] = "container_missing"
    print(json.dumps(report)); raise SystemExit

# Create inTOP src_in bound to source via par.top
src_in = container.op('src_in') or container.create(inTOP, 'src_in')
try: src_in.name = 'src_in'
except Exception: pass
try: src_in.par.top = SOURCE_TOP_PATH
except Exception: report['warnings'].append('Could not set src_in.par.top')

# Wire src_in -> TDDepthAnything input 0
try: tox_op.inputConnectors[0].connect(src_in)
except Exception: report['warnings'].append('Wire src_in->TDDepthAnything failed (non-fatal)')

# Defensive par sets (UNVERIFIED par names — based on IntentDev README)
def _trysetpar(op_ref, par_name, value):
    p = getattr(op_ref.par, par_name, None)
    if p is None: return False
    try: p.val = value; return True
    except Exception: return False

validated_pars = []
missing_pars = []

if _trysetpar(tox_op, 'Inputtop', src_in.path): validated_pars.append('Inputtop')
else: missing_pars.append('Inputtop')

if _trysetpar(tox_op, 'Outputresolution', OUTPUT_RESOLUTION): validated_pars.append('Outputresolution')
else: missing_pars.append('Outputresolution')

if _trysetpar(tox_op, 'Modelvariant', MODEL_VARIANT): validated_pars.append('Modelvariant')
else: missing_pars.append('Modelvariant')

# depth_out nullTOP wired from TDDepthAnything output 0
depth_out = container.op('depth_out') or container.create(nullTOP, 'depth_out')
try: depth_out.name = 'depth_out'
except Exception: pass
try: depth_out.inputConnectors[0].connect(tox_op)
except Exception: report['warnings'].append('Wire TDDepthAnything->depth_out failed (non-fatal)')
report['depth_out_path'] = depth_out.path

# Frame cooker keeps chain alive when source is static
cooker = container.op('cooker') or container.create(executeDAT, 'cooker')
try:
    cooker.text = "def onFrameStart(frame):\\n    parent().op('depth_out').cook(force=True)\\n    return\\n"
    cooker.par.framestart = True
    cooker.par.active = True
except Exception:
    report['warnings'].append('Frame cooker setup failed (non-fatal)')

report['validated_pars'] = validated_pars
report['missing_pars'] = missing_pars

result = json.dumps(report)
print(result)
`;

export async function createDepthFromTwoDImpl(
  ctx: ToolContext,
  args: CreateDepthFromTwoDArgs,
): Promise<CallToolResult> {
  // Surface a macOS warning — TDDepthAnything requires NVIDIA CUDA + TensorRT.
  const platformWarnings: string[] = [];
  if (platform === "darwin") {
    platformWarnings.push(
      "WARNING: TDDepthAnything requires an NVIDIA GPU with CUDA and TensorRT. macOS is not supported. The TOX will fail to cook on Apple Silicon or AMD GPUs.",
    );
  }

  const candidates = buildCandidatePaths(args.tox_path);

  // Phase 0 — short-circuit BEFORE any bridge call when every candidate is
  // absolute and missing on disk. Avoids TD-hang on executePythonScript.
  const precheck = precheckToxCandidates(candidates);
  if (precheck.allAbsoluteAndMissing) {
    const checkedList = precheck.absoluteChecked.join("\n  - ");
    return errorResult(
      `Install TDDepthAnything from https://github.com/IntentDev/TDDepthAnything and place TDDepthAnything.tox in ~/Documents/Derivative/COMP/, or pass tox_path explicitly.\n\nSearched:\n  - ${checkedList}`,
    );
  }

  // Phase 1 — drop TDDepthAnything.tox into a fresh wrapper baseCOMP.
  // We first create the wrapper, then drop the tox inside it.
  // dropExternalTox runs its own absolute-missing precheck and short-circuits
  // before any bridge call when no candidate exists on disk.
  const wrapperCreate = await dropExternalToxWithWrapper(ctx, args.parent_path, candidates);

  if ("error" in wrapperCreate) {
    // Enrich precheck/no-candidate errors with install hint.
    const original = wrapperCreate.error.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    return errorResult(
      `Install TDDepthAnything from https://github.com/IntentDev/TDDepthAnything and ` +
        `place TDDepthAnything.tox in ~/Documents/Derivative/COMP/, or pass tox_path explicitly. ${original}`,
    );
  }

  const { wrapperPath, toxContainerPath, foundPath, dropWarnings, missingPars } = wrapperCreate.ok;

  // Phase 2 — configure: wire source, set pars, build depth_out + cooker.
  const script = buildPayloadScript(CONFIGURE_TEMPLATE, {
    tox_container_path: toxContainerPath,
    wrapper_container_path: wrapperPath,
    source_top_path: args.source_top_path,
    output_resolution: args.output_resolution,
    model_variant: args.model_variant,
  });

  let report: ConfigureReport;
  try {
    const exec = await ctx.client.executePythonScript(script, true);
    report = parsePythonReport<ConfigureReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "container_missing" || report.error === "tox_missing") {
    return errorResult(
      `TDDepthAnything wrapper disappeared between load and configure (unexpected — re-run).`,
    );
  }

  const containerPath = wrapperPath;
  const depthTopPath = report.depth_out_path ?? `${containerPath}/depth_out`;
  const droppedToxPath = foundPath || toxContainerPath;

  // Merge missing pars from drop validation + configure pass.
  const configureMissing = report.missing_pars ?? [];
  const mergedMissing = Array.from(new Set([...missingPars, ...configureMissing]));

  const allWarnings = [
    ...platformWarnings,
    ...dropWarnings,
    ...(report.warnings ?? []),
    ...mergedMissing.map(
      (p) => `Custom par '${p}' not found on TDDepthAnything (UNVERIFIED par name — confirm live).`,
    ),
  ];

  const summary = [
    `Built depth_from_2d: TDDepthAnything v2 wrapper wrapping '${args.source_top_path}' → depth TOP at '${depthTopPath}'.`,
    `Feed this depth_top_path into create_depth_displacement / create_depth_pop_field / create_depth_silhouette.`,
    `NOTE: First cook may take 30–60 s for TensorRT engine compile. Requires NVIDIA GPU + pre-built .engine weights.`,
    allWarnings.length > 0 ? `Warnings: ${allWarnings.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return jsonResult(summary, {
    container_path: containerPath,
    dropped_tox_path: droppedToxPath,
    depth_top_path: depthTopPath,
    source_top_path: args.source_top_path,
    output_resolution: Number(args.output_resolution),
    model_variant: args.model_variant,
    warnings: allWarnings,
  });
}

/**
 * Two-step drop: create the wrapper baseCOMP (depth_from_2d), then drop
 * TDDepthAnything.tox inside it via dropExternalTox. The helper expects the
 * parent to already exist and short-circuits on missing candidates.
 */
interface WrapperOk {
  wrapperPath: string;
  toxContainerPath: string;
  foundPath: string;
  dropWarnings: string[];
  missingPars: string[];
}

async function dropExternalToxWithWrapper(
  ctx: ToolContext,
  parentPath: string,
  candidates: string[],
): Promise<{ ok: WrapperOk } | { error: CallToolResult }> {
  // 1. Create wrapper baseCOMP via a tiny script so it exists for the drop helper.
  //    Idempotent: reuse existing one named 'depth_from_2d'.
  const wrapperPath = `${parentPath}/depth_from_2d`;
  const ensureScript = `
import json
root = op(${JSON.stringify(parentPath)})
if root is None:
    print(json.dumps({"error": "parent_missing"})); raise SystemExit
existing = root.op('depth_from_2d')
if existing is None:
    container = root.create(baseCOMP, 'depth_from_2d')
    try: container.name = 'depth_from_2d'
    except Exception: pass
else:
    container = existing
print(json.dumps({"wrapper_path": container.path}))
`;
  try {
    const exec = await ctx.client.executePythonScript(ensureScript, true);
    const out = parsePythonReport<{ error?: string; wrapper_path?: string }>(exec.stdout);
    if (out.error === "parent_missing") {
      return { error: errorResult(`Parent path not found in TouchDesigner: ${parentPath}`) };
    }
  } catch (err) {
    return { error: errorResult(friendlyTdError(err)) };
  }

  // 2. Drop TDDepthAnything into the wrapper.
  const drop = await dropExternalTox(ctx, {
    parent_path: wrapperPath,
    container_name: "TDDepthAnything",
    candidate_paths: candidates,
    expected_custom_pars: Array.from(EXPECTED_PARS),
    on_missing: "warn",
  });

  if ("error" in drop) {
    return { error: drop.error };
  }

  return {
    ok: {
      wrapperPath,
      toxContainerPath: drop.ok.container_path,
      foundPath: drop.ok.found_path,
      dropWarnings: drop.ok.warnings,
      missingPars: drop.ok.missing_pars,
    },
  };
}

export const registerCreateDepthFromTwoD: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_depth_from_2d",
    {
      title: "Create depth from 2D",
      description:
        "Wraps TDDepthAnything v2 (community TOX by IntentDev) to convert any 2D image/video TOP into a depth map TOP using Depth Anything v2 via NVIDIA TensorRT/ONNX — no Kinect or RealSense required. Given a source TOP path, drops the TOX into a fresh container, wires the source, exposes a depth Null TOP whose path can be fed directly into create_depth_displacement, create_depth_pop_field, or create_depth_silhouette. Requires the user to have installed TDDepthAnything.tox from https://github.com/IntentDev/TDDepthAnything and an NVIDIA GPU with CUDA + TensorRT pre-built weights (.engine/.onnx). NOT supported on macOS. First cook may take 30–60 s for engine compile. Returns container_path, dropped_tox_path, depth_top_path (the key output), source_top_path, output_resolution, model_variant, and warnings.",
      inputSchema: createDepthFromTwoDSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDepthFromTwoDImpl(ctx, args),
  );
};

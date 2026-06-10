import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { precheckToxCandidates } from "../util/toxCandidatePrecheck.js";

const q = (value: string): string => JSON.stringify(value);

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

interface DepthFromTwoDReport {
  error?: "no_candidate_found" | "parent_missing";
  candidates_checked?: string[];
  container_path?: string;
  found_path?: string;
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
 * `~` is expanded to Node `homedir()` so the Python bridge receives real absolute paths.
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
 * Python script that:
 * 1. Checks candidates in order until it finds a valid .tox file.
 * 2. Creates a baseCOMP container under `parentPath`.
 * 3. Loads TDDepthAnything.tox via `loadTox`.
 * 4. Creates an inTOP (src_in) bound to `sourceTopPath`.
 * 5. Wires src_in → TDDepthAnything (input 0) AND sets Inputtop par defensively.
 * 6. Creates a nullTOP (depth_out) wired from TDDepthAnything output 0.
 * 7. Defensively sets Outputresolution + Modelvariant pars — warns on missing.
 * 8. Installs a frame cooker to keep the chain alive.
 *
 * UNVERIFIED par names: Inputtop / Outputresolution / Modelvariant.
 * Based on IntentDev TDDepthAnything README. Mark with comment. Warn on missing.
 */
function buildDropScript(
  candidates: readonly string[],
  parentPath: string,
  sourceTopPath: string,
  outputResolution: string,
  modelVariant: string,
): string {
  return [
    "import json, os",
    `CANDIDATES = ${JSON.stringify(candidates)}`,
    `PARENT_PATH = ${q(parentPath)}`,
    `SOURCE_TOP_PATH = ${q(sourceTopPath)}`,
    `OUTPUT_RESOLUTION = ${q(outputResolution)}`,
    `MODEL_VARIANT = ${q(modelVariant)}`,
    "report = {'warnings': []}",
    "",
    "# Find first valid candidate",
    "tox_path = None",
    "checked = []",
    "for c in CANDIDATES:",
    "    checked.append(c)",
    "    if os.path.exists(c):",
    "        tox_path = c",
    "        break",
    "",
    "if tox_path is None:",
    "    report['error'] = 'no_candidate_found'",
    "    report['candidates_checked'] = checked",
    "    print(json.dumps(report))",
    "else:",
    "    root = op(PARENT_PATH)",
    "    if root is None:",
    "        report['error'] = 'parent_missing'",
    "        print(json.dumps(report))",
    "    else:",
    "        # Create container",
    "        container = root.create(baseCOMP, 'depth_from_2d')",
    "        try: container.name = 'depth_from_2d'",
    "        except Exception: pass",
    "        report['container_path'] = container.path",
    "",
    "        # Load TDDepthAnything TOX",
    "        existing = container.op('TDDepthAnything')",
    "        if existing is not None:",
    "            tox_op = existing",
    "            report['warnings'].append(\"Container 'TDDepthAnything' already existed; reusing.\")",
    "        else:",
    "            tox_op = container.loadTox(tox_path)",
    "            try: tox_op.name = 'TDDepthAnything'",
    "            except Exception: pass",
    "        report['found_path'] = tox_op.path",
    "",
    "        # Create inTOP (src_in) bound to source via par.top",
    "        src_in = container.op('src_in') or container.create(inTOP, 'src_in')",
    "        try: src_in.name = 'src_in'",
    "        except Exception: pass",
    "        try: src_in.par.top = SOURCE_TOP_PATH",
    "        except Exception: report['warnings'].append('Could not set src_in.par.top')",
    "",
    "        # Wire src_in → TDDepthAnything input 0 (fail-forward)",
    "        try: tox_op.inputConnectors[0].connect(src_in)",
    "        except Exception: report['warnings'].append('Wire src_in→TDDepthAnything failed (non-fatal)')",
    "",
    "        # Also set Inputtop custom par defensively",
    "        # UNVERIFIED par name: Inputtop — based on IntentDev README",
    "        def _trysetpar(op_ref, par_name, value):",
    "            p = getattr(op_ref.par, par_name, None)",
    "            if p is None: return False",
    "            try: p.val = value; return True",
    "            except Exception: return False",
    "",
    "        validated_pars = []",
    "        missing_pars = []",
    "",
    "        if _trysetpar(tox_op, 'Inputtop', src_in.path): validated_pars.append('Inputtop')",
    "        else: missing_pars.append('Inputtop')",
    "",
    "        # UNVERIFIED par name: Outputresolution — based on IntentDev README",
    "        if _trysetpar(tox_op, 'Outputresolution', OUTPUT_RESOLUTION): validated_pars.append('Outputresolution')",
    "        else: missing_pars.append('Outputresolution')",
    "",
    "        # UNVERIFIED par name: Modelvariant — based on IntentDev README",
    "        if _trysetpar(tox_op, 'Modelvariant', MODEL_VARIANT): validated_pars.append('Modelvariant')",
    "        else: missing_pars.append('Modelvariant')",
    "",
    "        # Create depth_out nullTOP wired from TDDepthAnything output 0",
    "        depth_out = container.op('depth_out') or container.create(nullTOP, 'depth_out')",
    "        try: depth_out.name = 'depth_out'",
    "        except Exception: pass",
    "        try: depth_out.inputConnectors[0].connect(tox_op)",
    "        except Exception: report['warnings'].append('Wire TDDepthAnything→depth_out failed (non-fatal)')",
    "        report['depth_out_path'] = depth_out.path",
    "",
    "        # Frame cooker to keep chain alive when source is static",
    "        cooker = container.op('cooker') or container.create(executeDAT, 'cooker')",
    "        try:",
    "            cooker.text = \"def onFrameStart(frame):\\n    parent().op('depth_out').cook(force=True)\\n    return\\n\"",
    "            cooker.par.framestart = True",
    "            cooker.par.active = True",
    "        except Exception:",
    "            report['warnings'].append('Frame cooker setup failed (non-fatal)')",
    "",
    "        report['validated_pars'] = validated_pars",
    "        report['missing_pars'] = missing_pars",
    "",
    "        print(json.dumps(report))",
  ].join("\n");
}

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

  // Round-2 Wave-4 fix: short-circuit BEFORE bridge call when every candidate
  // is absolute and missing on disk — avoids TD-hang on executePythonScript.
  const precheck = precheckToxCandidates(candidates);
  if (precheck.allAbsoluteAndMissing) {
    const checkedList = precheck.absoluteChecked.join("\n  - ");
    return errorResult(
      `Install TDDepthAnything from https://github.com/IntentDev/TDDepthAnything and place TDDepthAnything.tox in ~/Documents/Derivative/COMP/, or pass tox_path explicitly.\n\nSearched:\n  - ${checkedList}`,
    );
  }

  let report: DepthFromTwoDReport;
  try {
    const script = buildDropScript(
      candidates,
      args.parent_path,
      args.source_top_path,
      args.output_resolution,
      args.model_variant,
    );
    const exec = await ctx.client.executePythonScript(script, false);
    report = parsePythonReport<DepthFromTwoDReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "no_candidate_found") {
    const checkedList = (report.candidates_checked ?? candidates).join("\n  - ");
    return errorResult(
      `Install TDDepthAnything from https://github.com/IntentDev/TDDepthAnything and place TDDepthAnything.tox in ~/Documents/Derivative/COMP/, or pass tox_path explicitly.\n\nSearched:\n  - ${checkedList}`,
    );
  }

  if (report.error === "parent_missing") {
    return errorResult(`Parent path not found in TouchDesigner: ${args.parent_path}`);
  }

  const containerPath = report.container_path ?? `${args.parent_path}/depth_from_2d`;
  const depthTopPath = report.depth_out_path ?? `${containerPath}/depth_out`;
  const droppedToxPath = report.found_path ?? `${containerPath}/TDDepthAnything`;

  const allWarnings = [
    ...platformWarnings,
    ...(report.warnings ?? []),
    ...(report.missing_pars ?? []).map(
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

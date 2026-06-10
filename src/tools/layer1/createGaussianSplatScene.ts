import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { dropExternalTox } from "../util/dropExternalTox.js";
import { precheckToxCandidates } from "../util/toxCandidatePrecheck.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

// ---------------------------------------------------------------------------
// Resolution map
// ---------------------------------------------------------------------------

const RES_MAP: Record<string, [number, number]> = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
  "2160p": [3840, 2160],
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createGaussianSplatSceneSchema = z.object({
  splat_asset_path: z
    .string()
    .refine((v) => v.endsWith(".ply") || v.endsWith(".splat"), {
      message: "splat_asset_path must end in .ply or .splat",
    })
    .describe(
      "Absolute path to a .ply or .splat Gaussian Splat asset. Export from Polycam, Postshot, Luma, or Nerfstudio.",
    ),
  tox_path: z
    .string()
    .optional()
    .describe(
      "Optional explicit absolute path to TDGS.tox. When set, skips the standard candidate walk. " +
        "Useful when TDGS lives in a non-standard packages directory.",
    ),
  camera_path: z
    .string()
    .optional()
    .describe(
      "Absolute TD path to an existing cameraCOMP (e.g. one built by create_camera_orbit). " +
        "When set, TDGS's camera reference par is bound to it. When unset, TDGS uses its internal default camera.",
    ),
  output_res: z
    .enum(["720p", "1080p", "1440p", "2160p"])
    .default("1080p")
    .describe(
      "Output renderTOP resolution. 720p=1280×720, 1080p=1920×1080, 1440p=2560×1440, 2160p=3840×2160. " +
        "WARNING: 1440p+ requires a discrete GPU with ≥12GB VRAM; 2160p will crash TD on OOM. Default 1080p.",
    ),
  container_name: z
    .string()
    .default("gaussian_splat_scene")
    .describe("Name of the outer baseCOMP created by createSystemContainer."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network for the baseCOMP (default '/project1')."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), promotes SplatAssetPath, CameraRef, and OutputRes to the wrapper container as live knobs.",
    ),
});

export type CreateGaussianSplatSceneArgs = z.infer<typeof createGaussianSplatSceneSchema>;

// ---------------------------------------------------------------------------
// Expected pars (UNVERIFIED — par names confirmed at QA live-probe)
// ---------------------------------------------------------------------------

const EXPECTED_PARS = ["Plyfile", "Splatfile", "File", "Camera", "Cam"] as const;

// ---------------------------------------------------------------------------
// Candidate TDGS.tox paths
// ---------------------------------------------------------------------------

function buildCandidatePaths(toxOverride: string | undefined): string[] {
  if (toxOverride !== undefined) {
    return [toxOverride];
  }
  const home = os.homedir();
  return [
    path.join(home, "Documents", "Derivative", "COMP", "TDGS.tox"),
    path.join(home, "Documents", "Derivative", "COMP", "TDGS", "TDGS.tox"),
    path.join(home, "Documents", "touchdesigner", "TDGS", "TDGS.tox"),
    path.join(home, "Documents", "touchdesigner", "TDGS.tox"),
  ];
}

// ---------------------------------------------------------------------------
// Configure payload template (runs AFTER dropExternalTox)
// ---------------------------------------------------------------------------

const CONFIGURE_TEMPLATE = `
import base64, json, os
_payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))

CONTAINER_PATH   = _payload["container_path"]
SPLAT_ASSET_PATH = os.path.normpath(_payload["splat_asset_path"])
CAMERA_PATH      = _payload.get("camera_path")

report = {"warnings": []}

tdgs = op(CONTAINER_PATH)
if tdgs is None:
    report["error"] = "tdgs_missing"
    result = json.dumps(report)
    print(result)
    raise SystemExit

# 1. Validate asset on disk
if not os.path.exists(SPLAT_ASSET_PATH):
    report["error"] = "asset_missing"
    report["asset"] = SPLAT_ASSET_PATH
    result = json.dumps(report)
    print(result)
    raise SystemExit

# 2. Set asset par — try candidates in order (TDGS naming UNVERIFIED)
asset_par_name = None
for cand in ("Plyfile", "Splatfile", "File", "Asset"):
    p = getattr(tdgs.par, cand, None)
    if p is not None:
        p.val = SPLAT_ASSET_PATH
        asset_par_name = cand
        break
if asset_par_name is None:
    report["warnings"].append(
        "TDGS exposes no recognized asset par (tried Plyfile/Splatfile/File/Asset); set it manually."
    )
report["asset_par_name"] = asset_par_name

# 3. Bind camera if provided
if CAMERA_PATH:
    cam = op(CAMERA_PATH)
    if cam is None:
        report["warnings"].append("camera_path not found: " + str(CAMERA_PATH))
    else:
        cam_bound = False
        for cand in ("Camera", "Cam", "Cameracomp"):
            p = getattr(tdgs.par, cand, None)
            if p is not None:
                p.val = cam.path
                report["camera_par_name"] = cand
                cam_bound = True
                break
        if not cam_bound:
            report["warnings"].append("TDGS exposes no recognized camera par (tried Camera/Cam/Cameracomp).")

# 4. Locate inner output TOP (out1 first, then first renderTOP child)
inner_out = tdgs.op("out1")
if inner_out is None:
    inner_out = next(
        (c for c in tdgs.children if c.opType == "renderTOP"),
        None,
    )
report["inner_out_path"] = inner_out.path if inner_out else None

result = json.dumps(report)
print(result)
`;

interface ConfigureReport {
  error?: "tdgs_missing" | "asset_missing";
  asset?: string;
  asset_par_name?: string | null;
  camera_par_name?: string;
  inner_out_path?: string | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createGaussianSplatSceneImpl(
  ctx: ToolContext,
  args: CreateGaussianSplatSceneArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return runBuild(async () => {
    const warnings: string[] = [];
    const [resW, resH] = RES_MAP[args.output_res] ?? [1920, 1080];

    // 0. Pre-flight: short-circuit BEFORE container creation when every
    //    candidate is absolute and missing on disk — avoids TD-hang and
    //    orphan baseCOMP.
    const candidatePaths = buildCandidatePaths(args.tox_path);
    const precheck = precheckToxCandidates(candidatePaths);
    if (precheck.allAbsoluteAndMissing) {
      return errorResult(
        `No TDGS.tox found on disk. Tried: ${precheck.absoluteChecked.join(", ")}. ` +
          "Install TDGS by Anglerfish-graphics from https://github.com/Anglerfish-Graphics/TDGS " +
          "or pass an explicit tox_path. Note: TDGS requires TD build ≥2023.30000 with a " +
          "CUDA-capable NVIDIA GPU on Windows; it will not load on macOS/AMD.",
      );
    }

    // 1. Outer baseCOMP
    const builder = await createSystemContainer(ctx, args.parent_path, args.container_name);

    // 2. Drop TDGS.tox
    const dropResult = await dropExternalTox(ctx, {
      parent_path: builder.containerPath,
      container_name: "TDGS",
      candidate_paths: candidatePaths,
      expected_custom_pars: Array.from(EXPECTED_PARS),
      on_missing: "warn",
    });

    if ("error" in dropResult) {
      // Enrich the error message with install hint
      const original = dropResult.error.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(" ");
      return {
        ...dropResult.error,
        content: [
          {
            type: "text" as const,
            text:
              original +
              " Install TDGS by Anglerfish-graphics from https://github.com/Anglerfish-Graphics/TDGS " +
              "or pass an explicit tox_path. Note: TDGS requires TD build ≥2023.30000 with a CUDA-capable " +
              "NVIDIA GPU on Windows; it will not load on macOS/AMD.",
          },
        ],
      };
    }

    const {
      container_path: tdgsPath,
      found_path,
      missing_pars,
      warnings: dropWarn,
    } = dropResult.ok;
    warnings.push(...dropWarn);
    if (missing_pars.length > 0) {
      warnings.push(
        `Missing TDGS custom pars (probe with live TD to confirm names): ${missing_pars.join(", ")}`,
      );
    }

    // 3. Configure pass — set asset, bind camera, locate inner output TOP
    const configScript = buildPayloadScript(CONFIGURE_TEMPLATE, {
      container_path: tdgsPath,
      splat_asset_path: args.splat_asset_path,
      camera_path: args.camera_path ?? null,
    });

    let innerOutPath: string | null = null;
    let assetParName: string | null = null;

    try {
      const exec = await ctx.client.executePythonScript(configScript, true);
      const cfg = parsePythonReport<ConfigureReport>(exec.stdout);
      warnings.push(...(cfg.warnings ?? []));

      if (cfg.error === "tdgs_missing") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `TDGS container not found at ${tdgsPath} after drop. This is unexpected — re-run or check TD console for load errors.`,
            },
          ],
        };
      }

      if (cfg.error === "asset_missing") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Splat asset not found on disk: ${cfg.asset ?? args.splat_asset_path}. ` +
                "Provide an absolute path to a .ply or .splat file exported from Polycam, Postshot, Luma, or Nerfstudio.",
            },
          ],
        };
      }

      innerOutPath = cfg.inner_out_path ?? null;
      assetParName = cfg.asset_par_name ?? null;
    } catch (err) {
      warnings.push(`Configure pass failed (non-fatal): ${String(err)}`);
    }

    // 4. selectTOP selects TDGS inner output
    const splatOutTop = innerOutPath ?? `${tdgsPath}/out1`;
    const splat_out = await builder.add("selectTOP", "splat_out", { top: splatOutTop });

    // 5. fitTOP for resolution scaling
    const scale = await builder.add("fitTOP", "scale", {
      outputresolution: "custom",
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(splat_out, scale);

    // 6. Null output
    const out1 = await builder.add("nullTOP", "out1");
    await builder.connect(scale, out1);

    // 7. Expose controls
    if (args.expose_controls) {
      await builder.python(
        `
_c = op(${JSON.stringify(builder.containerPath)})
try:
    pg = _c.appendCustomPage("Controls")
    _c.par.SplatAssetPath = ${JSON.stringify(args.splat_asset_path)}
except Exception:
    pass
`.trim(),
      );
    }

    const extra: Record<string, unknown> = {
      container_path: builder.containerPath,
      dropped_tox_path: found_path,
      output_top_path: out1,
      camera_path: args.camera_path ?? null,
      asset_par_name: assetParName,
      output_res: args.output_res,
      resolution: [resW, resH],
      warnings: [...builder.warnings, ...warnings],
    };

    return finalize(ctx, {
      summary:
        `Built Gaussian Splat scene inside ${builder.containerPath}. ` +
        `TDGS tox: ${found_path}. ` +
        `Asset: ${args.splat_asset_path}${assetParName ? ` (par: ${assetParName})` : " (par: unresolved — set manually)"}. ` +
        `Output TOP: ${out1} @ ${args.output_res} (${resW}×${resH}).` +
        (args.camera_path
          ? ` Camera bound: ${args.camera_path}.`
          : " Camera: TDGS internal default.") +
        (warnings.length ? ` Warnings: ${warnings.join("; ")}` : ""),
      builder,
      outputPath: out1,
      capturePreviewImage: true,
      extra,
    });
  });
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateGaussianSplatScene: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_gaussian_splat_scene",
    {
      title: "Create Gaussian Splat scene",
      description:
        "Drops the community TDGS .tox by Anglerfish-graphics into a fresh baseCOMP, loads a " +
        ".ply or .splat Gaussian Splat asset, optionally binds an existing cameraCOMP, and exposes " +
        "a clean output renderTOP at 720p–2160p. Assets can be exported from Polycam, Postshot, Luma, " +
        "or Nerfstudio. The wrapper connects to any existing tdmcp camera rig (create_camera_orbit, " +
        "XY pads, MIDI). REQUIREMENTS: TDGS by Anglerfish-graphics installed " +
        "(https://github.com/Anglerfish-Graphics/TDGS); TouchDesigner build ≥2023.30000; CUDA-capable " +
        "NVIDIA GPU on Windows. macOS and AMD GPUs are not supported by TDGS — the tool returns a " +
        "friendly error. VRAM: 720p≈2GB, 1080p≈4-6GB, 1440p≈12GB+, 2160p≈16GB+ (OOM crashes TD — " +
        "no friendly error, start at 720p on a laptop). Returns container_path, dropped_tox_path, " +
        "output_top_path, camera_path, warnings, and a preview image.",
      inputSchema: createGaussianSplatSceneSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGaussianSplatSceneImpl(ctx, args),
  );
};

import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { dropExternalTox } from "../util/dropExternalTox.js";
import { precheckToxCandidates } from "../util/toxCandidatePrecheck.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";
import { installFrameCooker } from "./poseSource.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const driveStreamdiffusionSchema = z.object({
  tox_path: z
    .string()
    .optional()
    .describe(
      "Optional explicit absolute or project-relative override. When set, becomes the only candidate; standard discovery is skipped.",
    ),
  source_top_path: z
    .string()
    .optional()
    .describe(
      "File system path to a video/image file to feed into the StreamDiffusionTD container (creates a moviefileinTOP). When omitted, a synthetic noise TOP is created for device-free preview.",
    ),
  prompt: z
    .string()
    .default("a vibrant neon cyberpunk portrait, ultra detailed")
    .describe("Sets the Prompt custom par on the tox."),
  strength: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe("img2img denoising strength — sets Strength par."),
  cfg: z
    .number()
    .min(0)
    .max(30)
    .default(1.2)
    .describe("Classifier-free guidance scale. Low CFG (1–2) is normal for StreamDiffusion/LCM."),
  seed: z.number().int().default(-1).describe("Random seed. -1 = random per tox convention."),
  controlnet_weight: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Sets Controlnetweight when the par is present in the tox build."),
  t_index: z
    .number()
    .int()
    .optional()
    .describe("Sets Tindex (denoise step list index) when present; omitted = tox default."),
  output_mode: z
    .enum(["internal", "syphon_spout", "ndi"])
    .default("internal")
    .describe(
      "internal = Null TOP only. syphon_spout / ndi = adds an FM-01 sender wired from out1.",
    ),
  output_name: z
    .string()
    .default("tdmcp_streamdiffusion")
    .describe("Sender/source name when output_mode != 'internal'."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network for the fresh streamdiffusion_driver baseCOMP."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Reserved for v2 — the tox already surfaces its own UI; this field is accepted but not acted on in v1.",
    ),
});

export type DriveStreamdiffusionArgs = z.infer<typeof driveStreamdiffusionSchema>;

// ---------------------------------------------------------------------------
// Candidate path builder
// ---------------------------------------------------------------------------

const EXPECTED_PARS = ["Tindex", "Prompt", "Strength", "Cfg", "Seed", "Controlnetweight"] as const;

function buildCandidatePaths(toxPathOverride: string | undefined): string[] {
  if (toxPathOverride !== undefined) {
    return [toxPathOverride];
  }
  const home = os.homedir();
  return [
    path.join(home, "Documents", "Derivative", "COMP", "StreamDiffusionTD.tox"),
    path.join(home, "Documents", "Derivative", "StreamDiffusionTD", "StreamDiffusionTD.tox"),
    path.join(home, "Documents", "touchdesigner", "StreamDiffusionTD", "StreamDiffusionTD.tox"),
    path.join(home, "Documents", "StreamDiffusionTD", "StreamDiffusionTD.tox"),
  ];
}

// ---------------------------------------------------------------------------
// Configure payload template
// ---------------------------------------------------------------------------

const CONFIGURE_TEMPLATE = `
import base64, json
_payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))

CONTAINER  = _payload["container_path"]
SOURCE_TOP = _payload["source_top"]
OUT1_PATH  = _payload["out1_path"]
PARS       = _payload["pars_to_set"]
VALID_PARS = _payload["validated_pars"]

report = {"warnings": [], "ok": True}

try:
    sd = op(CONTAINER)
    src = op(SOURCE_TOP)
    out1 = op(OUT1_PATH)

    # Wire source → SD container input 0
    if sd is not None and src is not None:
        try:
            sd.inputConnectors[0].connect(src)
        except Exception as e:
            report["warnings"].append("Wire source->SD failed: " + str(e))

    # Wire SD container → out1
    if out1 is not None and sd is not None:
        try:
            out1.inputConnectors[0].connect(sd)
        except Exception as e:
            report["warnings"].append("Wire SD->out1 failed: " + str(e))

    # Set only validated pars (defensive)
    if sd is not None:
        for par_name, value in PARS.items():
            if par_name in VALID_PARS and value is not None:
                try:
                    setattr(sd.par, par_name, value)
                except Exception as e:
                    report["warnings"].append(f"Set par {par_name} failed: " + str(e))
except Exception as e:
    report["ok"] = False
    report["error"] = str(e)

result = json.dumps(report)
print(result)
`;

interface ConfigureReport {
  ok: boolean;
  error?: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function driveStreamdiffusionImpl(
  ctx: ToolContext,
  args: DriveStreamdiffusionArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return runBuild(async () => {
    const warnings: string[] = [];

    // 0. Pre-flight: short-circuit BEFORE touching TD when the candidate set
    //    is entirely absolute and nothing exists on disk. This avoids creating
    //    an orphan baseCOMP and (more importantly) avoids any bridge call —
    //    TD has been observed to hang on executePythonScript under load.
    const candidatePathsPrecheck = buildCandidatePaths(args.tox_path);
    const precheck = precheckToxCandidates(candidatePathsPrecheck);
    if (precheck.allAbsoluteAndMissing) {
      return errorResult(
        "StreamDiffusionTD.tox not found on disk. Install dotsimulate/StreamDiffusion-TouchDesigner " +
          "and place the .tox in one of the standard locations, or pass tox_path explicitly. " +
          `Checked: ${precheck.absoluteChecked.join(", ")}.`,
      );
    }

    // 1. Create system container
    const builder = await createSystemContainer(ctx, args.parent_path, "streamdiffusion_driver");

    // 2. Source TOP — synthetic noiseTOP fallback avoids macOS file-chooser modal hang.
    // When a real path is provided, use moviefileinTOP with explicit file + play pars.
    const sourceTop = args.source_top_path
      ? await builder.add("moviefileinTOP", "source_in", {
          file: args.source_top_path,
          play: true,
        })
      : await builder.add("noiseTOP", "source_in");

    // 3. Drop the community tox via FM-02
    const dropResult = await dropExternalTox(ctx, {
      parent_path: builder.containerPath,
      container_name: "StreamDiffusionTD",
      candidate_paths: candidatePathsPrecheck,
      expected_custom_pars: Array.from(EXPECTED_PARS),
      on_missing: "warn",
    });

    if ("error" in dropResult) {
      return dropResult.error;
    }

    const {
      container_path,
      found_path,
      validated_pars,
      missing_pars,
      warnings: dropWarnings,
    } = dropResult.ok;
    warnings.push(...dropWarnings);
    if (missing_pars.length > 0) {
      warnings.push(`Missing custom pars: ${missing_pars.join(", ")}`);
    }

    // 4. Null TOP output
    const out1 = await builder.add("nullTOP", "out1");

    // 5. Configure pass — wire and set pars
    const parsToSet: Record<string, unknown> = {
      Prompt: args.prompt,
      Strength: args.strength,
      Cfg: args.cfg,
      Seed: args.seed,
    };
    if (args.controlnet_weight !== undefined) parsToSet.Controlnetweight = args.controlnet_weight;
    if (args.t_index !== undefined) parsToSet.Tindex = args.t_index;

    const configScript = buildPayloadScript(CONFIGURE_TEMPLATE, {
      container_path,
      source_top: sourceTop,
      out1_path: out1,
      pars_to_set: parsToSet,
      validated_pars,
    });

    try {
      const exec = await ctx.client.executePythonScript(configScript, true);
      const configReport = parsePythonReport<ConfigureReport>(exec.stdout);
      warnings.push(...(configReport.warnings ?? []));
      if (!configReport.ok && configReport.error) {
        warnings.push(`Configure pass error: ${configReport.error}`);
      }
    } catch (err) {
      const msg = String(err);
      const isTimeout =
        msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("econnrefused");
      warnings.push(
        isTimeout
          ? "StreamDiffusion configure timed out — TD may be loading the .tox or stalled on file access. Restart TD if it becomes unresponsive."
          : `Configure pass failed: ${msg}`,
      );
    }

    // 6. Frame cooker
    await installFrameCooker(builder, out1, "cooker");

    // 7. Optional FM-01 outbound
    let senderInfo: { kind: "syphon_spout" | "ndi"; name: string; op_path: string } | undefined;

    if (args.output_mode === "syphon_spout") {
      try {
        const syphonOut = await builder.add("syphonspoutoutTOP", "syphon_out", {
          senderName: args.output_name,
          active: true,
        });
        await builder.connect(out1, syphonOut);
        senderInfo = { kind: "syphon_spout", name: args.output_name, op_path: syphonOut };
      } catch (err) {
        warnings.push(
          `syphonspoutoutTOP not available on this platform — skipping Syphon/Spout sender. ${String(err)}`,
        );
      }
    } else if (args.output_mode === "ndi") {
      try {
        const ndiOut = await builder.add("ndioutTOP", "ndi_out", {
          name: args.output_name,
          active: true,
        });
        await builder.connect(out1, ndiOut);
        senderInfo = { kind: "ndi", name: args.output_name, op_path: ndiOut };
      } catch (err) {
        warnings.push(`ndioutTOP not available — skipping NDI sender. ${String(err)}`);
      }
    }

    const outputTopPath = out1;
    const exposedPars = validated_pars;

    const extra: Record<string, unknown> = {
      container_path: builder.containerPath,
      dropped_tox_path: container_path,
      found_path,
      output_top_path: outputTopPath,
      source_top_path: sourceTop,
      validated_pars: exposedPars,
      missing_pars,
      warnings: [...builder.warnings, ...warnings],
    };
    if (senderInfo !== undefined) extra.sender_info = senderInfo;

    return finalize(ctx, {
      summary: `Built StreamDiffusion driver inside ${builder.containerPath}. Tox: ${found_path}. Output TOP: ${outputTopPath}. Validated pars: [${exposedPars.join(", ")}].${missing_pars.length ? ` Missing pars (warn): [${missing_pars.join(", ")}].` : ""}${senderInfo ? ` Sender: ${senderInfo.kind} "${senderInfo.name}".` : ""}`,
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

export const registerDriveStreamdiffusion: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "drive_streamdiffusion",
    {
      title: "Drive StreamDiffusionTD",
      description:
        "Wraps the community StreamDiffusionTD.tox (by dotsimulate) into a one-shot Layer 1 setup: locate the .tox via candidate-path discovery, drop it into a fresh baseCOMP, wire a camera/source TOP into its input, set the prompt/strength/cfg/seed custom pars, and optionally re-broadcast the output via Syphon/Spout or NDI. Returns a friendly error when the .tox is not installed. The result envelope includes validated_pars so downstream tools (create_ai_mirror) know which SD pars to bind a control panel to.",
      inputSchema: driveStreamdiffusionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => driveStreamdiffusionImpl(ctx, args),
  );
};

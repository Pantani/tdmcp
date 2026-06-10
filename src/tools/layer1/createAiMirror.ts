import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { driveStreamdiffusionImpl } from "./driveStreamdiffusion.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const createAiMirrorBaseSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP."),
  name: z.string().default("ai_mirror").describe("Container name."),
  source: z
    .enum(["camera", "synthetic", "existing_top"])
    .default("camera")
    .describe(
      "Input source: USB camera (hype default), self-animated synthetic TOP, or an existing TOP routed through a Select.",
    ),
  existing_top_path: z.string().optional().describe("Required when source='existing_top'."),
  camera_device_idx: z.coerce
    .number()
    .int()
    .default(0)
    .describe("USB camera device index when source='camera'."),
  fallback_to_synthetic: z
    .boolean()
    .default(true)
    .describe("If camera creation fails, build a synthetic noise source instead of aborting."),
  prompt: z.string().default("ethereal water").describe("Initial StreamDiffusion prompt."),
  negative_prompt: z
    .string()
    .default("blurry, low quality, deformed")
    .describe("Initial StreamDiffusion negative prompt."),
  strength: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.65)
    .describe("img2img mix; surfaced in the panel."),
  cfg: z.coerce
    .number()
    .min(0)
    .max(12)
    .default(1.4)
    .describe("Classifier-free guidance scale; SD sweet spot 1–2."),
  steps: z.coerce.number().int().min(1).max(8).default(2).describe("StreamDiffusion 1–4 step LCM."),
  seed: z.coerce.number().int().default(-1).describe("-1 = random per frame."),
  output_mode: z
    .enum(["syphon_spout", "ndi", "internal"])
    .default("syphon_spout")
    .describe(
      "Output: syphon_spout (macOS/Windows showcase form), ndi (cross-host), or internal (no sender).",
    ),
  output_sender_name: z.string().default("ai_mirror").describe("Sender / NDI name."),
  expose_control_panel: z
    .boolean()
    .default(true)
    .describe("Build the prompt+sliders panel and wire .expr expressions to SD pars."),
  show_camera_preview: z
    .boolean()
    .default(true)
    .describe("Add a small selectTOP preview of the camera inside the panel."),
});

export const createAiMirrorSchema = createAiMirrorBaseSchema.superRefine((args, ctx) => {
  if (args.source === "existing_top" && !args.existing_top_path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["existing_top_path"],
      message: "existing_top_path is required when source='existing_top'.",
    });
  }
});

type CreateAiMirrorArgs = z.infer<typeof createAiMirrorSchema>;

const q = (value: string): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// Source dispatch
// ---------------------------------------------------------------------------

async function buildSyntheticSource(builder: NetworkBuilder): Promise<string> {
  const source = await builder.add("noiseTOP", "cam_in");
  await builder.python(
    `op(${q(source)}).par.tz.expr = "absTime.seconds * 2"\nop(${q(source)}).par.tx.expr = "absTime.seconds * 0.35"`,
  );
  return source;
}

async function buildSource(builder: NetworkBuilder, args: CreateAiMirrorArgs): Promise<string> {
  if (args.source === "existing_top") {
    // Validated upstream by superRefine, but be defensive.
    const top = args.existing_top_path ?? "";
    return builder.add("selectTOP", "cam_in", { top });
  }
  if (args.source === "synthetic") {
    return buildSyntheticSource(builder);
  }
  try {
    const source = await builder.add("videodeviceinTOP", "cam_in", {
      device: args.camera_device_idx,
    });
    builder.warnings.push(
      "Camera source requested; USB device selection, macOS camera permission, and live frame availability are UNVERIFIED until opened in TouchDesigner.",
    );
    return source;
  } catch (err) {
    if (!args.fallback_to_synthetic) throw err;
    builder.warnings.push(
      `Camera source could not be created; fallback_to_synthetic=true built a synthetic source instead (${String(err)}).`,
    );
    return buildSyntheticSource(builder);
  }
}

// ---------------------------------------------------------------------------
// FM-04 envelope parsing
// ---------------------------------------------------------------------------

interface SdEnvelope {
  container_path?: string;
  output_top_path?: string;
  validated_pars?: string[];
}

function parseSdEnvelope(result: CallToolResult): SdEnvelope {
  for (const part of result.content) {
    if (part.type !== "text") continue;
    const text = (part as { type: "text"; text: string }).text;
    const match = /```json\s*([\s\S]*?)```/.exec(text);
    if (!match?.[1]) continue;
    try {
      const parsed = JSON.parse(match[1]) as Record<string, unknown>;
      return {
        container_path:
          typeof parsed.container_path === "string" ? parsed.container_path : undefined,
        output_top_path:
          typeof parsed.output_top_path === "string" ? parsed.output_top_path : undefined,
        validated_pars: Array.isArray(parsed.validated_pars)
          ? (parsed.validated_pars as unknown[]).filter((p): p is string => typeof p === "string")
          : undefined,
      };
    } catch {
      // fall through
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Control panel wiring
// ---------------------------------------------------------------------------

interface PanelPaths {
  panel: string;
  promptText: string;
  negPromptText: string;
  strengthSlider: string;
  cfgSlider: string;
  statusText: string;
  previewCam?: string;
}

async function buildPanel(
  builder: NetworkBuilder,
  args: CreateAiMirrorArgs,
  camIn: string,
): Promise<PanelPaths> {
  const panel = await builder.add("containerCOMP", "panel");
  const promptText = await builder.add("textDAT", "prompt_text", undefined, panel);
  await builder.python(`op(${q(promptText)}).text = ${q(args.prompt)}`);
  const negPromptText = await builder.add("textDAT", "neg_prompt_text", undefined, panel);
  await builder.python(`op(${q(negPromptText)}).text = ${q(args.negative_prompt)}`);
  const strengthSlider = await builder.add("sliderCOMP", "strength_slider", undefined, panel);
  const cfgSlider = await builder.add("sliderCOMP", "cfg_slider", undefined, panel);
  // Initialize sliders to caller-supplied values (panel.u is 0..1; cfg rescales 0..12).
  const cfgU = Math.max(0, Math.min(1, args.cfg / 12));
  const strengthU = Math.max(0, Math.min(1, args.strength));
  await builder.python(
    `op(${q(strengthSlider)}).panel.u.val = ${strengthU}\nop(${q(cfgSlider)}).panel.u.val = ${cfgU}`,
  );
  let previewCam: string | undefined;
  if (args.show_camera_preview) {
    previewCam = await builder.add(
      "selectTOP",
      "preview_cam",
      { top: camIn, resolutionw: 256, resolutionh: 144 },
      panel,
    );
  }
  const statusText = await builder.add("textDAT", "status_text", undefined, panel);
  return { panel, promptText, negPromptText, strengthSlider, cfgSlider, statusText, previewCam };
}

interface ParBinding {
  parName: string;
  exprSource: string; // Python expression to inject as .expr
}

/**
 * Map SD par name → expression that reads from the panel.
 * Returns only entries for pars present in `validatedPars`.
 */
function bindingsFor(validatedPars: readonly string[], panelPaths: PanelPaths): ParBinding[] {
  const bindings: ParBinding[] = [];
  const want = (par: string) => validatedPars.includes(par);
  if (want("Prompt")) {
    bindings.push({
      parName: "Prompt",
      exprSource: `op(${q(panelPaths.promptText)}).text`,
    });
  }
  if (want("Strength")) {
    bindings.push({
      parName: "Strength",
      exprSource: `op(${q(panelPaths.strengthSlider)}).panel.u`,
    });
  }
  if (want("Cfg")) {
    bindings.push({
      parName: "Cfg",
      // sliderCOMP.panel.u is 0..1; rescale to 0..12 for CFG.
      exprSource: `op(${q(panelPaths.cfgSlider)}).panel.u * 12.0`,
    });
  }
  return bindings;
}

async function wireSdExpressions(
  builder: NetworkBuilder,
  sdContainerPath: string,
  bindings: ParBinding[],
): Promise<void> {
  if (bindings.length === 0) return;
  const lines: string[] = [`_sd = op(${q(sdContainerPath)})`];
  lines.push("if _sd is None:");
  lines.push(`    raise RuntimeError('SD container not found: ' + ${q(sdContainerPath)})`);
  for (const { parName, exprSource } of bindings) {
    lines.push(`_tp = getattr(_sd.par, ${q(parName)}, None)`);
    lines.push("if _tp is not None:");
    lines.push(`    _tp.expr = ${q(exprSource)}`);
    lines.push("    _PM = type(_tp.mode)");
    lines.push("    _tp.mode = _PM.EXPRESSION");
  }
  await builder.python(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createAiMirrorImpl(
  ctx: ToolContext,
  args: CreateAiMirrorArgs,
): Promise<CallToolResult> {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // 1. Source TOP
    const camIn = await buildSource(builder, args);

    // 2. Stable sd_in handle
    const sdIn = await builder.add("nullTOP", "sd_in");
    await builder.connect(camIn, sdIn);

    // 3. Delegate to FM-04 driveStreamdiffusionImpl. It creates its own baseCOMP
    //    under our container ("streamdiffusion_driver"). The spec uses "sd" as a
    //    label — FM-04 names it "streamdiffusion_driver"; we surface its path as
    //    sd_container_path verbatim.
    const sdResult = await driveStreamdiffusionImpl(ctx, {
      parent_path: builder.containerPath,
      source_top_path: sdIn,
      prompt: args.prompt,
      strength: args.strength,
      cfg: args.cfg,
      seed: args.seed,
      output_mode: args.output_mode,
      output_name: args.output_sender_name,
      expose_controls: true,
    });

    // Detect precheck-tox-missing signature for graceful degradation.
    // All other isError cases (runBuild fatals, bridge errors) surface directly.
    const isPrecheckMissing = (r: CallToolResult): boolean => {
      if (!r.isError) return false;
      const text = r.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return /\bno_candidate_found\b/i.test(text);
    };

    let sdContainerPath: string | undefined;
    let sdOutputTop: string | undefined;
    let validatedPars: string[] = [];

    if (sdResult.isError) {
      if (isPrecheckMissing(sdResult)) {
        // Degrade gracefully: extract the friendly message, push to warnings,
        // continue building skeleton without SD pars.
        const sdMsg =
          sdResult.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .split("\n")[0] ?? "SD tox not found";
        builder.warnings.push(`drive_streamdiffusion: ${sdMsg} — skeleton built without SD pars.`);
        // sdContainerPath / sdOutputTop / validatedPars remain undefined/empty
      } else {
        // Fatal or unknown error — surface directly.
        return sdResult;
      }
    } else {
      const envelope = parseSdEnvelope(sdResult);
      sdContainerPath = envelope.container_path;
      sdOutputTop = envelope.output_top_path;
      validatedPars = envelope.validated_pars ?? [];
    }

    if (!sdContainerPath) {
      builder.warnings.push(
        "drive_streamdiffusion did not return a container_path — sd pars cannot be auto-wired.",
      );
    }
    if (!sdOutputTop) {
      builder.warnings.push(
        "drive_streamdiffusion did not return an output_top_path — 'out' will be left unconnected.",
      );
    }

    // 4. Stable showcase out
    const out = await builder.add("nullTOP", "out");
    if (sdOutputTop) await builder.connect(sdOutputTop, out);

    // 5. Optional control panel
    let panelPaths: PanelPaths | undefined;
    if (args.expose_control_panel) {
      panelPaths = await buildPanel(builder, args, camIn);

      if (sdContainerPath) {
        const bindings = bindingsFor(validatedPars, panelPaths);
        const expectedPars = ["Prompt", "Strength", "Cfg"] as const;
        const missing = expectedPars.filter((p) => !validatedPars.includes(p));
        if (missing.length > 0) {
          builder.warnings.push(
            `Panel built but SD pars ${missing.join(", ")} not in validated_pars — set manually on op('${sdContainerPath}').`,
          );
        }
        await wireSdExpressions(builder, sdContainerPath, bindings);
      }

      // Status text reflects build summary.
      const status = `${args.output_mode} → "${args.output_sender_name}" · source=${args.source}`;
      await builder.python(`op(${q(panelPaths.statusText)}).text = ${q(status)}`);
    }

    const extra: Record<string, unknown> = {
      container_path: builder.containerPath,
      camera_top_path: camIn,
      sd_container_path: sdContainerPath,
      output_top_path: out,
      control_panel_path: panelPaths?.panel,
      source: args.source,
      output_mode: args.output_mode,
      sender_name: args.output_sender_name,
      validated_pars: validatedPars,
    };

    return finalize(ctx, {
      summary: `AI mirror ready (${args.source} → StreamDiffusion → ${args.output_mode}). Sender: ${args.output_sender_name}.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      extra,
    });
  });
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateAiMirror: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ai_mirror",
    {
      title: "Create AI Mirror",
      description:
        "Layer 1 COMBO: wires the canonical 2026 AI-mirror installation in one MCP call — camera (or synthetic / existing TOP) → StreamDiffusion (img2img live, delegated to drive_streamdiffusion) → Syphon/Spout/NDI/internal output → a prompt+strength+cfg control panel whose sliders and textDATs drive SD pars via .expr expressions. Panel only binds pars present in drive_streamdiffusion's validated_pars; missing pars are warned, not errored. Camera source on macOS triggers the OS permission dialog on first cook; fallback_to_synthetic keeps the rig alive when the camera is unavailable.",
      inputSchema: createAiMirrorBaseSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAiMirrorImpl(ctx, createAiMirrorSchema.parse(args)),
  );
};

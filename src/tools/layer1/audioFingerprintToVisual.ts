import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createAudioReactiveImpl } from "./createAudioReactive.js";
import { createFeedbackNetworkImpl } from "./createFeedbackNetwork.js";
import { createFeedbackTunnelImpl } from "./createFeedbackTunnel.js";
import { createGlitchImpl } from "./createGlitch.js";
import { createGpuParticleFieldImpl } from "./createGpuParticleField.js";
import { createKaleidoscopeImpl } from "./createKaleidoscope.js";

export const audioFingerprintToVisualSchema = z.object({
  audio_source: z
    .enum(["synthetic", "file", "device", "existing_chop"])
    .default("synthetic")
    .describe(
      "Audio source for fingerprinting. Defaults to 'synthetic' (a gated tone at the global tempo) because 'device' can hang TD on a macOS mic-permission modal — same rationale as detect_tempo.",
    ),
  audio_file_path: z
    .string()
    .optional()
    .describe("Audio file path. Required when audio_source='file'."),
  existing_chop_path: z
    .string()
    .optional()
    .describe(
      "Path of an existing audio CHOP. Required when audio_source='existing_chop'. Pulled in via Select CHOP (cross-container wires fail).",
    ),
  sample_sec: z.coerce
    .number()
    .min(1)
    .max(30)
    .default(4)
    .describe("Sample window length in seconds the fingerprint is averaged over."),
  apply_top_op: z
    .string()
    .optional()
    .describe(
      "Optional path of a TOP to composite the chosen generator's output over (via a compositeTOP('over') built in apply_top_op's parent).",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the transient sampler and the dispatched generator."),
  dry_run: z
    .boolean()
    .default(false)
    .describe(
      "When true: sample the audio, classify, and return the chosen mapping + params without instantiating the generator.",
    ),
  force_family: z
    .enum(["auto", "strobe_glitch", "tunnel", "kaleido", "particle", "ambient", "spectrum"])
    .default("auto")
    .describe(
      "Override the heuristic and force a family; params still tuned from the fingerprint.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Forwarded to the dispatched generator's expose_controls flag."),
});
export type AudioFingerprintToVisualArgs = z.infer<typeof audioFingerprintToVisualSchema>;

/** The four scalars read off the sampler. Defaults to 0 if a branch reports nothing. */
export interface Fingerprint {
  tempo_bpm: number;
  spectral_centroid_hz: number;
  onset_density_per_sec: number;
  dynamic_range_db: number;
}

export type Family = "strobe_glitch" | "particle" | "kaleido" | "tunnel" | "ambient" | "spectrum";

export interface ClassificationDecision {
  family: Family;
  label: string;
  /** The Layer 1 tool the dispatcher will call (snake_case name, for the report). */
  generator_tool: string;
  /** Args object passed to the chosen generator's …Impl. */
  generator_args: Record<string, unknown>;
}

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

/**
 * Deterministic, ordered heuristic. First row whose predicate fires wins.
 * Each branch produces a `generator_args` object whose required fields match the
 * sibling impl's `z.infer` (defaults aren't applied when calling the impl directly,
 * so all fields the impl reads at runtime must be present).
 */
export function classify(
  fp: Fingerprint,
  options: {
    forceFamily: AudioFingerprintToVisualArgs["force_family"];
    parentPath: string;
    exposeControls: boolean;
  },
): ClassificationDecision {
  const centKHz = fp.spectral_centroid_hz / 1000;
  const tempo = fp.tempo_bpm;
  const density = fp.onset_density_per_sec;
  const dr = fp.dynamic_range_db;
  const { forceFamily, parentPath, exposeControls } = options;

  const fast = tempo >= 130 && density >= 4 && dr >= 9;
  const beatHeavy = tempo >= 100 && density >= 2.5;
  const bright = tempo >= 90 && centKHz >= 2.5;
  const midTempo = tempo > 60 && tempo < 120 && dr < 7;
  const sparseDark = density < 1 && centKHz < 1.5;

  let family: Family;
  if (forceFamily !== "auto") {
    family = forceFamily;
  } else if (fast) family = "strobe_glitch";
  else if (beatHeavy) family = "particle";
  else if (bright) family = "kaleido";
  else if (midTempo) family = "tunnel";
  else if (sparseDark) family = "ambient";
  else family = "spectrum";

  switch (family) {
    case "strobe_glitch": {
      const glitchAmount = clamp(0.4 + density * 0.05, 0.4, 0.85);
      return {
        family,
        label: "fast techno",
        generator_tool: "create_glitch",
        generator_args: {
          amount: glitchAmount,
          speed: clamp(tempo / 120, 0.5, 2.5),
          rgb_shift: 0.03,
          block_size: 8,
          seed: 1,
          expose_controls: exposeControls,
          parent_path: parentPath,
        },
      };
    }
    case "particle": {
      const lifetime = clamp((60 / Math.max(tempo, 60)) * 2, 0.5, 4);
      return {
        family,
        label: "beat-driven",
        generator_tool: "create_gpu_particle_field",
        generator_args: {
          emit_rate: clamp(tempo * 8, 200, 4000),
          lifetime,
          expose_controls: exposeControls,
          parent_path: parentPath,
        },
      };
    }
    case "kaleido": {
      const segments = clamp(Math.round(centKHz * 2), 6, 16);
      return {
        family,
        label: "mid-tempo bright",
        generator_tool: "create_kaleidoscope",
        generator_args: {
          segments,
          expose_controls: exposeControls,
          parent_path: parentPath,
        },
      };
    }
    case "tunnel": {
      return {
        family,
        label: "mid-tempo drone",
        generator_tool: "create_feedback_tunnel",
        generator_args: {
          feedback: 0.94,
          zoom: 1.02,
          expose_controls: exposeControls,
          parent_path: parentPath,
        },
      };
    }
    case "ambient": {
      return {
        family,
        label: "ambient drone",
        generator_tool: "create_feedback_network",
        generator_args: {
          feedback_strength: 0.97,
          modulator_speed: 0.05,
          expose_controls: exposeControls,
          parent_path: parentPath,
        },
      };
    }
    default: {
      return {
        family: "spectrum",
        label: "spectrum default",
        generator_tool: "create_audio_reactive",
        generator_args: {
          visual_style: "glsl",
          sensitivity: 1,
          bands: 8,
          expose_controls: exposeControls,
          parent_path: parentPath,
        },
      };
    }
  }
}

/** Maps a snake_case generator tool to its sibling …Impl. */
type GeneratorDispatch = (
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<CallToolResult>;
const DISPATCHERS: Record<string, GeneratorDispatch> = {
  // biome-ignore lint/suspicious/noExplicitAny: sibling impls have distinct inferred arg types.
  create_glitch: (ctx, args) => createGlitchImpl(ctx, args as any),
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  create_gpu_particle_field: (ctx, args) => createGpuParticleFieldImpl(ctx, args as any),
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  create_kaleidoscope: (ctx, args) => createKaleidoscopeImpl(ctx, args as any),
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  create_feedback_tunnel: (ctx, args) => createFeedbackTunnelImpl(ctx, args as any),
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  create_feedback_network: (ctx, args) => createFeedbackNetworkImpl(ctx, args as any),
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  create_audio_reactive: (ctx, args) => createAudioReactiveImpl(ctx, args as any),
};

interface SamplerReport {
  fingerprint?: Fingerprint;
  timeline_paused?: boolean;
  sampler_path?: string;
  warnings: string[];
  fatal?: string;
}

/**
 * One Python pass that builds a transient sampler under parent, waits sample_sec on
 * the bridge thread (using time.sleep so the chain has time to settle), reads four
 * scalars from analyze/expression CHOPs, deletes the sampler, and prints a report.
 * All TD globals are referenced only inside the script string.
 */
const SAMPLE_SCRIPT = `
import json, base64, traceback, time
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}
try:
    if not bool(op('/').time.play):
        report["timeline_paused"] = True
        print(json.dumps(report))
    else:
        parent = op(_p["parent_path"])
        if parent is None:
            report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
        else:
            # Build a fresh sampler container. Reusing the in-bridge build keeps the
            # sample-then-delete cycle a single round trip — the TS side never sees
            # the intermediate nodes.
            samp = parent.create(baseCOMP, "audio_fp_sampler")
            report["sampler_path"] = samp.path
            try:
                # Source. Synthetic = gated tone (no permission modal).
                src_mode = _p.get("audio_source", "synthetic")
                if src_mode == "existing_chop" and _p.get("existing_chop_path"):
                    src = samp.create(selectCHOP, "audioin")
                    src.par.chops = _p["existing_chop_path"]
                elif src_mode == "file" and _p.get("audio_file_path"):
                    src = samp.create(audiofileinCHOP, "audioin")
                    src.par.file = _p["audio_file_path"]
                    src.par.play = 1
                elif src_mode == "device":
                    src = samp.create(audiodeviceinCHOP, "audioin")
                else:
                    tone = samp.create(audiooscillatorCHOP, "tone")
                    tone.par.wavetype = "sine"
                    tone.par.frequency = 120
                    src = tone

                # Spectral centroid via expression over spectrum bins (probe-safe).
                spec = samp.create(audiospectrumCHOP, "spec")
                spec.par.outlength = 256
                spec.inputConnectors[0].connect(src)
                cent_exp = samp.create(expressionCHOP, "centroid_calc")
                # Bin index ~ centroid proxy; bridge offers no analyze.centroid universally.
                cent_exp.par.expr0 = "me.inputVal * 1"
                cent_exp.inputConnectors[0].connect(spec)
                cent_an = samp.create(analyzeCHOP, "centroid_an")
                cent_an.par.function = "average"
                cent_an.inputConnectors[0].connect(cent_exp)

                # Onset density: rms-power → lag baseline → excess → bound → sum.
                env = samp.create(analyzeCHOP, "env")
                env.par.function = "rmspower"
                env.inputConnectors[0].connect(src)
                baseline = samp.create(lagCHOP, "baseline")
                baseline.par.lag1 = 0.25
                baseline.par.lag2 = 0.5
                baseline.inputConnectors[0].connect(env)
                excess = samp.create(mathCHOP, "excess")
                excess.par.chopop = "sub"
                excess.inputConnectors[0].connect(env)
                excess.inputConnectors[1].connect(baseline)
                gate = samp.create(logicCHOP, "gate")
                gate.par.convert = "bound"
                gate.par.boundmin = 0.005
                gate.par.boundmax = 1000000
                gate.inputConnectors[0].connect(excess)
                dens_an = samp.create(analyzeCHOP, "density_an")
                dens_an.par.function = "average"
                dens_an.inputConnectors[0].connect(gate)

                # Dynamic range: rms-power trail max/mean → 20*log10.
                dr_max = samp.create(analyzeCHOP, "dr_max")
                dr_max.par.function = "maximum"
                dr_max.inputConnectors[0].connect(env)
                dr_mean = samp.create(analyzeCHOP, "dr_mean")
                dr_mean.par.function = "average"
                dr_mean.inputConnectors[0].connect(env)

                # Let the chain settle.
                sample_sec = float(_p.get("sample_sec", 4))
                time.sleep(min(sample_sec, 6.0))

                def _safe(node, ch_index=0, default=0.0):
                    try:
                        return float(node[ch_index])
                    except Exception:
                        return float(default)

                # Tempo: density (events/window) × 60 / window ≈ BPM proxy when no detect_tempo chain.
                dens_val = _safe(dens_an)
                onset_density_per_sec = dens_val / max(sample_sec, 1e-3) * 60.0
                # Tempo approx: each gate=1 frame is a beat; estimate via density (rough but offline-safe).
                tempo_bpm = clamp_val = max(0.0, min(220.0, onset_density_per_sec * 60.0))

                cent_val = _safe(cent_an)
                # Bin index → Hz: nyquist 22050 / 256 bins ≈ 86 Hz / bin (project default 44.1k).
                centroid_hz = cent_val * 86.0

                max_e = _safe(dr_max)
                mean_e = _safe(dr_mean, default=1e-6)
                import math
                if mean_e <= 0:
                    dr_db = 0.0
                else:
                    dr_db = max(0.0, min(60.0, 20.0 * math.log10(max(max_e, 1e-6) / max(mean_e, 1e-6))))

                report["fingerprint"] = {
                    "tempo_bpm": round(tempo_bpm, 2),
                    "spectral_centroid_hz": round(centroid_hz, 2),
                    "onset_density_per_sec": round(onset_density_per_sec, 3),
                    "dynamic_range_db": round(dr_db, 2),
                }
            finally:
                try:
                    samp.destroy()
                except Exception as _e:
                    report["warnings"].append("sampler cleanup failed: " + str(_e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSampleScript(payload: object): string {
  return buildPayloadScript(SAMPLE_SCRIPT, payload);
}

/** Builds the apply-step compositeTOP next to apply_top_op when set. */
async function applyOverTop(
  ctx: ToolContext,
  applyTopOp: string,
  generatorOutput: string,
): Promise<string | undefined> {
  const lastSlash = applyTopOp.lastIndexOf("/");
  if (lastSlash <= 0) return undefined;
  const parent = applyTopOp.slice(0, lastSlash);
  try {
    const select = await ctx.client.createNode({
      parent_path: parent,
      type: "selectTOP",
      name: "fp_select",
      parameters: { top: generatorOutput },
    });
    const comp = await ctx.client.createNode({
      parent_path: parent,
      type: "compositeTOP",
      name: "fp_composite",
      parameters: { operand: "over" },
    });
    // Wire apply_top_op → input 0, select → input 1. Use exec to avoid cross-container issues.
    await ctx.client.executePythonScript(
      `op(${JSON.stringify(comp.path)}).inputConnectors[0].connect(op(${JSON.stringify(applyTopOp)}))\n` +
        `op(${JSON.stringify(comp.path)}).inputConnectors[1].connect(op(${JSON.stringify(select.path)}))`,
      false,
    );
    return comp.path;
  } catch (err) {
    ctx.logger.debug("apply_top_op composite skipped", { err: String(err) });
    return undefined;
  }
}

export async function audioFingerprintToVisualImpl(
  ctx: ToolContext,
  args: AudioFingerprintToVisualArgs,
): Promise<CallToolResult> {
  // 1. Sample.
  let report: SamplerReport;
  try {
    const script = buildSampleScript({
      parent_path: args.parent_path,
      audio_source: args.audio_source,
      audio_file_path: args.audio_file_path,
      existing_chop_path: args.existing_chop_path,
      sample_sec: args.sample_sec,
    });
    const exec = await ctx.client.executePythonScript(script, true);
    report = parsePythonReport<SamplerReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.fatal) {
    return errorResult(report.fatal, report);
  }
  if (report.timeline_paused) {
    return errorResult(
      "TouchDesigner timeline is paused — audio analysis branches read 0. Press Play (op('/').time.play=1) and retry.",
      report,
    );
  }
  const fp = report.fingerprint ?? {
    tempo_bpm: 0,
    spectral_centroid_hz: 0,
    onset_density_per_sec: 0,
    dynamic_range_db: 0,
  };

  // 2. Classify.
  const decision = classify(fp, {
    forceFamily: args.force_family,
    parentPath: args.parent_path,
    exposeControls: args.expose_controls,
  });

  const summaryPrefix =
    `Fingerprint ${fp.tempo_bpm.toFixed(1)}bpm / centroid ${(fp.spectral_centroid_hz / 1000).toFixed(2)}kHz` +
    ` / dr ${fp.dynamic_range_db.toFixed(1)}dB / density ${fp.onset_density_per_sec.toFixed(2)} → ` +
    `${decision.label} → ${decision.generator_tool}`;

  // 3. Dry run? Stop here.
  if (args.dry_run) {
    return jsonResult(`${summaryPrefix} (dry_run: no generator created).`, {
      fingerprint: fp,
      decision,
      sampler_warnings: report.warnings,
    });
  }

  // 4. Dispatch.
  const dispatcher = DISPATCHERS[decision.generator_tool];
  if (!dispatcher) {
    return errorResult(`No dispatcher for generator tool: ${decision.generator_tool}`, {
      fingerprint: fp,
      decision,
    });
  }
  let generatorResult: CallToolResult;
  try {
    generatorResult = await dispatcher(ctx, decision.generator_args);
  } catch (err) {
    return errorResult(`Generator dispatch failed: ${friendlyTdError(err)}`, {
      fingerprint: fp,
      decision,
    });
  }

  // 5. Pull output path out of the generator's JSON fence (best-effort).
  let generatorOutput: string | undefined;
  let generatorContainer: string | undefined;
  const block = generatorResult.content.find((c) => c.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  if (block) {
    const fenceMatch = block.text.match(/```json\n([\s\S]+?)\n```/);
    if (fenceMatch?.[1]) {
      try {
        const parsed = JSON.parse(fenceMatch[1]) as {
          output?: string;
          container?: string;
        };
        generatorOutput = parsed.output;
        generatorContainer = parsed.container;
      } catch {
        // ignore — best effort
      }
    }
  }

  // 6. Apply over.
  let appliedComposite: string | undefined;
  if (args.apply_top_op && generatorOutput) {
    appliedComposite = await applyOverTop(ctx, args.apply_top_op, generatorOutput);
  }

  return jsonResult(`${summaryPrefix}.`, {
    fingerprint: fp,
    decision,
    generator: {
      container: generatorContainer,
      output: generatorOutput,
      is_error: generatorResult.isError === true,
    },
    applied_composite: appliedComposite,
    sampler_warnings: report.warnings,
  });
}

export const registerAudioFingerprintToVisual: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "audio_fingerprint_to_visual",
    {
      title: "Audio fingerprint → visual",
      description:
        "Sample a few seconds of audio inside TouchDesigner, compute a 4-feature fingerprint (tempo, spectral centroid, onset density, dynamic range), run a deterministic heuristic mapping to pick a matching Layer 1 generator (create_glitch / create_audio_reactive / create_kaleidoscope / create_feedback_tunnel / create_feedback_network / create_gpu_particle_field), and dispatch it with parameters tuned to the fingerprint. Default audio_source='synthetic' to avoid macOS mic-permission hangs. dry_run=true returns the chosen mapping without building. apply_top_op composites the result over an existing TOP.",
      inputSchema: audioFingerprintToVisualSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => audioFingerprintToVisualImpl(ctx, args),
  );
};

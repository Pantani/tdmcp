import { z } from "zod";
import type { AceStepClient } from "../../ace-client/aceStepClient.js";
import {
  type RunGenerationOptions,
  type RunGenerationOutcome,
  runGeneration,
} from "../../ace-client/runGeneration.js";
import { guardAce } from "../../ace-client/types.js";
import type { AceGenerateRequest } from "../../ace-client/validators.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolExtra, ToolRegistrar } from "../types.js";

/**
 * Field names mirror `ACEStepPipeline.__call__` verbatim. Defaults are applied
 * at parse time, so every defaulted field is REQUIRED in `z.infer` — callers of
 * `generateMusicImpl` (tests) must pass them.
 */
export const generateMusicSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "Tags / genre / mood description, comma-separated (e.g. 'lofi hip hop, mellow, rainy, 80 bpm'). Maps to ACE-Step `prompt`.",
    ),
  lyrics: z
    .string()
    .optional()
    .describe(
      "Optional lyrics with structure markers like [verse], [chorus], [bridge]. Omit for an instrumental. Maps to ACE-Step `lyrics`.",
    ),
  audio_duration: z
    .number()
    .default(-1)
    .describe(
      "Target length in seconds. -1 lets the model choose (randomizes ~30-240 s). Maps to ACE-Step `audio_duration` (upstream default 60).",
    ),
  manual_seeds: z
    .number()
    .int()
    .optional()
    .describe(
      "Optional integer seed for reproducible output. Omit for a random seed. Maps to ACE-Step `manual_seeds` (the native FastAPI layer renames this to `actual_seeds`).",
    ),
  infer_step: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Diffusion steps; more = higher quality + slower. Omitted uses the tdmcp default of 27 (ACE-Step's own default is 60).",
    ),
  guidance_scale: z
    .number()
    .positive()
    .optional()
    .describe("Prompt-adherence strength. Omitted uses 15.0 (ACE-Step default)."),
  mode: z
    .enum(["auto", "sync", "job"])
    .default("auto")
    .describe(
      "auto (default) blocks and returns the WAV unless a calibrated TDMCP_ACE_RTF estimate " +
        "exceeds TDMCP_ACE_SYNC_MAX_SECONDS, in which case it hands off to a job. sync always " +
        "blocks. job always returns a job_id immediately (poll with get_music_job).",
    ),
});

/**
 * Relaxed (required -> optional) so both branches fit one schema; `mode`
 * discriminates. A consumer reading `structuredContent.wavPath` on a sync result
 * is unaffected.
 */
export const generateMusicOutputSchema = z.object({
  mode: z.enum(["sync", "job"]),
  wavPath: z.string().optional(),
  seconds: z.number().optional(),
  seed: z.number().int().optional(),
  observed_rtf: z.number().optional(),
  job_id: z.string().optional(),
  estimated_seconds: z.number().optional(),
});

/**
 * The tool reads `ctx.aceClient`, which the integrator threads onto
 * `ToolContext`. Declared here as an intersection so this file compiles green in
 * isolation; a plain `ToolContext` is assignable (the field is optional).
 */
export type AceToolContext = ToolContext & { aceClient?: AceStepClient };

/** Maps the parsed args onto the client's request shape (shared by the ACE tools). */
export function toAceRequest(a: {
  prompt: string;
  lyrics?: string;
  audio_duration: number;
  manual_seeds?: number;
  infer_step?: number;
  guidance_scale?: number;
}): AceGenerateRequest {
  return {
    prompt: a.prompt,
    lyrics: a.lyrics,
    audio_duration: a.audio_duration,
    manual_seeds: a.manual_seeds,
    infer_step: a.infer_step,
    guidance_scale: a.guidance_scale,
  };
}

/** Builds the `RunGenerationOptions` from the client's config-derived knobs. */
export function runOptions(
  client: AceStepClient,
  mode: "auto" | "sync" | "job",
  extra: ToolExtra | undefined,
): RunGenerationOptions {
  return {
    extra,
    mode,
    syncMaxSeconds: client.syncMaxSeconds,
    rtf: client.rtf,
    defaultSteps: client.steps,
    pollMs: client.pollMs,
  };
}

function syncSummary(o: Extract<RunGenerationOutcome, { kind: "sync" }>): string {
  const base = `Generated ${o.result.seconds.toFixed(1)}s of music (seed ${o.result.seed}) -> ${o.result.wavPath}`;
  const wall = ` [${o.elapsedSeconds.toFixed(1)}s wall-clock`;
  if (o.observedRtf === undefined) return `${base}${wall}]`;
  const r = o.observedRtf.toFixed(2);
  return (
    `${base}${wall}, observed RTF ~ ${r} — set TDMCP_ACE_RTF=${r} to enable ` +
    "automatic job hand-off for long beds]"
  );
}

function jobSummary(o: Extract<RunGenerationOutcome, { kind: "job" }>): string {
  const est =
    o.estimatedSeconds !== undefined
      ? `Estimated ~${Math.round(o.estimatedSeconds)}s of generation, so this ran as a job. `
      : "Ran as a job (mode=job). ";
  return (
    `${est}job_id=${o.jobId} — poll get_music_job {job_id} until status=done, then read ` +
    "wavPath. Stop it early with cancel_music_job."
  );
}

export async function generateMusicImpl(ctx: AceToolContext, rawArgs: unknown, extra?: ToolExtra) {
  const parsed = generateMusicSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(
      `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const client = ctx.aceClient;
  if (!client) {
    return errorResult(
      "ACE-Step music generation is disabled. Set TDMCP_ACE_ENABLED=1 (and run the ace/ wrapper) to enable.",
    );
  }
  const a = parsed.data;
  return guardAce(
    () => runGeneration(client, toAceRequest(a), runOptions(client, a.mode, extra)),
    (o) =>
      o.kind === "sync"
        ? structuredResult(syncSummary(o), {
            mode: "sync",
            wavPath: o.result.wavPath,
            seconds: o.result.seconds,
            seed: o.result.seed,
            ...(o.observedRtf !== undefined ? { observed_rtf: o.observedRtf } : {}),
          })
        : structuredResult(jobSummary(o), {
            mode: "job",
            job_id: o.jobId,
            ...(o.estimatedSeconds !== undefined ? { estimated_seconds: o.estimatedSeconds } : {}),
          }),
  );
}

export const registerGenerateMusic: ToolRegistrar = (server, ctx) => {
  // Disabled-by-default gate: register ONLY when the built context has an ACE
  // client (reflects config.aceEnabled from env OR config file). With ACE off the
  // tool is not listed at all.
  if (!ctx.aceClient) return;
  server.registerTool(
    "generate_music",
    {
      title: "Generate music (ACE-Step)",
      description:
        "Generate a WAV from a text prompt (tags/genre) and optional lyrics via a local " +
        "ACE-Step server. Returns the written file path, realized duration, and seed (mode=sync), " +
        "or a job_id when the bed is long enough to hand off (mode=job). Offline/pre-render " +
        "bed generator, not real-time. Requires TDMCP_ACE_ENABLED=1 and a running ace/ wrapper.",
      inputSchema: generateMusicSchema.shape,
      outputSchema: generateMusicOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args, extra) => generateMusicImpl(ctx, args, extra),
  );
};

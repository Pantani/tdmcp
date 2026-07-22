import { z } from "zod";
import { estimateSeconds, progressReporter } from "../../ace-client/runGeneration.js";
import { guardAce } from "../../ace-client/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolExtra, ToolRegistrar } from "../types.js";
import { type AceToolContext, generateMusicSchema, toAceRequest } from "./generateMusic.js";

/** Shown when a job tool is invoked while the client is in native serving mode. */
const NATIVE_JOBS_UNSUPPORTED =
  "Job control is not supported in native ACE mode (infer-api.py is synchronous, " +
  "text2music-only, no job API). Set TDMCP_ACE_MODE=wrapper.";

/**
 * Reuse the sync generate surface so submit and generate share one input, minus
 * `mode` — this tool is definitionally `job`, so exposing it would be contradictory.
 */
export const submitMusicJobSchema = generateMusicSchema.omit({ mode: true });

export const submitMusicJobOutputSchema = z.object({ job_id: z.string() });

export async function submitMusicJobImpl(ctx: AceToolContext, rawArgs: unknown, extra?: ToolExtra) {
  const parsed = submitMusicJobSchema.safeParse(rawArgs);
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
  if (client.mode === "native") {
    return errorResult(NATIVE_JOBS_UNSUPPORTED);
  }
  const a = parsed.data;
  const req = toAceRequest(a);
  const est = estimateSeconds(req, { rtf: client.rtf, defaultSteps: client.steps });
  return guardAce(
    () => client.submitGenerate(req),
    (r) => {
      // One honest emit: the job exists. There is no loop here to report from, and
      // growing one would defeat the point of a non-blocking submit.
      progressReporter(extra, est).emit(0, `job ${r.job_id} submitted`);
      return structuredResult(`Submitted music job ${r.job_id}. Poll with get_music_job.`, {
        job_id: r.job_id,
      });
    },
  );
}

export const registerSubmitMusicJob: ToolRegistrar = (server, ctx) => {
  if (!ctx.aceClient) return;
  server.registerTool(
    "submit_music_job",
    {
      title: "Submit async music job (ACE-Step)",
      description:
        "Submit a non-blocking ACE-Step music generation job and get a job_id back " +
        "immediately. Poll with get_music_job and stop with cancel_music_job. Same prompt/" +
        "lyrics/duration surface as generate_music. Wrapper mode only. Requires TDMCP_ACE_ENABLED=1.",
      inputSchema: submitMusicJobSchema.shape,
      outputSchema: submitMusicJobOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args, extra) => submitMusicJobImpl(ctx, args, extra),
  );
};

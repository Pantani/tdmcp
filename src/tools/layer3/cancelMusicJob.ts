import { z } from "zod";
import { guardAce } from "../../ace-client/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolRegistrar } from "../types.js";
import type { AceToolContext } from "./generateMusic.js";

/** Shown when a job tool is invoked while the client is in native serving mode. */
const NATIVE_JOBS_UNSUPPORTED =
  "Job control is not supported in native ACE mode (infer-api.py is synchronous, " +
  "text2music-only, no job API). Set TDMCP_ACE_MODE=wrapper.";

export const cancelMusicJobSchema = z.object({
  job_id: z.string().min(1).describe("The job id to cancel; SIGKILLs its worker to free VRAM."),
});

export const cancelMusicJobOutputSchema = z.object({
  cancelled: z.boolean(),
  status: z.string().optional(),
});

export async function cancelMusicJobImpl(ctx: AceToolContext, rawArgs: unknown) {
  const parsed = cancelMusicJobSchema.safeParse(rawArgs);
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
  const jobId = parsed.data.job_id;
  return guardAce(
    () => client.cancelJob(jobId),
    (r) => {
      const summary = r.cancelled
        ? `Cancelled job ${jobId}.`
        : `Job ${jobId} was not cancellable (status ${r.status ?? "unknown"}).`;
      return structuredResult(summary, {
        cancelled: r.cancelled,
        ...(r.status ? { status: r.status } : {}),
      });
    },
  );
}

export const registerCancelMusicJob: ToolRegistrar = (server, ctx) => {
  if (!ctx.aceClient) return;
  server.registerTool(
    "cancel_music_job",
    {
      title: "Cancel music job (ACE-Step)",
      description:
        "Cancel a running async ACE-Step music job by its job_id. SIGKILLs the worker " +
        "subprocess to free GPU VRAM (ACE has no in-pipeline abort). Wrapper mode only. " +
        "Requires TDMCP_ACE_ENABLED=1.",
      inputSchema: cancelMusicJobSchema.shape,
      outputSchema: cancelMusicJobOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => cancelMusicJobImpl(ctx, args),
  );
};

import { z } from "zod";
import { guardAce } from "../../ace-client/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolRegistrar } from "../types.js";
import type { AceToolContext } from "./generateMusic.js";

/** Shown when a job tool is invoked while the client is in native serving mode. */
const NATIVE_JOBS_UNSUPPORTED =
  "Job control is not supported in native ACE mode (infer-api.py is synchronous, " +
  "text2music-only, no job API). Set TDMCP_ACE_MODE=wrapper.";

export const getMusicJobSchema = z.object({
  job_id: z.string().min(1).describe("The job id returned by submit_music_job (POST /jobs)."),
});

export const getMusicJobOutputSchema = z.object({
  status: z.string(),
  wavPath: z.string().optional(),
  seconds: z.number().optional(),
  seed: z.number().int().optional(),
  error: z.string().optional(),
});

export async function getMusicJobImpl(ctx: AceToolContext, rawArgs: unknown) {
  const parsed = getMusicJobSchema.safeParse(rawArgs);
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
    () => client.getJob(jobId),
    (r) => {
      const data: Record<string, unknown> = { status: r.status };
      if (r.wavPath != null) data.wavPath = r.wavPath;
      if (r.seconds != null) data.seconds = r.seconds;
      if (r.seed != null) data.seed = r.seed;
      if (r.error != null) data.error = r.error;
      const summary = `Job ${jobId}: ${r.status}${r.wavPath ? ` -> ${r.wavPath}` : ""}`;
      return structuredResult(summary, data);
    },
  );
}

export const registerGetMusicJob: ToolRegistrar = (server, ctx) => {
  if (!ctx.aceClient) return;
  server.registerTool(
    "get_music_job",
    {
      title: "Get music job status (ACE-Step)",
      description:
        "Poll an async ACE-Step music job by its job_id (from submit_music_job). Reports " +
        "status (running/done/error/cancelled) and, once done, the written wavPath, realized " +
        "duration, and seed. Wrapper mode only. Requires TDMCP_ACE_ENABLED=1.",
      inputSchema: getMusicJobSchema.shape,
      outputSchema: getMusicJobOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getMusicJobImpl(ctx, args),
  );
};
